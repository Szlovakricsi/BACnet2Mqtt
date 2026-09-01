export const VERSION = "0.4.2";
export const BASE_TOPIC = "bacnet2mqtt";
export const DISCOVERY_PREFIX = "homeassistant";

export const OBJECT_TYPE = {
  ANALOG_INPUT: 0,
  ANALOG_OUTPUT: 1,
  ANALOG_VALUE: 2,
  BINARY_INPUT: 3,
  BINARY_OUTPUT: 4,
  BINARY_VALUE: 5,
  DEVICE: 8,
  MULTI_STATE_INPUT: 13,
  SCHEDULE: 17,
  MULTI_STATE_OUTPUT: 14,
  MULTI_STATE_VALUE: 19
};

export const SUPPORTED_OBJECT_TYPES = new Set([
  OBJECT_TYPE.ANALOG_INPUT,
  OBJECT_TYPE.ANALOG_OUTPUT,
  OBJECT_TYPE.ANALOG_VALUE,
  OBJECT_TYPE.BINARY_INPUT,
  OBJECT_TYPE.BINARY_OUTPUT,
  OBJECT_TYPE.BINARY_VALUE,
  OBJECT_TYPE.MULTI_STATE_INPUT,
  OBJECT_TYPE.SCHEDULE,
  OBJECT_TYPE.MULTI_STATE_OUTPUT,
  OBJECT_TYPE.MULTI_STATE_VALUE
]);

export const WRITABLE_CANDIDATE_TYPES = new Set([
  OBJECT_TYPE.ANALOG_OUTPUT,
  OBJECT_TYPE.ANALOG_VALUE,
  OBJECT_TYPE.BINARY_OUTPUT,
  OBJECT_TYPE.BINARY_VALUE,
  OBJECT_TYPE.MULTI_STATE_OUTPUT,
  OBJECT_TYPE.MULTI_STATE_VALUE
]);

export const PROP = {
  EFFECTIVE_PERIOD: 32,
  EXCEPTION_SCHEDULE: 38,
  LIST_OF_OBJECT_PROPERTY_REFERENCES: 54,
  MAX_PRES_VALUE: 65,
  MIN_PRES_VALUE: 69,
  MODEL_NAME: 70,
  NUMBER_OF_STATES: 74,
  OBJECT_IDENTIFIER: 75,
  OBJECT_LIST: 76,
  OBJECT_NAME: 77,
  PRESENT_VALUE: 85,
  PRIORITY_ARRAY: 87,
  PRIORITY_FOR_WRITING: 88,
  RELINQUISH_DEFAULT: 104,
  RESOLUTION: 106,
  STATE_TEXT: 110,
  UNITS: 117,
  WEEKLY_SCHEDULE: 123,
  VENDOR_IDENTIFIER: 120,
  VENDOR_NAME: 121,
  SCHEDULE_DEFAULT: 174
};

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function pointId(deviceId, type, instance) {
  return `bacnet_${deviceId}_${type}_${instance}`;
}

export function pointTopic(deviceId, type, instance) {
  return `${BASE_TOPIC}/${deviceId}/${type}/${instance}`;
}

export function pointKey(deviceId, type, instance) {
  return `${deviceId}/${type}/${instance}`;
}

export function normalizeAddress(address) {
  if (!address) return null;
  if (typeof address === "string") return { address };
  if (typeof address === "object") return address;
  return null;
}
