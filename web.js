import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "./constants.js";

const WEB_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../web"
);
const PORT = 8099;
const RESTART_REQUIRED_FILE =
  "/data/homeassistant-restart-required.json";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8"
};

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store"
  });
  res.end(payload);
}

function normalizeRemote(address) {
  return String(address || "")
    .replace(/^::ffff:/, "")
    .replace(/^\[|\]$/g, "");
}

function isAllowedIngressClient(req) {
  const remote = normalizeRemote(req.socket?.remoteAddress);
  return ["172.30.32.2", "127.0.0.1", "::1"].includes(remote);
}

async function readJsonBody(req, maxBytes = 64 * 1024) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      throw Object.assign(new Error("Request body is too large"), { statusCode: 413 });
    }
    chunks.push(chunk);
  }

  if (!chunks.length) return {};

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("Invalid JSON body"), { statusCode: 400 });
  }
}

async function restartRequiredState() {
  try {
    const raw =
      await fs.readFile(
        RESTART_REQUIRED_FILE,
        "utf8"
      );

    const parsed = JSON.parse(raw);

    return {
      required:
        parsed?.required === true,
      reason:
        parsed?.reason || null,
      createdAt:
        parsed?.createdAt || null,
      appVersion:
        parsed?.appVersion || null
    };
  } catch (err) {
    if (err?.code !== "ENOENT") {
      console.warn(
        "[WEB] Could not read restart-required state:",
        err?.message || err
      );
    }

    return {
      required: false,
      reason: null,
      createdAt: null,
      appVersion: null
    };
  }
}

async function clearRestartRequired() {
  try {
    await fs.unlink(
      RESTART_REQUIRED_FILE
    );
  } catch (err) {
    if (err?.code !== "ENOENT") {
      throw err;
    }
  }
}

async function restartHomeAssistant() {
  const token =
    process.env.SUPERVISOR_TOKEN;

  if (!token) {
    throw new Error(
      "SUPERVISOR_TOKEN is unavailable"
    );
  }

  // Clear the flag before requesting the restart. If the request fails
  // synchronously, the flag is restored below so the user can retry.
  const existing =
    await restartRequiredState();

  await clearRestartRequired();

  try {
    const response =
      await fetch(
        "http://supervisor/core/restart",
        {
          method: "POST",
          headers: {
            Authorization:
              `Bearer ${token}`,
            "Content-Type":
              "application/json"
          },
          body: "{}"
        }
      );

    if (!response.ok) {
      const body =
        await response.text();

      throw new Error(
        `Supervisor core restart failed: ${response.status} ${body}`
      );
    }
  } catch (err) {
    if (existing.required) {
      await fs.writeFile(
        RESTART_REQUIRED_FILE,
        JSON.stringify(
          {
            ...existing,
            required: true
          },
          null,
          2
        ) + "\\n",
        "utf8"
      );
    }

    throw err;
  }
}

function requireGateway(getGateway) {
  const gateway = getGateway();
  if (!gateway) {
    throw Object.assign(
      new Error("BACnet gateway is still starting or not configured"),
      { statusCode: 503 }
    );
  }
  return gateway;
}

function parsePointPath(pathname) {
  const match = pathname.match(
    /^\/api\/devices\/(\d+)\/points\/(\d+)\/(\d+)(?:\/(value|reset))?$/
  );
  if (!match) return null;
  return {
    deviceId: Number(match[1]),
    type: Number(match[2]),
    instance: Number(match[3]),
    action: match[4] || null
  };
}

