import fs from "node:fs/promises";
import { pointKey } from "./constants.js";

const SETTINGS_FILE = "/data/ui-settings.json";

function finiteOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeScheduleStates(value) {
  const source = Array.isArray(value)
    ? value
    : String(value ?? "")
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => {
          const eq = line.indexOf("=");
          if (eq < 1) return null;
          return {
            label: line.slice(0, eq).trim(),
            value: line.slice(eq + 1).trim()
          };
        })
        .filter(Boolean);

  return source
    .map(item => ({
      label: String(item?.label ?? "").trim(),
      value: String(item?.value ?? "").trim()
    }))
    .filter(item => item.label && item.value !== "")
    .slice(0, 32);
}

function normalizeScheduleOverride(input = {}) {
  const result = {};

  if (Object.prototype.hasOwnProperty.call(input, "mode")) {
    const mode = String(input.mode || "").trim().toLowerCase();
    if (!["auto", "binary", "states", "number"].includes(mode)) {
      throw new Error("Schedule mode must be auto, binary, states or number");
    }
    if (mode !== "auto") result.mode = mode;
  }

  if (Object.prototype.hasOwnProperty.call(input, "valueType")) {
    const valueType = String(input.valueType || "").trim().toLowerCase();
    if (!["auto", "enumerated", "boolean", "real", "unsigned", "signed"].includes(valueType)) {
      throw new Error("Unsupported Schedule BACnet value type");
    }
    if (valueType !== "auto") result.valueType = valueType;
  }

  for (const key of ["onText", "onValue", "offText", "offValue", "nullText", "unit"]) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
    const value = String(input[key] ?? "").trim();
    if (value) result[key] = value;
  }

  for (const key of ["min", "max", "step"]) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
    const value = finiteOrNull(input[key]);
    if (value !== null) result[key] = value;
  }

  if (result.step !== undefined && !(result.step > 0)) {
    throw new Error("Schedule step must be greater than 0");
  }

  if (result.min !== undefined && result.max !== undefined && !(result.min < result.max)) {
    throw new Error("Schedule minimum must be lower than maximum");
  }

  if (Object.prototype.hasOwnProperty.call(input, "states")) {
    const states = normalizeScheduleStates(input.states);
    if (states.length) result.states = states;
  }

  return result;
}

export class UiSettings {
  constructor(logger) {
    this.log = logger;
    this.data = {
      devices: {},
      points: {},
      hiddenDevices: {}
    };
  }

  async load() {
    try {
      const raw = await fs.readFile(SETTINGS_FILE, "utf8");
      const parsed = JSON.parse(raw);
      this.data = {
        devices: parsed.devices || {},
        points: parsed.points || {},
        hiddenDevices: parsed.hiddenDevices || {}
      };
      this.log.info(
        `Loaded UI settings: ${Object.keys(this.data.devices).length} device overrides, ` +
        `${Object.keys(this.data.points).length} point overrides, ` +
        `${Object.keys(this.data.hiddenDevices).length} deleted devices`
      );
    } catch (err) {
      if (err?.code !== "ENOENT") {
        this.log.warn("Could not load UI settings:", err?.message || err);
      }
    }
  }

