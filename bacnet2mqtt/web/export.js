(() => {
  const state = { bridge: null, entities: [] };
  const $ = selector => document.querySelector(selector);
  const els = {
    settingsForm: $("#settingsForm"), enabled: $("#enabled"), deviceName: $("#deviceName"),
    deviceId: $("#deviceId"), pollInterval: $("#pollInterval"), bridgeStatus: $("#bridgeStatus"),
    addForm: $("#addForm"), entityInput: $("#entityInput"), entityList: $("#entityList"),
    entityInfo: $("#entityInfo"), objectType: $("#objectType"), instance: $("#instance"),
    writable: $("#writable"), objectName: $("#objectName"), mappingCount: $("#mappingCount"),
    mappingList: $("#mappingList"), toastHost: $("#toastHost")
  };

  function api(path, options = {}) {
    return fetch(`.${path}`, {
      ...options,
      headers: { "content-type": "application/json", ...(options.headers || {}) }
    }).then(async response => {
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      return data;
    });
  }

  function escapeHtml(value) {
    return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
  }

  function toast(message, kind = "success") {
    const node = document.createElement("div");
    node.className = `toast ${kind}`;
    node.textContent = message;
    els.toastHost.appendChild(node);
    setTimeout(() => node.remove(), 3600);
  }

  function entityById(id) {
    return state.entities.find(item => item.entityId === String(id).trim()) || null;
  }

  function renderBridge() {
    const bridge = state.bridge;
    if (!bridge) return;
    els.enabled.checked = bridge.enabled === true;
    els.deviceName.value = bridge.deviceName || "Home Assistant";
    els.deviceId.value = bridge.deviceId ?? 3900000;
    els.pollInterval.value = bridge.pollInterval ?? 2;
    const statusClass = bridge.lastError ? "error-text" : bridge.enabled ? "ok-text" : "";
    els.bridgeStatus.className = `status-line ${statusClass}`;
    els.bridgeStatus.textContent = bridge.lastError
      ? `HA API error: ${bridge.lastError}`
      : bridge.enabled
        ? `BACnet Device ${bridge.deviceId} enabled · ${bridge.mappings?.length || 0} objects`
        : "Virtual BACnet device is disabled.";
    renderMappings();
  }

  function renderMappings() {
    const mappings = state.bridge?.mappings || [];
    els.mappingCount.textContent = mappings.length;
    if (!mappings.length) {
      els.mappingList.innerHTML = `<div class="empty-map">No Home Assistant entities are exposed yet.</div>`;
      return;
    }
    els.mappingList.innerHTML = mappings.map(item => `
      <div class="mapping-item">
        <div><div class="mapping-name">${escapeHtml(item.name)}</div><div class="mapping-sub">${escapeHtml(item.entityId)}</div></div>
        <div class="mapping-object"><strong>${escapeHtml(item.objectTypeName)}</strong><div class="mapping-sub">Object ${item.objectType}:${item.instance}${item.writable ? " · writable" : " · read only"}</div></div>
        <div class="mapping-state">${item.available ? escapeHtml(item.state ?? "—") : '<span class="error-text">Unavailable</span>'}</div>
        <button class="btn danger-ghost small" type="button" data-remove="${encodeURIComponent(item.id)}">Remove</button>
      </div>`).join("");
    document.querySelectorAll("[data-remove]").forEach(button => {
      button.addEventListener("click", async () => {
        button.disabled = true;
        try {
          state.bridge = await api(`/api/ha-bacnet/mappings/${button.dataset.remove}`, { method: "DELETE" });
          renderBridge();
          toast("BACnet object removed");
        } catch (err) {
          toast(err.message, "error");
          button.disabled = false;
        }
      });
    });
  }

  function updateEntitySelection() {
    const entity = entityById(els.entityInput.value);
    if (!entity) {
      els.entityInfo.textContent = "Enter or select an exact Home Assistant entity_id.";
      return;
    }
    els.objectType.value = entity.recommendedType;
    els.writable.checked = entity.writable === true;
    els.objectName.value = entity.name || entity.entityId;
    els.entityInfo.textContent = `${entity.name} · state: ${entity.state}${entity.unit ? ` ${entity.unit}` : ""} · recommended: ${entity.recommendedType}`;
  }

  async function loadBridge() {
    state.bridge = await api("/api/ha-bacnet");
    renderBridge();
  }

  async function loadEntities() {
    try {
      const data = await api("/api/ha/entities");
      state.entities = data.entities || [];
      els.entityList.innerHTML = state.entities.map(item =>
        `<option value="${escapeHtml(item.entityId)}">${escapeHtml(item.name)} · ${escapeHtml(item.state)}</option>`
      ).join("");
      els.entityInfo.textContent = `${state.entities.length} Home Assistant entities available.`;
    } catch (err) {
      els.entityInfo.textContent = err.message;
      els.entityInfo.className = "entity-help error-text";
    }
  }

  els.entityInput.addEventListener("input", updateEntitySelection);
  els.entityInput.addEventListener("change", updateEntitySelection);

  els.settingsForm.addEventListener("submit", async event => {
    event.preventDefault();
    const submit = els.settingsForm.querySelector("button[type=submit]");
    submit.disabled = true;
    try {
      state.bridge = await api("/api/ha-bacnet", {
        method: "PUT",
        body: JSON.stringify({
          enabled: els.enabled.checked,
          deviceName: els.deviceName.value,
          deviceId: Number(els.deviceId.value),
          pollInterval: Number(els.pollInterval.value)
        })
      });
      renderBridge();
      toast("Virtual BACnet device settings saved");
    } catch (err) {
      toast(err.message, "error");
    } finally {
      submit.disabled = false;
    }
  });

  els.addForm.addEventListener("submit", async event => {
    event.preventDefault();
    const submit = els.addForm.querySelector("button[type=submit]");
    submit.disabled = true;
    try {
      const body = {
        entityId: els.entityInput.value.trim(),
        type: els.objectType.value,
        writable: els.writable.checked
      };
      if (els.instance.value.trim() !== "") body.instance = Number(els.instance.value);
      if (els.objectName.value.trim() !== "") body.name = els.objectName.value.trim();
      state.bridge = await api("/api/ha-bacnet/mappings", {
        method: "POST",
        body: JSON.stringify(body)
      });
      renderBridge();
      toast(`${body.entityId} exposed to BACnet`);
      els.entityInput.value = "";
      els.objectName.value = "";
      els.instance.value = "";
      els.writable.checked = false;
    } catch (err) {
      toast(err.message, "error");
    } finally {
      submit.disabled = false;
    }
  });

  Promise.all([loadBridge(), loadEntities()]).catch(err => toast(err.message, "error"));
  setInterval(() => void loadBridge().catch(() => {}), 5000);
})();