async function handleApi(req, res, url, getGateway, options) {
  const pathname = url.pathname;

  if (req.method === "GET" && pathname === "/api/status") {
    const gateway = getGateway();
    const restart =
      await restartRequiredState();

    return json(res, 200, {
      ok: true,
      version: VERSION,
      ready: Boolean(gateway),
      scanRunning: gateway?.scanRunning === true,
      pollRunning: gateway?.pollRunning === true,
      mqttHostConfigured: Boolean(String(options.mqtt_host || "").trim()),
      bacnetInterfaceConfigured: Boolean(String(options.bacnet_interface || "").trim()),
      homeAssistantRestartRequired:
        restart.required,
      homeAssistantRestartReason:
        restart.reason,
      homeAssistantRestartCreatedAt:
        restart.createdAt
    });
  }

  if (
    req.method === "POST" &&
    pathname === "/api/homeassistant/restart"
  ) {
    await restartHomeAssistant();

    return json(res, 202, {
      ok: true,
      restarting: true
    });
  }

  const gateway = requireGateway(getGateway);

  if (req.method === "GET" && pathname === "/api/devices") {
    return json(res, 200, {
      ...gateway.uiDeviceList(),
      scanRunning: gateway.scanRunning === true
    });
  }

  const devicePoints = pathname.match(/^\/api\/devices\/(\d+)\/points$/);
  if (req.method === "GET" && devicePoints) {
    const deviceId = Number(devicePoints[1]);
    const points = gateway.uiPoints(deviceId);
    if (!points) return json(res, 404, { error: "Device not found" });
    return json(res, 200, { deviceId, points });
  }

  const scheduleWeek =
    pathname.match(
      /^\/api\/devices\/(\d+)\/schedules\/(\d+)\/week$/
    );

  if (req.method === "POST" && scheduleWeek) {
    const deviceId = Number(scheduleWeek[1]);
    const instance = Number(scheduleWeek[2]);
    const body = await readJsonBody(req, 256 * 1024);
    const point = await gateway.uiWriteScheduleWeek(
      deviceId,
      instance,
      body.payload
    );
    return json(res, 200, { ok: true, point });
  }

  const renameDevice = pathname.match(/^\/api\/devices\/(\d+)$/);
  if (req.method === "PUT" && renameDevice) {
    const deviceId = Number(renameDevice[1]);
    const body = await readJsonBody(req);
    const device = await gateway.uiRenameDevice(deviceId, body.name);
    return json(res, 200, { ok: true, device });
  }

  if (req.method === "DELETE" && renameDevice) {
    const deviceId = Number(renameDevice[1]);
    await gateway.uiDeleteDevice(deviceId);
    return json(res, 200, { ok: true });
  }

  const restoreDevice = pathname.match(/^\/api\/devices\/(\d+)\/restore$/);
  if (req.method === "POST" && restoreDevice) {
    const deviceId = Number(restoreDevice[1]);
    await gateway.uiRestoreDevice(deviceId);
    return json(res, 200, { ok: true });
  }

  const readDevice = pathname.match(/^\/api\/devices\/(\d+)\/read$/);
  if (req.method === "POST" && readDevice) {
    const deviceId = Number(readDevice[1]);
    await gateway.uiReadDevice(deviceId);
    return json(res, 200, { ok: true });
  }

  const pointPath = parsePointPath(pathname);
  if (pointPath && req.method === "PUT" && pointPath.action === null) {
    const body = await readJsonBody(req);
    const point = await gateway.uiUpdatePoint(
      pointPath.deviceId,
      pointPath.type,
      pointPath.instance,
      body
    );
    return json(res, 200, { ok: true, point });
  }

  if (pointPath && req.method === "POST" && pointPath.action === "reset") {
    const point = await gateway.uiResetPoint(
      pointPath.deviceId,
      pointPath.type,
      pointPath.instance
    );
    return json(res, 200, { ok: true, point });
  }

  if (pointPath && req.method === "POST" && pointPath.action === "value") {
    const body = await readJsonBody(req);
    const point = await gateway.uiWritePoint(
      pointPath.deviceId,
      pointPath.type,
      pointPath.instance,
      body.value,
      body.release === true
    );
    return json(res, 200, { ok: true, point });
  }

  if (req.method === "POST" && pathname === "/api/scan") {
    if (gateway.scanRunning) {
      return json(res, 409, { error: "BACnet scan is already running" });
    }
    void gateway.scan().catch(err => {
      gateway.log.error("Ingress scan:", err?.message || err);
    });
    return json(res, 202, { ok: true, started: true });
  }

  if (req.method === "POST" && pathname === "/api/read") {
    void gateway.fullReadAll().catch(err => {
      gateway.log.error("Ingress read:", err?.message || err);
    });
    return json(res, 202, { ok: true, started: true });
  }

  return json(res, 404, { error: "API endpoint not found" });
}

async function serveStatic(res, pathname) {
  const routes = {
    "/": "index.html",
    "/index.html": "index.html",
    "/app.js": "app.js",
    "/styles.css": "styles.css",
    "/icon.png": "icon.png"
  };

  const filename = routes[pathname];
  if (!filename) return false;

  const filePath = path.join(WEB_ROOT, filename);
  const data = await fs.readFile(filePath);
  const ext = path.extname(filename).toLowerCase();

  res.writeHead(200, {
    "content-type": MIME[ext] || "application/octet-stream",
    "content-length": data.length,
    "cache-control": ["index.html", "app.js", "styles.css"].includes(filename)
      ? "no-store"
      : "public, max-age=3600"
  });
  res.end(data);
  return true;
}

export function startWebServer({ getGateway, options }) {
  const server = http.createServer(async (req, res) => {
    try {
      if (!isAllowedIngressClient(req)) {
        return json(res, 403, { error: "Ingress access only" });
      }

      const host = req.headers.host || "localhost";
      const url = new URL(req.url || "/", `http://${host}`);

      if (url.pathname.startsWith("/api/")) {
        return await handleApi(req, res, url, getGateway, options);
      }

      if (await serveStatic(res, url.pathname)) return;
      return json(res, 404, { error: "Not found" });
    } catch (err) {
      const status = Number(err?.statusCode) || 500;
      console.error("[WEB]", err?.stack || err?.message || err);
      return json(res, status, {
        error: err?.message || "Internal server error"
      });
    }
  });

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`[WEB] BACnet2MQTT Ingress UI listening on port ${PORT}`);
  });

  return server;
}
