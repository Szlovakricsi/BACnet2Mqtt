import fs from "node:fs/promises";
import { connect as mqttConnect } from "mqtt";
import { BASE_TOPIC } from "./constants.js";
import { Gateway } from "./gateway.js";
import { HomeAssistantBacnetBridge } from "./ha-bacnet.js";
import { installFrontendCardWithRetry } from "./frontend.js";
import { startWebServer } from "./web.js";

const OPTIONS_FILE = "/data/options.json";

async function readOptions() {
  const raw = await fs.readFile(OPTIONS_FILE, "utf8");
  const options = JSON.parse(raw);

  options.mqtt_port = Number(options.mqtt_port || 1883);
  options.bacnet_port = Number(options.bacnet_port || 47808);
  options.apdu_timeout = Number(options.apdu_timeout || 6000);
  options.write_priority = Number(options.write_priority || 16);
  options.scan_timeout = Number(options.scan_timeout || 5);
  options.health_interval = Number(options.health_interval || 10);
  options.poll_interval = Number(options.poll_interval || 60);
  options.read_concurrency = Number(options.read_concurrency || 8);
  options.cov_lifetime = Number(options.cov_lifetime || 300);
  options.cov_renew_percent = Number(options.cov_renew_percent || 80);
  options.cov_subscribe_delay_ms = Number(options.cov_subscribe_delay_ms || 30);
  options.cov_enabled = options.cov_enabled !== false;

  return options;
}

const options = await readOptions();

let gateway = null;
let haBacnet = null;
let startingGateway = false;
let shuttingDown = false;

const webServer = startWebServer({
  getGateway: () => gateway,
  getHaBacnet: () => haBacnet,
  options
});

// Install/register the bundled Lovelace card independently of BACnet/MQTT
// configuration. This also updates an older manually registered
// /local/bacnet-schedule-card.js resource when present.
void installFrontendCardWithRetry()
  .then(async () => {
    if (gateway) {
      await gateway.publishRestartUpdateState().catch(() => {});
    }
  })
  .catch(err => {
    console.error(
      "[FRONTEND]",
      err?.stack || err?.message || err
    );
  });

const requiredAddressOptions = [
  ["mqtt_host", "MQTT broker"],
  ["bacnet_interface", "BACnet local interface"],
  ["bacnet_broadcast", "BACnet broadcast address"]
];

const missingAddressOptions =
  requiredAddressOptions.filter(
    ([key]) => !String(options[key] ?? "").trim()
  );

if (missingAddressOptions.length) {
  console.error("");
  console.error("[CONFIG] BACnet2MQTT is not configured yet.");
  console.error(
    "[CONFIG] Set the following fields in the App Configuration tab:"
  );

  for (const [key, label] of missingAddressOptions) {
    console.error(`[CONFIG]   - ${label} (${key})`);
  }

  console.error("[CONFIG] Save the configuration and restart the App.");
  console.error("");

  // Keep the container alive so the configuration/log page remains
  // available instead of entering a Supervisor restart loop.
  await new Promise(() => {});
}

const mqttUrl = `mqtt://${options.mqtt_host}:${options.mqtt_port}`;

const mqttOptions = {
  clientId: `bacnet2mqtt-ha-app-${Math.random().toString(16).slice(2, 10)}`,
  clean: true,
  reconnectPeriod: 3000,
  connectTimeout: 10000,
  will: {
    topic: `${BASE_TOPIC}/driver/status`,
    payload: Buffer.from("offline"),
    qos: 0,
    retain: true
  }
};

if (options.mqtt_username) mqttOptions.username = options.mqtt_username;
if (options.mqtt_password) mqttOptions.password = options.mqtt_password;

const mqtt = mqttConnect(mqttUrl, mqttOptions);

mqtt.on("error", err => {
  console.error("[MQTT]", err?.message || err);
});

mqtt.on("reconnect", () => {
  console.log("[MQTT] reconnecting...");
});

mqtt.on("connect", async () => {
  console.log(`[MQTT] connected to ${mqttUrl}`);

  mqtt.publish(
    `${BASE_TOPIC}/driver/status`,
    "online",
    { qos: 0, retain: true }
  );

  mqtt.subscribe([
    `${BASE_TOPIC}/control/scan`,
    `${BASE_TOPIC}/control/read`,
    `${BASE_TOPIC}/control/homeassistant-restart`,
    `${BASE_TOPIC}/+/+/+/set`,
    `${BASE_TOPIC}/+/17/+/schedule/set/+`,
    "homeassistant/status"
  ]);

  try {
    if (!gateway && !startingGateway) {
      startingGateway = true;
      gateway = new Gateway(options, mqtt);
      await gateway.start();

      // Reuse the Gateway's already-bound BACnet/IP client/socket for the
      // reverse Home Assistant -> BACnet virtual device. This avoids a second
      // UDP/47808 listener and keeps both directions in one driver instance.
      haBacnet = new HomeAssistantBacnetBridge(
        options,
        gateway.bacnet,
        gateway.log
      );
      await haBacnet.start();

      startingGateway = false;
    } else if (gateway) {
      await gateway.republishDiscovery();
      if (haBacnet) {
        await haBacnet.refreshStates().catch(() => {});
      }
    }
  } catch (err) {
    startingGateway = false;
    console.error("[STARTUP]", err?.stack || err?.message || err);
  }
});

mqtt.on("message", async (topic, payload) => {
  if (!gateway) return;

  try {
    await gateway.onMqttMessage(topic, payload);
  } catch (err) {
    console.error("[MQTT MESSAGE]", err?.stack || err?.message || err);
  }
});

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`Received ${signal}, shutting down...`);

  try {
    if (haBacnet) await haBacnet.stop();
  } catch {}

  try {
    if (gateway) await gateway.stop();
  } catch {}

  // Graceful shutdown. Unexpected loss is handled by MQTT Last Will.
  try {
    await new Promise(resolve => {
      mqtt.publish(
        `${BASE_TOPIC}/driver/status`,
        "offline",
        { qos: 0, retain: true },
        () => resolve()
      );
    });
  } catch {}

  try {
    await new Promise(resolve => mqtt.end(false, {}, resolve));
  } catch {}

  try {
    await new Promise(resolve => webServer.close(resolve));
  } catch {}

  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
