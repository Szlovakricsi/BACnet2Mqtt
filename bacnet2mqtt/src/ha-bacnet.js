import fs from "node:fs/promises";
import * as BacnetModule from "@bacnet-js/client";
import { VERSION } from "./constants.js";

const ApplicationTag = BacnetModule.ApplicationTag ?? BacnetModule.default?.ApplicationTag;
const ObjectType = BacnetModule.ObjectType ?? BacnetModule.default?.ObjectType;
const PropertyIdentifier = BacnetModule.PropertyIdentifier ?? BacnetModule.default?.PropertyIdentifier;
const Segmentation = BacnetModule.Segmentation ?? BacnetModule.default?.Segmentation;
const ErrorClass = BacnetModule.ErrorClass ?? BacnetModule.default?.ErrorClass;
const ErrorCode = BacnetModule.ErrorCode ?? BacnetModule.default?.ErrorCode;
const EngineeringUnits = BacnetModule.EngineeringUnits ?? BacnetModule.default?.EngineeringUnits;
const ASN1_ARRAY_ALL = BacnetModule.ASN1_ARRAY_ALL ?? 0xffffffff;

const CONFIG_FILE = "/data/ha-bacnet-export.json";
const HA_API = "http://supervisor/core/api";

const TYPE_NAMES = {
  analog: "Analog Value",
  binary: "Binary Value",
  string: "CharacterString Value"
};

const BINARY_DOMAINS = new Set([
  "switch", "input_boolean", "light", "fan", "cover", "lock"
]);
const ANALOG_WRITE_DOMAINS = new Set(["number", "input_number"]);
const STRING_WRITE_DOMAINS = new Set([
  "select", "input_select", "text", "input_text", "climate"
]);

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function normalizeType(value) {
  const text = String(value || "").trim().toLowerCase();
  if (["analog", "av", "analog_value", "analog-value", "2"].includes(text)) return "analog";
  if (["binary", "bv", "binary_value", "binary-value", "5"].includes(text)) return "binary";
  if (["string", "text", "characterstring", "characterstring_value", "characterstring-value", "40"].includes(text)) return "string";
  return null;
}

function objectTypeFor(mapping) {
  if (mapping.type === "binary") return ObjectType.BINARY_VALUE;
  if (mapping.type === "string") return ObjectType.CHARACTERSTRING_VALUE;
  return ObjectType.ANALOG_VALUE;
}

function domainOf(entityId) {
  return String(entityId || "").split(".", 1)[0];
}

function binaryStateValue(state, domain) {
  const text = String(state ?? "").trim().toLowerCase();
  if (domain === "cover") return ["open", "opening", "on", "1", "true"].includes(text) ? 1 : 0;
  if (domain === "lock") return ["unlocked", "unlocking", "on", "1", "true"].includes(text) ? 1 : 0;
  return [
    "on", "1", "true", "open", "opening", "unlocked", "unlocking",
    "home", "active", "detected", "occupied", "wet", "problem"
  ].includes(text) ? 1 : 0;
}

function isBinaryLike(state, domain) {
  if (BINARY_DOMAINS.has(domain) || domain === "binary_sensor") return true;
  const text = String(state ?? "").trim().toLowerCase();
  return [
    "on", "off", "true", "false", "open", "closed", "opening", "closing",
    "locked", "unlocked", "locking", "unlocking", "home", "not_home",
    "active", "inactive", "detected", "clear", "occupied", "not_occupied"
  ].includes(text);
}

function canWriteEntity(entityId, type) {
  const domain = domainOf(entityId);
  if (type === "binary") return BINARY_DOMAINS.has(domain);
  if (type === "analog") return ANALOG_WRITE_DOMAINS.has(domain);
  if (type === "string") return STRING_WRITE_DOMAINS.has(domain);
  return false;
}

function recommendedType(entity) {
  const domain = domainOf(entity?.entity_id);
  if (isBinaryLike(entity?.state, domain)) return "binary";
  if (Number.isFinite(Number(entity?.state)) && String(entity?.state).trim() !== "") return "analog";
  return "string";
}

