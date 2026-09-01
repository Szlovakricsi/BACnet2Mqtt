import fs from "node:fs/promises";
import path from "node:path";
import WebSocket from "ws";
import { VERSION } from "./constants.js";

const CARD_VERSION = "0.3.3";
const BUNDLED_CARD = "/app/frontend/bacnet-schedule-card.js";
const HA_WWW_DIR = "/homeassistant/www";
const HA_CARD_FILE = path.join(
  HA_WWW_DIR,
  "bacnet-schedule-card.js"
);
const RESOURCE_BASE = "/local/bacnet-schedule-card.js";
const RESOURCE_URL =
  `${RESOURCE_BASE}?v=${CARD_VERSION}`;
const STATE_FILE =
  "/data/frontend-install-state.json";
const RESTART_REQUIRED_FILE =
  "/data/homeassistant-restart-required.json";

function log(level, ...args) {
  const method =
    level === "error"
      ? console.error
      : level === "warn"
        ? console.warn
        : console.log;

  method(
    `[FRONTEND ${level.toUpperCase()}]`,
    ...args
  );
}

async function readJsonFile(file) {
  try {
    return JSON.parse(
      await fs.readFile(file, "utf8")
    );
  } catch {
    return null;
  }
}

async function fileText(file) {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
}

async function copyCard() {
  const bundled =
    await fs.readFile(BUNDLED_CARD, "utf8");

  const existing =
    await fileText(HA_CARD_FILE);

  await fs.mkdir(
    HA_WWW_DIR,
    { recursive: true }
  );

  if (existing === bundled) {
    return false;
  }

  await fs.writeFile(
    HA_CARD_FILE,
    bundled,
    "utf8"
  );

  log(
    "info",
    `Installed Schedule Card v${CARD_VERSION} to ${HA_CARD_FILE}`
  );

  return true;
}

function supervisorToken() {
  const token =
    process.env.SUPERVISOR_TOKEN;

  if (!token) {
    throw new Error(
      "SUPERVISOR_TOKEN is unavailable"
    );
  }

  return token;
}

function wsMessage(
  ws,
  message,
  expectedId = null
) {
  return new Promise((resolve, reject) => {
    const timeout =
      setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `Home Assistant WebSocket timeout for ${message.type}`
          )
        );
      }, 12000);

    const cleanup = () => {
      clearTimeout(timeout);
      ws.off("message", onMessage);
      ws.off("error", onError);
    };

    const onError = err => {
      cleanup();
      reject(err);
    };

    const onMessage = raw => {
      let data;

      try {
        data =
          JSON.parse(
            raw.toString()
          );
      } catch {
        return;
      }

      if (
        expectedId !== null &&
        data.id !== expectedId
      ) {
        return;
      }

      cleanup();
      resolve(data);
    };

    ws.on("message", onMessage);
    ws.on("error", onError);
    ws.send(JSON.stringify(message));
  });
}

async function connectHomeAssistantWs() {
  const token =
    supervisorToken();

  return await new Promise(
    (resolve, reject) => {
      const ws =
        new WebSocket(
          "ws://supervisor/core/websocket"
        );

      const timeout =
        setTimeout(() => {
          try {
            ws.close();
          } catch {}

          reject(
            new Error(
              "Home Assistant WebSocket connection timeout"
            )
          );
        }, 12000);

      const fail = err => {
        clearTimeout(timeout);

        try {
          ws.close();
        } catch {}

        reject(err);
      };

      ws.once("error", fail);

      ws.on("message", raw => {
        let data;

        try {
          data =
            JSON.parse(
              raw.toString()
            );
        } catch {
          return;
        }

        if (
          data.type ===
          "auth_required"
        ) {
          ws.send(
            JSON.stringify({
              type: "auth",
              access_token: token
            })
          );
          return;
        }

        if (
          data.type ===
          "auth_invalid"
        ) {
          fail(
            new Error(
              data.message ||
              "Home Assistant WebSocket authentication failed"
            )
          );
          return;
        }

        if (
          data.type ===
          "auth_ok"
        ) {
          clearTimeout(timeout);
          ws.off("error", fail);
          resolve(ws);
        }
      });
    }
  );
}

function resourceBase(url) {
  return String(url || "")
    .split("?")[0];
}

