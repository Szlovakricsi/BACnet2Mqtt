import fs from "node:fs/promises";
import * as BacnetModule from "@bacnet-js/client";

const ApplicationTag =
  BacnetModule.ApplicationTag ??
  BacnetModule.default?.ApplicationTag;

const EngineeringUnits =
  BacnetModule.EngineeringUnits ??
  BacnetModule.default?.EngineeringUnits;

// @bacnet-js/client 3.x can appear with different ESM/CommonJS interop
// shapes depending on the Node.js runtime/build. Resolve the constructor
// defensively instead of assuming a single default-export shape.
const BacnetClient =
  (typeof BacnetModule.default === "function"
    ? BacnetModule.default
    : null) ??
  (typeof BacnetModule.default?.default === "function"
    ? BacnetModule.default.default
    : null) ??
  (typeof BacnetModule.BACnetClient === "function"
    ? BacnetModule.BACnetClient
    : null) ??
  (typeof BacnetModule.Client === "function"
    ? BacnetModule.Client
    : null);

if (typeof BacnetClient !== "function") {
  throw new TypeError(
    "Unable to resolve @bacnet-js/client constructor. Export keys: " +
    Object.keys(BacnetModule).join(", ")
  );
}

import {
  BASE_TOPIC,
  OBJECT_TYPE,
  SUPPORTED_OBJECT_TYPES,
  WRITABLE_CANDIDATE_TYPES,
  PROP,
  sleep,
  pointKey,
  normalizeAddress
} from "./constants.js";

import {
  publishDiscovery,
  publishPointState,
  publishDeviceAvailability,
  publishRestartUpdateState
} from "./discovery.js";
import { UiSettings } from "./ui-settings.js";

const CACHE_FILE = "/data/cache.json";
const RESTART_REQUIRED_FILE =
  "/data/homeassistant-restart-required.json";

function createLogger(level = "info") {
  const levels = { error: 0, warn: 1, info: 2, debug: 3 };
  const selected = levels[level] ?? 2;

  function log(name, ...args) {
    if (levels[name] <= selected) {
      const stamp = new Date().toISOString();
      console.log(`[${stamp}] [${name.toUpperCase()}]`, ...args);
    }
  }

  return {
    error: (...a) => log("error", ...a),
    warn: (...a) => log("warn", ...a),
    info: (...a) => log("info", ...a),
    debug: (...a) => log("debug", ...a)
  };
}

function firstValue(result) {
  if (!result || !Array.isArray(result.values) || !result.values.length) {
    return undefined;
  }
  return result.values[0]?.value;
}

function allValues(result) {
  if (!result || !Array.isArray(result.values)) return [];
  return result.values.map(v => v?.value);
}

function finiteOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function cleanUiNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  return Number(n.toPrecision(7));
}