  async save() {
    const tmp = `${SETTINGS_FILE}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.data, null, 2), "utf8");
    await fs.rename(tmp, SETTINGS_FILE);
  }

  isHidden(deviceId) {
    return Boolean(this.data.hiddenDevices?.[String(deviceId)]);
  }

  deviceOverride(deviceId) {
    return this.data.devices?.[String(deviceId)] || {};
  }

  pointOverride(deviceId, type, instance) {
    return this.data.points?.[pointKey(deviceId, type, instance)] || {};
  }

  effectiveDevice(device) {
    if (!device) return null;
    const override = this.deviceOverride(device.deviceId);
    return {
      ...device,
      sourceDeviceName:
        device.sourceDeviceName ||
        device.deviceName ||
        `BACnet ${device.deviceId}`,
      deviceName:
        String(override.name || "").trim() ||
        device.sourceDeviceName ||
        device.deviceName ||
        `BACnet ${device.deviceId}`
    };
  }

  effectivePoint(point) {
    if (!point) return null;
    const override = this.pointOverride(
      point.deviceId,
      point.bacType,
      point.bacInstance
    );

    return {
      ...point,
      sourcePointName:
        point.sourcePointName ||
        point.pointName ||
        `${point.bacType}:${point.bacInstance}`,
      sourceMinValue:
        point.sourceMinValue ?? point.minValue ?? null,
      sourceMaxValue:
        point.sourceMaxValue ?? point.maxValue ?? null,
      sourceResolution:
        point.sourceResolution ?? point.resolution ?? null,
      pointName:
        String(override.name || "").trim() ||
        point.sourcePointName ||
        point.pointName ||
        `${point.bacType}:${point.bacInstance}`,
      minValue:
        override.min !== undefined
          ? finiteOrNull(override.min)
          : (point.sourceMinValue ?? point.minValue ?? null),
      maxValue:
        override.max !== undefined
          ? finiteOrNull(override.max)
          : (point.sourceMaxValue ?? point.maxValue ?? null),
      resolution:
        override.step !== undefined
          ? finiteOrNull(override.step)
          : (point.sourceResolution ?? point.resolution ?? null),
      scheduleUiOverride:
        override.schedule && typeof override.schedule === "object"
          ? { ...override.schedule }
          : {}
    };
  }

  async setDeviceName(deviceId, name) {
    const key = String(deviceId);
    const value = String(name ?? "").trim();

    if (value) {
      this.data.devices[key] = {
        ...(this.data.devices[key] || {}),
        name: value
      };
    } else if (this.data.devices[key]) {
      delete this.data.devices[key].name;
      if (!Object.keys(this.data.devices[key]).length) {
        delete this.data.devices[key];
      }
    }

    await this.save();
  }

  async setPointOverride(deviceId, type, instance, input = {}) {
    const key = pointKey(deviceId, type, instance);
    const current = { ...(this.data.points[key] || {}) };

    if (Object.prototype.hasOwnProperty.call(input, "name")) {
      const name = String(input.name ?? "").trim();
      if (name) current.name = name;
      else delete current.name;
    }

    for (const [src, dst] of [
      ["min", "min"],
      ["max", "max"],
      ["step", "step"]
    ]) {
      if (!Object.prototype.hasOwnProperty.call(input, src)) continue;
      const raw = input[src];
      if (raw === null || raw === undefined || raw === "") {
        delete current[dst];
      } else {
        const n = Number(raw);
        if (!Number.isFinite(n)) {
          throw new Error(`${src} must be a finite number`);
        }
        current[dst] = n;
      }
    }

    if (Object.prototype.hasOwnProperty.call(input, "schedule")) {
      const normalized = normalizeScheduleOverride(input.schedule || {});
      if (Object.keys(normalized).length) current.schedule = normalized;
      else delete current.schedule;
    }

    if (current.step !== undefined && !(current.step > 0)) {
      throw new Error("step must be greater than 0");
    }

    if (
      current.min !== undefined &&
      current.max !== undefined &&
      !(current.min < current.max)
    ) {
      throw new Error("min must be lower than max");
    }

    if (Object.keys(current).length) {
      this.data.points[key] = current;
    } else {
      delete this.data.points[key];
    }

    await this.save();
  }

  async resetPointOverride(deviceId, type, instance) {
    delete this.data.points[pointKey(deviceId, type, instance)];
    await this.save();
  }

  async hideDevice(device) {
    const key = String(device.deviceId);
    this.data.hiddenDevices[key] = {
      deviceId: Number(device.deviceId),
      name:
        this.deviceOverride(device.deviceId).name ||
        device.deviceName ||
        `BACnet ${device.deviceId}`,
      sourceName:
        device.sourceDeviceName ||
        device.deviceName ||
        null,
      address: device.address || null,
      deletedAt: new Date().toISOString()
    };
    await this.save();
  }

  async restoreDevice(deviceId) {
    delete this.data.hiddenDevices[String(deviceId)];
    await this.save();
  }

  hiddenDevices() {
    return Object.values(this.data.hiddenDevices || {});
  }
}