async function ensureLovelaceResource() {
  const ws =
    await connectHomeAssistantWs();

  try {
    // Always list first. Besides finding an existing entry, this also
    // triggers Home Assistant's lazy resource-store load before create.
    const list =
      await wsMessage(
        ws,
        {
          id: 1,
          type: "lovelace/resources"
        },
        1
      );

    if (
      list.type !== "result" ||
      list.success !== true ||
      !Array.isArray(list.result)
    ) {
      throw new Error(
        `Could not list Lovelace resources: ${
          list.error?.message ||
          JSON.stringify(list)
        }`
      );
    }

    const existing =
      list.result.find(
        item =>
          resourceBase(item.url) ===
          RESOURCE_BASE
      );

    if (existing) {
      if (
        existing.url === RESOURCE_URL &&
        (
          existing.type === "module" ||
          existing.res_type === "module"
        )
      ) {
        return {
          changed: false,
          action: "already registered"
        };
      }

      const update =
        await wsMessage(
          ws,
          {
            id: 2,
            type:
              "lovelace/resources/update",
            resource_id:
              existing.id,
            url:
              RESOURCE_URL,
            res_type:
              "module"
          },
          2
        );

      if (
        update.type !== "result" ||
        update.success !== true
      ) {
        throw new Error(
          `Could not update Lovelace resource: ${
            update.error?.message ||
            JSON.stringify(update)
          }`
        );
      }

      log(
        "info",
        `Updated Lovelace resource to ${RESOURCE_URL}`
      );

      return {
        changed: true,
        action: "updated"
      };
    }

    const create =
      await wsMessage(
        ws,
        {
          id: 3,
          type:
            "lovelace/resources/create",
          url:
            RESOURCE_URL,
          res_type:
            "module"
        },
        3
      );

    if (
      create.type !== "result" ||
      create.success !== true
    ) {
      throw new Error(
        `Could not create Lovelace resource: ${
          create.error?.message ||
          JSON.stringify(create)
        }`
      );
    }

    log(
      "info",
      `Registered Lovelace resource ${RESOURCE_URL}`
    );

    return {
      changed: true,
      action: "created"
    };
  } finally {
    try {
      ws.close();
    } catch {}
  }
}

async function haService(domain, service, data) {
  const token =
    supervisorToken();

  const response =
    await fetch(
      `http://supervisor/core/api/services/${domain}/${service}`,
      {
        method: "POST",
        headers: {
          Authorization:
            `Bearer ${token}`,
          "Content-Type":
            "application/json"
        },
        body:
          JSON.stringify(data)
      }
    );

  if (!response.ok) {
    const body =
      await response.text();

    throw new Error(
      `Home Assistant service ${domain}.${service} failed: ` +
      `${response.status} ${body}`
    );
  }
}

async function dismissLegacyRestartNotification() {
  try {
    await haService(
      "persistent_notification",
      "dismiss",
      {
        notification_id:
          "bacnet2mqtt_restart_required"
      }
    );
  } catch (err) {
    // The old notification may not exist; this is not a startup failure.
    log(
      "debug",
      "Legacy restart notification dismiss skipped:",
      err?.message || err
    );
  }
}

async function markRestartRequired(reason) {
  await fs.writeFile(
    RESTART_REQUIRED_FILE,
    JSON.stringify(
      {
        required: true,
        appVersion: VERSION,
        cardVersion: CARD_VERSION,
        reason,
        createdAt: new Date().toISOString()
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  log(
    "info",
    "Home Assistant restart required flag created"
  );
}

async function saveInstallState() {
  await fs.writeFile(
    STATE_FILE,
    JSON.stringify(
      {
        appVersion: VERSION,
        cardVersion: CARD_VERSION,
        resourceUrl: RESOURCE_URL,
        installedAt:
          new Date().toISOString()
      },
      null,
      2
    ) + "\n",
    "utf8"
  );
}

export async function installFrontendCard() {
  const previous =
    await readJsonFile(
      STATE_FILE
    );

  await dismissLegacyRestartNotification();

  const versionChanged =
    previous?.appVersion !== VERSION ||
    previous?.cardVersion !== CARD_VERSION;

  const fileChanged =
    await copyCard();

  const resource =
    await ensureLovelaceResource();

  await saveInstallState();

  if (
    versionChanged ||
    fileChanged ||
    resource.changed
  ) {
    await markRestartRequired(
      versionChanged
        ? `BACnet2MQTT was updated to ${VERSION}`
        : `BACnet Schedule Card was updated to ${CARD_VERSION}`
    );
  }

  log(
    "info",
    `Schedule Card v${CARD_VERSION}: ${resource.action}`
  );

  return {
    fileChanged,
    resourceChanged:
      resource.changed,
    versionChanged
  };
}

export async function installFrontendCardWithRetry() {
  const delays =
    [0, 3000, 7000, 15000, 30000];

  for (
    let attempt = 0;
    attempt < delays.length;
    attempt++
  ) {
    if (delays[attempt]) {
      await new Promise(
        resolve =>
          setTimeout(
            resolve,
            delays[attempt]
          )
      );
    }

    try {
      return await installFrontendCard();
    } catch (err) {
      const last =
        attempt ===
        delays.length - 1;

      log(
        last ? "error" : "warn",
        `Frontend install attempt ${attempt + 1}/${delays.length} failed:`,
        err?.message || err
      );

      if (last) {
        throw err;
      }
    }
  }
}
