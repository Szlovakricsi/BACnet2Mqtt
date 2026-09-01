(() => {
  console.info("[BACnet2MQTT Web UI] v0.3.3 loaded");
  const state = {
    status: null,
    devices: [],
    hidden: [],
    selectedDeviceId: null,
    points: [],
    loadingPoints: false,
    scanRunning: false,
    liveTimer: null,
    deviceTimer: null,
    scheduleEditor: {
      pointKey: null,
      grid: null,
      selected: null,
      dirty: false
    }
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  const els = {
    gatewayBadge: $("#gatewayBadge"),
    webUiVersion: $("#webUiVersion"),
    scanBtn: $("#scanBtn"),
    readAllBtn: $("#readAllBtn"),
    deviceCount: $("#deviceCount"),
    onlineCount: $("#onlineCount"),
    offlineCount: $("#offlineCount"),
    deviceSearch: $("#deviceSearch"),
    deviceList: $("#deviceList"),
    deletedSection: $("#deletedSection"),
    deletedCount: $("#deletedCount"),
    deletedList: $("#deletedList"),
    emptyState: $("#emptyState"),
    deviceContent: $("#deviceContent"),
    selectedOnlineDot: $("#selectedOnlineDot"),
    selectedOnlineText: $("#selectedOnlineText"),
    selectedDeviceName: $("#selectedDeviceName"),
    selectedDeviceId: $("#selectedDeviceId"),
    selectedDeviceMeta: $("#selectedDeviceMeta"),
    readDeviceBtn: $("#readDeviceBtn"),
    renameDeviceBtn: $("#renameDeviceBtn"),
    deleteDeviceBtn: $("#deleteDeviceBtn"),
    pointSearch: $("#pointSearch"),
    typeFilter: $("#typeFilter"),
    writableOnly: $("#writableOnly"),
    pointCount: $("#pointCount"),
    totalPointStat: $("#totalPointStat"),
    writablePointStat: $("#writablePointStat"),
    overridePointStat: $("#overridePointStat"),
    pointsList: $("#pointsList"),
    renameDialog: $("#renameDialog"),
    renameForm: $("#renameForm"),
    renameInput: $("#renameInput"),
    deleteDialog: $("#deleteDialog"),
    deleteForm: $("#deleteForm"),
    deleteMessage: $("#deleteMessage"),
    scheduleDialog: $("#scheduleDialog"),
    scheduleCloseBtn: $("#scheduleCloseBtn"),
    scheduleCancelBtn: $("#scheduleCancelBtn"),
    scheduleDeviceName: $("#scheduleDeviceName"),
    scheduleTitle: $("#scheduleTitle"),
    scheduleObjectId: $("#scheduleObjectId"),
    scheduleMeta: $("#scheduleMeta"),
    schedulePresentValue: $("#schedulePresentValue"),
    scheduleLegend: $("#scheduleLegend"),
    scheduleGridBody: $("#scheduleGridBody"),
    scheduleNumericEditor: $("#scheduleNumericEditor"),
    scheduleNumericSlot: $("#scheduleNumericSlot"),
    scheduleNumericInput: $("#scheduleNumericInput"),
    scheduleNumericApply: $("#scheduleNumericApply"),
    scheduleNumericClear: $("#scheduleNumericClear"),
    scheduleCopyMonday: $("#scheduleCopyMonday"),
    scheduleClearWeek: $("#scheduleClearWeek"),
    scheduleSaveStatus: $("#scheduleSaveStatus"),
    scheduleSaveBtn: $("#scheduleSaveBtn"),
    scheduleError: $("#scheduleError"),
    toastHost: $("#toastHost")
  };

  function api(path, options = {}) {
    return fetch(`.${path}`, {
      ...options,
      headers: {
        "content-type": "application/json",
        ...(options.headers || {})
      }
    }).then(async response => {
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      return data;
    });
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function toast(message, kind = "success") {
    const node = document.createElement("div");
    node.className = `toast ${kind}`;
    node.textContent = message;
    els.toastHost.appendChild(node);
    setTimeout(() => node.remove(), 3600);
  }

  function selectedDevice() {
    return state.devices.find(d => Number(d.deviceId) === Number(state.selectedDeviceId)) || null;
  }

  function setGatewayBadge(ready) {
    els.gatewayBadge.className = `status-pill ${ready ? "online" : "error"}`;
    $("span:last-child", els.gatewayBadge).textContent = ready ? `Gateway online · v${state.status?.version || ""}` : "Gateway not ready";
  }


  async function refreshStatus() {
    try {
      state.status = await api("/api/status");
      setGatewayBadge(state.status.ready);
      if (els.webUiVersion) {
        els.webUiVersion.textContent =
          `BACnet workspace · Web UI v${state.status?.version || "0.3.3"}`;
      }
    } catch (err) {
      els.gatewayBadge.className = "status-pill error";
      $("span:last-child", els.gatewayBadge).textContent = "Ingress connection error";
    }
  }

  async function refreshDevices({ preserve = true } = {}) {
    try {
      const data = await api("/api/devices");
      state.devices = data.devices || [];
      state.hidden = data.hidden || [];
      state.scanRunning = data.scanRunning === true;
      els.scanBtn.disabled = state.scanRunning;
      els.scanBtn.textContent = state.scanRunning ? "Scanning…" : "Scan BACnet";

      if (state.selectedDeviceId && !state.devices.some(d => Number(d.deviceId) === Number(state.selectedDeviceId))) {
        state.selectedDeviceId = null;
        state.points = [];
      }

      renderDevices();
      renderDeleted();
      renderSelectedHeader();

      if (!preserve && !state.selectedDeviceId && state.devices.length === 1) {
        await selectDevice(state.devices[0].deviceId);
      }
    } catch (err) {
      if (!String(err.message).includes("still starting")) toast(err.message, "error");
    }
  }

  function renderDevices() {
    const query = els.deviceSearch.value.trim().toLowerCase();
    const visible = state.devices.filter(device => {
      const hay = `${device.name} ${device.sourceName || ""} ${device.deviceId} ${device.address || ""} ${device.modelName || ""}`.toLowerCase();
      return !query || hay.includes(query);
    });

    els.deviceCount.textContent = state.devices.length;
    els.onlineCount.textContent =
      state.devices.filter(device => device.online).length;
    els.offlineCount.textContent =
      state.devices.filter(device => !device.online).length;

    if (!visible.length) {
      els.deviceList.innerHTML = `<div class="no-points">${state.devices.length ? "No matching devices" : "No BACnet devices discovered"}</div>`;
      return;
    }

    els.deviceList.innerHTML = visible.map(device => `
      <button class="device-item ${Number(device.deviceId) === Number(state.selectedDeviceId) ? "selected" : ""}" type="button" data-device-id="${device.deviceId}">
        <span class="online-dot ${device.online ? "online" : ""}" title="${device.online ? "Online" : "Offline"}"></span>
        <span>
          <span class="device-name">${escapeHtml(device.name)}</span>
          <span class="device-sub">ID ${device.deviceId}${device.address ? ` · ${escapeHtml(device.address)}` : ""}</span>
        </span>
        <span class="device-points">${device.pointCount}</span>
      </button>
    `).join("");

    $$("[data-device-id]", els.deviceList).forEach(button => {
      button.addEventListener("click", () => selectDevice(Number(button.dataset.deviceId)));
    });
  }

  function renderDeleted() {
    els.deletedCount.textContent = state.hidden.length;
    els.deletedSection.style.display = state.hidden.length ? "block" : "none";
    els.deletedList.innerHTML = state.hidden.map(device => `
      <div class="deleted-item">
        <span>${escapeHtml(device.name || `Device ${device.deviceId}`)} · ID ${device.deviceId}</span>
        <button class="btn secondary small" type="button" data-restore-id="${device.deviceId}">Restore</button>
      </div>
    `).join("");

    $$("[data-restore-id]", els.deletedList).forEach(button => {
      button.addEventListener("click", async () => {
        button.disabled = true;
        try {
          toast(`Restoring device ${button.dataset.restoreId}; BACnet scan started.`);
          await api(`/api/devices/${button.dataset.restoreId}/restore`, { method: "POST", body: "{}" });
          await refreshDevices();
        } catch (err) {
          toast(err.message, "error");
        } finally {
          button.disabled = false;
        }
      });
    });
  }

  async function selectDevice(deviceId) {
    state.selectedDeviceId = Number(deviceId);
    state.points = [];
    renderDevices();
    renderSelectedHeader();
    await loadPoints();
  }

  function renderSelectedHeader() {
    const device = selectedDevice();
    els.emptyState.classList.toggle("hidden", Boolean(device));
    els.deviceContent.classList.toggle("hidden", !device);
    if (!device) return;

    els.selectedDeviceName.textContent = device.name;
    els.selectedDeviceId.textContent = `Device ${device.deviceId}`;
    els.selectedOnlineDot.className = `online-dot ${device.online ? "online" : ""}`;
    els.selectedOnlineText.textContent = device.online ? "Online" : "Offline";
    els.selectedDeviceMeta.textContent = [
      device.online ? "Online" : "Offline",
      device.address,
      device.modelName,
      device.vendorName
    ].filter(Boolean).join(" · ");
  }

  async function loadPoints({ quiet = false } = {}) {
    if (!state.selectedDeviceId || state.loadingPoints) return;
    state.loadingPoints = true;
    if (!quiet) els.pointsList.innerHTML = `<div class="no-points">Reading points…</div>`;

    try {
      const data = await api(`/api/devices/${state.selectedDeviceId}/points`);
      state.points = data.points || [];
      rebuildTypeFilter();
      renderPoints();
    } catch (err) {
      if (!quiet) els.pointsList.innerHTML = `<div class="no-points">${escapeHtml(err.message)}</div>`;
    } finally {
      state.loadingPoints = false;
    }
  }

  function rebuildTypeFilter() {
    const previous = els.typeFilter.value;
    const types = [...new Map(state.points.map(point => [point.type, point.typeName])).entries()].sort((a,b) => a[0]-b[0]);
    els.typeFilter.innerHTML = `<option value="all">All object types</option>` + types.map(([type, name]) => `<option value="${type}">${escapeHtml(name)}</option>`).join("");
    if ([...els.typeFilter.options].some(o => o.value === previous)) els.typeFilter.value = previous;
  }

  function filteredPoints() {
    const query = els.pointSearch.value.trim().toLowerCase();
    const type = els.typeFilter.value;
    const writableOnly = els.writableOnly.checked;

    return state.points.filter(point => {
      if (type !== "all" && String(point.type) !== type) return false;
      if (writableOnly && !point.writable) return false;
      if (!query) return true;
      const hay = `${point.name} ${point.sourceName || ""} ${point.typeName} ${point.type}/${point.instance}`.toLowerCase();
      return hay.includes(query);
    });
  }

  function displayValue(point) {
    if (Number(point.type) === 17 && point.schedule) {
      return point.schedule.presentText ||
        (point.schedule.presentValue === null || point.schedule.presentValue === undefined
          ? "—"
          : String(point.schedule.presentValue));
    }
    if (point.value === null || point.value === undefined || point.value === "") return "—";
    if (point.states && point.states[String(Number(point.value))] !== undefined) {
      return `${point.states[String(Number(point.value))]} (${point.value})`;
    }
    if ([3,4,5].includes(Number(point.type))) return Number(point.value) ? "1 / ON" : "0 / OFF";
    if (typeof point.value === "object") return JSON.stringify(point.value);
    return String(point.value);
  }

  function valueControl(point) {
    if (Number(point.type) === 17) {
      return `<button class="btn accent small edit-schedule" type="button">Edit schedule</button>`;
    }

    if (!point.writable) return `<span class="readonly-tag">Read only</span>`;

    if ([1,2].includes(Number(point.type))) {
      return `
        <input class="number-control write-value" type="number" value="${escapeHtml(point.value ?? "")}" ${point.min !== null ? `min="${point.min}"` : ""} ${point.max !== null ? `max="${point.max}"` : ""} ${point.step !== null ? `step="${point.step}"` : `step="any"`} aria-label="New value">
        <button class="btn accent small set-value" type="button">Set</button>
        <button class="btn secondary small release-value" type="button">Release</button>`;
    }

    if ([4,5].includes(Number(point.type))) {
      const on = Number(point.value) === 1;
      return `
        <button class="btn secondary small binary-toggle ${on ? "on" : "off"}" type="button" data-next="${on ? 0 : 1}">${on ? "1 · ON" : "0 · OFF"}</button>
        <button class="btn secondary small release-value" type="button">Release</button>`;
    }

    if ([14,19].includes(Number(point.type))) {
      const options = Object.entries(point.states || {}).sort((a,b) => Number(a[0])-Number(b[0]));
      return `
        <select class="select-control write-select" aria-label="New state">
          ${options.map(([value,name]) => `<option value="${escapeHtml(value)}" ${Number(value) === Number(point.value) ? "selected" : ""}>${escapeHtml(name)} (${value})</option>`).join("")}
        </select>
        <button class="btn accent small set-select" type="button">Set</button>
        <button class="btn secondary small release-value" type="button">Release</button>`;
    }

    return `<span class="readonly-tag">No direct control</span>`;
  }

  function scheduleStatesText(config) {
    return (config?.states || [])
      .map(item => `${item.label}=${item.value}`)
      .join("\n");
  }

  function pointSettings(point) {
    const analog = point.analog;

    if (Number(point.type) === 17) {
      const cfg = point.schedule?.config || {};
      return `
        <label class="field-label">Display name
          <input class="text-control cfg-name" type="text" maxlength="120" value="${escapeHtml(point.name)}">
          <span class="field-hint">BACnet: ${escapeHtml(point.sourceName || "—")}</span>
        </label>
        <label class="field-label">Schedule mode
          <select class="select-control cfg-schedule-mode">
            ${["binary","states","number"].map(value => `<option value="${value}" ${cfg.mode === value ? "selected" : ""}>${value === "binary" ? "Binary ON / OFF" : value === "states" ? "Named states" : "Numeric"}</option>`).join("")}
          </select>
          <span class="field-hint">Controls how Schedule values are displayed and edited.</span>
        </label>
        <label class="field-label">BACnet value type
          <select class="select-control cfg-schedule-value-type">
            ${[
              ["auto","Auto"],
              ["enumerated","Enumerated"],
              ["boolean","Boolean"],
              ["real","REAL"],
              ["unsigned","Unsigned integer"],
              ["signed","Signed integer"]
            ].map(([value,label]) => `<option value="${value}" ${String(cfg.valueType || "auto") === value ? "selected" : ""}>${label}</option>`).join("")}
          </select>
          <span class="field-hint">BACnet application datatype used when writing Weekly_Schedule.</span>
        </label>
        <label class="field-label">ON text
          <input class="text-control cfg-schedule-on-text" type="text" value="${escapeHtml(cfg.onText || "ON")}">
          <span class="field-hint">Text shown in the card.</span>
        </label>
        <label class="field-label">ON value
          <input class="text-control cfg-schedule-on-value" type="text" value="${escapeHtml(cfg.onValue ?? "1")}">
          <span class="field-hint">Raw BACnet value, normally 1.</span>
        </label>
        <label class="field-label">OFF text
          <input class="text-control cfg-schedule-off-text" type="text" value="${escapeHtml(cfg.offText || "OFF")}">
          <span class="field-hint">Text shown in the card.</span>
        </label>
        <label class="field-label">OFF value
          <input class="text-control cfg-schedule-off-value" type="text" value="${escapeHtml(cfg.offValue ?? "0")}">
          <span class="field-hint">Raw BACnet value, normally 0.</span>
        </label>
        <label class="field-label">NULL / empty text
          <input class="text-control cfg-schedule-null-text" type="text" value="${escapeHtml(cfg.nullText || "Empty")}">
          <span class="field-hint">Shown for a half-hour without an event.</span>
        </label>
        <label class="field-label">Unit
          <input class="text-control cfg-schedule-unit" type="text" value="${escapeHtml(cfg.unit || "")}" placeholder="e.g. °C">
          <span class="field-hint">Optional display unit for numeric schedules.</span>
        </label>
        <label class="field-label">Minimum
          <input class="number-control cfg-schedule-min" type="number" step="any" value="${cfg.min ?? ""}">
        </label>
        <label class="field-label">Maximum
          <input class="number-control cfg-schedule-max" type="number" step="any" value="${cfg.max ?? ""}">
        </label>
        <label class="field-label">Step
          <input class="number-control cfg-schedule-step" type="number" min="0" step="any" value="${cfg.step ?? ""}">
        </label>
        <label class="field-label schedule-states-field">Named states
          <textarea class="text-control cfg-schedule-states" rows="4" placeholder="OFF=0&#10;ON=1&#10;AUTO=3">${escapeHtml(scheduleStatesText(cfg))}</textarea>
          <span class="field-hint">One state per line: Display text=raw BACnet value.</span>
        </label>
        <div class="settings-actions schedule-settings-actions">
          <button class="btn accent small save-config" type="button">Save</button>
          <button class="btn secondary small reset-config" type="button">Reset to BACnet</button>
        </div>`;
    }

    return `
      <label class="field-label">Display name
        <input class="text-control cfg-name" type="text" maxlength="120" value="${escapeHtml(point.name)}">
        <span class="field-hint">BACnet: ${escapeHtml(point.sourceName || "—")}</span>
      </label>
      ${analog ? `
        <label class="field-label">Minimum
          <input class="number-control cfg-min" type="number" step="any" value="${point.min ?? ""}">
          <span class="field-hint">BACnet: ${point.sourceMin ?? "—"}</span>
        </label>
        <label class="field-label">Maximum
          <input class="number-control cfg-max" type="number" step="any" value="${point.max ?? ""}">
          <span class="field-hint">BACnet: ${point.sourceMax ?? "—"}</span>
        </label>
        <label class="field-label">Step
          <input class="number-control cfg-step" type="number" min="0" step="any" value="${point.step ?? ""}">
          <span class="field-hint">BACnet: ${point.sourceStep ?? "—"}</span>
        </label>` : `
        <div class="field-label"><span>Minimum / Maximum / Step</span><span class="field-hint">Not applicable to ${escapeHtml(point.typeName)}</span></div>`}
      <div class="settings-actions">
        <button class="btn accent small save-config" type="button">Save</button>
        <button class="btn secondary small reset-config" type="button">Reset to BACnet</button>
      </div>`;
  }

  function renderPointStats() {
    els.totalPointStat.textContent =
      state.points.length;

    els.writablePointStat.textContent =
      state.points.filter(
        point => point.writable
      ).length;

    els.overridePointStat.textContent =
      state.points.filter(
        point => point.overridden
      ).length;
  }

  function renderPoints() {
    renderPointStats();
    const points = filteredPoints();
    els.pointCount.textContent = points.length;

    if (!points.length) {
      els.pointsList.innerHTML = `<div class="no-points">No data points match the current filter.</div>`;
      return;
    }

    els.pointsList.innerHTML = points.map(point => `
      <article class="point-card" data-point-key="${point.key}" data-type="${point.type}" data-instance="${point.instance}">
        <div class="point-main">
          <div class="point-identity">
            <div class="point-name-line">
              <span class="point-name">${escapeHtml(point.name)}</span>
              ${point.writable ? `<span class="write-chip">WRITABLE</span>` : ""}
              ${point.overridden ? `<span class="override-chip">OVERRIDE</span>` : ""}
            </div>
            <div class="point-object">${point.type}:${point.instance}</div>
          </div>
          <div class="point-type">${escapeHtml(point.typeName)}</div>
          <div class="current-value">
            <div class="value-label">Current value</div>
            <div class="value-text" data-live-value>${escapeHtml(displayValue(point))}${point.unit ? `<span class="unit">${escapeHtml(point.unit)}</span>` : ""}</div>
          </div>
          <div class="point-control">${valueControl(point)}</div>
          <button class="btn secondary settings-toggle" type="button" aria-label="Point settings">⋯</button>
        </div>
        <div class="point-settings">${pointSettings(point)}</div>
      </article>
    `).join("");

    bindPointEvents();
  }

  function pointFromCard(card) {
    return state.points.find(point => point.key === card.dataset.pointKey);
  }

  function bindPointEvents() {
    $$(".point-card", els.pointsList).forEach(card => {
      const point = pointFromCard(card);
      if (!point) return;

      $(".settings-toggle", card).addEventListener("click", () => card.classList.toggle("open"));

      const editSchedule = $(".edit-schedule", card);
      if (editSchedule) editSchedule.addEventListener("click", () => openScheduleEditor(point));

      const setButton = $(".set-value", card);
      if (setButton) setButton.addEventListener("click", () => writePoint(card, $(".write-value", card).value, false));

      const binary = $(".binary-toggle", card);
      if (binary) binary.addEventListener("click", () => writePoint(card, binary.dataset.next, false));

      const setSelect = $(".set-select", card);
      if (setSelect) setSelect.addEventListener("click", () => writePoint(card, $(".write-select", card).value, false));

      const release = $(".release-value", card);
      if (release) release.addEventListener("click", () => writePoint(card, null, true));

      $(".save-config", card).addEventListener("click", () => savePointConfig(card));
      $(".reset-config", card).addEventListener("click", () => resetPointConfig(card));
    });
  }

  async function writePoint(card, value, release) {
    const point = pointFromCard(card);
    if (!point) return;
    const controls = $$("button,input,select", $(".point-control", card));
    controls.forEach(c => c.disabled = true);
    try {
      await api(`/api/devices/${point.deviceId}/points/${point.type}/${point.instance}/value`, {
        method: "POST",
        body: JSON.stringify({ value, release })
      });
      toast(release ? `${point.name}: priority released` : `${point.name}: value written`);
      await loadPoints({ quiet: true });
    } catch (err) {
      toast(err.message, "error");
    } finally {
      controls.forEach(c => c.disabled = false);
    }
  }

  function numberOrNull(input) {
    const value = input.value.trim();
    return value === "" ? null : Number(value);
  }

  async function savePointConfig(card) {
    const point = pointFromCard(card);
    if (!point) return;
    const button = $(".save-config", card);
    button.disabled = true;

    const body = { name: $(".cfg-name", card).value.trim() };
    if (point.analog) {
      body.min = numberOrNull($(".cfg-min", card));
      body.max = numberOrNull($(".cfg-max", card));
      body.step = numberOrNull($(".cfg-step", card));
    }

    if (Number(point.type) === 17) {
      body.schedule = {
        mode: $(".cfg-schedule-mode", card).value,
        valueType: $(".cfg-schedule-value-type", card).value,
        onText: $(".cfg-schedule-on-text", card).value.trim(),
        onValue: $(".cfg-schedule-on-value", card).value.trim(),
        offText: $(".cfg-schedule-off-text", card).value.trim(),
        offValue: $(".cfg-schedule-off-value", card).value.trim(),
        nullText: $(".cfg-schedule-null-text", card).value.trim(),
        unit: $(".cfg-schedule-unit", card).value.trim(),
        min: numberOrNull($(".cfg-schedule-min", card)),
        max: numberOrNull($(".cfg-schedule-max", card)),
        step: numberOrNull($(".cfg-schedule-step", card)),
        states: $(".cfg-schedule-states", card).value
      };
    }

    try {
      await api(`/api/devices/${point.deviceId}/points/${point.type}/${point.instance}`, {
        method: "PUT",
        body: JSON.stringify(body)
      });
      toast(`${point.name}: configuration saved`);
      await loadPoints({ quiet: true });
    } catch (err) {
      toast(err.message, "error");
    } finally {
      button.disabled = false;
    }
  }

  async function resetPointConfig(card) {
    const point = pointFromCard(card);
    if (!point) return;
    const button = $(".reset-config", card);
    button.disabled = true;
    try {
      await api(`/api/devices/${point.deviceId}/points/${point.type}/${point.instance}/reset`, { method: "POST", body: "{}" });
      toast(`${point.name}: BACnet defaults restored`);
      await loadPoints({ quiet: true });
    } catch (err) {
      toast(err.message, "error");
    } finally {
      button.disabled = false;
    }
  }

  async function liveRefresh() {
    if (!state.selectedDeviceId || document.hidden) return;
    if ($("input:focus, select:focus", els.pointsList)) return;

    try {
      const data = await api(`/api/devices/${state.selectedDeviceId}/points`);
      const fresh = data.points || [];
      const freshMap = new Map(fresh.map(point => [point.key, point]));
      let structureChanged = fresh.length !== state.points.length;

      for (const old of state.points) {
        const next = freshMap.get(old.key);
        if (!next || next.name !== old.name || next.writable !== old.writable || next.min !== old.min || next.max !== old.max || next.step !== old.step || JSON.stringify(next.schedule?.config || null) !== JSON.stringify(old.schedule?.config || null)) {
          structureChanged = true;
          break;
        }
      }

      state.points = fresh;

      if (structureChanged) {
        rebuildTypeFilter();
        renderPoints();
        return;
      }

      $$(".point-card", els.pointsList).forEach(card => {
        const point = freshMap.get(card.dataset.pointKey);
        if (!point) return;
        const valueNode = $("[data-live-value]", card);
        if (valueNode) valueNode.innerHTML = `${escapeHtml(displayValue(point))}${point.unit ? `<span class="unit">${escapeHtml(point.unit)}</span>` : ""}`;

        const binary = $(".binary-toggle", card);
        if (binary) {
          const on = Number(point.value) === 1;
          binary.classList.toggle("on", on);
          binary.classList.toggle("off", !on);
          binary.dataset.next = on ? "0" : "1";
          binary.textContent = on ? "1 · ON" : "0 · OFF";
        }

        const select = $(".write-select", card);
        if (select && document.activeElement !== select) select.value = String(point.value ?? "");
      });
    } catch {}
  }

  function scheduleDays() {
    return [
      ["Monday", "monday"],
      ["Tuesday", "tuesday"],
      ["Wednesday", "wednesday"],
      ["Thursday", "thursday"],
      ["Friday", "friday"],
      ["Saturday", "saturday"],
      ["Sunday", "sunday"]
    ];
  }

  function scheduleSlots() {
    const result = [];
    for (let hour = 0; hour < 24; hour++) {
      for (const minute of [0, 30]) {
        result.push(`${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`);
      }
    }
    return result;
  }

  function emptyScheduleGrid() {
    const grid = {};
    for (const [, day] of scheduleDays()) {
      grid[day] = {};
      for (const time of scheduleSlots()) grid[day][time] = null;
    }
    return grid;
  }

  function activeSchedulePoint() {
    return state.points.find(point => point.key === state.scheduleEditor.pointKey) || null;
  }

  function scheduleConfig(point) {
    return point?.schedule?.config || {
      mode: "binary",
      valueType: "enumerated",
      onText: "ON",
      onValue: "1",
      offText: "OFF",
      offValue: "0",
      nullText: "Empty",
      unit: "",
      states: []
    };
  }

  function scheduleOptions(point) {
    const cfg = scheduleConfig(point);
    if (cfg.mode === "binary") {
      return [
        { label: cfg.onText || "ON", value: String(cfg.onValue ?? "1"), kind: "on" },
        { label: cfg.offText || "OFF", value: String(cfg.offValue ?? "0"), kind: "off" }
      ];
    }
    if (cfg.mode === "states") {
      return (cfg.states || []).map(item => ({
        label: String(item.label),
        value: String(item.value),
        kind: "state"
      }));
    }
    return [];
  }

  function scheduleLabel(point, value) {
    const cfg = scheduleConfig(point);
    if (value === null || value === undefined || value === "") return cfg.nullText || "Empty";
    const raw = String(value);
    const option = scheduleOptions(point).find(item => String(item.value) === raw);
    if (option) return option.label;
    return cfg.unit ? `${raw} ${cfg.unit}` : raw;
  }

  function scheduleKind(point, value) {
    if (value === null || value === undefined || value === "") return "empty";
    return scheduleOptions(point).find(item => String(item.value) === String(value))?.kind || "state";
  }

  function parseScheduleWeekly(point) {
    const grid = emptyScheduleGrid();
    const weekly = point?.schedule?.weekly || {};
    for (const [, day] of scheduleDays()) {
      const text = String(weekly[day] || "").trim();
      if (!text || text === "-") continue;
      for (const part of text.split(";")) {
        const match = part.trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*=\s*(.+)$/);
        if (!match) continue;
        const h = Number(match[1]);
        const m = Number(match[2]);
        if (h < 0 || h > 23 || ![0, 30].includes(m)) continue;
        const time = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
        let raw = match[3].trim();
        const cfg = scheduleConfig(point);
        if (raw.toUpperCase() === String(cfg.onText || "ON").toUpperCase()) raw = String(cfg.onValue ?? "1");
        else if (raw.toUpperCase() === String(cfg.offText || "OFF").toUpperCase()) raw = String(cfg.offValue ?? "0");
        const option = (cfg.states || []).find(item => String(item.label).toUpperCase() === raw.toUpperCase());
        if (option) raw = String(option.value);
        grid[day][time] = raw.toUpperCase() === "NULL" ? null : raw;
      }
    }
    return grid;
  }

  function renderScheduleLegend(point) {
    const cfg = scheduleConfig(point);
    const items = [
      `<span class="schedule-legend-chip"><span class="schedule-legend-dot empty"></span>${escapeHtml(cfg.nullText || "Empty")}</span>`
    ];
    for (const option of scheduleOptions(point)) {
      items.push(`<span class="schedule-legend-chip"><span class="schedule-legend-dot ${option.kind}"></span>${escapeHtml(option.label)} <small>${escapeHtml(option.value)}</small></span>`);
    }
    if (cfg.mode === "number") {
      items.push(`<span class="schedule-legend-note">Numeric${cfg.unit ? ` · ${escapeHtml(cfg.unit)}` : ""}</span>`);
    }
    els.scheduleLegend.innerHTML = items.join("");
  }

  function renderScheduleGrid() {
    const point = activeSchedulePoint();
    if (!point || !state.scheduleEditor.grid) return;
    const grid = state.scheduleEditor.grid;
    els.scheduleGridBody.innerHTML = scheduleSlots().map(time => `
      <tr>
        <td class="schedule-time-cell">${time}</td>
        ${scheduleDays().map(([, day]) => {
          const value = grid[day][time];
          const kind = scheduleKind(point, value);
          const selected = state.scheduleEditor.selected?.day === day && state.scheduleEditor.selected?.time === time;
          return `<td><button class="schedule-cell ${kind !== "empty" ? kind : ""} ${selected ? "selected" : ""}" type="button" data-schedule-day="${day}" data-schedule-time="${time}" title="${escapeHtml(`${scheduleLabel(point, value)}${value !== null ? ` (${value})` : ""}`)}">${value === null ? "" : escapeHtml(scheduleLabel(point, value))}</button></td>`;
        }).join("")}
      </tr>`).join("");

    $$('[data-schedule-day]', els.scheduleGridBody).forEach(button => {
      button.addEventListener("click", () => editScheduleCell(button.dataset.scheduleDay, button.dataset.scheduleTime));
    });
  }

  function editScheduleCell(day, time) {
    const point = activeSchedulePoint();
    if (!point) return;
    const cfg = scheduleConfig(point);
    const grid = state.scheduleEditor.grid;

    if (cfg.mode === "number") {
      state.scheduleEditor.selected = { day, time };
      els.scheduleNumericEditor.classList.remove("hidden");
      els.scheduleNumericSlot.textContent = `${day[0].toUpperCase()}${day.slice(1)} · ${time}`;
      els.scheduleNumericInput.value = grid[day][time] ?? "";
      if (cfg.min !== null && cfg.min !== undefined) els.scheduleNumericInput.min = cfg.min; else els.scheduleNumericInput.removeAttribute("min");
      if (cfg.max !== null && cfg.max !== undefined) els.scheduleNumericInput.max = cfg.max; else els.scheduleNumericInput.removeAttribute("max");
      els.scheduleNumericInput.step = cfg.step ?? "any";
      renderScheduleGrid();
      els.scheduleNumericInput.focus();
      return;
    }

    const options = scheduleOptions(point);
    const current = grid[day][time];
    const index = options.findIndex(item => String(item.value) === String(current));
    grid[day][time] = current === null
      ? (options[0]?.value ?? null)
      : index >= 0 && index < options.length - 1
        ? options[index + 1].value
        : null;
    state.scheduleEditor.dirty = true;
    els.scheduleSaveStatus.textContent = "Changed";
    renderScheduleGrid();
  }

  function serializeScheduleGrid() {
    const grid = state.scheduleEditor.grid;
    return scheduleDays().map(([label, day]) => {
      const events = [];
      for (const time of scheduleSlots()) {
        const value = grid[day][time];
        if (value !== null && value !== undefined && value !== "") events.push(`${time}=${value}`);
      }
      return `${label}:${events.length ? events.join(";") : "-"}`;
    }).join(" | ");
  }

  function setScheduleError(message) {
    els.scheduleError.textContent = message || "";
    els.scheduleError.classList.toggle("hidden", !message);
  }

  function openScheduleEditor(point) {
    if (!point?.schedule) return;
    state.scheduleEditor = {
      pointKey: point.key,
      grid: parseScheduleWeekly(point),
      selected: null,
      dirty: false
    };
    const device = selectedDevice();
    els.scheduleDeviceName.textContent = device?.name || point.deviceName || "BACnet device";
    els.scheduleTitle.textContent = point.name;
    els.scheduleObjectId.textContent = `Schedule ${point.instance}`;
    els.schedulePresentValue.textContent = point.schedule.presentText || "—";
    const cfg = scheduleConfig(point);
    els.scheduleMeta.textContent = `30-minute editor · ${cfg.mode === "binary" ? "ON / OFF" : cfg.mode === "states" ? "Named states" : `Numeric${cfg.unit ? ` · ${cfg.unit}` : ""}`}`;
    els.scheduleNumericEditor.classList.add("hidden");
    els.scheduleSaveStatus.textContent = "Ready";
    setScheduleError("");
    renderScheduleLegend(point);
    renderScheduleGrid();
    els.scheduleDialog.showModal();
  }

  async function saveScheduleEditor() {
    const point = activeSchedulePoint();
    if (!point) return;
    els.scheduleSaveBtn.disabled = true;
    els.scheduleSaveStatus.textContent = "Saving…";
    setScheduleError("");
    try {
      const result = await api(`/api/devices/${point.deviceId}/schedules/${point.instance}/week`, {
        method: "POST",
        body: JSON.stringify({ payload: serializeScheduleGrid() })
      });
      state.scheduleEditor.dirty = false;
      els.scheduleSaveStatus.textContent = "Saved and confirmed";
      toast(`${point.name}: weekly schedule saved`);
      await loadPoints({ quiet: true });
      const refreshed = state.points.find(item => item.key === point.key);
      if (refreshed) {
        state.scheduleEditor.pointKey = refreshed.key;
        state.scheduleEditor.grid = parseScheduleWeekly(refreshed);
        els.schedulePresentValue.textContent = refreshed.schedule?.presentText || "—";
        renderScheduleLegend(refreshed);
        renderScheduleGrid();
      }
    } catch (err) {
      els.scheduleSaveStatus.textContent = "Save failed";
      setScheduleError(err.message);
    } finally {
      els.scheduleSaveBtn.disabled = false;
    }
  }

  function closeScheduleEditor() {
    els.scheduleDialog.close();
  }

  els.deviceSearch.addEventListener("input", renderDevices);
  els.pointSearch.addEventListener("input", renderPoints);
  els.typeFilter.addEventListener("change", renderPoints);
  els.writableOnly.addEventListener("change", renderPoints);

  els.scanBtn.addEventListener("click", async () => {
    els.scanBtn.disabled = true;
    els.scanBtn.textContent = "Scanning…";
    try {
      await api("/api/scan", { method: "POST", body: "{}" });
      toast("BACnet scan started");
      setTimeout(() => refreshDevices(), 1500);
    } catch (err) {
      toast(err.message, "error");
      els.scanBtn.disabled = false;
      els.scanBtn.textContent = "Scan BACnet";
    }
  });

  els.readAllBtn.addEventListener("click", async () => {
    els.readAllBtn.disabled = true;
    try {
      await api("/api/read", { method: "POST", body: "{}" });
      toast("Read all started");
    } catch (err) {
      toast(err.message, "error");
    } finally {
      setTimeout(() => { els.readAllBtn.disabled = false; }, 1000);
    }
  });

  els.readDeviceBtn.addEventListener("click", async () => {
    const device = selectedDevice();
    if (!device) return;
    els.readDeviceBtn.disabled = true;
    try {
      await api(`/api/devices/${device.deviceId}/read`, { method: "POST", body: "{}" });
      await loadPoints({ quiet: true });
      toast(`${device.name}: values refreshed`);
    } catch (err) {
      toast(err.message, "error");
    } finally {
      els.readDeviceBtn.disabled = false;
    }
  });

  els.renameDeviceBtn.addEventListener("click", () => {
    const device = selectedDevice();
    if (!device) return;
    els.renameInput.value = device.name;
    els.renameDialog.showModal();
    setTimeout(() => els.renameInput.select(), 0);
  });

  els.renameForm.addEventListener("submit", async event => {
    event.preventDefault();
    const device = selectedDevice();
    if (!device) return;
    const submit = $("button[type=submit]", els.renameForm);
    submit.disabled = true;
    try {
      await api(`/api/devices/${device.deviceId}`, { method: "PUT", body: JSON.stringify({ name: els.renameInput.value }) });
      els.renameDialog.close();
      await refreshDevices();
      toast("Device name updated");
    } catch (err) {
      toast(err.message, "error");
    } finally {
      submit.disabled = false;
    }
  });

  els.deleteDeviceBtn.addEventListener("click", () => {
    const device = selectedDevice();
    if (!device) return;
    els.deleteMessage.textContent = `${device.name} (Device ${device.deviceId}) will be removed from BACnet2MQTT and its Home Assistant MQTT Discovery entities will be removed. The physical BACnet controller is not changed. You can restore it later.`;
    els.deleteDialog.showModal();
  });

  els.deleteForm.addEventListener("submit", async event => {
    event.preventDefault();
    const device = selectedDevice();
    if (!device) return;
    const submit = $("button[type=submit]", els.deleteForm);
    submit.disabled = true;
    try {
      await api(`/api/devices/${device.deviceId}`, { method: "DELETE" });
      els.deleteDialog.close();
      state.selectedDeviceId = null;
      state.points = [];
      await refreshDevices();
      toast(`${device.name} deleted from BACnet2MQTT`);
    } catch (err) {
      toast(err.message, "error");
    } finally {
      submit.disabled = false;
    }
  });


  els.scheduleCloseBtn.addEventListener("click", closeScheduleEditor);
  els.scheduleCancelBtn.addEventListener("click", closeScheduleEditor);
  els.scheduleDialog.addEventListener("cancel", event => {
    event.preventDefault();
    closeScheduleEditor();
  });
  els.scheduleSaveBtn.addEventListener("click", saveScheduleEditor);
  els.scheduleCopyMonday.addEventListener("click", () => {
    if (!state.scheduleEditor.grid) return;
    for (const [, day] of scheduleDays()) {
      if (day === "monday") continue;
      for (const time of scheduleSlots()) state.scheduleEditor.grid[day][time] = state.scheduleEditor.grid.monday[time];
    }
    state.scheduleEditor.dirty = true;
    els.scheduleSaveStatus.textContent = "Changed";
    renderScheduleGrid();
  });
  els.scheduleClearWeek.addEventListener("click", () => {
    state.scheduleEditor.grid = emptyScheduleGrid();
    state.scheduleEditor.dirty = true;
    els.scheduleSaveStatus.textContent = "Changed";
    renderScheduleGrid();
  });
  els.scheduleNumericApply.addEventListener("click", () => {
    const point = activeSchedulePoint();
    const selected = state.scheduleEditor.selected;
    if (!point || !selected) return;
    const raw = els.scheduleNumericInput.value.trim();
    if (raw === "" || !Number.isFinite(Number(raw))) {
      setScheduleError("Enter a valid numeric value.");
      return;
    }
    state.scheduleEditor.grid[selected.day][selected.time] = String(Number(raw));
    state.scheduleEditor.dirty = true;
    els.scheduleSaveStatus.textContent = "Changed";
    setScheduleError("");
    renderScheduleGrid();
  });
  els.scheduleNumericClear.addEventListener("click", () => {
    const selected = state.scheduleEditor.selected;
    if (!selected) return;
    state.scheduleEditor.grid[selected.day][selected.time] = null;
    els.scheduleNumericInput.value = "";
    state.scheduleEditor.dirty = true;
    els.scheduleSaveStatus.textContent = "Changed";
    renderScheduleGrid();
  });

  $$('[data-close-dialog]').forEach(button => {
    button.addEventListener("click", () => button.closest("dialog").close());
  });

  async function init() {
    await refreshStatus();
    if (state.status?.ready) await refreshDevices({ preserve: false });
    state.liveTimer = setInterval(liveRefresh, 2000);
    state.deviceTimer = setInterval(async () => {
      await refreshStatus();
      if (state.status?.ready) await refreshDevices();
    }, 5000);
  }

  init().catch(err => toast(err.message, "error"));
})();