function unitCode(unit) {
  const key = String(unit || "").trim();
  const names = {
    "°C": "DEGREES_CELSIUS",
    "°F": "DEGREES_FAHRENHEIT",
    "%": "PERCENT",
    "W": "WATTS",
    "kW": "KILOWATTS",
    "V": "VOLTS",
    "mV": "MILLIVOLTS",
    "A": "AMPERES",
    "mA": "MILLIAMPERES",
    "Hz": "HERTZ",
    "Pa": "PASCALS",
    "kPa": "KILOPASCALS",
    "bar": "BARS",
    "ppm": "PARTS_PER_MILLION",
    "lx": "LUXES",
    "s": "SECONDS",
    "min": "MINUTES",
    "h": "HOURS"
  };
  return EngineeringUnits?.[names[key]] ?? EngineeringUnits?.NO_UNITS ?? 95;
}

function app(type, value) {
  return { type, value };
}

function firstAppValue(value) {
  const item = Array.isArray(value) ? value[0] : value;
  return item && typeof item === "object" && "value" in item ? item.value : item;
}

export class HomeAssistantBacnetBridge {
  constructor(options, bacnetClient, log = console) {
    this.options = options;
    this.bacnet = bacnetClient;
    this.log = log;
    this.states = new Map();
    this.pollTimer = null;
    this.lastRefresh = null;
    this.lastError = null;
    this.started = false;
    this.config = this.defaultConfig();

    this._onWhoIs = req => void this.handleWhoIs(req);
    this._onReadProperty = req => void this.handleReadProperty(req);
    this._onReadPropertyMultiple = req => void this.handleReadPropertyMultiple(req);
    this._onWriteProperty = req => void this.handleWriteProperty(req);
  }

  defaultConfig() {
    return {
      enabled: false,
      deviceId: 3900000,
      deviceName: "Home Assistant",
      pollInterval: 2,
      mappings: []
    };
  }

  async load() {
    try {
      const parsed = JSON.parse(await fs.readFile(CONFIG_FILE, "utf8"));
      this.config = this.normalizeConfig(parsed);
    } catch (err) {
      if (err?.code !== "ENOENT") {
        this.log.warn?.("HA→BACnet config load failed:", err?.message || err);
      }
      this.config = this.defaultConfig();
    }
  }

  normalizeConfig(input = {}) {
    const defaults = this.defaultConfig();
    const mappings = Array.isArray(input.mappings) ? input.mappings : [];
    return {
      enabled: input.enabled === true,
      deviceId: clampInt(input.deviceId, 0, 4194303, defaults.deviceId),
      deviceName: String(input.deviceName || defaults.deviceName).trim().slice(0, 120) || defaults.deviceName,
      pollInterval: clampInt(input.pollInterval, 1, 60, defaults.pollInterval),
      mappings: mappings.map(item => this.normalizeMapping(item)).filter(Boolean)
    };
  }

  normalizeMapping(input = {}) {
    const entityId = String(input.entityId || input.entity_id || "").trim();
    const type = normalizeType(input.type);
    const instance = clampInt(input.instance, 0, 4194303, -1);
    if (!entityId || !type || instance < 0) return null;
    return {
      id: String(input.id || `${type}:${instance}`),
      entityId,
      name: String(input.name || entityId).trim().slice(0, 120) || entityId,
      type,
      instance,
      writable: input.writable === true,
      unit: input.unit == null ? null : String(input.unit).slice(0, 40)
    };
  }

