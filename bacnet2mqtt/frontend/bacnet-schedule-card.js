console.info("[BACnet Schedule Card] v0.3.3 loaded");

class BacnetScheduleCard extends HTMLElement {
  static getStubConfig() {
    return {
      entity: "text.example_weekly_schedule",
      autosave: false
    };
  }

  setConfig(config) {
    this.config = {
      title: "",
      autosave: false,
      save_delay: 700,
      ...config
    };

    if (!this.config.entity) {
      throw new Error("Define the BACnet2MQTT Weekly Schedule text entity.");
    }

    this._hass = null;
    this._grid = this._emptyGrid();
    this._dirty = false;
    this._saving = false;
    this._pendingPayload = null;
    this._readbackDeadline = 0;
    this._lastSourceSignature = null;
    this._saveTimer = null;
    this._selectedNumericCell = null;

    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._syncFromHomeAssistant();
    this._updateHeader();
  }

  getCardSize() {
    return 2;
  }

  _entity() {
    return this._hass?.states?.[this.config.entity] || null;
  }

  _days() {
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

  _slots() {
    const result = [];
    for (let h = 0; h < 24; h++) {
      for (const m of [0, 30]) {
        result.push(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
      }
    }
    return result;
  }

  _emptyGrid() {
    const grid = {};
    for (const [, day] of this._days()) {
      grid[day] = {};
      for (const time of this._slots()) grid[day][time] = null;
    }
    return grid;
  }

  _scheduleConfig() {
    const source = this._entity()?.attributes?.schedule_config || {};
    const mode = ["binary", "states", "number"].includes(String(source.mode))
      ? String(source.mode)
      : "binary";

    const states = Array.isArray(source.states)
      ? source.states
          .map(item => ({
            label: String(item?.label ?? "").trim(),
            value: String(item?.value ?? "").trim()
          }))
          .filter(item => item.label && item.value !== "")
      : [];

    return {
      mode,
      valueType: String(source.valueType || "auto"),
      onText: String(source.onText || "ON"),
      onValue: String(source.onValue ?? "1"),
      offText: String(source.offText || "OFF"),
      offValue: String(source.offValue ?? "0"),
      nullText: String(source.nullText || "Empty"),
      unit: String(source.unit || ""),
      min: source.min ?? null,
      max: source.max ?? null,
      step: source.step ?? null,
      states
    };
  }

  _stateOptions() {
    const config = this._scheduleConfig();
    if (config.mode === "binary") {
      return [
        { label: config.onText, value: config.onValue, kind: "on" },
        { label: config.offText, value: config.offValue, kind: "off" }
      ];
    }
    if (config.mode === "states") {
      return config.states.map(item => ({ ...item, kind: "state" }));
    }
    return [];
  }

  _labelForValue(value) {
    const config = this._scheduleConfig();
    if (value === null || value === undefined || value === "") return config.nullText;
    const raw = typeof value === "boolean"
      ? (value ? "1" : "0")
      : String(value);
    const option = this._stateOptions().find(item => String(item.value) === raw);
    if (option) return option.label;
    return config.unit ? `${raw} ${config.unit}` : raw;
  }

  _kindForValue(value) {
    if (value === null || value === undefined || value === "") return "empty";
    const raw = typeof value === "boolean"
      ? (value ? "1" : "0")
      : String(value);
    const option = this._stateOptions().find(item => String(item.value) === raw);
    return option?.kind || "state";
  }

  _render() {
    this.shadowRoot.innerHTML = `
      <style>
        :host { display:block; }
        * { box-sizing:border-box; }
        button,input { font:inherit; }
        ha-card {
          overflow:hidden;
          border:1px solid var(--divider-color, rgba(255,255,255,.12));
          border-radius:14px;
          background:var(--ha-card-background, var(--card-background-color, #1c1c1c));
          box-shadow:none;
        }
        .compact {
          min-height:78px;
          display:flex;
          align-items:center;
          gap:14px;
          padding:12px 16px;
        }
        .status-dot {
          width:13px;height:13px;border-radius:50%;flex:none;
          background:var(--disabled-text-color,#777);
          box-shadow:0 0 0 5px rgba(128,128,128,.10);
        }
        .status-dot.on { background:var(--success-color,#4caf50); box-shadow:0 0 0 5px rgba(76,175,80,.12); }
        .compact-copy { min-width:0; flex:1; }
        .device-name { font-size:12px; color:var(--secondary-text-color,#aaa); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .compact-title { margin-top:1px; font-size:17px; font-weight:600; color:var(--primary-text-color,#fff); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .compact-state { margin-top:5px; font-size:13px; color:var(--secondary-text-color,#bbb); }
        .open-btn,.footer-btn,.close-btn,.tool-btn,.cell-btn,.number-btn {
          border:0; cursor:pointer; color:var(--primary-text-color,#fff);
        }
        .open-btn {
          min-height:42px; padding:0 16px; border-radius:10px;
          background:var(--secondary-background-color,#2b2b2b); font-weight:600;
        }
        dialog {
          width:min(96vw,1120px); max-width:1120px; max-height:92vh;
          padding:0; border:0; border-radius:22px;
          background:var(--ha-card-background,var(--card-background-color,#1c1c1c));
          color:var(--primary-text-color,#fff);
          box-shadow:0 20px 70px rgba(0,0,0,.55);
        }
        dialog::backdrop { background:rgba(0,0,0,.56); }
        .dialog-shell { display:flex; flex-direction:column; max-height:92vh; }
        .dialog-header {
          display:grid; grid-template-columns:44px minmax(0,1fr) auto; gap:12px; align-items:center;
          padding:16px 20px 14px; border-bottom:1px solid var(--divider-color,rgba(255,255,255,.11));
        }
        .close-btn { width:40px;height:40px;border-radius:50%; background:transparent; font-size:28px; line-height:1; }
        .close-btn:hover { background:var(--secondary-background-color,#2a2a2a); }
        .dialog-device { font-size:12px; color:var(--secondary-text-color,#aaa); }
        .dialog-title { font-size:21px; font-weight:600; line-height:1.1; }
        .object-badge { color:var(--secondary-text-color,#aaa); font-size:12px; }
        .summary {
          display:flex; align-items:center; gap:12px; padding:16px 22px;
          border-bottom:1px solid var(--divider-color,rgba(255,255,255,.10));
        }
        .summary-icon { width:38px;height:38px;border-radius:10px;display:grid;place-items:center;background:var(--secondary-background-color,#292929);font-size:20px; }
        .summary-copy { flex:1; min-width:0; }
        .summary-label { font-size:14px; font-weight:600; }
        .summary-meta { margin-top:2px; color:var(--secondary-text-color,#aaa); font-size:12px; }
        .summary-state { font-size:14px; font-weight:600; }
        .notice {
          margin:14px 22px 0; padding:12px 14px; border-radius:7px;
          background:rgba(3,169,244,.14); color:var(--primary-text-color,#fff);
          border-left:3px solid var(--info-color,#03a9f4); font-size:13px; line-height:1.45;
        }
        .legend { display:flex; gap:10px; flex-wrap:wrap; align-items:center; padding:12px 22px; color:var(--secondary-text-color,#aaa); font-size:12px; }
        .legend-chip { display:inline-flex;align-items:center;gap:6px; }
        .legend-mark { width:15px;height:15px;border-radius:4px;border:1px solid var(--divider-color,rgba(255,255,255,.13));background:var(--primary-background-color,#111); }
        .legend-mark.on { border-color:rgba(76,175,80,.5); background:rgba(76,175,80,.20); }
        .legend-mark.off { border-color:rgba(158,158,158,.45); background:rgba(158,158,158,.13); }
        .numeric-editor { display:none; margin:0 22px 12px; padding:10px 12px; border:1px solid var(--divider-color,rgba(255,255,255,.10)); border-radius:10px; align-items:center; gap:8px; flex-wrap:wrap; }
        .numeric-editor.show { display:flex; }
        .numeric-editor strong { min-width:130px; font-size:13px; }
        .numeric-editor input { min-height:38px; width:150px; border:1px solid var(--divider-color,rgba(255,255,255,.14));border-radius:8px;background:var(--primary-background-color,#111);color:var(--primary-text-color,#fff);padding:0 10px; }
        .number-btn,.tool-btn { min-height:38px;padding:0 12px;border-radius:8px;background:var(--secondary-background-color,#2a2a2a); }
        .number-btn.primary { background:var(--primary-color,#03a9f4); color:var(--text-primary-color,#fff); }
        .table-wrap { overflow:auto; padding:0 22px 16px; min-height:240px; }
        table { width:100%; min-width:760px; border-collapse:separate; border-spacing:0; table-layout:fixed; font-size:11px; }
        th,td { padding:0; text-align:center; border-right:1px solid var(--divider-color,rgba(255,255,255,.09)); border-bottom:1px solid var(--divider-color,rgba(255,255,255,.09)); }
        thead th { position:sticky;top:0;z-index:3;height:38px;background:var(--secondary-background-color,#262626);font-weight:600; }
        thead th:first-child, td:first-child { border-left:1px solid var(--divider-color,rgba(255,255,255,.09)); }
        thead th { border-top:1px solid var(--divider-color,rgba(255,255,255,.09)); }
        .time-head { width:62px; position:sticky; left:0; z-index:4; }
        .time-cell { position:sticky;left:0;z-index:2;height:32px;padding-right:7px;text-align:right;background:var(--secondary-background-color,#262626);color:var(--secondary-text-color,#aaa);font-variant-numeric:tabular-nums; }
        .cell-btn { width:100%;height:32px;border-radius:0;background:var(--primary-background-color,#151515);font-size:10px;font-weight:650; }
        .cell-btn:hover,.cell-btn.selected { outline:1px solid var(--primary-color,#03a9f4); outline-offset:-1px; }
        .cell-btn.on { color:var(--success-color,#66bb6a);background:rgba(76,175,80,.14); }
        .cell-btn.off { color:var(--secondary-text-color,#c2c2c2);background:rgba(158,158,158,.08); }
        .cell-btn.state { color:var(--primary-color,#03a9f4);background:rgba(3,169,244,.10); }
        .error { display:none;margin:0 22px 12px;padding:10px 12px;border-radius:7px;background:rgba(244,67,54,.12);color:var(--error-color,#ef5350);font-size:12px; }
        .error.show { display:block; }
        .dialog-footer {
          display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:14px 20px;
          border-top:1px solid var(--divider-color,rgba(255,255,255,.11));
        }
        .tools { display:flex;gap:8px;flex-wrap:wrap;flex:1; }
        .footer-status { color:var(--secondary-text-color,#aaa);font-size:12px;margin-right:8px; }
        .footer-btn { min-height:42px;padding:0 18px;border-radius:22px;background:transparent;font-weight:650; }
        .footer-btn.primary { background:var(--primary-color,#03a9f4); color:var(--text-primary-color,#fff); }
        .footer-btn.secondary { color:var(--primary-color,#03a9f4); }
        @media(max-width:650px){
          dialog{width:98vw;max-height:94vh;border-radius:16px}.dialog-header{padding:12px}.summary{padding:12px}.notice,.legend,.numeric-editor{margin-left:12px;margin-right:12px}.legend{padding-left:0;padding-right:0}.table-wrap{padding-left:12px;padding-right:12px}.dialog-footer{padding:12px}.footer-status{flex-basis:100%}
        }
      </style>

      <ha-card>
        <div class="compact">
          <span class="status-dot"></span>
          <div class="compact-copy">
            <div class="device-name">BACnet Schedule</div>
            <div class="compact-title">Weekly Schedule</div>
            <div class="compact-state">Loading…</div>
          </div>
          <button class="open-btn" type="button">Open</button>
        </div>
      </ha-card>

      <dialog>
        <div class="dialog-shell">
          <div class="dialog-header">
            <button class="close-btn" type="button" aria-label="Close">×</button>
            <div>
              <div class="dialog-device">BACnet device</div>
              <div class="dialog-title">Weekly Schedule</div>
            </div>
            <div class="object-badge">Schedule</div>
          </div>

          <div class="summary">
            <div class="summary-icon" aria-hidden="true">◫</div>
            <div class="summary-copy">
              <div class="summary-label">Weekly program</div>
              <div class="summary-meta">30-minute editor · Monday–Sunday</div>
            </div>
            <div class="summary-state">—</div>
          </div>

          <div class="notice">The BACnet values can remain numeric (for example 1 / 0 / NULL), while this card displays the configured text labels such as ON and OFF.</div>

          <div class="legend"></div>

          <div class="numeric-editor">
            <strong class="numeric-slot">Selected slot</strong>
            <input class="numeric-input" type="number" step="any" aria-label="Schedule value">
            <button class="number-btn primary numeric-apply" type="button">Apply</button>
            <button class="number-btn numeric-clear" type="button">Clear</button>
          </div>

          <div class="table-wrap">
            <table>
              <thead><tr><th class="time-head">Time</th>${this._days().map(([label]) => `<th>${label}</th>`).join("")}</tr></thead>
              <tbody></tbody>
            </table>
          </div>

          <div class="error"></div>

          <div class="dialog-footer">
            <div class="tools">
              <button class="tool-btn copy-btn" type="button">Copy Monday to all</button>
              <button class="tool-btn clear-btn" type="button">Clear week</button>
            </div>
            <span class="footer-status">Ready</span>
            <button class="footer-btn secondary cancel-btn" type="button">Close</button>
            <button class="footer-btn primary save-btn" type="button">Save</button>
          </div>
        </div>
      </dialog>
    `;

    const root = this.shadowRoot;
    root.querySelector(".open-btn").addEventListener("click", () => root.querySelector("dialog").showModal());
    root.querySelector(".close-btn").addEventListener("click", () => root.querySelector("dialog").close());
    root.querySelector(".cancel-btn").addEventListener("click", () => root.querySelector("dialog").close());
    root.querySelector("dialog").addEventListener("cancel", event => { event.preventDefault(); root.querySelector("dialog").close(); });
    root.querySelector(".save-btn").addEventListener("click", () => this._save());
    root.querySelector(".copy-btn").addEventListener("click", () => this._copyMonday());
    root.querySelector(".clear-btn").addEventListener("click", () => this._clear());
    root.querySelector(".numeric-apply").addEventListener("click", () => this._applyNumeric());
    root.querySelector(".numeric-clear").addEventListener("click", () => this._clearNumeric());
    this._renderGrid();
    this._renderLegend();
  }

  _renderLegend() {
    const config = this._scheduleConfig();
    const legend = this.shadowRoot.querySelector(".legend");
    const items = [`<span class="legend-chip"><span class="legend-mark"></span>${this._escape(config.nullText)}</span>`];
    for (const option of this._stateOptions()) {
      items.push(`<span class="legend-chip"><span class="legend-mark ${option.kind}"></span>${this._escape(option.label)} <small>(${this._escape(option.value)})</small></span>`);
    }
    if (config.mode === "number") items.push(`<span>Numeric values${config.unit ? ` · ${this._escape(config.unit)}` : ""}</span>`);
    legend.innerHTML = items.join("");
    this.shadowRoot.querySelector(".numeric-editor").classList.toggle("show", config.mode === "number" && Boolean(this._selectedNumericCell));
  }

  _renderGrid() {
    const tbody = this.shadowRoot.querySelector("tbody");
    tbody.innerHTML = "";
    for (const time of this._slots()) {
      const tr = document.createElement("tr");
      const tdTime = document.createElement("td");
      tdTime.className = "time-cell";
      tdTime.textContent = time;
      tr.appendChild(tdTime);
      for (const [, day] of this._days()) {
        const td = document.createElement("td");
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "cell-btn";
        btn.dataset.day = day;
        btn.dataset.time = time;
        btn.addEventListener("click", () => this._editCell(day, time));
        td.appendChild(btn);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    this._paintGrid();
  }

  _editCell(day, time) {
    const config = this._scheduleConfig();
    if (config.mode === "number") {
      this._selectedNumericCell = { day, time };
      const input = this.shadowRoot.querySelector(".numeric-input");
      input.value = this._grid[day][time] ?? "";
      if (config.min !== null) input.min = config.min; else input.removeAttribute("min");
      if (config.max !== null) input.max = config.max; else input.removeAttribute("max");
      input.step = config.step ?? "any";
      this.shadowRoot.querySelector(".numeric-slot").textContent = `${day[0].toUpperCase()}${day.slice(1)} · ${time}`;
      this._renderLegend();
      this._paintGrid();
      input.focus();
      return;
    }

    const options = this._stateOptions();
    const current = this._grid[day][time];
    const idx = options.findIndex(item => String(item.value) === String(current));
    this._grid[day][time] = current === null
      ? (options[0]?.value ?? null)
      : idx >= 0 && idx < options.length - 1
        ? options[idx + 1].value
        : null;
    this._markDirty();
    this._paintCell(day, time);
  }

  _applyNumeric() {
    if (!this._selectedNumericCell) return;
    const input = this.shadowRoot.querySelector(".numeric-input");
    if (input.value === "" || !Number.isFinite(Number(input.value))) {
      this._error("Enter a valid numeric value.");
      return;
    }
    const { day, time } = this._selectedNumericCell;
    this._grid[day][time] = String(Number(input.value));
    this._markDirty();
    this._paintCell(day, time);
    this._error("");
  }

  _clearNumeric() {
    if (!this._selectedNumericCell) return;
    const { day, time } = this._selectedNumericCell;
    this._grid[day][time] = null;
    this.shadowRoot.querySelector(".numeric-input").value = "";
    this._markDirty();
    this._paintCell(day, time);
  }

  _paintGrid() {
    for (const [, day] of this._days()) for (const time of this._slots()) this._paintCell(day, time);
  }

  _paintCell(day, time) {
    const btn = this.shadowRoot.querySelector(`.cell-btn[data-day="${day}"][data-time="${time}"]`);
    if (!btn) return;
    const raw = this._grid[day][time];
    const kind = this._kindForValue(raw);
    btn.className = `cell-btn ${kind !== "empty" ? kind : ""}`;
    if (this._selectedNumericCell?.day === day && this._selectedNumericCell?.time === time) btn.classList.add("selected");
    btn.textContent = raw === null ? "" : this._labelForValue(raw);
    btn.title = `${day} ${time}: ${raw === null ? this._scheduleConfig().nullText : `${this._labelForValue(raw)} (${raw})`}`;
  }

  _markDirty() {
    this._dirty = true;
    this._status("Changed");
    if (this.config.autosave) {
      clearTimeout(this._saveTimer);
      this._saveTimer = setTimeout(() => this._save(), Number(this.config.save_delay) || 700);
    }
  }

  _source() {
    const entity = this._entity();
    if (!entity) return null;
    const weekly = entity.attributes?.weekly_schedule;
    if (weekly && typeof weekly === "object" && !Array.isArray(weekly)) return { type: "weekly", weekly };
    const state = String(entity.state ?? "");
    if (state && !["unknown", "unavailable"].includes(state.toLowerCase())) return { type: "text", text: state };
    return null;
  }

  _parseSource(source) {
    const grid = this._emptyGrid();
    if (source.type === "weekly") {
      for (const [, day] of this._days()) this._parseDay(grid, day, source.weekly?.[day] || "");
      return grid;
    }
    const dayMap = Object.fromEntries(this._days().map(([label, key]) => [label.toLowerCase(), key]));
    for (const section of String(source.text || "").split("|").map(v => v.trim()).filter(Boolean)) {
      const colon = section.indexOf(":");
      if (colon < 0) continue;
      const day = dayMap[section.slice(0, colon).trim().toLowerCase()];
      if (day) this._parseDay(grid, day, section.slice(colon + 1).trim());
    }
    return grid;
  }

  _parseDay(grid, day, body) {
    if (!body || body === "-") return;
    for (const part of String(body).split(";")) {
      const match = part.trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*=\s*(.+)$/);
      if (!match) continue;
      const h = Number(match[1]);
      const m = Number(match[2]);
      if (h < 0 || h > 23 || ![0, 30].includes(m)) continue;
      const time = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
      let raw = match[3].trim();
      const config = this._scheduleConfig();
      if (raw.toUpperCase() === String(config.onText).toUpperCase()) raw = config.onValue;
      else if (raw.toUpperCase() === String(config.offText).toUpperCase()) raw = config.offValue;
      const stateOption = (config.states || []).find(item => String(item.label).toUpperCase() === raw.toUpperCase());
      if (stateOption) raw = stateOption.value;
      grid[day][time] = raw.toUpperCase() === "NULL" ? null : String(raw);
    }
  }

  _serializeGrid(grid = this._grid) {
    return this._days().map(([label, day]) => {
      const events = [];
      for (const time of this._slots()) {
        const value = grid[day][time];
        if (value !== null && value !== undefined && value !== "") events.push(`${time}=${value}`);
      }
      return `${label}:${events.length ? events.join(";") : "-"}`;
    }).join(" | ");
  }

  _syncFromHomeAssistant() {
    if (!this._hass || this._saving || this._dirty) return;
    const source = this._source();
    if (!source) return;
    const candidate = this._parseSource(source);
    const candidatePayload = this._serializeGrid(candidate);

    if (this._pendingPayload) {
      if (candidatePayload === this._pendingPayload) {
        this._pendingPayload = null;
        this._grid = candidate;
        this._status("Saved and confirmed");
        this._paintGrid();
      } else if (Date.now() < this._readbackDeadline) {
        return;
      } else {
        this._status("Saved · waiting for BACnet readback");
      }
      return;
    }

    const signature = JSON.stringify(source);
    if (signature === this._lastSourceSignature) return;
    this._lastSourceSignature = signature;
    this._grid = candidate;
    this._renderLegend();
    this._paintGrid();
  }

  async _save() {
    if (!this._hass || this._saving) return;
    const payload = this._serializeGrid();
    if (payload.length > 255) {
      this._error(`This schedule is ${payload.length} characters. Home Assistant Text entities are limited to 255 characters. Use the BACnet2MQTT Ingress editor for dense schedules.`);
      return;
    }
    this._saving = true;
    this._status("Saving…");
    this._error("");
    try {
      await this._hass.callService("text", "set_value", { entity_id: this.config.entity, value: payload });
      this._dirty = false;
      this._pendingPayload = payload;
      this._readbackDeadline = Date.now() + 10000;
      this._status("Saved · waiting for BACnet readback");
    } catch (err) {
      this._error(err?.message || String(err));
      this._status("Save failed");
    } finally {
      this._saving = false;
    }
  }

  _copyMonday() {
    for (const [, day] of this._days()) {
      if (day === "monday") continue;
      for (const time of this._slots()) this._grid[day][time] = this._grid.monday[time];
    }
    this._markDirty();
    this._paintGrid();
  }

  _clear() {
    this._grid = this._emptyGrid();
    this._markDirty();
    this._paintGrid();
  }

  _updateHeader() {
    const entity = this._entity();
    if (!entity) return;
    const attrs = entity.attributes || {};
    const friendly = String(attrs.friendly_name || "Weekly Schedule").replace(/\s*-\s*Weekly Schedule\s*$/i, "").trim();
    const title = String(this.config.title || friendly || "Weekly Schedule");
    const device = String(attrs.device_name || "BACnet Schedule");
    const present = attrs.present_value;
    const presentText = attrs.present_value_text || this._labelForValue(present);
    const normalizedPresent = typeof present === "boolean" ? (present ? "1" : "0") : String(present);
    const on = normalizedPresent === String(this._scheduleConfig().onValue);

    this.shadowRoot.querySelector(".compact-title").textContent = title;
    this.shadowRoot.querySelector(".device-name").textContent = device;
    this.shadowRoot.querySelector(".compact-state").textContent = `Current state: ${presentText ?? "—"}`;
    this.shadowRoot.querySelector(".dialog-title").textContent = title;
    this.shadowRoot.querySelector(".dialog-device").textContent = device;
    this.shadowRoot.querySelector(".summary-state").textContent = presentText ?? "—";
    this.shadowRoot.querySelector(".object-badge").textContent = `Schedule ${attrs.object_instance ?? ""}`.trim();
    this.shadowRoot.querySelector(".status-dot").classList.toggle("on", on);
    this._renderLegend();
    this._paintGrid();
  }

  _status(text) {
    this.shadowRoot.querySelector(".footer-status").textContent = text;
  }

  _error(text) {
    const node = this.shadowRoot.querySelector(".error");
    node.textContent = text || "";
    node.classList.toggle("show", Boolean(text));
  }

  _escape(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }
}

if (!customElements.get("bacnet-schedule-card")) {
  customElements.define("bacnet-schedule-card", BacnetScheduleCard);
}

window.customCards = window.customCards || [];
if (!window.customCards.some(card => card.type === "bacnet-schedule-card")) {
  window.customCards.push({
    type: "bacnet-schedule-card",
    name: "BACnet Schedule Card",
    preview: true,
    description: "Weekly BACnet Schedule editor with configurable display values.",
    getEntitySuggestion: (hass, entityId) => {
      const entity = hass?.states?.[entityId];
      if (entityId?.startsWith("text.") && entity?.attributes?.object_type === "schedule") {
        return { config: { type: "custom:bacnet-schedule-card", entity: entityId, autosave: false } };
      }
      return null;
    }
  });
}
