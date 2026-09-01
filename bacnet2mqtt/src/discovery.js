import {
  BASE_TOPIC,
  DISCOVERY_PREFIX,
  VERSION,
  OBJECT_TYPE,
  pointId,
  pointTopic
} from "./constants.js";

function mqttPublish(client, topic, payload, retain = true) {
  return new Promise((resolve, reject) => {
    client.publish(topic, payload, { qos: 0, retain }, err => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function deviceDescriptor(device) {
  return {
    identifiers: [`bacnet_${device.deviceId}`],
    name: device.deviceName || `BACnet ${device.deviceId}`,
    manufacturer: device.vendorName || (
      device.vendorId !== undefined && device.vendorId !== null
        ? `BACnet vendor ${device.vendorId}`
        : "BACnet"
    ),
    model: device.modelName || "BACnet Device"
  };
}

function driverDescriptor() {
  return {
    identifiers: ["bacnet2mqtt_driver"],
    name: "BACnet Driver",
    manufacturer: "BACnet2MQTT",
    model: "Home Assistant App",
    sw_version: VERSION
  };
}

function origin() {
  return {
    name: "BACnet2MQTT Home Assistant App",
    sw_version: VERSION
  };
}

function pointAvailability(deviceId) {
  return [
    {
      topic: `${BASE_TOPIC}/driver/status`,
      payload_available: "online",
      payload_not_available: "offline"
    },
    {
      topic: `${BASE_TOPIC}/${deviceId}/availability`,
      payload_available: "online",
      payload_not_available: "offline"
    }
  ];
}

function unitName(point) {
  if (!point.unitName) return null;
  const n = String(point.unitName).toUpperCase();

  const common = {
    DEGREES_CELSIUS: "°C",
    DEGREES_FAHRENHEIT: "°F",
    PERCENT: "%",
    PERCENT_RELATIVE_HUMIDITY: "%",
    PASCALS: "Pa",
    KILOPASCALS: "kPa",
    BARS: "bar",
    VOLTS: "V",
    AMPERES: "A",
    WATTS: "W",
    KILOWATTS: "kW",
    WATT_HOURS: "Wh",
    KILOWATT_HOURS: "kWh",
    SECONDS: "s",
    MINUTES: "min",
    HOURS: "h",
    REVOLUTIONS_PER_MINUTE: "rpm",
    CUBIC_METERS_PER_HOUR: "m³/h",
    LITERS_PER_SECOND: "L/s"
  };

  return common[n] || n.toLowerCase().replaceAll("_", " ");
}


function cleanBacnetReal(value) {
  const n = Number(value);

  if (!Number.isFinite(n)) {
    return null;
  }

  // BACnet Analog metadata is normally encoded as REAL (float32).
  // Converting that value to JavaScript exposes the binary float noise,
  // for example:
  //
  //   0.001 -> 0.0010000000474974513
  //   0.1   -> 0.10000000149011612
  //
  // MQTT Number ultimately becomes an HTML number input. If we publish
  // the noisy value as "step", normal values such as 1, 10 or 100 are
  // considered invalid by the browser. Seven significant digits match
  // the useful precision of a BACnet REAL while removing that noise.
  return Number(n.toPrecision(7));
}

function numberConfig(point) {
  const rawMin = Number(point.minValue);
  const rawMax = Number(point.maxValue);
  const rawStep = Number(point.resolution);
  const current = Number(point.value);

  let min;
  let max;

  const cleanMin = cleanBacnetReal(rawMin);
  const cleanMax = cleanBacnetReal(rawMax);
  const cleanStep = cleanBacnetReal(rawStep);

  // BACnet Min_Pres_Value / Max_Pres_Value are useful only if they form
  // a valid range. Some controllers return 0/0 or placeholder values.
  if (
    cleanMin !== null &&
    cleanMax !== null &&
    cleanMin < cleanMax
  ) {
    min = cleanMin;
    max = cleanMax;
  } else if (Number.isFinite(current)) {
    const span = Math.max(Math.abs(current) * 2, 100);

    min = Math.floor(
      Math.min(
        0,
        current - span
      )
    );

    max = Math.ceil(
      Math.max(
        100,
        current + span
      )
    );

    if (!(min < max)) {
      min = current - 100;
      max = current + 100;
    }
  } else {
    min = -1000000;
    max = 1000000;
  }

  let step =
    cleanStep !== null && cleanStep >= 0.001
      ? cleanStep
      : 0.1;

  if (step < 0.001) {
    step = 0.001;
  }

  // Final cleanup also guarantees JSON contains ordinary decimal values.
  min = cleanBacnetReal(min) ?? min;
  max = cleanBacnetReal(max) ?? max;
  step = cleanBacnetReal(step) ?? step;

  return {
    min,
    max,
    step
  };
}


function normalizeWritableAnalogState(point, value) {
  const n = Number(value);

  if (!Number.isFinite(n)) {
    return value;
  }

  const limits = numberConfig(point);
  const step = Number(limits.step);
  const min = Number(limits.min);

  // For an HTML number input, valid values are:
  //   min + N * step
  //
  // BACnet REAL values are float32 and can arrive as e.g.
  // 0.0020000000949949026 even though the controller value is logically
  // 0.002. That raw value makes the HA/browser number input invalid and
  // causes the spinner to jump unexpectedly.
  if (
    Number.isFinite(step) &&
    step > 0 &&
    Number.isFinite(min)
  ) {
    const count = Math.round((n - min) / step);
    const aligned = min + count * step;
    return cleanBacnetReal(aligned) ?? aligned;
  }

  return cleanBacnetReal(n) ?? n;
}

function classify(point) {
  const type = Number(point.bacType);
  const writable = point.writable === true;

  switch (type) {
    case OBJECT_TYPE.ANALOG_INPUT:
      return { component: "sensor", writable: false };

    case OBJECT_TYPE.ANALOG_OUTPUT:
    case OBJECT_TYPE.ANALOG_VALUE:
      return writable
        ? { component: "number", writable: true }
        : { component: "sensor", writable: false };

    case OBJECT_TYPE.BINARY_INPUT:
      return { component: "binary_sensor", writable: false };

    case OBJECT_TYPE.BINARY_OUTPUT:
    case OBJECT_TYPE.BINARY_VALUE:
      return writable
        ? { component: "switch", writable: true }
        : { component: "binary_sensor", writable: false };

    case OBJECT_TYPE.MULTI_STATE_INPUT:
      return { component: "sensor", writable: false };

    case OBJECT_TYPE.SCHEDULE:
      return { component: "sensor", writable: false };

    case OBJECT_TYPE.MULTI_STATE_OUTPUT:
    case OBJECT_TYPE.MULTI_STATE_VALUE:
      return writable
        ? { component: "select", writable: true }
        : { component: "sensor", writable: false };

    default:
      return null;
  }
}


function jsonSafe(value, depth = 0) {
  if (depth > 12) return "[max-depth]";

  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value ?? null;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Buffer.isBuffer(value)) {
    return value.toString("hex");
  }

  if (Array.isArray(value)) {
    return value.map(v => jsonSafe(v, depth + 1));
  }

  if (typeof value === "object") {
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === "function") continue;
      result[key] = jsonSafe(item, depth + 1);
    }
    return result;
  }

  return String(value);
}

const SCHEDULE_DAYS = [
  ["monday", "Monday"],
  ["tuesday", "Tuesday"],
  ["wednesday", "Wednesday"],
  ["thursday", "Thursday"],
  ["friday", "Friday"],
  ["saturday", "Saturday"],
  ["sunday", "Sunday"]
];

function bacnetDatePart(entry) {
  if (!entry || typeof entry !== "object") return null;

  const raw = entry.raw || null;

  if (
    raw &&
    Number(raw.year) === 255 &&
    Number(raw.month) === 255 &&
    Number(raw.day) === 255
  ) {
    return null;
  }

  if (raw) {
    const year = Number(raw.year);
    const month = Number(raw.month);
    const day = Number(raw.day);

    if (
      Number.isFinite(year) &&
      Number.isFinite(month) &&
      Number.isFinite(day)
    ) {
      const fullYear = year < 100 ? 1900 + year : year;
      return `${String(fullYear).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
  }

  const value = entry.value;

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return [
      value.getFullYear(),
      String(value.getMonth() + 1).padStart(2, "0"),
      String(value.getDate()).padStart(2, "0")
    ].join("-");
  }

  if (typeof value === "string") {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) {
      return [
        d.getFullYear(),
        String(d.getMonth() + 1).padStart(2, "0"),
        String(d.getDate()).padStart(2, "0")
      ].join("-");
    }
  }

  return null;
}

function friendlyEffectivePeriod(value) {
  const list = Array.isArray(value) ? value : [];

  const start = bacnetDatePart(list[0]);
  const end = bacnetDatePart(list[1]);

  return {
    unrestricted: start === null && end === null,
    start,
    end
  };
}

function controlledObject(point) {
  const refs = point.schedule?.objectPropertyReferences;
  const first = Array.isArray(refs) ? refs[0] : refs;

  if (!first || typeof first !== "object") return null;

  const objectId =
    first.objectId ??
    first.objectIdentifier ??
    first.object ??
    null;

  const property =
    first.id?.value ??
    first.propertyIdentifier ??
    first.propertyId ??
    first.property?.id ??
    null;

  if (!objectId) return null;

  return {
    object_type:
      Number(objectId.objectType ?? objectId.type),
    object_instance:
      Number(objectId.instance),
    property_id:
      property !== null && property !== undefined
        ? Number(property)
        : null
  };
}

function scheduleAttributes(point) {
  const schedule = point.schedule || {};
  const templates = schedule.dayTemplates || {};

  const friendlyWeekly = {};
  for (const [key] of SCHEDULE_DAYS) {
    friendlyWeekly[key] = templates[key] || "";
  }

  return jsonSafe({
    object_type: "schedule",
    object_instance: Number(point.bacInstance),
    device_name: point.deviceDisplayName ?? null,
    present_value: point.value ?? null,
    present_value_text:
      point.presentValueText ?? null,
    schedule_config:
      point.scheduleConfig ?? null,
    schedule_default: schedule.scheduleDefault ?? null,
    priority_for_writing: schedule.priorityForWriting ?? null,
    effective_period: friendlyEffectivePeriod(schedule.effectivePeriod),
    weekly_schedule: friendlyWeekly,
    exception_schedule: schedule.exceptionSchedule ?? [],
    controlled_object: controlledObject(point),
    weekly_schedule_raw: schedule.weeklySchedule ?? null
  });
}

function discoveryTopic(component, objectId) {
  return `${DISCOVERY_PREFIX}/${component}/bacnet/${objectId}/config`;
}

function addConfig(messages, component, objectId, config) {
  messages.push({
    topic: discoveryTopic(component, objectId),
    payload: JSON.stringify(config),
    retain: true
  });
}

function addRemoval(messages, component, objectId) {
  messages.push({
    topic: discoveryTopic(component, objectId),
    payload: "",
    retain: true
  });
}

export async function publishDiscovery(client, cache, logger) {
  const messages = [];
  const currentTopics = new Set();

  const devices = Object.values(cache.devices || {});
  const allPoints = Object.values(cache.points || {}).flat();

  for (const point of allPoints) {
    const device = cache.devices?.[String(point.deviceId)];
    if (!device) continue;

    const classification = classify(point);
    if (!classification) continue;

    const { component, writable } = classification;
    const id = pointId(point.deviceId, point.bacType, point.bacInstance);
    const base = pointTopic(point.deviceId, point.bacType, point.bacInstance);

    for (const oldComponent of ["sensor", "binary_sensor", "switch", "number", "select"]) {
      if (oldComponent !== component) {
        addRemoval(messages, oldComponent, id);
      }
    }

    if (!writable) {
      addRemoval(messages, "button", `${id}_release`);
    }

    const config = {
      name: point.pointName || `BACnet ${point.bacType}/${point.bacInstance}`,
      unique_id: id,
      state_topic: `${base}/state`,
      availability: pointAvailability(point.deviceId),
      availability_mode: "all",
      device: deviceDescriptor(device),
      origin: origin()
    };

    if (Number(point.bacType) === OBJECT_TYPE.SCHEDULE) {
      config.icon = "mdi:calendar-clock";
      config.json_attributes_topic = `${base}/attributes`;
    }

    const unit =
      Number(point.bacType) === OBJECT_TYPE.SCHEDULE
        ? String(point.scheduleConfig?.unit || "").trim() || null
        : unitName(point);

    if ((component === "sensor" || component === "number") && unit) {
      config.unit_of_measurement = unit;
    }

    if (writable) {
      config.command_topic = `${base}/set`;
    }

    if (component === "number") {
      const limits = numberConfig(point);

      config.mode = "box";
      config.min = limits.min;
      config.max = limits.max;
      config.step = limits.step;

      logger.info(
        `HA number ${point.deviceId}/${point.bacType}/${point.bacInstance} ` +
        `(${point.pointName}): min=${config.min}, max=${config.max}, ` +
        `step=${config.step}, raw_resolution=${point.resolution}, ` +
        `value=${point.value}`
      );
    }

    if (component === "switch" || component === "binary_sensor") {
      config.payload_on = "ON";
      config.payload_off = "OFF";
    }

    if (component === "select") {
      const options = Object.entries(point.states || {})
        .sort((a, b) => Number(a[0]) - Number(b[0]))
        .map(([, name]) => String(name));

      if (!options.length) {
        logger.warn(
          `No state mapping for writable multi-state ${point.deviceId}/${point.bacType}/${point.bacInstance}; publishing as sensor`
        );
        addRemoval(messages, "select", id);

        const sensorConfig = { ...config };
        delete sensorConfig.command_topic;
        delete sensorConfig.options;

        addConfig(messages, "sensor", id, sensorConfig);
        currentTopics.add(discoveryTopic("sensor", id));
        continue;
      }

      config.options = options;
    }

    addConfig(messages, component, id, config);
    currentTopics.add(discoveryTopic(component, id));

    // BACnet Schedule: expose ONE editable MQTT Text entity for the
    // complete Monday-Sunday program.
    //
    // Example:
    // Monday:08:00=ON;16:00=OFF | Tuesday:- | Wednesday:- |
    // Thursday:- | Friday:- | Saturday:- | Sunday:-
    //
    // Remove the seven weekday text entities created by v0.1.5.
    if (Number(point.bacType) === OBJECT_TYPE.SCHEDULE) {
      for (const [dayKey] of SCHEDULE_DAYS) {
        addRemoval(
          messages,
          "text",
          `${id}_${dayKey}`
        );
      }

      const weekId =
        `${id}_week`;

      const weekConfig = {
        name:
          `${point.pointName} - Weekly Schedule`,

        unique_id:
          weekId,

        state_topic:
          `${base}/schedule`,

        // The Text entity must subscribe to the Schedule attributes topic.
        // v0.2.7 accidentally attached this only to the Schedule sensor.
        // The card reads Present_Value directly from this Text entity.
        json_attributes_topic:
          `${base}/attributes`,

        value_template:
          "{{ " +
          "'Monday:' ~ (value_json.monday | default('-', true)) ~ " +
          "' | Tuesday:' ~ (value_json.tuesday | default('-', true)) ~ " +
          "' | Wednesday:' ~ (value_json.wednesday | default('-', true)) ~ " +
          "' | Thursday:' ~ (value_json.thursday | default('-', true)) ~ " +
          "' | Friday:' ~ (value_json.friday | default('-', true)) ~ " +
          "' | Saturday:' ~ (value_json.saturday | default('-', true)) ~ " +
          "' | Sunday:' ~ (value_json.sunday | default('-', true)) " +
          "}}",

        command_topic:
          `${base}/schedule/set/week`,

        command_template:
          "{{ value }}",

        mode:
          "text",

        min:
          0,

        max:
          255,

        availability:
          pointAvailability(point.deviceId),

        availability_mode:
          "all",

        icon:
          "mdi:calendar-edit",

        device:
          deviceDescriptor(device),

        origin:
          origin()
      };

      addConfig(
        messages,
        "text",
        weekId,
        weekConfig
      );

      currentTopics.add(
        discoveryTopic(
          "text",
          weekId
        )
      );
    }

    if (writable) {
      const releaseConfig = {
        name: `${point.pointName} - Priority Release`,
        unique_id: `${id}_release`,
        command_topic: `${base}/set`,
        payload_press: "RELEASE",
        availability: pointAvailability(point.deviceId),
        availability_mode: "all",
        entity_category: "config",
        icon: "mdi:priority-high",
        device: deviceDescriptor(device),
        origin: origin()
      };

      addConfig(messages, "button", `${id}_release`, releaseConfig);
      currentTopics.add(discoveryTopic("button", `${id}_release`));
    }
  }

  for (const device of devices) {
    const id = `bacnet_${device.deviceId}_status`;

    addRemoval(messages, "button", `bacnet_${device.deviceId}_scan`);
    addRemoval(messages, "button", `bacnet_${device.deviceId}_read`);
    addRemoval(messages, "binary_sensor", id);

    const statusConfig = {
      name: "BACnet Status",
      unique_id: id,
      state_topic: `${BASE_TOPIC}/${device.deviceId}/availability`,
      availability_topic: `${BASE_TOPIC}/driver/status`,
      payload_available: "online",
      payload_not_available: "offline",
      entity_category: "diagnostic",
      icon: "mdi:lan-connect",
      device: deviceDescriptor(device),
      origin: origin()
    };

    addConfig(messages, "sensor", id, statusConfig);
    currentTopics.add(discoveryTopic("sensor", id));
  }

  const driver = driverDescriptor();

  const scanConfig = {
    name: "BACnet Scan",
    unique_id: "bacnet2mqtt_driver_scan",
    command_topic: `${BASE_TOPIC}/control/scan`,
    payload_press: "SCAN",
    availability_topic: `${BASE_TOPIC}/driver/status`,
    payload_available: "online",
    payload_not_available: "offline",
    entity_category: "config",
    icon: "mdi:magnify-scan",
    device: driver,
    origin: origin()
  };

  addConfig(messages, "button", "bacnet2mqtt_driver_scan", scanConfig);
  currentTopics.add(discoveryTopic("button", "bacnet2mqtt_driver_scan"));

  const readConfig = {
    name: "BACnet Read",
    unique_id: "bacnet2mqtt_driver_read",
    command_topic: `${BASE_TOPIC}/control/read`,
    payload_press: "READ",
    availability_topic: `${BASE_TOPIC}/driver/status`,
    payload_available: "online",
    payload_not_available: "offline",
    entity_category: "config",
    icon: "mdi:refresh",
    device: driver,
    origin: origin()
  };

  addConfig(messages, "button", "bacnet2mqtt_driver_read", readConfig);
  currentTopics.add(discoveryTopic("button", "bacnet2mqtt_driver_read"));

  const driverStatus = {
    name: "BACnet Driver Status",
    unique_id: "bacnet2mqtt_driver_status",
    state_topic: `${BASE_TOPIC}/driver/status`,
    entity_category: "diagnostic",
    icon: "mdi:server-network",
    device: driver,
    origin: origin()
  };

  addConfig(messages, "sensor", "bacnet2mqtt_driver_status", driverStatus);
  currentTopics.add(discoveryTopic("sensor", "bacnet2mqtt_driver_status"));

  // Native Home Assistant Update entity used for the required Core restart
  // after the bundled Lovelace resource changes. Opening this entity gives
  // the normal Home Assistant firmware/update dialog instead of an Ingress
  // popup. Pressing Update sends RESTART to BACnet2MQTT.
  const rebootUpdate = {
    name: "Home Assistant Reboot Required",
    unique_id: "bacnet2mqtt_homeassistant_reboot",
    title: "Home Assistant Reboot Required",
    state_topic: `${BASE_TOPIC}/driver/homeassistant_reboot`,
    command_topic: `${BASE_TOPIC}/control/homeassistant-restart`,
    payload_install: "RESTART",
    availability_topic: `${BASE_TOPIC}/driver/status`,
    payload_available: "online",
    payload_not_available: "offline",
    device_class: "firmware",
    entity_category: "config",
    icon: "mdi:restart-alert",
    device: driver,
    origin: origin()
  };

  addConfig(
    messages,
    "update",
    "bacnet2mqtt_homeassistant_reboot",
    rebootUpdate
  );
  currentTopics.add(
    discoveryTopic(
      "update",
      "bacnet2mqtt_homeassistant_reboot"
    )
  );

  for (const oldTopic of cache.discoveryTopics || []) {
    if (!currentTopics.has(oldTopic)) {
      messages.push({ topic: oldTopic, payload: "", retain: true });
    }
  }

  for (const msg of messages) {
    await mqttPublish(client, msg.topic, msg.payload, msg.retain);
  }

  cache.discoveryTopics = [...currentTopics];
  logger.info(`Published Home Assistant discovery (${currentTopics.size} active entities)`);
}

export async function publishRestartUpdateState(
  client,
  required,
  inProgress = false
) {
  const installed = VERSION;
  const latest = required
    ? `${VERSION}.1`
    : VERSION;

  await mqttPublish(
    client,
    `${BASE_TOPIC}/driver/homeassistant_reboot`,
    JSON.stringify({
      installed_version: installed,
      latest_version: latest,
      title: "Home Assistant Reboot Required",
      release_summary: required
        ? "BACnet2MQTT frontend resources changed. Home Assistant must be restarted once to load the new Schedule Card."
        : "Home Assistant is using the current BACnet2MQTT frontend resources.",
      in_progress: inProgress === true
    }),
    true
  );
}

export function statePayload(point, value) {
  const type = Number(point.bacType);

  if (
    type === OBJECT_TYPE.BINARY_INPUT ||
    type === OBJECT_TYPE.BINARY_OUTPUT ||
    type === OBJECT_TYPE.BINARY_VALUE
  ) {
    if (typeof value === "boolean") return value ? "ON" : "OFF";
    return Number(value) ? "ON" : "OFF";
  }

  if (
    type === OBJECT_TYPE.MULTI_STATE_INPUT ||
    type === OBJECT_TYPE.MULTI_STATE_OUTPUT ||
    type === OBJECT_TYPE.MULTI_STATE_VALUE
  ) {
    const mapped = point.states?.[String(Number(value))];
    return mapped !== undefined ? String(mapped) : String(value);
  }

  if (
    (
      type === OBJECT_TYPE.ANALOG_OUTPUT ||
      type === OBJECT_TYPE.ANALOG_VALUE
    ) &&
    point.writable === true
  ) {
    return String(
      normalizeWritableAnalogState(
        point,
        value
      )
    );
  }

  if (type === OBJECT_TYPE.SCHEDULE) {
    if (point.scheduleConfig?.mode === "number") {
      return value === null || value === undefined ? "" : String(value);
    }
    if (point.presentValueText !== null && point.presentValueText !== undefined) {
      return String(point.presentValueText);
    }
  }

  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(jsonSafe(value));
  return String(value);
}

export async function publishPointState(client, point, value) {
  const base =
    pointTopic(point.deviceId, point.bacType, point.bacInstance);

  await mqttPublish(
    client,
    `${base}/state`,
    statePayload(point, value),
    false
  );

  if (Number(point.bacType) === OBJECT_TYPE.SCHEDULE) {
    await mqttPublish(
      client,
      `${base}/attributes`,
      JSON.stringify(scheduleAttributes(point)),
      true
    );

    const templates = point.schedule?.dayTemplates || {};

    await mqttPublish(
      client,
      `${base}/schedule`,
      JSON.stringify({
        monday: templates.monday || "",
        tuesday: templates.tuesday || "",
        wednesday: templates.wednesday || "",
        thursday: templates.thursday || "",
        friday: templates.friday || "",
        saturday: templates.saturday || "",
        sunday: templates.sunday || ""
      }),
      true
    );
  }
}

export async function publishDeviceAvailability(client, deviceId, online) {
  await mqttPublish(
    client,
    `${BASE_TOPIC}/${deviceId}/availability`,
    online ? "online" : "offline",
    true
  );
}