  async save() {
    const tmp = `${CONFIG_FILE}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.config, null, 2) + "\n", "utf8");
    await fs.rename(tmp, CONFIG_FILE);
  }

  async start() {
    if (this.started) return;
    await this.load();
    this.bacnet.on("whoIs", this._onWhoIs);
    this.bacnet.on("readProperty", this._onReadProperty);
    this.bacnet.on("readPropertyMultiple", this._onReadPropertyMultiple);
    this.bacnet.on("writeProperty", this._onWriteProperty);
    this.started = true;
    await this.refreshStates().catch(() => {});
    this.restartPolling();
    this.log.info?.(
      `HA→BACnet virtual device ${this.config.enabled ? "enabled" : "disabled"}: ` +
      `Device ${this.config.deviceId}, ${this.config.mappings.length} mapped entities`
    );
  }

  async stop() {
    clearInterval(this.pollTimer);
    this.pollTimer = null;
    if (!this.started) return;
    this.bacnet.removeListener("whoIs", this._onWhoIs);
    this.bacnet.removeListener("readProperty", this._onReadProperty);
    this.bacnet.removeListener("readPropertyMultiple", this._onReadPropertyMultiple);
    this.bacnet.removeListener("writeProperty", this._onWriteProperty);
    this.started = false;
  }

  restartPolling() {
    clearInterval(this.pollTimer);
    this.pollTimer = null;
    if (!this.config.enabled || !this.config.mappings.length) return;
    this.pollTimer = setInterval(() => {
      void this.refreshStates().catch(() => {});
    }, this.config.pollInterval * 1000);
  }

  token() {
    const token = process.env.SUPERVISOR_TOKEN;
    if (!token) throw new Error("SUPERVISOR_TOKEN is unavailable; Home Assistant API access is required");
    return token;
  }

  async haFetch(path, options = {}) {
    const response = await fetch(`${HA_API}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.token()}`,
        "Content-Type": "application/json",
        ...(options.headers || {})
      }
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Home Assistant API ${response.status}: ${text || response.statusText}`);
    }
    if (response.status === 204) return null;
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  async refreshStates() {
    try {
      const states = await this.haFetch("/states");
      if (!Array.isArray(states)) throw new Error("Home Assistant states response is not an array");
      const next = new Map();
      for (const state of states) {
        if (state?.entity_id) next.set(String(state.entity_id), state);
      }
      this.states = next;
      this.lastRefresh = new Date().toISOString();
      this.lastError = null;
      return states;
    } catch (err) {
      this.lastError = err?.message || String(err);
      throw err;
    }
  }

  entitySummary(entity) {
    const type = recommendedType(entity);
    const entityId = String(entity.entity_id);
    return {
      entityId,
      name: String(entity.attributes?.friendly_name || entityId),
      state: entity.state,
      unit: entity.attributes?.unit_of_measurement ?? null,
      domain: domainOf(entityId),
      recommendedType: type,
      writable: canWriteEntity(entityId, type),
      attributes: {
        deviceClass: entity.attributes?.device_class ?? null,
        stateClass: entity.attributes?.state_class ?? null
      }
    };
  }

  async listEntities() {
    const states = await this.refreshStates();
    return states.map(entity => this.entitySummary(entity)).sort((a, b) => a.entityId.localeCompare(b.entityId));
  }

  uiState() {
    return {
      enabled: this.config.enabled,
      deviceId: this.config.deviceId,
      deviceName: this.config.deviceName,
      pollInterval: this.config.pollInterval,
      mappings: this.config.mappings.map(mapping => ({
        ...mapping,
        objectType: objectTypeFor(mapping),
        objectTypeName: TYPE_NAMES[mapping.type],
        state: this.states.get(mapping.entityId)?.state ?? null,
        available: this.states.has(mapping.entityId)
      })),
      lastRefresh: this.lastRefresh,
      lastError: this.lastError
    };
  }

  async updateConfig(input = {}) {
    const next = {
      ...this.config,
      enabled: input.enabled === undefined ? this.config.enabled : input.enabled === true,
      deviceId: input.deviceId === undefined
        ? this.config.deviceId
        : clampInt(input.deviceId, 0, 4194303, this.config.deviceId),
      deviceName: input.deviceName === undefined
        ? this.config.deviceName
        : (String(input.deviceName || "").trim().slice(0, 120) || "Home Assistant"),
      pollInterval: input.pollInterval === undefined
        ? this.config.pollInterval
        : clampInt(input.pollInterval, 1, 60, this.config.pollInterval)
    };
    this.config = this.normalizeConfig(next);
    await this.save();
    if (this.config.enabled) await this.refreshStates().catch(() => {});
    this.restartPolling();
    return this.uiState();
  }

  nextInstance(type) {
    const used = new Set(
      this.config.mappings.filter(item => item.type === type).map(item => Number(item.instance))
    );
    let value = 1;
    while (used.has(value)) value++;
    return value;
  }

  async addMapping(input = {}) {
    const entityId = String(input.entityId || "").trim();
    if (!entityId) throw Object.assign(new Error("entityId is required"), { statusCode: 400 });

    if (!this.states.has(entityId)) await this.refreshStates();
    const entity = this.states.get(entityId);
    if (!entity) throw Object.assign(new Error(`Home Assistant entity ${entityId} not found`), { statusCode: 404 });

    const type = normalizeType(input.type) || recommendedType(entity);
    const instance = input.instance === undefined || input.instance === null || input.instance === ""
      ? this.nextInstance(type)
      : clampInt(input.instance, 0, 4194303, -1);
    if (instance < 0) throw Object.assign(new Error("Invalid BACnet object instance"), { statusCode: 400 });

    if (this.config.mappings.some(item => item.type === type && Number(item.instance) === instance)) {
      throw Object.assign(new Error(`${TYPE_NAMES[type]} instance ${instance} already exists`), { statusCode: 409 });
    }
    if (this.config.mappings.some(item => item.entityId === entityId)) {
      throw Object.assign(new Error(`${entityId} is already exposed to BACnet`), { statusCode: 409 });
    }

    const requestedWritable = input.writable === undefined
      ? canWriteEntity(entityId, type)
      : input.writable === true;
    if (requestedWritable && !canWriteEntity(entityId, type)) {
      throw Object.assign(
        new Error(`${entityId} cannot be written as ${TYPE_NAMES[type]} through a supported Home Assistant service`),
        { statusCode: 400 }
      );
    }

    const mapping = this.normalizeMapping({
      id: `${type}:${instance}`,
      entityId,
      name: input.name || entity.attributes?.friendly_name || entityId,
      type,
      instance,
      writable: requestedWritable,
      unit: input.unit ?? entity.attributes?.unit_of_measurement ?? null
    });
    this.config.mappings.push(mapping);
    await this.save();
    this.restartPolling();
    return this.uiState();
  }

  async removeMapping(id) {
    const key = decodeURIComponent(String(id || ""));
    const before = this.config.mappings.length;
    this.config.mappings = this.config.mappings.filter(item => item.id !== key);
    if (before === this.config.mappings.length) {
      throw Object.assign(new Error(`Mapping ${key} not found`), { statusCode: 404 });
    }
    await this.save();
    this.restartPolling();
    return this.uiState();
  }

  isOwnIAm(data) {
    return this.config.enabled && Number(data?.payload?.deviceId) === Number(this.config.deviceId);
  }

  mappingForObject(objectId) {
    if (!objectId) return null;
    return this.config.mappings.find(mapping =>
      Number(objectTypeFor(mapping)) === Number(objectId.type) &&
      Number(mapping.instance) === Number(objectId.instance)
    ) || null;
  }

  isOurObject(objectId) {
    if (!this.config.enabled || !objectId) return false;
    if (Number(objectId.type) === Number(ObjectType.DEVICE)) {
      return Number(objectId.instance) === Number(this.config.deviceId);
    }
    return Boolean(this.mappingForObject(objectId));
  }

  deviceObjectId() {
    return { type: ObjectType.DEVICE, instance: Number(this.config.deviceId) };
  }

  objectList() {
    return [
      this.deviceObjectId(),
      ...this.config.mappings.map(mapping => ({
        type: objectTypeFor(mapping),
        instance: Number(mapping.instance)
      }))
    ];
  }

  propertyIdsFor(objectId) {
    if (Number(objectId.type) === Number(ObjectType.DEVICE)) {
      return [
        PropertyIdentifier.DESCRIPTION,
        PropertyIdentifier.OBJECT_LIST,
        PropertyIdentifier.VENDOR_NAME,
        PropertyIdentifier.VENDOR_IDENTIFIER,
        PropertyIdentifier.MODEL_NAME,
        PropertyIdentifier.FIRMWARE_REVISION,
        PropertyIdentifier.APPLICATION_SOFTWARE_VERSION,
        PropertyIdentifier.PROTOCOL_VERSION,
        PropertyIdentifier.PROTOCOL_REVISION,
        PropertyIdentifier.SEGMENTATION_SUPPORTED,
        PropertyIdentifier.MAX_APDU_LENGTH_ACCEPTED,
        PropertyIdentifier.APDU_TIMEOUT,
        PropertyIdentifier.NUMBER_OF_APDU_RETRIES,
        PropertyIdentifier.DATABASE_REVISION
      ].filter(Number.isFinite);
    }
    const mapping = this.mappingForObject(objectId);
    if (!mapping) return [];
    const common = [PropertyIdentifier.DESCRIPTION, PropertyIdentifier.PRESENT_VALUE, PropertyIdentifier.OUT_OF_SERVICE];
    if (mapping.type === "analog") common.push(PropertyIdentifier.UNITS);
    if (mapping.type === "binary") common.push(PropertyIdentifier.ACTIVE_TEXT, PropertyIdentifier.INACTIVE_TEXT);
    return common.filter(Number.isFinite);
  }

  arrayData(values, property, valueTag) {
    const rawIndex = property?.index;
    const index = rawIndex === undefined || rawIndex === null ? ASN1_ARRAY_ALL : Number(rawIndex);
    if (index === ASN1_ARRAY_ALL) return values.map(value => app(valueTag, value));
    if (index === 0) return app(ApplicationTag.UNSIGNED_INTEGER, values.length);
    if (index >= 1 && index <= values.length) return app(valueTag, values[index - 1]);
    throw Object.assign(new Error("Invalid BACnet array index"), {
      bacnetClass: ErrorClass.PROPERTY,
      bacnetCode: ErrorCode.INVALID_ARRAY_INDEX
    });
  }

  genericProperty(objectId, property) {
    const id = Number(property?.id);
    if (id === Number(PropertyIdentifier.OBJECT_IDENTIFIER)) return app(ApplicationTag.OBJECTIDENTIFIER, objectId);
    if (id === Number(PropertyIdentifier.OBJECT_TYPE)) return app(ApplicationTag.ENUMERATED, Number(objectId.type));

    if (Number(objectId.type) === Number(ObjectType.DEVICE)) {
      if (id === Number(PropertyIdentifier.OBJECT_NAME)) return app(ApplicationTag.CHARACTER_STRING, this.config.deviceName);
      if (id === Number(PropertyIdentifier.DESCRIPTION)) return app(ApplicationTag.CHARACTER_STRING, "Home Assistant entities exposed by BACnet2MQTT");
      if (id === Number(PropertyIdentifier.OBJECT_LIST)) return this.arrayData(this.objectList(), property, ApplicationTag.OBJECTIDENTIFIER);
      if (id === Number(PropertyIdentifier.VENDOR_NAME)) return app(ApplicationTag.CHARACTER_STRING, "BACnet2MQTT");
      if (id === Number(PropertyIdentifier.VENDOR_IDENTIFIER)) return app(ApplicationTag.UNSIGNED_INTEGER, 0);
      if (id === Number(PropertyIdentifier.MODEL_NAME)) return app(ApplicationTag.CHARACTER_STRING, "Home Assistant BACnet Bridge");
      if (id === Number(PropertyIdentifier.FIRMWARE_REVISION)) return app(ApplicationTag.CHARACTER_STRING, VERSION);
      if (id === Number(PropertyIdentifier.APPLICATION_SOFTWARE_VERSION)) return app(ApplicationTag.CHARACTER_STRING, VERSION);
      if (id === Number(PropertyIdentifier.PROTOCOL_VERSION)) return app(ApplicationTag.UNSIGNED_INTEGER, 1);
      if (id === Number(PropertyIdentifier.PROTOCOL_REVISION)) return app(ApplicationTag.UNSIGNED_INTEGER, 24);
      if (id === Number(PropertyIdentifier.SEGMENTATION_SUPPORTED)) return app(ApplicationTag.ENUMERATED, Segmentation.NO_SEGMENTATION);
      if (id === Number(PropertyIdentifier.MAX_APDU_LENGTH_ACCEPTED)) return app(ApplicationTag.UNSIGNED_INTEGER, 1476);
      if (id === Number(PropertyIdentifier.APDU_TIMEOUT)) return app(ApplicationTag.UNSIGNED_INTEGER, Number(this.options.apdu_timeout || 6000));
      if (id === Number(PropertyIdentifier.NUMBER_OF_APDU_RETRIES)) return app(ApplicationTag.UNSIGNED_INTEGER, 3);
      if (id === Number(PropertyIdentifier.DATABASE_REVISION)) return app(ApplicationTag.UNSIGNED_INTEGER, 1);
      if (id === Number(PropertyIdentifier.PROPERTY_LIST)) {
        return this.arrayData(this.propertyIdsFor(objectId), property, ApplicationTag.ENUMERATED);
      }
      return null;
    }

    const mapping = this.mappingForObject(objectId);
    if (!mapping) return null;
    if (id === Number(PropertyIdentifier.OBJECT_NAME)) return app(ApplicationTag.CHARACTER_STRING, mapping.name);
    if (id === Number(PropertyIdentifier.DESCRIPTION)) return app(ApplicationTag.CHARACTER_STRING, mapping.entityId);
    if (id === Number(PropertyIdentifier.OUT_OF_SERVICE)) return app(ApplicationTag.BOOLEAN, false);
    if (id === Number(PropertyIdentifier.PROPERTY_LIST)) {
      return this.arrayData(this.propertyIdsFor(objectId), property, ApplicationTag.ENUMERATED);
    }
    if (id === Number(PropertyIdentifier.UNITS) && mapping.type === "analog") {
      return app(ApplicationTag.ENUMERATED, unitCode(mapping.unit));
    }
    if (id === Number(PropertyIdentifier.ACTIVE_TEXT) && mapping.type === "binary") {
      return app(ApplicationTag.CHARACTER_STRING, "ON");
    }
    if (id === Number(PropertyIdentifier.INACTIVE_TEXT) && mapping.type === "binary") {
      return app(ApplicationTag.CHARACTER_STRING, "OFF");
    }
    if (id === Number(PropertyIdentifier.PRESENT_VALUE)) {
      const state = this.states.get(mapping.entityId);
      if (!state) {
        throw Object.assign(new Error(`Home Assistant entity ${mapping.entityId} is unavailable`), {
          bacnetClass: ErrorClass.PROPERTY,
          bacnetCode: ErrorCode.VALUE_NOT_INITIALIZED
        });
      }
      if (mapping.type === "binary") {
        return app(ApplicationTag.ENUMERATED, binaryStateValue(state.state, domainOf(mapping.entityId)));
      }
      if (mapping.type === "analog") {
        const value = Number(state.state);
        if (!Number.isFinite(value)) {
          throw Object.assign(new Error(`Home Assistant state ${state.state} is not numeric`), {
            bacnetClass: ErrorClass.PROPERTY,
            bacnetCode: ErrorCode.VALUE_NOT_INITIALIZED
          });
        }
        return app(ApplicationTag.REAL, value);
      }
      return app(ApplicationTag.CHARACTER_STRING, String(state.state ?? ""));
    }
    return null;
  }

  readPropertyData(objectId, property) {
    if (!this.isOurObject(objectId)) {
      throw Object.assign(new Error("Unknown BACnet object"), {
        bacnetClass: ErrorClass.OBJECT,
        bacnetCode: ErrorCode.UNKNOWN_OBJECT
      });
    }
    const data = this.genericProperty(objectId, property);
    if (data !== null && data !== undefined) return data;
    throw Object.assign(new Error("Unknown BACnet property"), {
      bacnetClass: ErrorClass.PROPERTY,
      bacnetCode: ErrorCode.UNKNOWN_PROPERTY
    });
  }

  errorResponse(req, err) {
    const header = req?.header;
    if (!header?.expectingReply || !header.sender) return;
    const service = Number(req?.service);
    const invokeId = Number(req?.invokeId);
    if (!Number.isFinite(service) || !Number.isFinite(invokeId)) return;
    try {
      this.bacnet.errorResponse(
        header.sender,
        service,
        invokeId,
        err?.bacnetClass ?? ErrorClass.SERVICES,
        err?.bacnetCode ?? ErrorCode.OPERATIONAL_PROBLEM
      );
    } catch (responseErr) {
      this.log.debug?.("HA→BACnet error response failed:", responseErr?.message || responseErr);
    }
  }

  async handleWhoIs(req) {
    if (!this.config.enabled || !req?.header?.sender) return;
    try {
      this.bacnet.iAmResponse(
        req.header.sender,
        Number(this.config.deviceId),
        Segmentation.NO_SEGMENTATION,
        0
      );
    } catch (err) {
      this.log.debug?.("HA→BACnet I-Am failed:", err?.message || err);
    }
  }

  async handleReadProperty(req) {
    if (!this.config.enabled) return;
    const objectId = req?.payload?.objectId;
    if (!this.isOurObject(objectId)) return;
    try {
      const data = this.readPropertyData(objectId, req.payload.property);
      this.bacnet.readPropertyResponse(
        req.header.sender,
        req.invokeId,
        objectId,
        req.payload.property,
        data
      );
    } catch (err) {
      this.log.debug?.("HA→BACnet ReadProperty:", err?.message || err);
      this.errorResponse(req, err);
    }
  }

  async handleReadPropertyMultiple(req) {
    if (!this.config.enabled) return;
    const requests = req?.payload?.properties;
    if (!Array.isArray(requests) || !requests.length) return;
    if (!requests.some(item => this.isOurObject(item?.objectId))) return;
    try {
      const values = requests.map(item => {
        if (!this.isOurObject(item.objectId)) {
          throw Object.assign(new Error("Unknown BACnet object"), {
            bacnetClass: ErrorClass.OBJECT,
            bacnetCode: ErrorCode.UNKNOWN_OBJECT
          });
        }
        const requested = Array.isArray(item.properties) ? item.properties : [];
        const properties = requested.length === 1 && Number(requested[0]?.id) === Number(PropertyIdentifier.ALL)
          ? [
              { id: PropertyIdentifier.OBJECT_IDENTIFIER, index: ASN1_ARRAY_ALL },
              { id: PropertyIdentifier.OBJECT_NAME, index: ASN1_ARRAY_ALL },
              { id: PropertyIdentifier.OBJECT_TYPE, index: ASN1_ARRAY_ALL },
              ...this.propertyIdsFor(item.objectId).map(id => ({ id, index: ASN1_ARRAY_ALL }))
            ]
          : requested;
        return {
          objectId: item.objectId,
          values: properties.map(property => {
            const data = this.readPropertyData(item.objectId, property);
            return {
              property,
              value: Array.isArray(data) ? data : [data]
            };
          })
        };
      });
      this.bacnet.readPropertyMultipleResponse(req.header.sender, req.invokeId, values);
    } catch (err) {
      this.log.debug?.("HA→BACnet ReadPropertyMultiple:", err?.message || err);
      this.errorResponse(req, err);
    }
  }

  async writeEntity(mapping, value) {
    const entityId = mapping.entityId;
    const domain = domainOf(entityId);
    let service;
    let data;

    if (mapping.type === "binary") {
      const on = Number(value) !== 0;
      if (["switch", "input_boolean", "light", "fan"].includes(domain)) {
        service = on ? "turn_on" : "turn_off";
        data = { entity_id: entityId };
      } else if (domain === "cover") {
        service = on ? "open_cover" : "close_cover";
        data = { entity_id: entityId };
      } else if (domain === "lock") {
        service = on ? "unlock" : "lock";
        data = { entity_id: entityId };
      }
    } else if (mapping.type === "analog") {
      if (["number", "input_number"].includes(domain)) {
        service = "set_value";
        data = { entity_id: entityId, value: Number(value) };
      }
    } else if (mapping.type === "string") {
      const text = String(value ?? "");
      if (["select", "input_select"].includes(domain)) {
        service = "select_option";
        data = { entity_id: entityId, option: text };
      } else if (["text", "input_text"].includes(domain)) {
        service = "set_value";
        data = { entity_id: entityId, value: text };
      } else if (domain === "climate") {
        service = "set_hvac_mode";
        data = { entity_id: entityId, hvac_mode: text };
      }
    }

    if (!service || !data) {
      throw Object.assign(new Error(`No supported Home Assistant write service for ${entityId}`), {
        bacnetClass: ErrorClass.PROPERTY,
        bacnetCode: ErrorCode.WRITE_ACCESS_DENIED
      });
    }

    await this.haFetch(`/services/${domain}/${service}`, {
      method: "POST",
      body: JSON.stringify(data)
    });

    const old = this.states.get(entityId);
    if (old) {
      let optimistic = value;
      if (mapping.type === "binary") {
        const on = Number(value) !== 0;
        optimistic = domain === "cover" ? (on ? "open" : "closed")
          : domain === "lock" ? (on ? "unlocked" : "locked")
            : (on ? "on" : "off");
      }
      this.states.set(entityId, { ...old, state: String(optimistic) });
    }
    setTimeout(() => void this.refreshStates().catch(() => {}), 250);
  }

  async handleWriteProperty(req) {
    if (!this.config.enabled) return;
    const objectId = req?.payload?.objectId;
    if (!this.isOurObject(objectId)) return;
    try {
      const mapping = this.mappingForObject(objectId);
      const property = req?.payload?.value?.property;
      if (!mapping) {
        throw Object.assign(new Error("Device object is read-only"), {
          bacnetClass: ErrorClass.PROPERTY,
          bacnetCode: ErrorCode.WRITE_ACCESS_DENIED
        });
      }
      if (Number(property?.id) !== Number(PropertyIdentifier.PRESENT_VALUE) || !mapping.writable) {
        throw Object.assign(new Error("BACnet property is read-only"), {
          bacnetClass: ErrorClass.PROPERTY,
          bacnetCode: ErrorCode.WRITE_ACCESS_DENIED
        });
      }
      const raw = firstAppValue(req.payload.value.value);
      if (mapping.type === "analog" && !Number.isFinite(Number(raw))) {
        throw Object.assign(new Error("Analog value must be numeric"), {
          bacnetClass: ErrorClass.PROPERTY,
          bacnetCode: ErrorCode.VALUE_OUT_OF_RANGE
        });
      }
      if (mapping.type === "binary" && ![0, 1, false, true, "0", "1"].includes(raw)) {
        throw Object.assign(new Error("Binary value must be 0 or 1"), {
          bacnetClass: ErrorClass.PROPERTY,
          bacnetCode: ErrorCode.VALUE_OUT_OF_RANGE
        });
      }
      await this.writeEntity(mapping, raw);
      this.bacnet.simpleAckResponse(req.header.sender, req.service, req.invokeId);
      this.log.info?.(
        `HA→BACnet write ${mapping.entityId} <= ${String(raw)} from ` +
        `${TYPE_NAMES[mapping.type]} ${mapping.instance}`
      );
    } catch (err) {
      this.log.warn?.("HA→BACnet WriteProperty:", err?.message || err);
      this.errorResponse(req, err);
    }
  }
}