function displayValue(v) {
  if (v === undefined) return "<unavailable>";
  if (v === null) return "NULL";
  if (typeof v === "object") {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

function engineeringUnitName(value) {
  if (value === undefined || value === null) return null;
  try {
    return EngineeringUnits?.[Number(value)] || String(value);
  } catch {
    return String(value);
  }
}

function asObjectId(value) {
  if (!value || typeof value !== "object") return null;
  const type = Number(value.type ?? value.objectType);
  const instance = Number(value.instance);
  if (!Number.isFinite(type) || !Number.isFinite(instance)) return null;
  return { type, instance };
}

function receiverAddressString(address) {
  return address?.address || "";
}

function fnv1a32(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h || 1;
}

async function mapLimit(items, limit, fn) {
  const result = new Array(items.length);
  let index = 0;

  async function worker() {
    while (true) {
      const i = index++;
      if (i >= items.length) return;
      try {
        result[i] = await fn(items[i], i);
      } catch (err) {
        result[i] = { error: err };
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length || 1) }, () => worker())
  );

  return result;
}

export class Gateway {
  constructor(options, mqttClient) {
    this.options = options;
    this.mqtt = mqttClient;
    this.log = createLogger(options.log_level);
    this.uiSettings = new UiSettings(this.log);

    this.cache = {
      devices: {},
      points: {},
      discoveryTopics: []
    };

    this.deviceOnline = new Map();
    this.scanCollector = null;
    this.scanRunning = false;
    this.pollRunning = false;
    this.healthRunning = false;
    this.rediscovering = new Set();

    this.covSubscriptions = new Map();
    this.covRenewTimer = null;

    this.log.info(`BACnet library loaded: constructor=${BacnetClient.name || "anonymous"}`);

    this.bacnet = new BacnetClient({
      apduTimeout: Number(options.apdu_timeout),
      interface: options.bacnet_interface,
      port: Number(options.bacnet_port),
      broadcastAddress: options.bacnet_broadcast,
      reuseAddr: true
    });

    // Install the listening handler immediately so startup cannot miss
    // a fast UDP socket "listening" event between construction and start().
    this.bacnetReady = new Promise(resolve => {
      this.bacnet.once("listening", resolve);
    });

    this.bacnet.on("error", err => {
      this.log.error("BACnet client error:", err?.message || err);
    });

    this.bacnet.on("iAm", data => {
      this.handleIAm(data).catch(err => {
        this.log.warn("I-Am handler:", err?.message || err);
      });
    });

    this.bacnet.on("covNotifyUnconfirmed", data => {
      this.handleCov(data).catch(err => {
        this.log.warn("COV handler:", err?.message || err);
      });
    });

    this.bacnet.on("covNotify", data => {
      this.handleCov(data).catch(err => {
        this.log.warn("Confirmed COV handler:", err?.message || err);
      });
    });
  }

  async loadCache() {
    try {
      const raw = await fs.readFile(CACHE_FILE, "utf8");
      const parsed = JSON.parse(raw);
      this.cache = {
        devices: parsed.devices || {},
        points: parsed.points || {},
        discoveryTopics: parsed.discoveryTopics || []
      };

      // Migrate older caches so UI overrides can always fall back to the
      // original BACnet metadata instead of stacking on previous overrides.
      for (const device of Object.values(this.cache.devices)) {
        if (!device.sourceDeviceName) {
          device.sourceDeviceName =
            device.deviceName || `BACnet ${device.deviceId}`;
        }
      }

      for (const point of Object.values(this.cache.points).flat()) {
        if (!point.sourcePointName) {
          point.sourcePointName =
            point.pointName || `${point.bacType}:${point.bacInstance}`;
        }
        if (!("sourceMinValue" in point)) point.sourceMinValue = point.minValue ?? null;
        if (!("sourceMaxValue" in point)) point.sourceMaxValue = point.maxValue ?? null;
        if (!("sourceResolution" in point)) point.sourceResolution = point.resolution ?? null;
      }

      this.log.info(
        `Loaded cache: ${Object.keys(this.cache.devices).length} devices, ` +
        `${Object.values(this.cache.points).flat().length} points`
      );
    } catch (err) {
      if (err?.code !== "ENOENT") {
        this.log.warn("Could not load cache:", err?.message || err);
      }
    }
  }

  async saveCache() {
    const tmp = `${CACHE_FILE}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.cache, null, 2), "utf8");
    await fs.rename(tmp, CACHE_FILE);
  }

  async start() {
    await this.loadCache();
    await this.uiSettings.load();

    await this.publishEffectiveDiscovery();
    await this.publishRestartUpdateState().catch(err => {
      this.log.debug("Restart update state publish failed:", err?.message || err);
    });
    for (const device of Object.values(this.cache.devices)) {
      if (this.uiSettings.isHidden(device.deviceId)) continue;
      await this.setDeviceOnline(device.deviceId, false, false);
    }

    await this.bacnetReady;

    this.log.info(
      `BACnet/IP listening on ${this.options.bacnet_interface}:${this.options.bacnet_port}, ` +
      `broadcast ${this.options.bacnet_broadcast}`
    );

    try {
      await this.scan();
    } catch (err) {
      this.log.error("Initial BACnet scan failed:", err?.message || err);
    }

    this.startTimers();
  }

  startTimers() {
    const healthMs = Number(this.options.health_interval) * 1000;
    const pollMs = Number(this.options.poll_interval) * 1000;

    this.healthTimer = setInterval(() => {
      this.healthCheck().catch(err => this.log.warn("Health check:", err?.message || err));
    }, healthMs);

    this.pollTimer = setInterval(() => {
      this.fullReadAll().catch(err => this.log.warn("Full read:", err?.message || err));
    }, pollMs);

    if (this.options.cov_enabled) {
      const renewMs = Math.max(
        10000,
        Math.floor(
          Number(this.options.cov_lifetime) *
          1000 *
          (Number(this.options.cov_renew_percent) / 100)
        )
      );

      this.covRenewTimer = setInterval(() => {
        this.renewCov().catch(err => this.log.warn("COV renew:", err?.message || err));
      }, renewMs);
    }
  }

  async stop() {
    clearInterval(this.healthTimer);
    clearInterval(this.pollTimer);
    clearInterval(this.covRenewTimer);

    try {
      this.bacnet.close();
    } catch {}
  }

  async handleIAm(data) {
    const payload = data?.payload;
    const address = normalizeAddress(data?.header?.sender);
    if (!payload || !address) return;

    const deviceId = Number(payload.deviceId);
    if (!Number.isFinite(deviceId)) return;
    if (this.uiSettings.isHidden(deviceId)) return;

    const candidate = {
      deviceId,
      address,
      vendorId: payload.vendorId ?? payload.vendorIdentifier ?? null,
      maxApdu: payload.maxApdu ?? null,
      segmentation: payload.segmentation ?? null,
      deviceName: this.cache.devices?.[String(deviceId)]?.sourceDeviceName ||
        this.cache.devices?.[String(deviceId)]?.deviceName || `BACnet ${deviceId}`,
      sourceDeviceName: this.cache.devices?.[String(deviceId)]?.sourceDeviceName ||
        this.cache.devices?.[String(deviceId)]?.deviceName || `BACnet ${deviceId}`,
      modelName: this.cache.devices?.[String(deviceId)]?.modelName || null,
      vendorName: this.cache.devices?.[String(deviceId)]?.vendorName || null
    };

    if (this.scanCollector) {
      this.scanCollector.set(String(deviceId), candidate);
    }
  }

  serviceOptions(device, options = {}) {
    const result = { ...options };

    const maxApdu = Number(device?.maxApdu);
    if (Number.isFinite(maxApdu) && maxApdu > 0) {
      result.maxApdu = maxApdu;
    }

    return result;
  }

  async readProp(device, objectId, propertyId, options = {}) {
    if (!device?.address) throw new Error("Device address missing");

    return this.bacnet.readProperty(
      device.address,
      objectId,
      propertyId,
      this.serviceOptions(device, options)
    );
  }

  async readScalar(device, objectId, propertyId, options = {}) {
    const result = await this.readProp(device, objectId, propertyId, options);
    return firstValue(result);
  }

  async readOptional(device, objectId, propertyId, options = {}) {
    try {
      return await this.readScalar(device, objectId, propertyId, options);
    } catch {
      return undefined;
    }
  }

  async readOptionalPayload(device, objectId, propertyId, options = {}) {
    try {
      const result = await this.readProp(
        device,
        objectId,
        propertyId,
        options
      );

      if (!result || !Array.isArray(result.values)) {
        return undefined;
      }

      if (result.values.length === 1) {
        return result.values[0]?.value;
      }

      return result.values.map(v => v?.value);
    } catch {
      return undefined;
    }
  }

  async enrichDevice(device) {
    const objectId = { type: OBJECT_TYPE.DEVICE, instance: device.deviceId };

    const [deviceName, vendorName, vendorId, modelName] = await Promise.all([
      this.readOptional(device, objectId, PROP.OBJECT_NAME),
      this.readOptional(device, objectId, PROP.VENDOR_NAME),
      this.readOptional(device, objectId, PROP.VENDOR_IDENTIFIER),
      this.readOptional(device, objectId, PROP.MODEL_NAME)
    ]);

    const sourceDeviceName =
      deviceName ??
      device.sourceDeviceName ??
      device.deviceName ??
      `BACnet ${device.deviceId}`;

    return {
      ...device,
      deviceName: sourceDeviceName,
      sourceDeviceName,
      vendorName: vendorName ?? device.vendorName ?? null,
      vendorId: vendorId ?? device.vendorId ?? null,
      modelName: modelName ?? device.modelName ?? null
    };
  }

  async readObjectList(device) {
    const deviceObject = {
      type: OBJECT_TYPE.DEVICE,
      instance: device.deviceId
    };

    // Object_List is an array. Reading the complete property can look
    // successful while still returning only a partial list on devices
    // with limited APDU/segmentation support. For discovery reliability,
    // always prefer indexed reads:
    //
    //   index 0  -> array length
    //   index 1..N -> individual object identifiers
    //
    // This is intentionally slower than one large read but avoids silently
    // losing BACnet objects on controllers such as the AS680.
    let count = 0;

    try {
      const countRaw = await this.readScalar(
        device,
        deviceObject,
        PROP.OBJECT_LIST,
        { arrayIndex: 0 }
      );

      count = Number(countRaw);

      if (!Number.isFinite(count) || count < 0 || count > 50000) {
        throw new Error(`Invalid Object_List count: ${displayValue(countRaw)}`);
      }

      this.log.info(
        `Device ${device.deviceId}: Object_List reports ${count} objects`
      );
    } catch (err) {
      this.log.warn(
        `Device ${device.deviceId}: indexed Object_List count failed, trying full read:`,
        err?.message || err
      );

      const result = await this.readProp(
        device,
        deviceObject,
        PROP.OBJECT_LIST
      );

      const ids = allValues(result)
        .map(asObjectId)
        .filter(Boolean);

      this.log.info(
        `Device ${device.deviceId}: full Object_List returned ${ids.length} objects`
      );

      return ids;
    }

    const ids = [];
    let failed = 0;

    // Sequential reads are deliberate. Some BACnet controllers become
    // unreliable if a large number of Object_List array indices are read
    // concurrently.
    for (let i = 1; i <= count; i++) {
      try {
        const value = await this.readScalar(
          device,
          deviceObject,
          PROP.OBJECT_LIST,
          { arrayIndex: i }
        );

        const id = asObjectId(value);

        if (id) {
          ids.push(id);
        } else {
          this.log.debug(
            `Device ${device.deviceId}: Object_List[${i}] is not an object id: ${displayValue(value)}`
          );
        }
      } catch (err) {
        failed++;

        this.log.warn(
          `Device ${device.deviceId}: Object_List[${i}] read failed:`,
          err?.message || err
        );
      }
    }

    this.log.info(
      `Device ${device.deviceId}: Object_List read ${ids.length}/${count}` +
      (failed ? ` (${failed} failed indices)` : "")
    );

    return ids;
  }

  async discoverPoint(device, objectId) {
    const pointName = await this.readOptional(device, objectId, PROP.OBJECT_NAME);
    const presentValue = await this.readOptional(device, objectId, PROP.PRESENT_VALUE);

    let writable = false;
    if (WRITABLE_CANDIDATE_TYPES.has(Number(objectId.type))) {
      try {
        await this.readScalar(device, objectId, PROP.RELINQUISH_DEFAULT);
        writable = true;
      } catch {
        writable = false;
      }
    }

    const point = {
      deviceId: Number(device.deviceId),
      deviceName: device.deviceName,
      pointName: pointName ?? `${objectId.type}:${objectId.instance}`,
      sourcePointName: pointName ?? `${objectId.type}:${objectId.instance}`,
      bacType: Number(objectId.type),
      bacInstance: Number(objectId.instance),
      writable,
      value: presentValue,
      unitName: null,
      states: null,
      minValue: null,
      maxValue: null,
      resolution: null,
      sourceMinValue: null,
      sourceMaxValue: null,
      sourceResolution: null,
      schedule: null
    };

    if (
      objectId.type === OBJECT_TYPE.ANALOG_INPUT ||
      objectId.type === OBJECT_TYPE.ANALOG_OUTPUT ||
      objectId.type === OBJECT_TYPE.ANALOG_VALUE
    ) {
      const [unit, minValue, maxValue, resolution] = await Promise.all([
        this.readOptional(device, objectId, PROP.UNITS),
        this.readOptional(device, objectId, PROP.MIN_PRES_VALUE),
        this.readOptional(device, objectId, PROP.MAX_PRES_VALUE),
        this.readOptional(device, objectId, PROP.RESOLUTION)
      ]);

      point.unitName = engineeringUnitName(unit);
      point.minValue = finiteOrNull(minValue);
      point.maxValue = finiteOrNull(maxValue);
      point.resolution = finiteOrNull(resolution);
      point.sourceMinValue = point.minValue;
      point.sourceMaxValue = point.maxValue;
      point.sourceResolution = point.resolution;
    }

    if (
      objectId.type === OBJECT_TYPE.MULTI_STATE_INPUT ||
      objectId.type === OBJECT_TYPE.MULTI_STATE_OUTPUT ||
      objectId.type === OBJECT_TYPE.MULTI_STATE_VALUE
    ) {
      let states = {};

      try {
        const stateResult = await this.readProp(device, objectId, PROP.STATE_TEXT);
        const values = allValues(stateResult);
        values.forEach((name, index) => {
          if (name !== undefined && name !== null && String(name) !== "") {
            states[String(index + 1)] = String(name);
          }
        });
      } catch {}

      if (!Object.keys(states).length) {
        const count = Number(await this.readOptional(device, objectId, PROP.NUMBER_OF_STATES));

        if (Number.isFinite(count) && count > 0 && count <= 1000) {
          for (let i = 1; i <= count; i++) {
            states[String(i)] = String(i);
          }
        }
      }

      point.states = states;
    }

    if (objectId.type === OBJECT_TYPE.SCHEDULE) {
      const [
        scheduleDefault,
        priorityForWriting,
        effectivePeriod,
        weeklySchedule,
        exceptionSchedule,
        objectPropertyReferences
      ] = await Promise.all([
        this.readOptionalPayload(
          device,
          objectId,
          PROP.SCHEDULE_DEFAULT
        ),
        this.readOptionalPayload(
          device,
          objectId,
          PROP.PRIORITY_FOR_WRITING
        ),
        this.readOptionalPayload(
          device,
          objectId,
          PROP.EFFECTIVE_PERIOD
        ),
        this.readOptionalPayload(
          device,
          objectId,
          PROP.WEEKLY_SCHEDULE
        ),
        this.readOptionalPayload(
          device,
          objectId,
          PROP.EXCEPTION_SCHEDULE
        ),
        this.readOptionalPayload(
          device,
          objectId,
          PROP.LIST_OF_OBJECT_PROPERTY_REFERENCES
        )
      ]);

      point.schedule = {
        scheduleDefault:
          scheduleDefault ?? null,

        priorityForWriting:
          priorityForWriting ?? null,

        effectivePeriod:
          effectivePeriod ?? null,

        weeklySchedule:
          weeklySchedule ?? null,

        exceptionSchedule:
          exceptionSchedule ?? null,

        objectPropertyReferences:
          objectPropertyReferences ?? null,

        dayTemplates:
          {}
      };

      point.schedule.dayTemplates =
        this.buildScheduleDayTemplates(
          point
        );

      this.log.info(
        `Schedule ${device.deviceId}/17/${objectId.instance} ` +
        `(${point.pointName}) discovered`
      );

      this.log.debug(
        `Schedule ${device.deviceId}/17/${objectId.instance}: ` +
        `default=${displayValue(scheduleDefault)}, ` +
        `priority=${displayValue(priorityForWriting)}`
      );
    }

    return point;
  }

  async discoverPoints(device) {
    const objectList = await this.readObjectList(device);

    const supported = objectList.filter(obj =>
      SUPPORTED_OBJECT_TYPES.has(Number(obj.type))
    );

    const skipped = objectList.filter(obj =>
      !SUPPORTED_OBJECT_TYPES.has(Number(obj.type))
    );

    const typeCounts = {};
    for (const obj of objectList) {
      const t = String(Number(obj.type));
      typeCounts[t] = (typeCounts[t] || 0) + 1;
    }

    this.log.info(
      `Device ${device.deviceId} (${device.deviceName}): ` +
      `Object_List=${objectList.length}, supported=${supported.length}, skipped=${skipped.length}`
    );

    this.log.debug(
      `Device ${device.deviceId}: object types ${JSON.stringify(typeCounts)}`
    );

    if (skipped.length) {
      const skippedTypes = {};
      for (const obj of skipped) {
        const t = String(Number(obj.type));
        skippedTypes[t] = (skippedTypes[t] || 0) + 1;
      }

      this.log.info(
        `Device ${device.deviceId}: unsupported object types skipped ${JSON.stringify(skippedTypes)}`
      );
    }

    const results = await mapLimit(
      supported,
      Number(this.options.read_concurrency),
      obj => this.discoverPoint(device, obj)
    );

    const points = [];
    let failures = 0;

    for (let i = 0; i < results.length; i++) {
      const result = results[i];

      if (result && !result.error) {
        points.push(result);
      } else {
        failures++;
        const obj = supported[i];

        this.log.warn(
          `Device ${device.deviceId}: point discovery failed for ` +
          `${obj?.type}/${obj?.instance}: ` +
          `${result?.error?.message || result?.error || "unknown error"}`
        );
      }
    }

    this.cache.points[String(device.deviceId)] = points;

    this.log.info(
      `Device ${device.deviceId}: ${points.length}/${supported.length} points discovered` +
      (failures ? ` (${failures} failed)` : "")
    );

    return points;
  }

  async scan() {
    if (this.scanRunning) {
      this.log.warn("BACnet scan already running");
      return;
    }

    this.scanRunning = true;
    this.scanCollector = new Map();

    try {
      this.log.info(`Starting BACnet scan (${this.options.scan_timeout}s)...`);
      this.bacnet.whoIs();

      await sleep(Number(this.options.scan_timeout) * 1000);

      const found = [...this.scanCollector.values()];
      this.log.info(`BACnet scan found ${found.length} devices`);

      for (const rawDevice of found) {
        try {
          if (this.uiSettings.isHidden(rawDevice.deviceId)) {
            this.log.debug(`Ignoring deleted device ${rawDevice.deviceId}`);
            continue;
          }
          const device = await this.enrichDevice(rawDevice);
          this.cache.devices[String(device.deviceId)] = device;

          await this.setDeviceOnline(device.deviceId, true, false);
          await this.discoverPoints(device);
        } catch (err) {
          this.log.warn(
            `Device ${rawDevice.deviceId} discovery failed:`,
            err?.message || err
          );
        }
      }

      await this.saveCache();
      await this.publishEffectiveDiscovery();

      if (this.options.cov_enabled) {
        await this.subscribeCovAll();
      }

      await this.fullReadAll();
    } finally {
      this.scanCollector = null;
      this.scanRunning = false;
    }
  }

  async rediscoverDevice(deviceId) {
    const key = String(deviceId);
    if (this.rediscovering.has(key)) return;

    const device = this.cache.devices[key];
    if (!device?.address) return;

    this.rediscovering.add(key);

    try {
      this.log.info(`Device ${deviceId} offline -> online: rediscovery`);
      const enriched = await this.enrichDevice(device);
      this.cache.devices[key] = enriched;

      await this.discoverPoints(enriched);
      await this.saveCache();
      await this.publishEffectiveDiscovery();

      if (this.options.cov_enabled) {
        await this.subscribeCovDevice(enriched);
      }

      await this.readDevice(enriched);
    } catch (err) {
      this.log.warn(
        `Rediscovery failed for device ${deviceId}:`,
        err?.message || err
      );
    } finally {
      this.rediscovering.delete(key);
    }
  }

  async setDeviceOnline(deviceId, online, allowRediscovery = true) {
    const key = String(deviceId);
    const hadPrevious = this.deviceOnline.has(key);
    const previous = this.deviceOnline.get(key);

    this.deviceOnline.set(key, !!online);
    await publishDeviceAvailability(this.mqtt, deviceId, !!online);

    if (
      allowRediscovery &&
      hadPrevious &&
      previous === false &&
      online === true
    ) {
      void this.rediscoverDevice(deviceId);
    }
  }

  pointsForDevice(deviceId) {
    return this.cache.points?.[String(deviceId)] || [];
  }

  scheduleDayKeys() {
    return [
      "monday",
      "tuesday",
      "wednesday",
      "thursday",
      "friday",
      "saturday",
      "sunday"
    ];
  }

  scheduleTimeText(timeEntry) {
    const rawValue =
      timeEntry?.value ??
      timeEntry ??
      null;

    let date = null;

    if (rawValue instanceof Date) {
      date = rawValue;
    } else if (typeof rawValue === "string") {
      const parsed = new Date(rawValue);
      if (!Number.isNaN(parsed.getTime())) {
        date = parsed;
      }
    }

    if (!date || Number.isNaN(date.getTime())) {
      return "00:00";
    }

    // BACnet TIME has no timezone. The library represents it as a Date.
    // getHours()/getMinutes() intentionally use the app's local timezone,
    // which restores the original controller-local 08:00 from an ISO
    // representation such as 07:00Z.
    const hh =
      String(date.getHours()).padStart(2, "0");

    const mm =
      String(date.getMinutes()).padStart(2, "0");

    const ss =
      Number(date.getSeconds());

    return ss
      ? `${hh}:${mm}:${String(ss).padStart(2, "0")}`
      : `${hh}:${mm}`;
  }

  scheduleReference(point) {
    const refs =
      point.schedule?.objectPropertyReferences;

    const first =
      Array.isArray(refs)
        ? refs[0]
        : refs;

    if (!first || typeof first !== "object") {
      return null;
    }

    const objectId =
      first.objectId ??
      first.objectIdentifier ??
      first.object ??
      null;

    if (!objectId) {
      return null;
    }

    const type =
      Number(
        objectId.objectType ??
        objectId.type
      );

    const instance =
      Number(objectId.instance);

    if (
      !Number.isFinite(type) ||
      !Number.isFinite(instance)
    ) {
      return null;
    }

    return {
      type,
      instance
    };
  }

  scheduleTargetPoint(point) {
    const ref =
      this.scheduleReference(point);

    if (!ref) {
      return null;
    }

    return this.findPoint(
      point.deviceId,
      ref.type,
      ref.instance
    );
  }

  scheduleConfig(point) {
    const target =
      this.scheduleTargetPoint(point);

    const override =
      point?.scheduleUiOverride &&
      typeof point.scheduleUiOverride === "object"
        ? point.scheduleUiOverride
        : this.uiSettings.pointOverride(
            point.deviceId,
            point.bacType,
            point.bacInstance
          )?.schedule || {};

    let mode = "binary";
    let valueType = "enumerated";
    let unit = "";
    let min = null;
    let max = null;
    let step = null;
    let states = [];

    if (target) {
      const targetType =
        Number(target.bacType);

      if (
        targetType === OBJECT_TYPE.ANALOG_INPUT ||
        targetType === OBJECT_TYPE.ANALOG_OUTPUT ||
        targetType === OBJECT_TYPE.ANALOG_VALUE
      ) {
        mode = "number";
        valueType = "real";
        unit = target.unitName || "";
        min = cleanUiNumber(target.minValue);
        max = cleanUiNumber(target.maxValue);
        step = cleanUiNumber(target.resolution);
      } else if (
        targetType === OBJECT_TYPE.MULTI_STATE_INPUT ||
        targetType === OBJECT_TYPE.MULTI_STATE_OUTPUT ||
        targetType === OBJECT_TYPE.MULTI_STATE_VALUE
      ) {
        mode = "states";
        valueType = "unsigned";
        states = Object.entries(target.states || {})
          .sort((a, b) => Number(a[0]) - Number(b[0]))
          .map(([value, label]) => ({
            label: String(label),
            value: String(value)
          }));
      }
    }

    const config = {
      mode,
      valueType,
      onText: "ON",
      onValue: "1",
      offText: "OFF",
      offValue: "0",
      nullText: "Empty",
      unit,
      min,
      max,
      step,
      states
    };

    for (const key of [
      "mode",
      "valueType",
      "onText",
      "onValue",
      "offText",
      "offValue",
      "nullText",
      "unit",
      "min",
      "max",
      "step"
    ]) {
      if (override[key] !== undefined) {
        config[key] = override[key];
      }
    }

    if (Array.isArray(override.states)) {
      config.states = override.states
        .map(item => ({
          label: String(item?.label ?? "").trim(),
          value: String(item?.value ?? "").trim()
        }))
        .filter(item => item.label && item.value !== "");
    }

    return config;
  }

  scheduleDisplayValue(point, rawValue) {
    if (rawValue === null || rawValue === undefined) {
      return this.scheduleConfig(point).nullText || "Empty";
    }

    const config = this.scheduleConfig(point);
    const raw = typeof rawValue === "boolean"
      ? (rawValue ? "1" : "0")
      : String(rawValue);

    if (config.mode === "binary") {
      if (raw === String(config.onValue)) return config.onText || "ON";
      if (raw === String(config.offValue)) return config.offText || "OFF";
    }

    if (config.mode === "states") {
      const option = (config.states || []).find(
        item => String(item.value) === raw
      );
      if (option) return option.label;
    }

    return config.unit
      ? `${raw} ${config.unit}`
      : raw;
  }

  scheduleRawValue(valueEntry) {
    const value =
      valueEntry?.value ??
      valueEntry;

    if (value === null || value === undefined) {
      return null;
    }

    if (typeof value === "boolean") {
      return value ? "1" : "0";
    }

    return String(value);
  }

  encodeScheduleConfiguredValue(config, rawText) {
    const type = String(config?.valueType || "auto").toLowerCase();
    const text = String(rawText ?? "").trim();

    if (type === "auto") return null;

    if (type === "boolean") {
      const upper = text.toUpperCase();
      let value;
      if (["1", "ON", "TRUE", "ACTIVE"].includes(upper)) value = true;
      else if (["0", "OFF", "FALSE", "INACTIVE"].includes(upper)) value = false;
      else throw new Error(`Invalid Boolean Schedule value "${text}"`);
      return { type: ApplicationTag.BOOLEAN ?? 1, value };
    }

    if (type === "real") {
      const value = Number(text);
      if (!Number.isFinite(value)) throw new Error(`Invalid REAL Schedule value "${text}"`);
      return { type: ApplicationTag.REAL, value };
    }

    if (type === "unsigned") {
      const value = Number(text);
      if (!Number.isInteger(value) || value < 0) {
        throw new Error(`Invalid UNSIGNED Schedule value "${text}"`);
      }
      return { type: ApplicationTag.UNSIGNED_INTEGER, value };
    }

    if (type === "signed") {
      const value = Number(text);
      if (!Number.isInteger(value)) {
        throw new Error(`Invalid SIGNED Schedule value "${text}"`);
      }
      return { type: ApplicationTag.SIGNED_INTEGER ?? ApplicationTag.SIGNED_INT ?? 3, value };
    }

    if (type === "enumerated") {
      const value = Number(text);
      if (!Number.isInteger(value) || value < 0) {
        throw new Error(`Invalid ENUMERATED Schedule value "${text}"`);
      }
      return { type: ApplicationTag.ENUMERATED, value };
    }

    return null;
  }

  scheduleValueText(point, valueEntry) {
    const raw =
      this.scheduleRawValue(valueEntry);

    return raw === null
      ? "NULL"
      : raw;
  }

  buildScheduleDayTemplates(point) {
    const weekly =
      Array.isArray(point.schedule?.weeklySchedule)
        ? point.schedule.weeklySchedule
        : [];

    const result = {};

    this.scheduleDayKeys()
      .forEach((dayKey, dayIndex) => {
        const day =
          Array.isArray(weekly[dayIndex])
            ? weekly[dayIndex]
            : [];

        result[dayKey] =
          day
            .map(entry => {
              const time =
                this.scheduleTimeText(
                  entry?.time
                );

              const value =
                this.scheduleValueText(
                  point,
                  entry?.value
                );

              return `${time}=${value}`;
            })
            .join(";");
      });

    return result;
  }

  scheduleValueFromText(point, text) {
    const upper =
      String(text ?? "")
        .trim()
        .toUpperCase();

    if (upper === "NULL") {
      return {
        type: ApplicationTag.NULL,
        value: null
      };
    }

    const config =
      this.scheduleConfig(point);

    let configuredText =
      String(text ?? "").trim();

    if (config.mode === "binary") {
      if (upper === String(config.onText || "ON").toUpperCase()) {
        configuredText = String(config.onValue);
      } else if (upper === String(config.offText || "OFF").toUpperCase()) {
        configuredText = String(config.offValue);
      }
    } else if (config.mode === "states") {
      const option = (config.states || []).find(item =>
        String(item.label).toUpperCase() === upper ||
        String(item.value) === String(text).trim()
      );
      if (option) configuredText = String(option.value);
    }

    const configured =
      this.encodeScheduleConfiguredValue(
        config,
        configuredText
      );

    if (configured) {
      return configured;
    }

    // Preserve the configured raw binary values even when valueType is Auto.
    if (config.mode === "binary") {
      const binaryUpper = String(configuredText).toUpperCase();
      if (
        String(configuredText) === String(config.onValue) ||
        binaryUpper === "ON" ||
        binaryUpper === "1" ||
        binaryUpper === "TRUE"
      ) {
        return { type: ApplicationTag.ENUMERATED, value: Number(config.onValue) };
      }
      if (
        String(configuredText) === String(config.offValue) ||
        binaryUpper === "OFF" ||
        binaryUpper === "0" ||
        binaryUpper === "FALSE"
      ) {
        return { type: ApplicationTag.ENUMERATED, value: Number(config.offValue) };
      }
    }

    const target =
      this.scheduleTargetPoint(point);

    if (target) {
      const type =
        Number(target.bacType);

      if (
        type === OBJECT_TYPE.BINARY_OUTPUT ||
        type === OBJECT_TYPE.BINARY_VALUE ||
        type === OBJECT_TYPE.BINARY_INPUT
      ) {
        if (
          ["ON", "1", "TRUE", "ACTIVE"].includes(upper)
        ) {
          return {
            type: ApplicationTag.ENUMERATED,
            value: 1
          };
        }

        if (
          ["OFF", "0", "FALSE", "INACTIVE"].includes(upper)
        ) {
          return {
            type: ApplicationTag.ENUMERATED,
            value: 0
          };
        }

        throw new Error(
          `Invalid binary schedule value "${text}". Use ON/OFF or 0/1.`
        );
      }

      if (
        type === OBJECT_TYPE.MULTI_STATE_OUTPUT ||
        type === OBJECT_TYPE.MULTI_STATE_VALUE ||
        type === OBJECT_TYPE.MULTI_STATE_INPUT
      ) {
        let value = null;

        for (
          const [index, name]
          of Object.entries(target.states || {})
        ) {
          if (
            String(name).toUpperCase() === upper ||
            String(index) === String(text).trim()
          ) {
            value = Number(index);
            break;
          }
        }

        if (
          value === null &&
          Number.isInteger(Number(text)) &&
          Number(text) >= 1
        ) {
          value = Number(text);
        }

        if (!Number.isInteger(value)) {
          throw new Error(
            `Invalid multi-state schedule value "${text}"`
          );
        }

        return {
          type: ApplicationTag.UNSIGNED_INTEGER,
          value
        };
      }

      if (
        type === OBJECT_TYPE.ANALOG_OUTPUT ||
        type === OBJECT_TYPE.ANALOG_VALUE ||
        type === OBJECT_TYPE.ANALOG_INPUT
      ) {
        const value = Number(text);

        if (!Number.isFinite(value)) {
          throw new Error(
            `Invalid analog schedule value "${text}"`
          );
        }

        return {
          type: ApplicationTag.REAL,
          value
        };
      }
    }

    // No referenced point was resolved. Reuse the datatype already used
    // by this Schedule when possible.
    const existingWeekly =
      Array.isArray(point.schedule?.weeklySchedule)
        ? point.schedule.weeklySchedule
        : [];

    let existingType = null;

    for (const day of existingWeekly) {
      if (!Array.isArray(day)) continue;

      for (const event of day) {
        const t =
          Number(event?.value?.type);

        if (Number.isFinite(t)) {
          existingType = t;
          break;
        }
      }

      if (existingType !== null) {
        break;
      }
    }

    if (existingType === ApplicationTag.ENUMERATED) {
      const value = Number(text);
      if (!Number.isInteger(value)) {
        throw new Error(
          `Schedule expects an enumerated value; "${text}" is invalid`
        );
      }

      return {
        type: ApplicationTag.ENUMERATED,
        value
      };
    }

    const numeric = Number(text);

    if (Number.isFinite(numeric)) {
      return {
        type:
          existingType ??
          ApplicationTag.REAL,

        value:
          numeric
      };
    }

    throw new Error(
      `Cannot determine BACnet datatype for Schedule value "${text}"`
    );
  }

  parseScheduleDay(point, payload) {
    const text =
      String(payload ?? "")
        .trim();

    if (
      text === "" ||
      text === "-" ||
      text.toUpperCase() === "EMPTY"
    ) {
      return [];
    }

    const parts =
      text
        .split(";")
        .map(v => v.trim())
        .filter(Boolean);

    const events = [];

    for (const part of parts) {
      const match =
        part.match(
          /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*=\s*(.+)$/
        );

      if (!match) {
        throw new Error(
          `Invalid Schedule entry "${part}". Format: 08:00=ON;16:00=OFF`
        );
      }

      const hour =
        Number(match[1]);

      const minute =
        Number(match[2]);

      const second =
        Number(match[3] || 0);

      if (
        hour < 0 ||
        hour > 23 ||
        minute < 0 ||
        minute > 59 ||
        second < 0 ||
        second > 59
      ) {
        throw new Error(
          `Invalid Schedule time "${match[1]}:${match[2]}"`
        );
      }

      const value =
        this.scheduleValueFromText(
          point,
          match[4].trim()
        );

      // Construct the BACnet TIME in local time. This matches the
      // library's Schedule decode representation and avoids the UTC
      // one-hour/two-hour display shift.
      const time =
        new Date(
          1900,
          0,
          1,
          hour,
          minute,
          second,
          0
        );

      events.push({
        time: {
          type:
            ApplicationTag.TIME,

          value:
            time
        },

        value
      });
    }

    events.sort((a, b) =>
      a.time.value.getTime() -
      b.time.value.getTime()
    );

    return events;
  }

  scheduleDayAliases() {
    return {
      monday: "monday",
      mon: "monday",

      tuesday: "tuesday",
      tue: "tuesday",
      tues: "tuesday",

      wednesday: "wednesday",
      wed: "wednesday",

      thursday: "thursday",
      thu: "thursday",
      thur: "thursday",
      thurs: "thursday",

      friday: "friday",
      fri: "friday",

      saturday: "saturday",
      sat: "saturday",

      sunday: "sunday",
      sun: "sunday"
    };
  }

  normalizeScheduleDayName(text) {
    const key =
      String(text ?? "")
        .trim()
        .toLowerCase();

    return (
      this.scheduleDayAliases()[key] ??
      null
    );
  }

  parseScheduleWeek(point, payload) {
    const text =
      String(payload ?? "")
        .trim();

    if (!text) {
      throw new Error(
        "Weekly Schedule cannot be empty. " +
        "Use e.g. Monday:- | Tuesday:- | ... to clear days."
      );
    }

    const parts =
      text
        .split("|")
        .map(v => v.trim())
        .filter(Boolean);

    const updates = {};

    for (const part of parts) {
      const colon =
        part.indexOf(":");

      if (colon < 1) {
        throw new Error(
          `Invalid weekly Schedule section "${part}". ` +
          `Expected: Monday:08:00=ON;16:00=OFF`
        );
      }

      const dayLabel =
        part.slice(0, colon).trim();

      const valueText =
        part.slice(colon + 1).trim();

      const dayKey =
        this.normalizeScheduleDayName(
          dayLabel
        );

      if (!dayKey) {
        throw new Error(
          `Unknown Schedule day "${dayLabel}"`
        );
      }

      updates[dayKey] =
        this.parseScheduleDay(
          point,
          valueText
        );
    }

    if (!Object.keys(updates).length) {
      throw new Error(
        "No valid weekdays found in weekly Schedule"
      );
    }

    return updates;
  }

  async writeScheduleWeek(
    deviceId,
    scheduleInstance,
    payload
  ) {
    const device =
      this.cache.devices?.[
        String(deviceId)
      ];

    const point =
      this.findPoint(
        deviceId,
        OBJECT_TYPE.SCHEDULE,
        scheduleInstance
      );

    if (!device || !point) {
      throw new Error(
        `Schedule ${deviceId}/17/${scheduleInstance} not found`
      );
    }

    const objectId = {
      type:
        OBJECT_TYPE.SCHEDULE,

      instance:
        Number(scheduleInstance)
    };

    // Always read the latest program first. This prevents the app from
    // overwriting a BACnet schedule that another workstation changed
    // after our last cached read.
    const freshWeekly =
      await this.readOptionalPayload(
        device,
        objectId,
        PROP.WEEKLY_SCHEDULE
      );

    const weeklySource =
      Array.isArray(freshWeekly)
        ? freshWeekly
        : Array.isArray(
            point.schedule?.weeklySchedule
          )
          ? point.schedule.weeklySchedule
          : [];

    // @bacnet-js/client expects BACNetWeeklySchedulePayload directly:
    // an array containing EXACTLY seven Daily_Schedule arrays
    // (Monday through Sunday). Never pass the custom WEEKLY_SCHEDULE
    // application-tag wrapper to writeProperty().
    const weekly =
      Array.from(
        { length: 7 },
        (_, index) =>
          Array.isArray(weeklySource[index])
            ? weeklySource[index]
            : []
      );

    const updates =
      this.parseScheduleWeek(
        point,
        payload
      );

    const dayKeys =
      this.scheduleDayKeys();

    for (
      const [dayKey, dayEvents]
      of Object.entries(updates)
    ) {
      const dayIndex =
        dayKeys.indexOf(dayKey);

      if (dayIndex >= 0) {
        weekly[dayIndex] =
          dayEvents;
      }
    }

    this.log.info(
      `Schedule weekly write ${deviceId}/17/${scheduleInstance}: "${payload}"`
    );

    this.log.debug(
      `Weekly_Schedule encode ${deviceId}/17/${scheduleInstance}: ` +
      `days=${weekly.length}, events=[${weekly.map(day => day.length).join(",")}]`
    );

    // IMPORTANT:
    // BACNetWritePropertyValues is a union. For Weekly_Schedule the
    // library expects BACNetWeeklySchedulePayload DIRECTLY, not
    // [{type: ApplicationTag.WEEKLY_SCHEDULE, value: weekly}].
    //
    // The old wrapper made the encoder see an outer array with length 1,
    // causing:
    // "Could not encode: weekly schedule should have exactly 7 days".
    await this.bacnet.writeProperty(
      device.address,
      objectId,
      PROP.WEEKLY_SCHEDULE,
      weekly,
      this.serviceOptions(
        device,
        {}
      )
    );

    await sleep(250);

    await this.refreshScheduleProperties(
      device,
      point
    );

    const readback =
      point.schedule?.dayTemplates ?? {};

    this.log.info(
      `Schedule weekly confirmed ${deviceId}/17/${scheduleInstance}: ` +
      JSON.stringify(readback)
    );

    await this.publishEffectivePointState(
      point,
      point.value
    );

    await this.saveCache();
  }

  async writeScheduleDay(
    deviceId,
    scheduleInstance,
    dayKey,
    payload
  ) {
    const device =
      this.cache.devices?.[
        String(deviceId)
      ];

    const point =
      this.findPoint(
        deviceId,
        OBJECT_TYPE.SCHEDULE,
        scheduleInstance
      );

    if (!device || !point) {
      throw new Error(
        `Schedule ${deviceId}/17/${scheduleInstance} not found`
      );
    }

    const dayIndex =
      this.scheduleDayKeys()
        .indexOf(dayKey);

    if (dayIndex < 0) {
      throw new Error(
        `Unknown Schedule day "${dayKey}"`
      );
    }

    // Read a fresh Weekly_Schedule first so editing one day never
    // overwrites changes made elsewhere to the other six days.
    const objectId = {
      type:
        OBJECT_TYPE.SCHEDULE,

      instance:
        Number(scheduleInstance)
    };

    const freshWeekly =
      await this.readOptionalPayload(
        device,
        objectId,
        PROP.WEEKLY_SCHEDULE
      );

    const weeklySource =
      Array.isArray(freshWeekly)
        ? freshWeekly
        : Array.isArray(point.schedule?.weeklySchedule)
          ? point.schedule.weeklySchedule
          : [];

    const weekly =
      Array.from(
        { length: 7 },
        (_, index) =>
          Array.isArray(weeklySource[index])
            ? weeklySource[index]
            : []
      );

    const newDay =
      this.parseScheduleDay(
        point,
        payload
      );

    weekly[dayIndex] =
      newDay;

    this.log.info(
      `Schedule write ${deviceId}/17/${scheduleInstance} ` +
      `${dayKey}: "${payload}"`
    );

    this.log.debug(
      `Weekly_Schedule encode ${deviceId}/17/${scheduleInstance}: ` +
      `days=${weekly.length}, events=[${weekly.map(day => day.length).join(",")}]`
    );

    await this.bacnet.writeProperty(
      device.address,
      objectId,
      PROP.WEEKLY_SCHEDULE,
      weekly,
      this.serviceOptions(
        device,
        {}
      )
    );

    // Read back and publish the actual program.
    await sleep(250);

    await this.refreshScheduleProperties(
      device,
      point
    );

    point.schedule.dayTemplates =
      this.buildScheduleDayTemplates(
        point
      );

    const readback =
      point.schedule.dayTemplates?.[
        dayKey
      ] ?? "";

    this.log.info(
      `Schedule confirmed ${deviceId}/17/${scheduleInstance} ` +
      `${dayKey}: "${readback}"`
    );

    await this.publishEffectivePointState(
      point,
      point.value
    );

    await this.saveCache();
  }

  async refreshScheduleProperties(device, point) {
    if (Number(point.bacType) !== OBJECT_TYPE.SCHEDULE) {
      return;
    }

    const objectId = {
      type: OBJECT_TYPE.SCHEDULE,
      instance: Number(point.bacInstance)
    };

    const [
      scheduleDefault,
      priorityForWriting,
      effectivePeriod,
      weeklySchedule,
      exceptionSchedule,
      objectPropertyReferences
    ] = await Promise.all([
      this.readOptionalPayload(
        device,
        objectId,
        PROP.SCHEDULE_DEFAULT
      ),
      this.readOptionalPayload(
        device,
        objectId,
        PROP.PRIORITY_FOR_WRITING
      ),
      this.readOptionalPayload(
        device,
        objectId,
        PROP.EFFECTIVE_PERIOD
      ),
      this.readOptionalPayload(
        device,
        objectId,
        PROP.WEEKLY_SCHEDULE
      ),
      this.readOptionalPayload(
        device,
        objectId,
        PROP.EXCEPTION_SCHEDULE
      ),
      this.readOptionalPayload(
        device,
        objectId,
        PROP.LIST_OF_OBJECT_PROPERTY_REFERENCES
      )
    ]);

    point.schedule = {
      scheduleDefault:
        scheduleDefault ?? point.schedule?.scheduleDefault ?? null,

      priorityForWriting:
        priorityForWriting ?? point.schedule?.priorityForWriting ?? null,

      effectivePeriod:
        effectivePeriod ?? point.schedule?.effectivePeriod ?? null,

      weeklySchedule:
        weeklySchedule ?? point.schedule?.weeklySchedule ?? null,

      exceptionSchedule:
        exceptionSchedule ?? point.schedule?.exceptionSchedule ?? null,

      objectPropertyReferences:
        objectPropertyReferences ??
        point.schedule?.objectPropertyReferences ??
        null,

      dayTemplates:
        point.schedule?.dayTemplates ??
        {}
    };

    point.schedule.dayTemplates =
      this.buildScheduleDayTemplates(
        point
      );
  }

  async readPoint(device, point, publish = true) {
    const value = await this.readScalar(
      device,
      { type: Number(point.bacType), instance: Number(point.bacInstance) },
      PROP.PRESENT_VALUE
    );

    point.value = value;

    if (Number(point.bacType) === OBJECT_TYPE.SCHEDULE) {
      await this.refreshScheduleProperties(device, point);
    }

    if (publish) {
      await this.publishEffectivePointState(point, value);
    }

    return value;
  }

  async readDevice(device) {
    const points = this.pointsForDevice(device.deviceId);
    if (!points.length) return;

    const results = await mapLimit(
      points,
      Number(this.options.read_concurrency),
      point => this.readPoint(device, point, true)
    );

    const success = results.some(r => !(r && r.error));

    if (success) {
      await this.setDeviceOnline(device.deviceId, true);
    } else {
      await this.setDeviceOnline(device.deviceId, false);
    }
  }

  async fullReadAll() {
    if (this.pollRunning) return;
    this.pollRunning = true;

    try {
      const devices = Object.values(this.cache.devices || {});
      for (const device of devices) {
        try {
          await this.readDevice(device);
        } catch (err) {
          this.log.debug(
            `Read device ${device.deviceId} failed:`,
            err?.message || err
          );
          await this.setDeviceOnline(device.deviceId, false);
        }
      }

      await this.saveCache();
    } finally {
      this.pollRunning = false;
    }
  }

  healthProbePoints(points) {
    const preferred = [
      OBJECT_TYPE.ANALOG_INPUT,
      OBJECT_TYPE.BINARY_INPUT,
      OBJECT_TYPE.MULTI_STATE_INPUT,
      OBJECT_TYPE.ANALOG_VALUE,
      OBJECT_TYPE.BINARY_VALUE,
      OBJECT_TYPE.MULTI_STATE_VALUE,
      OBJECT_TYPE.ANALOG_OUTPUT,
      OBJECT_TYPE.BINARY_OUTPUT,
      OBJECT_TYPE.MULTI_STATE_OUTPUT
    ];

    const selected = [];

    for (const type of preferred) {
      const p = points.find(x => Number(x.bacType) === type);
      if (p && !selected.includes(p)) selected.push(p);
      if (selected.length >= 3) break;
    }

    for (const p of points) {
      if (selected.length >= 3) break;
      if (!selected.includes(p)) selected.push(p);
    }

    return selected;
  }

  async checkDevice(device) {
    const points = this.pointsForDevice(device.deviceId);
    const probes = this.healthProbePoints(points);

    if (!probes.length) {
      try {
        await this.readScalar(
          device,
          { type: OBJECT_TYPE.DEVICE, instance: device.deviceId },
          PROP.OBJECT_NAME
        );
        return true;
      } catch {
        return false;
      }
    }

    for (const point of probes) {
      try {
        const value = await this.readPoint(device, point, true);
        if (value !== undefined) return true;
      } catch {}
    }

    return false;
  }

  async restartRequiredState() {
    try {
      const parsed = JSON.parse(
        await fs.readFile(
          RESTART_REQUIRED_FILE,
          "utf8"
        )
      );
      return parsed?.required === true;
    } catch (err) {
      if (err?.code !== "ENOENT") {
        this.log.debug(
          "Restart-required state read failed:",
          err?.message || err
        );
      }
      return false;
    }
  }

  async publishRestartUpdateState(inProgress = false) {
    const required =
      await this.restartRequiredState();

    await publishRestartUpdateState(
      this.mqtt,
      required,
      inProgress
    );
  }

  async restartHomeAssistantFromUpdate() {
    const token =
      process.env.SUPERVISOR_TOKEN;

    if (!token) {
      throw new Error(
        "SUPERVISOR_TOKEN is unavailable"
      );
    }

    const previous =
      await this.restartRequiredState();

    await this.publishRestartUpdateState(true);

    try {
      await fs.unlink(RESTART_REQUIRED_FILE).catch(err => {
        if (err?.code !== "ENOENT") throw err;
      });

      const response = await fetch(
        "http://supervisor/core/restart",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json"
          },
          body: "{}"
        }
      );

      if (!response.ok) {
        throw new Error(
          `Supervisor core restart failed: ${response.status} ${await response.text()}`
        );
      }

      await publishRestartUpdateState(
        this.mqtt,
        false,
        true
      );
    } catch (err) {
      if (previous) {
        await fs.writeFile(
          RESTART_REQUIRED_FILE,
          JSON.stringify({
            required: true,
            appVersion: VERSION,
            reason: "BACnet2MQTT frontend update requires Home Assistant restart",
            createdAt: new Date().toISOString()
          }, null, 2) + "\\n",
          "utf8"
        );
      }
      await this.publishRestartUpdateState(false);
      throw err;
    }
  }

  async healthCheck() {
    if (this.healthRunning) return;
    this.healthRunning = true;

    try {
      for (const device of Object.values(this.cache.devices || {})) {
        const online = await this.checkDevice(device);
        await this.setDeviceOnline(device.deviceId, online);
      }
      await this.publishRestartUpdateState().catch(err => {
        this.log.debug(
          "Restart update state publish failed:",
          err?.message || err
        );
      });
    } finally {
      this.healthRunning = false;
    }
  }

  findPoint(deviceId, type, instance) {
    return this.pointsForDevice(deviceId).find(p =>
      Number(p.bacType) === Number(type) &&
      Number(p.bacInstance) === Number(instance)
    );
  }

  async readPrioritySlot(device, point, priority) {
    try {
      return await this.readScalar(
        device,
        {
          type: Number(point.bacType),
          instance: Number(point.bacInstance)
        },
        PROP.PRIORITY_ARRAY,
        { arrayIndex: Number(priority) }
      );
    } catch {
      return undefined;
    }
  }

  valuesMatch(type, actual, expected) {
    if (
      type === OBJECT_TYPE.ANALOG_OUTPUT ||
      type === OBJECT_TYPE.ANALOG_VALUE
    ) {
      return (
        Number.isFinite(Number(actual)) &&
        Number.isFinite(Number(expected)) &&
        Math.abs(Number(actual) - Number(expected)) <= 0.05
      );
    }

    return Number(actual) === Number(expected);
  }

  parseWriteValue(point, payload) {
    const text = String(payload ?? "").trim();
    const upper = text.toUpperCase();

    if (upper === "RELEASE" || upper === "NULL") {
      return {
        released: true,
        rawValue: null,
        values: [{ type: ApplicationTag.NULL, value: null }]
      };
    }

    const type = Number(point.bacType);

    if (
      type === OBJECT_TYPE.BINARY_OUTPUT ||
      type === OBJECT_TYPE.BINARY_VALUE
    ) {
      let value;

      if (["ON", "1", "TRUE", "ACTIVE"].includes(upper)) value = 1;
      else if (["OFF", "0", "FALSE", "INACTIVE"].includes(upper)) value = 0;
      else throw new Error(`Invalid binary value "${text}"`);

      return {
        released: false,
        rawValue: value,
        values: [{ type: ApplicationTag.ENUMERATED, value }]
      };
    }

    if (
      type === OBJECT_TYPE.ANALOG_OUTPUT ||
      type === OBJECT_TYPE.ANALOG_VALUE
    ) {
      const value = Number(text);
      if (!Number.isFinite(value)) {
        throw new Error(`Invalid analog value "${text}"`);
      }

      return {
        released: false,
        rawValue: value,
        values: [{ type: ApplicationTag.REAL, value }]
      };
    }

    if (
      type === OBJECT_TYPE.MULTI_STATE_OUTPUT ||
      type === OBJECT_TYPE.MULTI_STATE_VALUE
    ) {
      let value = null;

      for (const [index, name] of Object.entries(point.states || {})) {
        if (
          String(name) === text ||
          String(name).toUpperCase() === upper ||
          String(index) === text
        ) {
          value = Number(index);
          break;
        }
      }

      if (value === null && Number.isInteger(Number(text)) && Number(text) >= 1) {
        value = Number(text);
      }

      if (!Number.isInteger(value) || value < 1) {
        throw new Error(`Invalid multi-state value "${text}"`);
      }

      return {
        released: false,
        rawValue: value,
        values: [{ type: ApplicationTag.UNSIGNED_INTEGER, value }]
      };
    }

    throw new Error(`BACnet type ${type} is not writable`);
  }

  async handleWriteTopic(topic, payload) {
    const parts = String(topic).split("/");
    if (parts.length !== 5 || parts[4] !== "set") return;

    const deviceId = Number(parts[1]);
    const type = Number(parts[2]);
    const instance = Number(parts[3]);

    const point = this.findPoint(deviceId, type, instance);
    const device = this.cache.devices?.[String(deviceId)];

    if (!device || !point) {
      throw new Error(`Point ${deviceId}/${type}/${instance} not found`);
    }

    if (point.writable !== true) {
      throw new Error(`Point ${deviceId}/${type}/${instance} is read-only`);
    }

    const command = this.parseWriteValue(point, payload);
    const priority = Number(this.options.write_priority);

    await this.bacnet.writeProperty(
      device.address,
      { type, instance },
      PROP.PRESENT_VALUE,
      command.values,
      this.serviceOptions(device, { priority })
    );

    this.log.info(
      `Write ACK ${deviceId}/${type}/${instance} P${priority}: ` +
      `${command.released ? "RELEASE" : command.rawValue}`
    );

    // Check whether the command actually landed in the requested
    // Priority_Array slot. A WriteProperty ACK only means the device
    // accepted the request; it does not guarantee that Present_Value
    // will be controlled by that priority if a higher priority is active.
    await sleep(150);

    const prioritySlot = await this.readPrioritySlot(
      device,
      point,
      priority
    );

    this.log.info(
      `Write verify ${deviceId}/${type}/${instance}: ` +
      `P${priority} slot=${displayValue(prioritySlot)}`
    );

    await sleep(350);

    const maxAttempts = 8;
    let lastActual = undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const actual = await this.readPoint(device, point, true);
        lastActual = actual;

        await this.setDeviceOnline(deviceId, true);

        this.log.debug(
          `Write readback ${deviceId}/${type}/${instance} ` +
          `attempt ${attempt}/${maxAttempts}: actual=${displayValue(actual)}`
        );

        if (command.released) {
          // A release is confirmed by an empty/NULL Priority_Array slot,
          // not by a specific Present_Value (which may be controlled by a
          // different priority or Relinquish_Default).
          const slotNow = await this.readPrioritySlot(
            device,
            point,
            priority
          );

          if (slotNow === null) {
            this.log.info(
              `Release confirmed ${deviceId}/${type}/${instance} P${priority}`
            );
            return;
          }

          // Some stacks represent BACnet NULL as undefined when decoding
          // an array element. If the property itself cannot be read, keep
          // retrying instead of claiming success.
          if (slotNow === undefined) {
            this.log.debug(
              `Release verify ${deviceId}/${type}/${instance}: Priority_Array unavailable`
            );
          } else {
            this.log.debug(
              `Release verify ${deviceId}/${type}/${instance}: ` +
              `P${priority} slot=${displayValue(slotNow)}`
            );
          }
        } else if (this.valuesMatch(type, actual, command.rawValue)) {
          this.log.info(
            `Write confirmed ${deviceId}/${type}/${instance}: ${displayValue(actual)}`
          );
          return;
        }
      } catch (err) {
        this.log.debug(
          `Write readback error ${deviceId}/${type}/${instance} ` +
          `attempt ${attempt}/${maxAttempts}: ${err?.message || err}`
        );
      }

      if (attempt < maxAttempts) {
        await sleep(500);
      }
    }

    // Give a useful BACnet-priority diagnosis instead of only saying
    // "readback timeout".
    if (!command.released) {
      const slotMatches =
        prioritySlot !== undefined &&
        prioritySlot !== null &&
        this.valuesMatch(type, prioritySlot, command.rawValue);

      if (slotMatches) {
        throw new Error(
          `Write accepted at P${priority}, but Present_Value stayed ` +
          `${displayValue(lastActual)} instead of ${displayValue(command.rawValue)}. ` +
          `A higher BACnet priority is probably active.`
        );
      }

      throw new Error(
        `Write readback timeout ${deviceId}/${type}/${instance}: ` +
        `expected=${displayValue(command.rawValue)}, ` +
        `actual=${displayValue(lastActual)}, ` +
        `P${priority} slot=${displayValue(prioritySlot)}`
      );
    }

    throw new Error(
      `Release verification timeout ${deviceId}/${type}/${instance} P${priority}`
    );
  }

  covIdFor(point) {
    let id = fnv1a32(`${point.deviceId}/${point.bacType}/${point.bacInstance}`);

    while (
      this.covSubscriptions.has(id) &&
      this.covSubscriptions.get(id).key !==
        pointKey(point.deviceId, point.bacType, point.bacInstance)
    ) {
      id = (id + 1) >>> 0;
      if (id === 0) id = 1;
    }

    return id;
  }

  async subscribeCovPoint(device, point) {
    const id = this.covIdFor(point);

    await this.bacnet.subscribeCov(
      device.address,
      { type: Number(point.bacType), instance: Number(point.bacInstance) },
      id,
      false,
      false,
      Number(this.options.cov_lifetime),
      {}
    );

    this.covSubscriptions.set(id, {
      key: pointKey(point.deviceId, point.bacType, point.bacInstance),
      deviceId: Number(point.deviceId),
      bacType: Number(point.bacType),
      bacInstance: Number(point.bacInstance)
    });

    return id;
  }

  async subscribeCovDevice(device) {
    if (!this.options.cov_enabled) return;

    const points =
      this.pointsForDevice(device.deviceId)
        .filter(point =>
          Number(point.bacType) !== OBJECT_TYPE.SCHEDULE
        );

    const skippedSchedules =
      this.pointsForDevice(device.deviceId)
        .filter(point =>
          Number(point.bacType) === OBJECT_TYPE.SCHEDULE
        )
        .length;

    let ok = 0;
    let failed = 0;

    for (const point of points) {
      try {
        await this.subscribeCovPoint(device, point);
        ok++;
      } catch (err) {
        failed++;
        this.log.debug(
          `COV not available ${device.deviceId}/${point.bacType}/${point.bacInstance}:`,
          err?.message || err
        );
      }

      const delay = Number(this.options.cov_subscribe_delay_ms);
      if (delay > 0) await sleep(delay);
    }

    this.log.info(
      `COV device ${device.deviceId}: ${ok} subscribed, ${failed} failed` +
      (skippedSchedules
        ? `, ${skippedSchedules} Schedule object(s) use polling`
        : "")
    );
  }

  async subscribeCovAll() {
    this.covSubscriptions.clear();

    for (const device of Object.values(this.cache.devices || {})) {
      if (this.deviceOnline.get(String(device.deviceId)) === false) continue;
      await this.subscribeCovDevice(device);
    }
  }

  async renewCov() {
    if (!this.options.cov_enabled || !this.covSubscriptions.size) return;

    this.log.debug(`Renewing ${this.covSubscriptions.size} COV subscriptions`);

    const current = [...this.covSubscriptions.values()];
    for (const sub of current) {
      const device = this.cache.devices?.[String(sub.deviceId)];
      const point = this.findPoint(sub.deviceId, sub.bacType, sub.bacInstance);
      if (!device || !point) continue;

      try {
        await this.subscribeCovPoint(device, point);
      } catch (err) {
        this.log.debug(
          `COV renew failed ${sub.deviceId}/${sub.bacType}/${sub.bacInstance}:`,
          err?.message || err
        );
      }

      const delay = Number(this.options.cov_subscribe_delay_ms);
      if (delay > 0) await sleep(delay);
    }
  }

  extractCovPayload(data) {
    return data?.payload?.request ?? data?.request ?? data?.payload ?? data ?? {};
  }

  extractCovSubscriptionId(payload) {
    return Number(
      payload?.subscriberProcessId ??
      payload?.subscriberProcessIdentifier ??
      payload?.subscriptionProcessId ??
      payload?.subscriptionProcessIdentifier
    );
  }

  extractCovObject(payload) {
    return payload?.monitoredObjectId ??
      payload?.monitoredObjectIdentifier ??
      payload?.monitoredObject ??
      payload?.objectId ??
      null;
  }

  extractCovPresentValue(payload) {
    const values = payload?.values ?? payload?.listOfValues ?? payload?.properties ?? [];
    if (!Array.isArray(values)) return undefined;

    for (const item of values) {
      const propId = item?.property?.id ?? item?.propertyId ?? item?.id;
      if (Number(propId) !== PROP.PRESENT_VALUE) continue;

      const raw = item?.value ?? item?.values;

      if (Array.isArray(raw)) {
        return raw[0]?.value ?? raw[0];
      }

      if (raw && typeof raw === "object" && "value" in raw) {
        return raw.value;
      }

      return raw;
    }

    return undefined;
  }

  async handleCov(data) {
    const payload = this.extractCovPayload(data);
    const subId = this.extractCovSubscriptionId(payload);

    let sub = Number.isFinite(subId) ? this.covSubscriptions.get(subId) : null;

    if (!sub) {
      const objectId = this.extractCovObject(payload);
      const sender = receiverAddressString(data?.header?.sender ?? data?.address);

      if (objectId) {
        for (const candidate of this.covSubscriptions.values()) {
          const device = this.cache.devices?.[String(candidate.deviceId)];

          if (
            Number(candidate.bacType) === Number(objectId.type) &&
            Number(candidate.bacInstance) === Number(objectId.instance) &&
            (!sender || !device?.address?.address || sender === receiverAddressString(device.address))
          ) {
            sub = candidate;
            break;
          }
        }
      }
    }

    if (!sub) return;

    const value = this.extractCovPresentValue(payload);
    if (value === undefined) return;

    const point = this.findPoint(sub.deviceId, sub.bacType, sub.bacInstance);
    if (!point) return;

    point.value = value;
    await this.publishEffectivePointState(point, value);
    await this.setDeviceOnline(sub.deviceId, true);

    this.log.debug(`COV ${sub.deviceId}/${sub.bacType}/${sub.bacInstance} = ${value}`);
  }

  async onMqttMessage(topic, payloadBuffer) {
    const payload = payloadBuffer.toString();

    if (topic === `${BASE_TOPIC}/control/homeassistant-restart`) {
      if (["RESTART", "REBOOT", "INSTALL"].includes(payload.trim().toUpperCase())) {
        await this.restartHomeAssistantFromUpdate();
      }
      return;
    }

    if (topic === `${BASE_TOPIC}/control/scan`) {
      if (payload.trim().toUpperCase() === "SCAN") {
        void this.scan().catch(err => {
          this.log.error("Manual scan:", err?.message || err);
        });
      }
      return;
    }

    if (topic === `${BASE_TOPIC}/control/read`) {
      if (payload.trim().toUpperCase() === "READ") {
        void this.fullReadAll().catch(err => {
          this.log.error("Manual read:", err?.message || err);
        });
      }
      return;
    }

    const scheduleWeekMatch =
      String(topic).match(
        /^bacnet2mqtt\/(\d+)\/17\/(\d+)\/schedule\/set\/week$/
      );

    if (scheduleWeekMatch) {
      const deviceId =
        Number(scheduleWeekMatch[1]);

      const instance =
        Number(scheduleWeekMatch[2]);

      try {
        await this.writeScheduleWeek(
          deviceId,
          instance,
          payload
        );
      } catch (err) {
        this.log.warn(
          `Schedule weekly write failed ${deviceId}/17/${instance}:`,
          err?.message || err
        );

        const point =
          this.findPoint(
            deviceId,
            OBJECT_TYPE.SCHEDULE,
            instance
          );

        if (point) {
          await this.publishEffectivePointState(
            point,
            point.value
          );
        }
      }

      return;
    }

    // Keep the v0.1.5 per-day MQTT command topics compatible even though
    // Home Assistant v0.1.6 now exposes one full-week text control.
    const scheduleDayMatch =
      String(topic).match(
        /^bacnet2mqtt\/(\d+)\/17\/(\d+)\/schedule\/set\/(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/
      );

    if (scheduleDayMatch) {
      const deviceId =
        Number(scheduleDayMatch[1]);

      const instance =
        Number(scheduleDayMatch[2]);

      const dayKey =
        scheduleDayMatch[3];

      try {
        await this.writeScheduleDay(
          deviceId,
          instance,
          dayKey,
          payload
        );
      } catch (err) {
        this.log.warn(
          `Schedule write failed ${deviceId}/17/${instance} ${dayKey}:`,
          err?.message || err
        );

        const point =
          this.findPoint(
            deviceId,
            OBJECT_TYPE.SCHEDULE,
            instance
          );

        if (point) {
          await this.publishEffectivePointState(
            point,
            point.value
          );
        }
      }

      return;
    }

    if (topic === "homeassistant/status") {
      if (payload.trim().toLowerCase() === "online") {
        await this.publishEffectiveDiscovery();
        await this.publishRestartUpdateState().catch(() => {});
        void this.fullReadAll();
      }
      return;
    }

    if (topic.startsWith(`${BASE_TOPIC}/`) && topic.endsWith("/set")) {
      try {
        await this.handleWriteTopic(topic, payload);
      } catch (err) {
        this.log.warn("Write failed:", err?.message || err);
      }
    }
  }

  effectiveCache() {
    const devices = {};
    const points = {};

    for (const [key, device] of Object.entries(this.cache.devices || {})) {
      if (this.uiSettings.isHidden(device.deviceId)) continue;
      devices[key] = this.uiSettings.effectiveDevice(device);
    }

    for (const [key, devicePoints] of Object.entries(this.cache.points || {})) {
      if (!devices[key]) continue;
      points[key] = (devicePoints || []).map(point =>
        this.effectivePointForPublishing(point)
      );
    }

    return {
      devices,
      points,
      discoveryTopics: [...(this.cache.discoveryTopics || [])]
    };
  }

  async publishEffectiveDiscovery() {
    const effective = this.effectiveCache();
    await publishDiscovery(this.mqtt, effective, this.log);
    this.cache.discoveryTopics = effective.discoveryTopics;
  }

  effectivePointForPublishing(point) {
    const effective =
      this.uiSettings.effectivePoint(point);

    if (Number(effective.bacType) === OBJECT_TYPE.SCHEDULE) {
      const device =
        this.cache.devices?.[String(effective.deviceId)];
      effective.deviceDisplayName =
        device
          ? this.uiSettings.effectiveDevice(device).deviceName
          : `BACnet ${effective.deviceId}`;
      effective.scheduleConfig =
        this.scheduleConfig(effective);
      effective.presentValueText =
        this.scheduleDisplayValue(
          effective,
          effective.value
        );
    }

    return effective;
  }

  async publishEffectivePointState(point, value) {
    await publishPointState(
      this.mqtt,
      this.effectivePointForPublishing(point),
      value
    );
  }

  objectTypeName(type) {
    const names = {
      0: "Analog Input",
      1: "Analog Output",
      2: "Analog Value",
      3: "Binary Input",
      4: "Binary Output",
      5: "Binary Value",
      13: "Multi-State Input",
      14: "Multi-State Output",
      17: "Schedule",
      19: "Multi-State Value"
    };
    return names[Number(type)] || `Object ${type}`;
  }

  uiDeviceList() {
    const devices = Object.values(this.cache.devices || {})
      .filter(device => !this.uiSettings.isHidden(device.deviceId))
      .map(device => {
        const effective = this.uiSettings.effectiveDevice(device);
        return {
          deviceId: Number(device.deviceId),
          name: effective.deviceName,
          sourceName: device.sourceDeviceName || device.deviceName || null,
          online: this.deviceOnline.get(String(device.deviceId)) === true,
          address: receiverAddressString(device.address) || null,
          vendorName: device.vendorName || null,
          vendorId: device.vendorId ?? null,
          modelName: device.modelName || null,
          pointCount: this.pointsForDevice(device.deviceId).length
        };
      })
      .sort((a, b) => a.deviceId - b.deviceId);

    const hidden = this.uiSettings.hiddenDevices()
      .map(item => ({
        ...item,
        online: false
      }))
      .sort((a, b) => Number(a.deviceId) - Number(b.deviceId));

    return { devices, hidden };
  }

  uiPoints(deviceId) {
    const device = this.cache.devices?.[String(deviceId)];
    if (!device || this.uiSettings.isHidden(deviceId)) return null;

    const effectiveDevice = this.uiSettings.effectiveDevice(device);

    return this.pointsForDevice(deviceId)
      .map(rawPoint => {
        const point = this.uiSettings.effectivePoint(rawPoint);
        const type = Number(point.bacType);
        const analog = [
          OBJECT_TYPE.ANALOG_INPUT,
          OBJECT_TYPE.ANALOG_OUTPUT,
          OBJECT_TYPE.ANALOG_VALUE
        ].includes(type);

        return {
          key: pointKey(point.deviceId, point.bacType, point.bacInstance),
          deviceId: Number(point.deviceId),
          deviceName: effectiveDevice.deviceName,
          name: point.pointName,
          sourceName: rawPoint.sourcePointName || rawPoint.pointName,
          type,
          typeName: this.objectTypeName(type),
          instance: Number(point.bacInstance),
          writable: point.writable === true,
          value:
            analog && point.writable === true
              ? cleanUiNumber(point.value)
              : (point.value ?? null),
          unit: point.unitName || null,
          states: point.states || null,
          analog,
          min: analog ? cleanUiNumber(point.minValue) : null,
          max: analog ? cleanUiNumber(point.maxValue) : null,
          step: analog ? cleanUiNumber(point.resolution) : null,
          sourceMin: analog ? cleanUiNumber(rawPoint.sourceMinValue ?? rawPoint.minValue) : null,
          sourceMax: analog ? cleanUiNumber(rawPoint.sourceMaxValue ?? rawPoint.maxValue) : null,
          sourceStep: analog ? cleanUiNumber(rawPoint.sourceResolution ?? rawPoint.resolution) : null,
          overridden: Boolean(
            Object.keys(
              this.uiSettings.pointOverride(
                point.deviceId,
                point.bacType,
                point.bacInstance
              )
            ).length
          ),
          schedule:
            type === OBJECT_TYPE.SCHEDULE
              ? {
                  presentValue: point.value ?? null,
                  presentText:
                    this.scheduleDisplayValue(point, point.value),
                  weekly:
                    point.schedule?.dayTemplates || {},
                  priorityForWriting:
                    point.schedule?.priorityForWriting ?? null,
                  scheduleDefault:
                    point.schedule?.scheduleDefault ?? null,
                  controlledObject:
                    this.scheduleReference(point),
                  config:
                    this.scheduleConfig(point)
                }
              : null
        };
      })
      .sort((a, b) =>
        a.type - b.type ||
        a.instance - b.instance
      );
  }

  async uiRenameDevice(deviceId, name) {
    const device = this.cache.devices?.[String(deviceId)];
    if (!device || this.uiSettings.isHidden(deviceId)) {
      throw new Error(`Device ${deviceId} not found`);
    }
    await this.uiSettings.setDeviceName(deviceId, name);
    await this.publishEffectiveDiscovery();
    await this.saveCache();
    return this.uiSettings.effectiveDevice(device);
  }

  async uiDeleteDevice(deviceId) {
    const key = String(deviceId);
    const device = this.cache.devices?.[key];
    if (!device) throw new Error(`Device ${deviceId} not found`);

    await this.uiSettings.hideDevice(device);
    await publishDeviceAvailability(this.mqtt, deviceId, false);

    for (const [id, sub] of [...this.covSubscriptions.entries()]) {
      if (Number(sub.deviceId) === Number(deviceId)) {
        this.covSubscriptions.delete(id);
      }
    }

    this.deviceOnline.delete(key);
    delete this.cache.devices[key];
    delete this.cache.points[key];

    await this.publishEffectiveDiscovery();
    await this.saveCache();
  }

  async uiRestoreDevice(deviceId) {
    await this.uiSettings.restoreDevice(deviceId);

    if (!this.scanRunning) {
      void this.scan().catch(err => {
        this.log.warn(
          `Restore scan failed for device ${deviceId}:`,
          err?.message || err
        );
      });
    }
  }

  async uiUpdatePoint(deviceId, type, instance, input) {
    const point = this.findPoint(deviceId, type, instance);
    if (!point) {
      throw new Error(`Point ${deviceId}/${type}/${instance} not found`);
    }

    const analog = [
      OBJECT_TYPE.ANALOG_INPUT,
      OBJECT_TYPE.ANALOG_OUTPUT,
      OBJECT_TYPE.ANALOG_VALUE
    ].includes(Number(point.bacType));

    const update = { ...input };
    if (!analog) {
      delete update.min;
      delete update.max;
      delete update.step;
    }

    const overrideKey =
      pointKey(deviceId, type, instance);

    const previousOverride =
      this.uiSettings.data.points?.[overrideKey]
        ? { ...this.uiSettings.data.points[overrideKey] }
        : null;

    await this.uiSettings.setPointOverride(
      deviceId,
      type,
      instance,
      update
    );

    const effective = this.effectivePointForPublishing(point);

    const restorePrevious = async () => {
      if (previousOverride) {
        this.uiSettings.data.points[overrideKey] = previousOverride;
      } else {
        delete this.uiSettings.data.points[overrideKey];
      }
      await this.uiSettings.save();
    };

    if (
      analog &&
      effective.minValue !== null &&
      effective.maxValue !== null &&
      !(Number(effective.minValue) < Number(effective.maxValue))
    ) {
      await restorePrevious();
      throw new Error("Effective min must be lower than effective max");
    }
    if (
      analog &&
      effective.resolution !== null &&
      !(Number(effective.resolution) > 0)
    ) {
      await restorePrevious();
      throw new Error("Effective step must be greater than 0");
    }

    await this.publishEffectiveDiscovery();
    await this.publishEffectivePointState(point, point.value);
    await this.saveCache();
    return this.effectivePointForPublishing(point);
  }

  async uiResetPoint(deviceId, type, instance) {
    const point = this.findPoint(deviceId, type, instance);
    if (!point) {
      throw new Error(`Point ${deviceId}/${type}/${instance} not found`);
    }
    await this.uiSettings.resetPointOverride(deviceId, type, instance);
    await this.publishEffectiveDiscovery();
    await this.publishEffectivePointState(point, point.value);
    await this.saveCache();
    return this.effectivePointForPublishing(point);
  }

  async uiWritePoint(deviceId, type, instance, value, release = false) {
    const point = this.findPoint(deviceId, type, instance);
    if (!point) {
      throw new Error(`Point ${deviceId}/${type}/${instance} not found`);
    }
    if (point.writable !== true) {
      throw new Error("This BACnet point is read-only");
    }

    await this.handleWriteTopic(
      `${BASE_TOPIC}/${deviceId}/${type}/${instance}/set`,
      release ? "RELEASE" : String(value)
    );

    return this.uiSettings.effectivePoint(point);
  }

  async uiWriteScheduleWeek(deviceId, instance, payload) {
    const point =
      this.findPoint(
        deviceId,
        OBJECT_TYPE.SCHEDULE,
        instance
      );

    if (!point) {
      throw new Error(
        `Schedule ${deviceId}/17/${instance} not found`
      );
    }

    await this.writeScheduleWeek(
      deviceId,
      instance,
      payload
    );

    return this.effectivePointForPublishing(point);
  }

  async uiReadDevice(deviceId) {
    const device = this.cache.devices?.[String(deviceId)];
    if (!device || this.uiSettings.isHidden(deviceId)) {
      throw new Error(`Device ${deviceId} not found`);
    }
    await this.readDevice(device);
    await this.saveCache();
  }

  async republishDiscovery() {
    await this.publishEffectiveDiscovery();
    await this.saveCache();
  }
}
