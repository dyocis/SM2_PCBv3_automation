(() => {
  "use strict";

  const STORAGE_KEY = "nevermore-dashboard-endpoint";
  const HISTORY_KEY = "nevermore-dashboard-history-v2";
  const MEDIA_KEY = "nevermore-dashboard-media-v2";
  const DB_NAMESPACE = "nevermore_dashboard";
  const STALE_AFTER_MS = 20_000;
  const HISTORY_SAMPLE_MS = 10_000;
  const HISTORY_RETENTION_MS = 24 * 60 * 60 * 1_000;
  const HISTORY_SAVE_MS = 60_000;
  const RESTART_QUARANTINE_MS = 90_000;
  const HISTORY_STABLE_SAMPLES = 3;
  const MAX_CHART_GAP_MS = 35_000;
  const OUTLET_VOC_STEP_LIMIT = 120;
  const OUTLET_VOC_INVERSION_LIMIT = 80;
  const CONTROL_UNLOCK_MS = 5 * 60 * 1_000;
  const MIN_SAFE_RPM = 2_000;
  const OBJECTS = {
    "gcode_macro SM_LED_STATE": null,
    "fan_generic Filter": ["speed", "rpm"],
    "temperature_sensor BME_IN": ["temperature"],
    "temperature_sensor BME_OUT": ["temperature"],
    "bme280 BME_IN": ["pressure", "humidity", "temperature"],
    "bme280 BME_OUT": ["pressure", "humidity", "temperature"],
    "temperature_sensor SGP_IN": ["temperature"],
    "temperature_sensor SGP_OUT": ["temperature"],
    "temperature_sensor _SM_PCB": ["temperature"],
    "temperature_sensor _SM_MCU": ["temperature"],
    print_stats: ["state", "filename", "print_duration", "total_duration"],
    webhooks: ["state", "state_message"],
  };

  const MODE_COPY = {
    IDLE: "Waiting for the next filtration cycle.",
    "PRINT FILTRATION": "Filtering chamber air throughout the active print.",
    "POST PRINT PURGE": "Clearing residual VOCs before returning to idle.",
    "NORMAL FILTRATION": "VOC levels are elevated; normal filtration is active.",
    "HEAVY VOC": "High VOC load detected; filter is running at full output.",
    "VOC EMERGENCY": "Emergency VOC threshold exceeded; maximum treatment is active.",
    "CHAMBER COOLING": "Chamber limit reached; active cooling is latched.",
    "MANUAL OVERRIDE": "Automatic control is paused by a manual override.",
    "MANUAL VENT": "Automatic control is paused for a commanded exhaust-vent position.",
    "SGP40 PREPARING": "Outputs are off while the printer and chamber cool to clean-air calibration limits.",
    "SGP40 CALIBRATION": "Both VOC sensors are learning a clean-air baseline. Keep the printer completely inactive.",
    "SGP40 FINALIZING": "Both learned SGP40 baselines are being stored before Klipper restarts.",
    "SGP40 COMPLETE": "Both SGP40 baselines were saved. Automatic control remains paused until resumed.",
    "SGP40 CANCELLED": "The clean-air calibration was cancelled. Automatic control remains paused.",
    "SGP40 INTERRUPTED": "Activity or a restart invalidated the calibration window; start a new full calibration.",
    DISABLED: "Nevermore automatic control is disabled.",
    FAULT: "A safety condition requires attention.",
  };

  const VOC_LABELS = ["CLEAR", "FILTERING", "HEAVY", "EMERGENCY"];

  const $ = (id) => document.getElementById(id);
  const els = Object.fromEntries(
    [
      "connectionChip", "connectionText", "settingsButton", "settingsDialog", "settingsForm",
      "endpointInput", "demoButton", "toast", "faultBanner", "faultMessage", "statusBeacon",
      "profileLabel", "modeTitle", "modeDescription", "autoFlag", "printFlag", "purgeFlag",
      "latchFlag", "ventFlag", "interlockFlag", "sgpCalibrationFlag", "fanGauge", "fanPercent", "fanRpm", "vocStatePill", "vocIn", "vocOut",
      "vocDelta", "efficiency", "vocFill", "warningMarker", "highMarker", "emergencyMarker",
      "warningLabel", "highLabel", "emergencyLabel", "coolingPill", "tempIn", "tempOut",
      "tempDelta", "hysteresisRange", "temperaturePosition", "coolingOffLabel", "coolingOnLabel",
      "fanIcon", "fanComponentText", "fanComponentState", "uvComponentState",
      "peltierComponentState", "peltierInterlockText", "ventIcon", "ventComponentState", "lastAction", "lastActionClock", "transitionCount", "printState",
      "filename", "dataAge", "priorityStack", "footerEndpoint",
      "mediaHealthDial", "mediaHealthPill", "mediaHealthSummary", "restrictionState",
      "pressureDrop", "captureState", "captureTrend", "mediaRuntime", "mediaInstalled",
      "pressureIn", "pressureOut", "newMediaButton", "pressureCalibrateButton",
      "vocCalibrateButton", "calibrationNote", "recorderState", "historyChart",
      "chartEmpty", "chartTooltip", "chartLegend", "historyNote", "chartMetric",
      "chartRange", "controlStatus", "controlLockButton", "controlFanVisual",
      "controlFanPercent", "controlFanRpm", "uvControlState", "peltierControlState", "ventControlState",
      "autoControlState", "safetyState", "pcbTemp", "mcuTemp", "airflowState",
      "sgpCalibrationState", "sgpCalibrationTime", "sgpCalibrationButton", "helpTooltip",
      "clearFaultButton", "confirmDialog", "confirmForm", "confirmEyebrow",
      "confirmTitle", "confirmMessage", "confirmAcceptButton", "workspaceTabs",
    ].map((id) => [id, $(id)])
  );

  const state = {
    objects: {},
    endpoint: "",
    connection: "offline",
    connectionLabel: "Offline",
    lastMessageAt: 0,
    isDemo: false,
    demoTimer: null,
    history: [],
    historyMetric: "voc",
    historyMinutes: 60,
    historySource: "browser",
    recorderGuard: null,
    lastHistoryAttemptAt: 0,
    lastHistorySampleAt: 0,
    lastHistorySaveAt: 0,
    historyQuarantineUntil: 0,
    historyStableSamples: 0,
    media: defaultMediaState(),
    collectorLifetime: null,
    controlsLocked: true,
    controlPending: false,
    unlockTimer: null,
    confirmResolver: null,
    databaseAvailable: false,
    currentView: "live",
  };

  let client = null;
  let toastTimer = null;

  class MoonrakerClient {
    constructor(endpoint, handlers = {}) {
      this.endpoint = normalizeEndpoint(endpoint);
      this.handlers = handlers;
      this.socket = null;
      this.pending = new Map();
      this.nextId = 1;
      this.reconnectTimer = null;
      this.readyTimer = null;
      this.heartbeatTimer = null;
      this.reconnectAttempt = 0;
      this.closedByUser = false;
    }

    connect() {
      this.disconnect(false);
      this.closedByUser = false;
      this.handlers.onConnection?.("connecting", "Connecting");

      const url = new URL(this.endpoint);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.pathname = `${url.pathname.replace(/\/$/, "")}/websocket`.replace("//websocket", "/websocket");
      url.search = "";
      url.hash = "";

      try {
        this.socket = new WebSocket(url.toString());
      } catch (error) {
        this.handleDisconnect(error.message);
        return;
      }

      this.socket.addEventListener("open", () => this.handleOpen());
      this.socket.addEventListener("message", (event) => this.handleMessage(event));
      this.socket.addEventListener("close", () => this.handleDisconnect("Connection closed"));
      this.socket.addEventListener("error", () => this.handlers.onConnection?.("error", "Connection error"));
    }

    disconnect(markClosed = true) {
      this.closedByUser = markClosed;
      clearTimeout(this.reconnectTimer);
      clearTimeout(this.readyTimer);
      clearInterval(this.heartbeatTimer);
      this.pending.forEach(({ reject }) => reject(new Error("Connection closed")));
      this.pending.clear();
      if (this.socket) {
        this.socket.onclose = null;
        this.socket.close();
        this.socket = null;
      }
    }

    async handleOpen() {
      this.reconnectAttempt = 0;
      this.handlers.onConnection?.("connecting", "Klipper check");
      try {
        await this.waitForKlipper();
      } catch (error) {
        this.handlers.onConnection?.("error", "Klipper unavailable");
        this.handlers.onError?.(error.message);
      }
    }

    async waitForKlipper() {
      const info = await this.call("server.info");
      const klippyState = info?.klippy_state;

      if (klippyState === "ready") {
        await this.subscribe();
        await initializeLiveFeatures();
        this.handlers.onConnection?.("live", "Live");
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = setInterval(() => {
          this.call("server.info").catch(() => {});
        }, 10_000);
        return;
      }

      if (klippyState === "error" || klippyState === "shutdown" || klippyState === "disconnected") {
        throw new Error(info?.klippy_state_message || `Klipper is ${klippyState}`);
      }

      this.handlers.onConnection?.("connecting", "Klipper starting");
      this.readyTimer = setTimeout(() => this.waitForKlipper().catch((error) => {
        this.handlers.onError?.(error.message);
      }), 2_000);
    }

    async subscribe() {
      const result = await this.call("printer.objects.subscribe", { objects: OBJECTS });
      this.handlers.onStatus?.(result?.status || {});
    }

    call(method, params) {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
        return Promise.reject(new Error("Moonraker socket is not open"));
      }

      const id = this.nextId++;
      const payload = { jsonrpc: "2.0", method, id };
      if (params !== undefined) payload.params = params;

      return new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        this.socket.send(JSON.stringify(payload));
      });
    }

    handleMessage(event) {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }

      this.handlers.onMessage?.();

      if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message || "Moonraker request failed"));
        else pending.resolve(message.result);
        return;
      }

      if (message.method === "notify_status_update") {
        this.handlers.onStatus?.(message.params?.[0] || {});
      } else if (message.method === "notify_klippy_ready") {
        this.waitForKlipper().catch((error) => this.handlers.onError?.(error.message));
      } else if (
        message.method === "notify_klippy_disconnected" ||
        message.method === "notify_klippy_shutdown"
      ) {
        this.handlers.onConnection?.("stale", "Klipper offline");
      }
    }

    handleDisconnect(reason) {
      clearInterval(this.heartbeatTimer);
      this.pending.forEach(({ reject }) => reject(new Error(reason)));
      this.pending.clear();
      if (this.closedByUser) return;

      this.handlers.onConnection?.("offline", "Reconnecting");
      const delay = Math.min(15_000, 1_000 * 2 ** this.reconnectAttempt++);
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    }
  }

  function normalizeEndpoint(value) {
    let endpoint = String(value || "").trim();
    if (!endpoint) return "";
    if (!/^https?:\/\//i.test(endpoint)) endpoint = `http://${endpoint}`;
    const url = new URL(endpoint);
    url.pathname = url.pathname.replace(/\/$/, "");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  }

  function mergeStatus(patch) {
    Object.entries(patch || {}).forEach(([objectName, values]) => {
      state.objects[objectName] = { ...(state.objects[objectName] || {}), ...(values || {}) };
    });
    state.lastMessageAt = Date.now();
    render();
  }

  function buildViewModel() {
    const sm = state.objects["gcode_macro SM_LED_STATE"] || {};
    const fan = state.objects["fan_generic Filter"] || {};
    const bmeIn = state.objects["temperature_sensor BME_IN"] || {};
    const bmeOut = state.objects["temperature_sensor BME_OUT"] || {};
    const bmeInFull = state.objects["bme280 BME_IN"] || {};
    const bmeOutFull = state.objects["bme280 BME_OUT"] || {};
    const sgpIn = state.objects["temperature_sensor SGP_IN"] || {};
    const sgpOut = state.objects["temperature_sensor SGP_OUT"] || {};
    const pcb = state.objects["temperature_sensor _SM_PCB"] || {};
    const smMcu = state.objects["temperature_sensor _SM_MCU"] || {};
    const print = state.objects.print_stats || {};
    const webhooks = state.objects.webhooks || {};

    const tempIn = numberOr(bmeIn.temperature, sm.temp_in);
    const tempOut = numberOr(bmeOut.temperature, sm.temp_out);
    const vocIn = numberOr(sgpIn.temperature, sm.voc_in);
    const vocOut = numberOr(sgpOut.temperature, sm.voc_out);
    const fanSpeed = clamp(numberOr(fan.speed, sm.last_filter_speed, 0), 0, 1);
    const vocDelta = validNumber(vocIn) && validNumber(vocOut) ? vocIn - vocOut : null;
    const efficiency = validNumber(vocIn) && vocIn > 0 && validNumber(vocOut)
      ? clamp(((vocIn - vocOut) / vocIn) * 100, 0, 100)
      : null;
    const tempDelta = validNumber(tempIn) && validNumber(tempOut) ? tempIn - tempOut : null;
    const chamberTarget = numberOr(sm.chamber_target, 55);
    const chamberHysteresis = numberOr(sm.chamber_hysteresis, 5);
    const mode = String(sm.auto_reason || sm.current_state || "IDLE").toUpperCase();
    const fault = truthy(sm.fault) || webhooks.state === "error" || webhooks.state === "shutdown";

    return {
      mode: fault ? "FAULT" : mode,
      sourceMode: mode,
      fault,
      faultMessage: webhooks.state_message || "Nevermore safety state is active.",
      automation: truthy(sm.auto_mode),
      manual: truthy(sm.manual_override),
      printActive: truthy(sm.print_active),
      purgeActive: truthy(sm.purge_active),
      chamberLatched: truthy(sm.chamber_cooling_latched),
      fanSpeed,
      rpm: numberOr(fan.rpm, sm.last_rpm, 0),
      uv: truthy(sm.uv),
      peltier: truthy(sm.peltier),
      ventOpen: truthy(sm.vent_open),
      ventClosedReady: truthy(sm.vent_closed_ready),
      ventPendingOpen: truthy(sm.vent_pending_open),
      peltierPending: truthy(sm.peltier_pending_on),
      peltierCooldown: truthy(sm.peltier_cooldown_active),
      peltierInterlock: String(sm.peltier_interlock_state || "READY").replace(/^"|"$/g, ""),
      sgpCalibrationActive: truthy(sm.sgp40_calibration_active),
      sgpCalibrationHold: truthy(sm.sgp40_calibration_hold),
      sgpCalibrationPhase: String(sm.sgp40_calibration_phase || "IDLE").replace(/^"|"$/g, "").toUpperCase(),
      sgpCalibrationRemaining: Math.max(0, Math.round(numberOr(sm.sgp40_calibration_remaining, 0))),
      sgpCalibrationDuration: Math.max(0, Math.round(numberOr(sm.sgp40_calibration_duration, 86_400))),
      sgpCalibrationRevision: Math.max(0, Math.round(numberOr(sm.sgp40_calibration_revision, 0))),
      sgpCalibrationResetApplied: truthy(sm.sgp40_calibration_reset_applied),
      tempIn,
      tempOut,
      tempDelta,
      vocIn,
      vocOut,
      vocDelta,
      efficiency,
      vocState: clamp(Math.round(numberOr(sm.voc_state, 0)), 0, 3),
      vocWarning: numberOr(sm.voc_warning, 120),
      vocHigh: numberOr(sm.voc_high, 220),
      vocEmergency: numberOr(sm.voc_emergency, 400),
      chamberTarget,
      chamberOff: chamberTarget - chamberHysteresis,
      chamberHysteresis,
      pressureIn: numberOr(bmeInFull.pressure),
      pressureOut: numberOr(bmeOutFull.pressure),
      humidityIn: numberOr(bmeInFull.humidity),
      humidityOut: numberOr(bmeOutFull.humidity),
      pcbTemp: numberOr(pcb.temperature),
      mcuTemp: numberOr(smMcu.temperature),
      fanReady: truthy(sm.fan_ready),
      lastAction: String(sm.last_action || "NONE").replace(/^"|"$/g, ""),
      lastActionClock: String(sm.last_action_clock || "").replace(/^"|"$/g, ""),
      transitions: Math.round(numberOr(sm.transition_count, 0)),
      printState: String(print.state || (truthy(sm.print_active) ? "printing" : "standby")),
      filename: String(print.filename || "—").split("/").pop(),
    };
  }

  function render() {
    const vm = buildViewModel();
    const tone = vm.fault || vm.vocState === 3 ? "danger" : vm.sgpCalibrationActive || vm.vocState === 2 ? "warning" : "idle";
    const purgeBand = ["IDLE", "NORMAL FILTRATION", "HEAVY VOC", "VOC EMERGENCY"][vm.vocState];
    const modeForStack = vm.fault
      ? "FAULT"
      : vm.sourceMode === "POST PRINT PURGE"
        ? purgeBand
        : vm.sourceMode;

    els.modeTitle.textContent = vm.mode;
    els.modeDescription.textContent = MODE_COPY[vm.mode] || MODE_COPY[vm.sourceMode] || "Nevermore automation is active.";
    els.statusBeacon.dataset.tone = tone;
    els.profileLabel.textContent = state.isDemo ? "SIMULATED SYSTEM" : "LIVE SYSTEM";

    setFlag(els.autoFlag, vm.automation);
    setFlag(els.printFlag, vm.printActive);
    setFlag(els.purgeFlag, vm.purgeActive);
    setFlag(els.latchFlag, vm.chamberLatched);
    setFlag(els.ventFlag, vm.ventOpen);
    setFlag(els.interlockFlag, vm.peltierCooldown || vm.peltierPending);
    setFlag(els.sgpCalibrationFlag, vm.sgpCalibrationActive || vm.sgpCalibrationHold);
    els.sgpCalibrationFlag.textContent = vm.sgpCalibrationActive
      ? "SGP40 " + vm.sgpCalibrationPhase
      : vm.sgpCalibrationHold && vm.sgpCalibrationPhase !== "IDLE"
        ? "SGP40 " + vm.sgpCalibrationPhase
        : "SGP40 CAL";
    els.interlockFlag.textContent = vm.peltierCooldown
      ? "PELTIER COOLDOWN"
      : vm.peltierPending ? "PELTIER WAIT" : "PELTIER INTERLOCK";

    const fanPercent = Math.round(vm.fanSpeed * 100);
    els.fanGauge.style.setProperty("--fan-value", String(fanPercent));
    els.fanPercent.textContent = `${fanPercent}%`;
    els.fanRpm.textContent = `${formatInteger(vm.rpm)} RPM`;

    els.vocStatePill.textContent = VOC_LABELS[vm.vocState];
    els.vocStatePill.dataset.level = String(vm.vocState);
    els.vocIn.textContent = formatInteger(vm.vocIn);
    els.vocOut.textContent = formatInteger(vm.vocOut);
    els.vocDelta.textContent = validNumber(vm.vocDelta) ? `${vm.vocDelta >= 0 ? "−" : "+"}${formatInteger(Math.abs(vm.vocDelta))} index` : "—";
    els.efficiency.textContent = validNumber(vm.efficiency) ? `${vm.efficiency.toFixed(1)}%` : "—";

    const vocScaleMax = Math.max(vm.vocEmergency * 1.1, 1);
    els.vocFill.style.width = `${clamp((numberOr(vm.vocIn, 0) / vocScaleMax) * 100, 0, 100)}%`;
    positionThreshold(els.warningMarker, vm.vocWarning, vocScaleMax);
    positionThreshold(els.highMarker, vm.vocHigh, vocScaleMax);
    positionThreshold(els.emergencyMarker, vm.vocEmergency, vocScaleMax);
    positionThreshold(els.warningLabel, vm.vocWarning, vocScaleMax);
    positionThreshold(els.highLabel, vm.vocHigh, vocScaleMax);
    els.warningLabel.textContent = `WARN ${formatInteger(vm.vocWarning)}`;
    els.highLabel.textContent = `HIGH ${formatInteger(vm.vocHigh)}`;
    els.emergencyLabel.textContent = `EMERG ${formatInteger(vm.vocEmergency)}`;

    els.coolingPill.textContent = vm.chamberLatched ? "LATCHED" : "STANDBY";
    els.coolingPill.dataset.level = vm.chamberLatched ? "2" : "0";
    els.tempIn.textContent = formatDecimal(vm.tempIn);
    els.tempOut.textContent = formatDecimal(vm.tempOut);
    els.tempDelta.textContent = validNumber(vm.tempDelta) ? `${formatDecimal(vm.tempDelta)}°C` : "—°C";
    els.hysteresisRange.textContent = `${formatDecimal(vm.chamberTarget)} / ${formatDecimal(vm.chamberOff)}°C`;
    els.coolingOffLabel.textContent = `OFF ${formatDecimal(vm.chamberOff)}°`;
    els.coolingOnLabel.textContent = `ON ${formatDecimal(vm.chamberTarget)}°`;
    const tempScaleLow = Math.max(0, vm.chamberOff - 20);
    const tempScaleHigh = vm.chamberTarget + 5;
    const temperaturePct = validNumber(vm.tempIn)
      ? clamp(((vm.tempIn - tempScaleLow) / (tempScaleHigh - tempScaleLow)) * 100, 0, 100)
      : 0;
    els.temperaturePosition.style.left = `${temperaturePct}%`;

    setComponent(els.fanComponentState, fanPercent > 0, `${fanPercent}%`);
    setComponent(els.uvComponentState, vm.uv);
    setComponent(els.peltierComponentState, vm.peltier);
    if (vm.peltierCooldown || vm.peltierPending) {
      els.peltierComponentState.textContent = vm.peltierCooldown ? "COOLDOWN" : "WAITING";
      els.peltierComponentState.classList.remove("is-active");
      els.peltierComponentState.classList.add("is-pending");
    } else {
      els.peltierComponentState.classList.remove("is-pending");
    }
    els.peltierInterlockText.textContent = vm.peltierInterlock === "READY"
      ? "Vent and airflow interlocked"
      : vm.peltierInterlock;
    els.ventComponentState.textContent = vm.ventOpen ? "OPEN" : "CLOSED";
    els.ventComponentState.classList.toggle("is-active", vm.ventOpen);
    els.fanIcon.classList.toggle("is-running", fanPercent > 0);
    els.fanComponentText.textContent = fanPercent > 0 ? `${formatInteger(vm.rpm)} RPM measured` : "Stopped";
    document.querySelector(".uv-icon")?.classList.toggle("is-active", vm.uv);
    document.querySelector(".peltier-icon")?.classList.toggle("is-active", vm.peltier);
    els.ventIcon.classList.toggle("is-active", vm.ventOpen);

    els.lastAction.textContent = vm.lastAction || "NONE";
    els.lastActionClock.textContent = vm.lastActionClock && vm.lastActionClock !== "0"
      ? `At ${vm.lastActionClock} printer runtime`
      : "No transition timestamp recorded";
    els.transitionCount.textContent = formatInteger(vm.transitions);
    els.printState.textContent = titleCase(vm.printState);
    els.filename.textContent = vm.filename;
    els.filename.title = vm.filename;

    [...els.priorityStack.children].forEach((item) => {
      item.classList.toggle("is-active", item.dataset.mode === modeForStack);
    });

    els.faultBanner.hidden = !vm.fault;
    els.faultMessage.textContent = vm.faultMessage;
    renderExtended(vm);
    maybeRecordHistory(vm);
    renderConnection();
    renderAge();
  }

  function renderConnection() {
    els.connectionChip.dataset.state = state.connection;
    els.connectionText.textContent = state.connectionLabel;
    els.footerEndpoint.textContent = state.isDemo
      ? "Simulated live sequence"
      : state.endpoint
        ? `Moonraker · ${displayEndpoint(state.endpoint)}`
        : "Moonraker not configured";
  }

  function renderAge() {
    if (!state.lastMessageAt) {
      els.dataAge.textContent = "—";
      return;
    }
    const ageMs = Date.now() - state.lastMessageAt;
    els.dataAge.textContent = ageMs < 1_500 ? "Now" : `${Math.floor(ageMs / 1000)}s ago`;
    if (!state.isDemo && state.connection === "live" && ageMs > STALE_AFTER_MS) {
      setConnection("stale", "Data stale");
    }
  }

  function setConnection(connection, label) {
    const previousConnection = state.connection;
    state.connection = connection;
    state.connectionLabel = label;
    if (!state.isDemo && connection === "live" && previousConnection !== "live") {
      state.historyQuarantineUntil = Date.now() + RESTART_QUARANTINE_MS;
      state.historyStableSamples = 0;
      state.lastHistoryAttemptAt = 0;
    } else if (!state.isDemo && connection !== "live") {
      state.historyStableSamples = 0;
    }
    renderConnection();
    if (state.vm) renderExtended(state.vm);
  }

  function connect(endpoint) {
    stopDemo();
    let normalized;
    try {
      normalized = normalizeEndpoint(endpoint);
    } catch {
      showToast("Enter a valid printer address.");
      els.settingsDialog.showModal();
      return;
    }

    if (!normalized) {
      showToast("Enter the Moonraker or Mainsail address first.");
      return;
    }

    state.endpoint = normalized;
    state.objects = {};
    state.lastMessageAt = 0;
    state.isDemo = false;
    localStorage.setItem(STORAGE_KEY, normalized);
    client?.disconnect();
    client = new MoonrakerClient(normalized, {
      onConnection: setConnection,
      onStatus: mergeStatus,
      onMessage: () => {
        state.lastMessageAt = Date.now();
      },
      onError: (message) => showToast(message),
    });
    client.connect();
    render();
  }

  const DEMO_FRAMES = [
    {
      duration: 4_000,
      sm: { auto_reason: "IDLE", current_state: "IDLE", auto_mode: 1, print_active: 0, purge_active: 0, voc_state: 0, chamber_cooling_latched: 0, vent_open: 0, vent_closed_ready: 1, peltier_interlock_state: "READY", last_action: "PURGE COMPLETE", last_action_clock: "0s", transition_count: 4, uv: 0, peltier: 0 },
      fan: { speed: 0, rpm: 0 }, sensors: [27.1, 27.5, 99, 99], print: { state: "standby", filename: "" },
    },
    {
      duration: 6_000,
      sm: { auto_reason: "PRINT FILTRATION", current_state: "PRINT FILTRATION", auto_mode: 1, print_active: 1, purge_active: 0, voc_state: 1, chamber_cooling_latched: 0, vent_open: 0, vent_closed_ready: 1, peltier_interlock_state: "READY", last_action: "PRINT FILTRATION", last_action_clock: "615s", transition_count: 5, uv: 0, peltier: 0 },
      fan: { speed: 1, rpm: 9640 }, sensors: [36.7, 30.9, 164, 112], print: { state: "printing", filename: "OrcaToleranceTest_ASA_17m34s.gcode" },
    },
    {
      duration: 5_000,
      sm: { auto_reason: "CHAMBER COOLING", current_state: "CHAMBER COOLING", auto_mode: 1, print_active: 1, purge_active: 0, voc_state: 1, chamber_cooling_latched: 1, vent_open: 1, vent_closed_ready: 0, peltier_interlock_state: "VENT OPEN", last_action: "CHAMBER COOLING", last_action_clock: "1284s", transition_count: 6, uv: 0, peltier: 0 },
      fan: { speed: 1, rpm: 9590 }, sensors: [60.3, 48.7, 176, 118], print: { state: "printing", filename: "OrcaToleranceTest_ASA_17m34s.gcode" },
    },
    {
      duration: 5_000,
      sm: { auto_reason: "POST PRINT PURGE", current_state: "POST PRINT PURGE", auto_mode: 1, print_active: 0, purge_active: 1, voc_state: 2, chamber_cooling_latched: 0, vent_open: 1, vent_closed_ready: 0, peltier_interlock_state: "VENT OPEN", last_action: "POST PRINT PURGE", last_action_clock: "1510s", transition_count: 7, uv: 1, peltier: 0 },
      fan: { speed: 1, rpm: 9625 }, sensors: [48.2, 39.4, 246, 137], print: { state: "complete", filename: "OrcaToleranceTest_ASA_17m34s.gcode" },
    },
    {
      duration: 5_000,
      sm: { auto_reason: "POST PRINT PURGE", current_state: "POST PRINT PURGE", auto_mode: 1, print_active: 0, purge_active: 1, voc_state: 1, chamber_cooling_latched: 0, vent_open: 1, vent_closed_ready: 0, peltier_interlock_state: "VENT OPEN", last_action: "POST PRINT PURGE", last_action_clock: "1510s", transition_count: 7, uv: 0, peltier: 0 },
      fan: { speed: 0.6, rpm: 7620 }, sensors: [39.4, 34.8, 114, 101], print: { state: "complete", filename: "OrcaToleranceTest_ASA_17m34s.gcode" },
    },
  ];

  function startDemo() {
    client?.disconnect();
    client = null;
    stopDemo();
    state.isDemo = true;
    state.endpoint = "";
    state.objects = {};
    setConnection("live", "Demo");

    let frameIndex = 0;
    const applyFrame = () => {
      const frame = DEMO_FRAMES[frameIndex];
      mergeStatus({
        "gcode_macro SM_LED_STATE": {
          chamber_target: 60,
          chamber_hysteresis: 5,
          voc_idle_hysteresis: 20,
          voc_warning: 120,
          voc_high: 220,
          voc_emergency: 400,
          fault: 0,
          manual_override: 0,
          ...frame.sm,
        },
        "fan_generic Filter": frame.fan,
        "temperature_sensor BME_IN": { temperature: frame.sensors[0] },
        "temperature_sensor BME_OUT": { temperature: frame.sensors[1] },
        "bme280 BME_IN": { temperature: frame.sensors[0], pressure: 1008.42, humidity: 31.2 },
        "bme280 BME_OUT": { temperature: frame.sensors[1], pressure: 1008.35 - frame.fan.speed * 0.05, humidity: 29.8 },
        "temperature_sensor SGP_IN": { temperature: frame.sensors[2] },
        "temperature_sensor SGP_OUT": { temperature: frame.sensors[3] },
        "temperature_sensor _SM_PCB": { temperature: 38.2 + frame.fan.speed * 3 },
        "temperature_sensor _SM_MCU": { temperature: 42.5 + frame.fan.speed * 2 },
        print_stats: frame.print,
        webhooks: { state: "ready", state_message: "Printer is ready" },
      });
      frameIndex = (frameIndex + 1) % DEMO_FRAMES.length;
      state.demoTimer = setTimeout(applyFrame, frame.duration);
    };

    applyFrame();
    showToast("Demo mode cycles through idle, print, cooling, and purge states.");
  }

  function stopDemo() {
    clearTimeout(state.demoTimer);
    state.demoTimer = null;
    state.isDemo = false;
  }

  function initialEndpoint() {
    const query = new URLSearchParams(location.search);
    const fromQuery = query.get("moonraker");
    if (fromQuery) return fromQuery;

    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) return saved;

    const isLikelyPrinterHost = location.protocol.startsWith("http") &&
      !["localhost", "127.0.0.1", "terminal.local"].includes(location.hostname);
    return isLikelyPrinterHost ? location.origin : "";
  }

  function defaultMediaState() {
    return {
      installedAt: null,
      pressureZeroPa: null,
      pressureFreshPa: null,
      pressureCalibratedAt: null,
      vocFreshEfficiency: null,
      vocCalibratedAt: null,
      sgpCalibrationRevision: 0,
      fanSeconds: 0,
    };
  }

  function loadLocalFeatureState() {
    try {
      const history = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
      if (Array.isArray(history)) mergeHistory(history, "browser");
    } catch {
      localStorage.removeItem(HISTORY_KEY);
    }

    try {
      const media = JSON.parse(localStorage.getItem(MEDIA_KEY) || "null");
      if (media && typeof media === "object") {
        state.media = { ...defaultMediaState(), ...media };
      }
    } catch {
      localStorage.removeItem(MEDIA_KEY);
    }
  }

  async function initializeLiveFeatures() {
    if (!client || state.isDemo) return;

    try {
      const result = await client.call("server.database.get_item", {
        namespace: DB_NAMESPACE,
        key: "media",
      });
      if (result?.value && typeof result.value === "object") {
        state.media = { ...defaultMediaState(), ...result.value };
        localStorage.setItem(MEDIA_KEY, JSON.stringify(state.media));
      }
      state.databaseAvailable = true;
    } catch {
      state.databaseAvailable = false;
    }

    await loadCollectorHistory();
  }

  async function persistMedia(showResult = false) {
    localStorage.setItem(MEDIA_KEY, JSON.stringify(state.media));
    if (client && !state.isDemo) {
      try {
        await client.call("server.database.post_item", {
          namespace: DB_NAMESPACE,
          key: "media",
          value: state.media,
        });
        state.databaseAvailable = true;
        if (showResult) showToast("Media calibration saved on the printer.");
        return;
      } catch {
        state.databaseAvailable = false;
      }
    }
    if (showResult) showToast("Media calibration saved in this browser.");
  }

  async function loadCollectorHistory() {
    if (state.isDemo || !location.protocol.startsWith("http")) return;
    try {
      const response = await fetch("./data/history.json", { cache: "no-store" });
      if (!response.ok) throw new Error("Recorder unavailable");
      const payload = await response.json();
      if (!Array.isArray(payload.samples)) throw new Error("Recorder data invalid");
      mergeHistory(payload.samples, "pi");
      state.collectorLifetime = payload.lifetime || null;
      state.recorderGuard = payload.guard || null;
      state.historySource = "pi";
      renderChart();
    } catch {
      if (state.historySource !== "pi") state.historySource = "browser";
    }
  }

  function mergeHistory(samples, source) {
    const cutoff = Date.now() - HISTORY_RETENTION_MS;
    const combined = new Map();
    [...state.history, ...samples].forEach((point) => {
      const normalized = sanitizeHistoryPoint(point);
      if (normalized && normalized.t >= cutoff) combined.set(normalized.t, normalized);
    });
    state.history = cleanHistorySeries([...combined.values()]);
    if (source === "pi") state.historySource = "pi";
  }

  function sanitizeHistoryPoint(point) {
    if (!point || !Number.isFinite(Number(point.t))) return null;
    const clean = { t: Number(point.t), mode: String(point.mode || "") };
    ["vi", "vo", "ti", "to", "pi", "po", "hi", "ho", "fs", "rpm", "uv", "pel", "vent", "cal", "sgp"].forEach((key) => {
      const raw = point[key];
      const value = Number(raw);
      clean[key] = raw !== null && raw !== "" && Number.isFinite(value) ? value : null;
    });
    return clean;
  }

  function historyPointError(point) {
    if (![point.vi, point.vo].every((value) => validNumber(value) && value >= 0 && value <= 500)) {
      return "VOC sensor startup value";
    }
    if (![point.ti, point.to].every((value) => validNumber(value) && value >= 1 && value <= 110)) {
      return "temperature sensor startup value";
    }
    if (![point.pi, point.po].every((value) => validNumber(value) && value >= 300 && value <= 1200)) {
      return "pressure sensor startup value";
    }
    if (Math.abs(point.pi - point.po) > 20) return "impossible differential pressure";
    if ([point.hi, point.ho].some((value) => validNumber(value) && (value < 0 || value > 100))) {
      return "humidity outside range";
    }
    if (!validNumber(point.fs) || point.fs < 0 || point.fs > 1.05) return "fan command outside range";
    if (!validNumber(point.rpm) || point.rpm < 0 || point.rpm > 30_000) return "fan RPM outside range";
    if (validNumber(point.vent) && point.vent !== 0 && point.vent !== 1) return "vent state outside range";
    if (validNumber(point.cal) && point.cal !== 0 && point.cal !== 1) return "calibration state outside range";
    if (validNumber(point.sgp) && (point.sgp < 0 || point.sgp > 1_000_000)) return "SGP40 calibration revision outside range";
    return null;
  }

  function outletVocRestartError(previous, current) {
    if (!previous || !current) return null;
    const outletStep = current.vo - previous.vo;
    const outletInversion = current.vo - current.vi;
    return outletStep >= OUTLET_VOC_STEP_LIMIT && outletInversion >= OUTLET_VOC_INVERSION_LIMIT
      ? "outlet VOC restart spike"
      : null;
  }

  function cleanHistorySeries(points) {
    const ordered = points
      .filter((point) => point && validNumber(point.t))
      .sort((a, b) => a.t - b.t);
    const clean = [];
    let quarantineUntil = 0;
    let previousPlausible = null;

    ordered.forEach((point) => {
      if (historyPointError(point)) {
        quarantineUntil = Math.max(quarantineUntil, point.t + RESTART_QUARANTINE_MS);
        previousPlausible = null;
        return;
      }
      const transient = outletVocRestartError(previousPlausible, point);
      previousPlausible = point;
      if (transient) {
        quarantineUntil = Math.max(quarantineUntil, point.t + RESTART_QUARANTINE_MS);
        return;
      }
      if (point.t < quarantineUntil) return;
      clean.push(point);
    });

    return clean;
  }

  function maybeRecordHistory(vm) {
    const now = Date.now();
    if (now - state.lastHistoryAttemptAt < HISTORY_SAMPLE_MS) return;
    state.lastHistoryAttemptAt = now;

    if (!state.isDemo) {
      if (state.connection !== "live" || now < state.historyQuarantineUntil) return;

      const candidate = sanitizeHistoryPoint({
        t: now,
        vi: vm.vocIn,
        vo: vm.vocOut,
        ti: vm.tempIn,
        to: vm.tempOut,
        pi: vm.pressureIn,
        po: vm.pressureOut,
        hi: vm.humidityIn,
        ho: vm.humidityOut,
        fs: vm.fanSpeed,
        rpm: vm.rpm,
        uv: vm.uv ? 1 : 0,
        pel: vm.peltier ? 1 : 0,
        vent: vm.ventOpen ? 1 : 0,
        cal: vm.sgpCalibrationActive ? 1 : 0,
        sgp: vm.sgpCalibrationRevision,
        mode: vm.mode,
      });

      const previous = state.history.length ? state.history[state.history.length - 1] : null;
      if (!candidate || historyPointError(candidate) || outletVocRestartError(previous, candidate)) {
        state.historyQuarantineUntil = now + RESTART_QUARANTINE_MS;
        state.historyStableSamples = 0;
        return;
      }

      state.historyStableSamples += 1;
      if (state.historyStableSamples < HISTORY_STABLE_SAMPLES) return;
    }

    if (state.lastHistorySampleAt && state.media.installedAt && vm.fanSpeed > 0) {
      state.media.fanSeconds = numberOr(state.media.fanSeconds, 0) +
        Math.min((now - state.lastHistorySampleAt) / 1_000, HISTORY_SAMPLE_MS / 1_000 * 2);
    }

    state.lastHistorySampleAt = now;
    const point = sanitizeHistoryPoint({
      t: now,
      vi: vm.vocIn,
      vo: vm.vocOut,
      ti: vm.tempIn,
      to: vm.tempOut,
      pi: vm.pressureIn,
      po: vm.pressureOut,
      hi: vm.humidityIn,
      ho: vm.humidityOut,
      fs: vm.fanSpeed,
      rpm: vm.rpm,
      uv: vm.uv ? 1 : 0,
      pel: vm.peltier ? 1 : 0,
      vent: vm.ventOpen ? 1 : 0,
      cal: vm.sgpCalibrationActive ? 1 : 0,
      sgp: vm.sgpCalibrationRevision,
      mode: vm.mode,
    });
    if (point) mergeHistory([point], "browser");

    if (now - state.lastHistorySaveAt >= HISTORY_SAVE_MS) {
      state.lastHistorySaveAt = now;
      localStorage.setItem(HISTORY_KEY, JSON.stringify(state.history));
      persistMedia(false);
      renderChart();
    }
  }

  function rawPressureDeltaPa(pressureIn, pressureOut) {
    if (
      !validNumber(pressureIn) || !validNumber(pressureOut) ||
      pressureIn < 300 || pressureIn > 1200 || pressureOut < 300 || pressureOut > 1200 ||
      Math.abs(pressureIn - pressureOut) > 20
    ) return null;
    return (pressureIn - pressureOut) * 100;
  }

  function calibratedPressureDropPa(pressureIn, pressureOut) {
    const raw = rawPressureDeltaPa(pressureIn, pressureOut);
    const zero = numberOr(state.media.pressureZeroPa);
    if (!validNumber(raw) || !validNumber(zero)) return null;
    return Math.abs(raw - zero);
  }

  function sampleEfficiency(vocIn, vocOut) {
    if (
      !validNumber(vocIn) || !validNumber(vocOut) ||
      vocIn < 1 || vocIn > 500 || vocOut < 1 || vocOut > 500
    ) return null;
    return clamp(((vocIn - vocOut) / vocIn) * 100, 0, 100);
  }

  function sampleMatchesSgpRevision(point, revision) {
    const sampleRevision = validNumber(point?.sgp) ? Math.round(point.sgp) : 0;
    return sampleRevision === Math.round(numberOr(revision, 0));
  }

  function median(values) {
    const sorted = values.filter(validNumber).sort((a, b) => a - b);
    if (!sorted.length) return null;
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  function mediaRuntimeHours() {
    const collectorInstalledAt = Number(state.collectorLifetime?.installed_at);
    const installedAt = Number(state.media.installedAt);
    if (validNumber(collectorInstalledAt) && collectorInstalledAt === installedAt) {
      return numberOr(state.collectorLifetime?.fan_seconds, 0) / 3_600;
    }
    return numberOr(state.media.fanSeconds, 0) / 3_600;
  }

  function evaluateMediaHealth(vm) {
    const recentCutoff = Date.now() - 10 * 60 * 1_000;
    const pressureSamples = state.history
      .filter((point) => point.t >= recentCutoff && point.fs >= 0.9 && point.cal !== 1)
      .map((point) => calibratedPressureDropPa(point.pi, point.po))
      .filter(validNumber);
    const currentDrop = median(pressureSamples);
    const freshDrop = numberOr(state.media.pressureFreshPa);
    const restrictionRatio = validNumber(currentDrop) && validNumber(freshDrop) && freshDrop >= 0.5
      ? currentDrop / freshDrop
      : null;

    let restriction = { level: 0, label: "Needs baseline", detail: "Calibrate with fresh media" };
    if (validNumber(restrictionRatio)) {
      if (restrictionRatio <= 1.25) restriction = { level: 1, label: "Normal", detail: Math.round(restrictionRatio * 100) + "% of baseline" };
      else if (restrictionRatio <= 1.6) restriction = { level: 2, label: "Increasing", detail: Math.round(restrictionRatio * 100) + "% of baseline" };
      else restriction = { level: 3, label: "Restricted", detail: Math.round(restrictionRatio * 100) + "% of baseline" };
    } else if (validNumber(freshDrop) && pressureSamples.length < 6) {
      restriction = { level: 0, label: "Waiting for airflow", detail: "Needs 1 minute at full fan" };
    }

    const vocCutoff = Date.now() - 6 * 60 * 60 * 1_000;
    const qualifiedVoc = state.history
      .filter((point) => point.t >= vocCutoff && point.fs >= 0.9 && point.vi >= vm.vocWarning && point.cal !== 1 && sampleMatchesSgpRevision(point, vm.sgpCalibrationRevision))
      .map((point) => sampleEfficiency(point.vi, point.vo))
      .filter((value) => validNumber(value) && value > 0);
    const recentVoc = median(qualifiedVoc.slice(-60));
    const baselineMatchesRevision = Math.round(numberOr(state.media.sgpCalibrationRevision, 0)) === vm.sgpCalibrationRevision;
    const freshVoc = baselineMatchesRevision ? numberOr(state.media.vocFreshEfficiency) : null;
    const captureRatio = validNumber(recentVoc) && validNumber(freshVoc) && freshVoc >= 5
      ? recentVoc / freshVoc
      : null;

    let capture = { level: 0, label: "Learning", detail: qualifiedVoc.length + " qualified samples" };
    if (validNumber(captureRatio) && qualifiedVoc.length >= 12) {
      if (captureRatio >= 0.75) capture = { level: 1, label: "Stable", detail: Math.round(captureRatio * 100) + "% of fresh baseline" };
      else if (captureRatio >= 0.5) capture = { level: 2, label: "Trending down", detail: Math.round(captureRatio * 100) + "% of fresh baseline" };
      else capture = { level: 3, label: "Breakthrough", detail: Math.round(captureRatio * 100) + "% of fresh baseline" };
    } else if (!validNumber(freshVoc)) {
      capture = {
        level: 0,
        label: "Needs baseline",
        detail: baselineMatchesRevision
          ? "Capture during an elevated-VOC cycle"
          : "Renew after SGP40 calibration",
      };
    }

    const worst = Math.max(restriction.level, capture.level);
    const hasPressureCalibration = validNumber(freshDrop);
    const hasVocCalibration = validNumber(freshVoc);
    const hasCalibration = hasPressureCalibration || hasVocCalibration;
    const bothEvaluated = restriction.level > 0 && capture.level > 0;
    let overall = { level: 0, label: "LEARNING", summary: "Calibrate fresh media to begin trend-based health monitoring." };
    if (hasCalibration && worst === 1 && bothEvaluated) overall = { level: 1, label: "HEALTHY", summary: "Restriction and VOC capture remain close to the fresh-media baseline." };
    if (hasCalibration && worst === 1 && !bothEvaluated) overall = {
      level: 1,
      label: "PARTIAL",
      summary: hasPressureCalibration
        ? "Airflow restriction is normal; a fresh-carbon VOC baseline is still needed."
        : "VOC capture is stable; pressure calibration is still needed for restriction health.",
    };
    if (hasCalibration && worst === 2) overall = { level: 2, label: "MONITOR", summary: "One media trend has moved away from baseline; watch the next several cycles." };
    if (hasCalibration && worst === 3 && capture.level === 3) overall = { level: 3, label: "REPLACE", summary: "VOC breakthrough is substantially worse than the fresh-carbon baseline." };
    if (hasCalibration && worst === 3 && restriction.level === 3 && capture.level < 3) overall = { level: 3, label: "SERVICE", summary: "Pressure drop indicates restriction through the carbon and HEPA media path." };
    if (hasCalibration && worst === 0) overall = { level: 0, label: "GATHERING DATA", summary: "Calibration is saved; more full-flow samples are needed for a health result." };

    return { overall, restriction, capture, currentDrop, runtimeHours: mediaRuntimeHours() };
  }

  function renderExtended(vm) {
    state.vm = vm;
    const rawDrop = rawPressureDeltaPa(vm.pressureIn, vm.pressureOut);
    const health = evaluateMediaHealth(vm);

    els.pressureIn.textContent = validNumber(vm.pressureIn) ? vm.pressureIn.toFixed(2) : "—";
    els.pressureOut.textContent = validNumber(vm.pressureOut) ? vm.pressureOut.toFixed(2) : "—";
    els.pressureDrop.textContent = validNumber(health.currentDrop)
      ? "ΔP " + health.currentDrop.toFixed(1) + " Pa"
      : validNumber(rawDrop) ? "Raw ΔP " + rawDrop.toFixed(1) + " Pa" : "ΔP — Pa";
    els.mediaHealthPill.textContent = health.overall.label;
    els.mediaHealthPill.dataset.level = String(health.overall.level);
    els.mediaHealthDial.textContent = health.overall.level === 0 ? "…" : health.overall.label;
    els.mediaHealthSummary.textContent = health.overall.summary;
    els.restrictionState.textContent = health.restriction.label;
    els.captureState.textContent = health.capture.label;
    els.captureTrend.textContent = health.capture.detail;
    els.mediaRuntime.textContent = health.runtimeHours.toFixed(1) + " h";
    els.mediaInstalled.textContent = state.media.installedAt
      ? "Installed " + new Date(state.media.installedAt).toLocaleDateString()
      : "Install date not set";

    const fanPercent = Math.round(vm.fanSpeed * 100);
    els.controlFanVisual.style.setProperty("--control-fan-speed", String(fanPercent));
    els.controlFanPercent.textContent = fanPercent + "%";
    els.controlFanRpm.textContent = formatInteger(vm.rpm) + " RPM";
    els.uvControlState.textContent = vm.uv ? "ON" : "OFF";
    els.peltierControlState.textContent = vm.peltier
      ? "ON"
      : vm.peltierCooldown ? "COOLDOWN" : vm.peltierPending ? "WAITING" : "OFF";
    els.ventControlState.textContent = vm.ventOpen ? "OPEN" : "CLOSED";
    els.autoControlState.textContent = vm.automation && !vm.manual ? "AUTO" : "MANUAL";
    document.querySelector('[data-action="uv-toggle"]')?.setAttribute("aria-pressed", String(vm.uv));
    document.querySelector('[data-action="peltier-toggle"]')?.setAttribute("aria-pressed", String(vm.peltier));
    document.querySelector('[data-action="vent-toggle"]')?.setAttribute("aria-pressed", String(vm.ventOpen));

    els.pcbTemp.textContent = validNumber(vm.pcbTemp) ? vm.pcbTemp.toFixed(1) + "°C" : "—°C";
    els.mcuTemp.textContent = validNumber(vm.mcuTemp) ? vm.mcuTemp.toFixed(1) + "°C" : "—°C";
    els.airflowState.textContent = vm.rpm >= MIN_SAFE_RPM ? "Verified" : fanPercent > 0 ? "Starting" : "Stopped";
    els.safetyState.textContent = vm.fault
      ? "FAULT"
      : vm.peltierCooldown ? "COOLDOWN" : vm.peltierPending ? "INTERLOCK WAIT"
        : vm.rpm >= MIN_SAFE_RPM || (!vm.uv && !vm.peltier) ? "NOMINAL" : "CHECK AIRFLOW";

    const controlsAvailable = state.connection === "live" && !state.isDemo && !state.controlPending;
    document.querySelectorAll("[data-action]").forEach((button) => {
      const emergency = button.dataset.action === "emergency-off";
      const baselineRestartBlock = button.dataset.action === "resume-auto" && vm.sgpCalibrationResetApplied;
      button.disabled = !controlsAvailable || (state.controlsLocked && !emergency) || (vm.sgpCalibrationActive && !emergency) || baselineRestartBlock;
    });
    els.controlStatus.textContent = state.controlPending
      ? "Applying command…"
      : vm.sgpCalibrationActive
        ? "SGP40 clean-air calibration is active. Manual outputs are blocked until it completes or is cancelled."
      : state.controlsLocked
        ? "Controls are locked to prevent accidental operation."
        : "Manual controls unlocked. They lock automatically after five minutes.";
    els.controlLockButton.dataset.locked = String(state.controlsLocked);
    els.controlLockButton.querySelector("strong").textContent = state.controlsLocked ? "LOCKED" : "UNLOCKED";
    els.clearFaultButton.hidden = !vm.fault;

    els.recorderState.textContent = state.historySource === "pi" ? "Pi recorder" : "Browser history";
    els.recorderState.dataset.state = state.historySource;
    els.historyNote.textContent = vm.sgpCalibrationActive
      ? "SGP40 calibration samples are marked in the chart and excluded from media-health calculations."
      : state.historySource === "pi"
        ? state.recorderGuard?.state === "recording"
          ? "Pi recorder is filtering restart transients and recording stable telemetry."
          : "Pi recorder is protecting history while Klipper and the sensors stabilize."
        : "Install the optional Pi recorder for history that continues while this page is closed.";

    const phase = vm.sgpCalibrationPhase;
    els.sgpCalibrationState.textContent = phase === "IDLE" ? "READY" : phase;
    els.sgpCalibrationTime.textContent = vm.sgpCalibrationActive
      ? phase === "COOLING"
        ? "Waiting for safe clean-air temperatures"
        : formatDuration(vm.sgpCalibrationRemaining) + " remaining"
      : phase === "COMPLETE"
        ? "Baselines saved · automation paused"
        : phase === "INTERRUPTED"
          ? vm.sgpCalibrationResetApplied
            ? "FIRMWARE_RESTART required before resume"
            : "Restart the full 24-hour window"
          : phase === "CANCELLED"
            ? "Cancelled · automation paused"
            : "24-hour clean-air calibration";
    els.sgpCalibrationButton.textContent = vm.sgpCalibrationActive
      ? "Cancel SGP40 calibration"
      : "Calibrate SGP40 sensors";
    els.sgpCalibrationButton.dataset.active = String(vm.sgpCalibrationActive);
    els.sgpCalibrationButton.disabled = !controlsAvailable || state.controlsLocked;

    const maintenanceBlocked = vm.sgpCalibrationActive || vm.sgpCalibrationHold;
    els.pressureCalibrateButton.disabled = state.controlPending || state.connection !== "live" || state.isDemo || maintenanceBlocked;
    els.vocCalibrateButton.disabled = state.controlPending || state.connection !== "live" || state.isDemo || maintenanceBlocked;
    els.newMediaButton.disabled = state.controlPending || state.isDemo || vm.sgpCalibrationActive;
  }

  function setCurrentView(view) {
    state.currentView = ["live", "history", "media", "controls"].includes(view) ? view : "live";
    document.querySelectorAll("[data-view-panel]").forEach((panel) => {
      panel.hidden = panel.dataset.viewPanel !== state.currentView;
    });
    els.workspaceTabs.querySelectorAll("button").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.view === state.currentView);
    });
    if (state.currentView === "history") requestAnimationFrame(renderChart);
  }

  function renderChart() {
    if (!els.historyChart || state.currentView !== "history") return;
    const canvas = els.historyChart;
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 20 || rect.height < 20) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(rect.width * ratio);
    canvas.height = Math.round(rect.height * ratio);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);

    const end = Date.now();
    const start = end - state.historyMinutes * 60 * 1_000;
    const samples = state.history.filter((point) => point.t >= start && point.t <= end);
    els.chartEmpty.hidden = samples.length >= 2;
    els.chartLegend.replaceChildren();
    ctx.clearRect(0, 0, rect.width, rect.height);
    if (samples.length < 2) return;

    const definition = chartDefinition(state.historyMetric, samples);
    const values = definition.series.flatMap((series) => series.values.filter(validNumber));
    if (definition.thresholds) values.push(...definition.thresholds.map((item) => item.value).filter(validNumber));
    if (!values.length) return;

    let min = Math.min(...values);
    let max = Math.max(...values);
    const span = Math.max(max - min, state.historyMetric === "pressure" ? 2 : 10);
    min -= span * 0.12;
    max += span * 0.12;
    if (state.historyMetric === "voc" || state.historyMetric === "pressure") min = Math.max(0, min);

    const plot = { left: 52, right: rect.width - 18, top: 18, bottom: rect.height - 34 };
    const xFor = (time) => plot.left + ((time - start) / (end - start)) * (plot.right - plot.left);
    const yFor = (value) => plot.bottom - ((value - min) / (max - min)) * (plot.bottom - plot.top);

    ctx.lineWidth = 1;
    ctx.font = "11px Inter, system-ui, sans-serif";
    ctx.fillStyle = "#76828a";
    ctx.strokeStyle = "rgba(255,255,255,.08)";
    for (let row = 0; row <= 4; row += 1) {
      const y = plot.top + (plot.bottom - plot.top) * row / 4;
      const value = max - (max - min) * row / 4;
      ctx.beginPath();
      ctx.moveTo(plot.left, y);
      ctx.lineTo(plot.right, y);
      ctx.stroke();
      ctx.fillText(formatChartValue(value, state.historyMetric), 4, y + 4);
    }
    for (let column = 0; column <= 4; column += 1) {
      const x = plot.left + (plot.right - plot.left) * column / 4;
      const time = new Date(start + (end - start) * column / 4);
      ctx.beginPath();
      ctx.moveTo(x, plot.top);
      ctx.lineTo(x, plot.bottom);
      ctx.stroke();
      const label = time.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      ctx.fillText(label, clamp(x - 22, plot.left, plot.right - 44), rect.height - 10);
    }

    let hasCalibrationWindow = false;
    ctx.save();
    ctx.fillStyle = "rgba(255, 182, 74, .075)";
    samples.forEach((point, index) => {
      if (point.cal !== 1) return;
      hasCalibrationWindow = true;
      const previousTime = index > 0 ? (samples[index - 1].t + point.t) / 2 : point.t;
      const nextTime = index < samples.length - 1 ? (point.t + samples[index + 1].t) / 2 : point.t;
      const left = clamp(xFor(previousTime), plot.left, plot.right);
      const right = clamp(xFor(nextTime), plot.left, plot.right);
      ctx.fillRect(left, plot.top, Math.max(1, right - left), plot.bottom - plot.top);
    });
    ctx.restore();

    (definition.thresholds || []).forEach((threshold) => {
      const y = yFor(threshold.value);
      ctx.save();
      ctx.setLineDash([5, 5]);
      ctx.strokeStyle = threshold.color;
      ctx.globalAlpha = 0.55;
      ctx.beginPath();
      ctx.moveTo(plot.left, y);
      ctx.lineTo(plot.right, y);
      ctx.stroke();
      ctx.restore();
    });

    definition.series.forEach((series) => {
      ctx.lineWidth = series.width || 2;
      ctx.strokeStyle = series.color;
      ctx.beginPath();
      let drawing = false;
      samples.forEach((point, index) => {
        const value = series.values[index];
        if (!validNumber(value)) {
          drawing = false;
          return;
        }
        if (index > 0 && point.t - samples[index - 1].t > MAX_CHART_GAP_MS) drawing = false;
        const x = xFor(point.t);
        const y = yFor(value);
        if (!drawing) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
        drawing = true;
      });
      ctx.stroke();

      const item = document.createElement("span");
      item.innerHTML = '<i style="background:' + series.color + '"></i>' + series.label;
      els.chartLegend.appendChild(item);
    });

    if (hasCalibrationWindow) {
      const item = document.createElement("span");
      item.innerHTML = '<i style="background:#ffb64a;opacity:.45"></i>SGP40 calibration';
      els.chartLegend.appendChild(item);
    }

    canvas._chartMeta = { samples, plot, start, end, definition };
  }

  function chartDefinition(metric, samples) {
    const vm = state.vm || buildViewModel();
    if (metric === "temperature") {
      return {
        series: [
          { label: "Inlet °C", color: "#ff5a52", values: samples.map((point) => point.ti) },
          { label: "Outlet °C", color: "#45d8ff", values: samples.map((point) => point.to) },
        ],
        thresholds: [{ value: vm.chamberTarget, color: "#f5b942" }],
      };
    }
    if (metric === "pressure") {
      return {
        series: [
          {
            label: "Calibrated ΔP Pa",
            color: "#f5b942",
            width: 2.5,
            values: samples.map((point) => calibratedPressureDropPa(point.pi, point.po)),
          },
        ],
        thresholds: [],
      };
    }
    return {
      series: [
        { label: "VOC inlet", color: "#ff5a52", values: samples.map((point) => point.vi) },
        { label: "VOC outlet", color: "#45d8ff", values: samples.map((point) => point.vo) },
      ],
      thresholds: [
        { value: vm.vocWarning, color: "#f5b942" },
        { value: vm.vocHigh, color: "#ff8a4c" },
        { value: vm.vocEmergency, color: "#ff4f67" },
      ],
    };
  }

  function formatChartValue(value, metric) {
    if (!validNumber(value)) return "—";
    if (metric === "temperature") return value.toFixed(1) + "°";
    if (metric === "pressure") return value.toFixed(1) + " Pa";
    return Math.round(value).toString();
  }

  function showChartTooltip(event) {
    const meta = els.historyChart._chartMeta;
    if (!meta?.samples?.length) return;
    const rect = els.historyChart.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const targetTime = meta.start + clamp((x - meta.plot.left) / (meta.plot.right - meta.plot.left), 0, 1) * (meta.end - meta.start);
    let nearest = meta.samples[0];
    meta.samples.forEach((point) => {
      if (Math.abs(point.t - targetTime) < Math.abs(nearest.t - targetTime)) nearest = point;
    });
    const index = meta.samples.indexOf(nearest);
    const rows = meta.definition.series.map((series) => {
      return "<span><i style=\"background:" + series.color + "\"></i>" + series.label + " <strong>" + formatChartValue(series.values[index], state.historyMetric) + "</strong></span>";
    }).join("");
    const vent = nearest.vent === 1 ? "OPEN" : nearest.vent === 0 ? "CLOSED" : "UNKNOWN";
    const calibration = nearest.cal === 1
      ? '<span class="tooltip-state">SGP40 calibration <strong>ACTIVE</strong></span>'
      : "";
    const revision = validNumber(nearest.sgp)
      ? '<span class="tooltip-state">SGP40 baseline <strong>REV ' + Math.round(nearest.sgp) + "</strong></span>"
      : "";
    els.chartTooltip.innerHTML = "<time>" + new Date(nearest.t).toLocaleTimeString() + "</time>" + rows + "<span class=\"tooltip-state\">Exhaust vent <strong>" + vent + "</strong></span>" + calibration + revision;
    els.chartTooltip.hidden = false;
    els.chartTooltip.style.left = clamp(x + 12, 8, rect.width - 190) + "px";
    els.chartTooltip.style.top = clamp(event.clientY - rect.top - 10, 8, rect.height - 150) + "px";
  }

  function askConfirmation({ eyebrow = "CONFIRM CONTROL", title, message, accept = "Confirm", danger = false }) {
    els.confirmEyebrow.textContent = eyebrow;
    els.confirmTitle.textContent = title;
    els.confirmMessage.textContent = message;
    els.confirmAcceptButton.textContent = accept;
    els.confirmAcceptButton.classList.toggle("danger-action", danger);
    els.confirmDialog.showModal();
    return new Promise((resolve) => {
      state.confirmResolver = resolve;
    });
  }

  function setControlsLocked(locked) {
    state.controlsLocked = locked;
    clearTimeout(state.unlockTimer);
    if (!locked) {
      state.unlockTimer = setTimeout(() => {
        state.controlsLocked = true;
        render();
        showToast("Nevermore controls locked automatically.");
      }, CONTROL_UNLOCK_MS);
    }
    render();
  }

  async function runGcode(script) {
    if (!client || state.isDemo || state.connection !== "live") {
      throw new Error("Nevermore controls require a live printer connection.");
    }
    return client.call("printer.gcode.script", { script });
  }

  async function waitFor(predicate, timeoutMs, statusMessage) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (predicate()) return true;
      if (statusMessage) els.controlStatus.textContent = statusMessage;
      await delay(500);
    }
    throw new Error("Timed out waiting for verified Nevermore airflow.");
  }

  async function guardedOutputOn(kind) {
    const label = kind === "uv" ? "PCO / UV" : "carbon cooler";
    const confirmed = await askConfirmation({
      title: "Enable " + label + "?",
      message: kind === "peltier"
        ? "The dashboard will enter manual mode and start the Filter fan at 100%. The printer will close the exhaust flap, wait for its movement to complete, verify at least 2,000 RPM, and only then energize the carbon cooler."
        : "The dashboard will enter manual mode, start the Filter fan at 100%, verify at least 2,000 RPM, and only then request the PCO / UV output.",
      accept: "Start safely",
    });
    if (!confirmed) return;

    state.controlPending = true;
    render();
    try {
      await runGcode("NEVERMORE_MANUAL\nNEVERMORE_FILTER SPEED=1");
      await waitFor(
        () => state.vm?.rpm >= MIN_SAFE_RPM && state.vm?.fanReady,
        12_000,
        "Waiting for verified Filter airflow…"
      );
      await runGcode(kind === "uv" ? "NEVERMORE_UV VALUE=1" : "NEVERMORE_PELTIER VALUE=1");
      showToast(kind === "peltier"
        ? "Carbon-cooler request accepted; the printer interlock controls final enable."
        : "PCO / UV enabled with verified airflow.");
    } catch (error) {
      showToast(error.message);
    } finally {
      state.controlPending = false;
      setControlsLocked(false);
    }
  }

  async function handleControlAction(action) {
    const vm = state.vm || buildViewModel();
    if (action === "uv-toggle" && !vm.uv) return guardedOutputOn("uv");
    if (action === "peltier-toggle" && !vm.peltier && !vm.peltierPending) return guardedOutputOn("peltier");

    const activePrintWarning = vm.printActive
      ? " This will override automatic filtration during the active print."
      : "";
    const actions = {
      "fan-off": {
        title: "Stop manual airflow?",
        message: (vm.uv || vm.peltier ? "UV and Peltier will be turned off first." : "The Filter fan will stop.") + activePrintWarning,
        script: vm.uv || vm.peltier ? "NEVERMORE_MANUAL\nNEVERMORE_OFF" : "NEVERMORE_MANUAL\nNEVERMORE_FILTER SPEED=0",
      },
      "fan-60": {
        title: "Set Filter fan to 60%?",
        message: "Nevermore will enter manual mode and run normal filtration." + activePrintWarning,
        script: "NEVERMORE_MANUAL\nNEVERMORE_FILTER SPEED=0.6",
      },
      "fan-100": {
        title: "Set Filter fan to 100%?",
        message: "Nevermore will enter manual mode and run full filtration." + activePrintWarning,
        script: "NEVERMORE_MANUAL\nNEVERMORE_FILTER SPEED=1",
      },
      "uv-toggle": {
        title: "Turn PCO / UV off?",
        message: "The UV output will turn off. The Filter fan will remain at its current command.",
        script: "NEVERMORE_UV VALUE=0",
      },
      "peltier-toggle": {
        title: "Turn the carbon cooler off?",
        message: "The Peltier output will turn off. The Filter fan will remain at its current command.",
        script: "NEVERMORE_PELTIER VALUE=0",
      },
      "vent-toggle": {
        title: vm.ventOpen ? "Close the chamber exhaust vent?" : "Open the chamber exhaust vent?",
        message: (vm.ventOpen
          ? "The vent will be commanded closed and automatic chamber control will pause."
          : "The Peltier will be turned off first. If it was active, the Filter fan will cool its hot side for 60 seconds before the vent opens. Automatic chamber control will pause.") + activePrintWarning,
        script: vm.ventOpen ? "VENT_CLOSE" : "VENT_OPEN",
      },
      "resume-auto": {
        title: "Resume automatic control?",
        message: "Manual override will end and the active material profile will regain control within the automation cycle.",
        script: "NEVERMORE_AUTO_ENABLE",
      },
      "all-off": {
        title: "Turn all Nevermore outputs off?",
        message: "UV and Peltier will turn off before the Filter fan, and the exhaust vent will close. Nevermore will remain in manual mode.",
        script: "NEVERMORE_MANUAL\nNEVERMORE_OFF",
        danger: true,
      },
      "clear-fault": {
        title: "Clear the Nevermore fault latch?",
        message: "Only clear the latch after confirming airflow and temperature conditions are safe.",
        script: "NEVERMORE_CLEAR_ERROR",
        danger: true,
      },
      "emergency-off": {
        title: "Trigger Nevermore emergency shutdown?",
        message: "UV and Peltier will stop immediately, the exhaust vent will close, and the Filter fan will run at 100% for the 60-second safety cooldown. The fault latch will be set.",
        script: "NEVERMORE_EMERGENCY_OFF",
        danger: true,
      },
    };
    const config = actions[action];
    if (!config) return;
    const confirmed = await askConfirmation({
      eyebrow: config.danger ? "SAFETY CONFIRMATION" : "CONFIRM CONTROL",
      title: config.title,
      message: config.message,
      accept: config.danger ? "Confirm safety action" : "Apply",
      danger: config.danger,
    });
    if (!confirmed) return;

    state.controlPending = true;
    render();
    try {
      await runGcode(config.script);
      showToast("Nevermore command accepted.");
    } catch (error) {
      showToast(error.message);
    } finally {
      state.controlPending = false;
      if (action !== "emergency-off") setControlsLocked(false);
      else render();
    }
  }

  async function handleSgpCalibration() {
    const vm = state.vm || buildViewModel();
    if (state.controlsLocked) {
      showToast("Unlock the control console before changing SGP40 calibration state.");
      return;
    }

    if (vm.sgpCalibrationActive) {
      const confirmed = await askConfirmation({
        eyebrow: "CALIBRATION CONTROL",
        title: "Cancel the SGP40 calibration?",
        message: "The current clean-air learning window will be discarded. Nevermore will remain off in manual hold until you resume automation or start a new calibration.",
        accept: "Cancel calibration",
        danger: true,
      });
      if (!confirmed) return;

      state.controlPending = true;
      render();
      try {
        await runGcode("NEVERMORE_SGP_CALIBRATION_CANCEL");
        showToast("SGP40 calibration cancelled; automation remains paused.");
      } catch (error) {
        showToast(error.message);
      } finally {
        state.controlPending = false;
        render();
      }
      return;
    }

    if (vm.printActive || vm.purgeActive || ["printing", "paused"].includes(vm.printState.toLowerCase())) {
      showToast("SGP40 calibration can only be armed while the printer and purge cycle are idle.");
      return;
    }

    const confirmed = await askConfirmation({
      eyebrow: "24-HOUR CLEAN-AIR CALIBRATION",
      title: "Calibrate both SGP40 sensors?",
      message: "Before starting, remove VOC sources, briefly refresh the enclosure with clean room air, then close it. Nevermore will turn off, wait for the hotend to reach 50°C or less, the bed 40°C or less, and chamber air 35°C or less, reset both sensors, learn for 24 inactive hours, save both baselines, and restart Klipper. Any print, heater, Nevermore output activity, power loss, or Klipper restart invalidates the window.",
      accept: "Start 24-hour calibration",
    });
    if (!confirmed) return;

    state.controlPending = true;
    render();
    try {
      await runGcode("NEVERMORE_SGP_CALIBRATION_START");
      showToast("SGP40 calibration armed. You can leave the printer unattended.");
    } catch (error) {
      showToast(error.message);
    } finally {
      state.controlPending = false;
      setControlsLocked(true);
      render();
    }
  }

  async function markNewMedia() {
    const confirmed = await askConfirmation({
      eyebrow: "MEDIA MAINTENANCE",
      title: "Start a new media record?",
      message: "This resets the stored runtime and fresh-media pressure/VOC baselines. Historical chart data is not deleted.",
      accept: "Start new media",
      danger: true,
    });
    if (!confirmed) return;
    state.media = { ...defaultMediaState(), installedAt: Date.now() };
    await persistMedia(true);
    render();
  }

  async function calibratePressure() {
    const vm = state.vm || buildViewModel();
    if (vm.sgpCalibrationActive || vm.sgpCalibrationHold) {
      showToast("Resume automation or finish the SGP40 calibration state before pressure calibration.");
      return;
    }
    if (vm.printActive || vm.purgeActive) {
      showToast("Pressure calibration is available only while the printer is idle.");
      return;
    }
    if (state.controlsLocked) {
      showToast("Unlock the control console before pressure calibration.");
      setCurrentView("controls");
      return;
    }
    const confirmed = await askConfirmation({
      eyebrow: "FRESH-MEDIA CALIBRATION",
      title: "Calibrate pressure restriction?",
      message: "This takes about one minute. Nevermore will close the exhaust vent, turn all outputs off for the zero reading, run the Filter fan at 100% for the fresh-media reading, then return to automatic mode.",
      accept: "Begin calibration",
    });
    if (!confirmed) return;

    state.controlPending = true;
    els.calibrationNote.textContent = "Zeroing pressure sensors with airflow stopped…";
    render();
    try {
      await runGcode("NEVERMORE_MANUAL\nNEVERMORE_OFF");
      await waitFor(() => (state.vm?.rpm || 0) < 200 && (state.vm?.fanSpeed || 0) === 0, 12_000);
      await delay(3_000);
      const zeroValues = await collectValues(
        () => rawPressureDeltaPa(state.vm?.pressureIn, state.vm?.pressureOut),
        12_000,
        "Collecting zero-pressure samples…"
      );
      const zero = median(zeroValues);
      if (!validNumber(zero)) throw new Error("Pressure data was unavailable during zero calibration.");

      els.calibrationNote.textContent = "Starting full airflow for the fresh-media baseline…";
      await runGcode("NEVERMORE_FILTER SPEED=1");
      await waitFor(() => state.vm?.rpm >= MIN_SAFE_RPM && state.vm?.fanReady, 12_000);
      await delay(5_000);
      const flowValues = await collectValues(
        () => rawPressureDeltaPa(state.vm?.pressureIn, state.vm?.pressureOut),
        20_000,
        "Collecting full-flow pressure samples…"
      );
      const fresh = median(flowValues.map((value) => Math.abs(value - zero)));
      if (!validNumber(fresh) || fresh < 0.5) {
        throw new Error("The measured pressure signal was too small for a reliable baseline.");
      }

      state.media.pressureZeroPa = Number(zero.toFixed(3));
      state.media.pressureFreshPa = Number(fresh.toFixed(3));
      state.media.pressureCalibratedAt = Date.now();
      if (!state.media.installedAt) state.media.installedAt = Date.now();
      await persistMedia(false);
      await runGcode("NEVERMORE_AUTO_ENABLE");
      els.calibrationNote.textContent = "Fresh-media pressure baseline saved: " + fresh.toFixed(1) + " Pa at 100% fan.";
      showToast("Pressure calibration complete.");
    } catch (error) {
      els.calibrationNote.textContent = "Calibration stopped. Confirm Nevermore is in the desired operating mode.";
      showToast(error.message);
    } finally {
      state.controlPending = false;
      render();
    }
  }

  async function calibrateVoc() {
    const vm = state.vm || buildViewModel();
    if (vm.sgpCalibrationActive || vm.sgpCalibrationHold) {
      showToast("Resume automation or finish the SGP40 calibration state before setting a media VOC baseline.");
      return;
    }
    const cutoff = Date.now() - 5 * 60 * 1_000;
    const values = state.history
      .filter((point) => point.t >= cutoff && point.fs >= 0.9 && point.vi >= vm.vocWarning && point.cal !== 1 && sampleMatchesSgpRevision(point, vm.sgpCalibrationRevision))
      .map((point) => sampleEfficiency(point.vi, point.vo))
      .filter((value) => validNumber(value) && value > 0);
    if (values.length < 6) {
      showToast("VOC baseline needs at least one minute at full fan with inlet VOC above the warning threshold.");
      return;
    }
    const value = median(values);
    const confirmed = await askConfirmation({
      eyebrow: "FRESH-CARBON CALIBRATION",
      title: "Save current VOC capture as fresh?",
      message: "The recent median reduction of " + value.toFixed(1) + "% will become the carbon-performance baseline. Use this only with fresh media during a representative elevated-VOC cycle.",
      accept: "Save VOC baseline",
    });
    if (!confirmed) return;
    state.media.vocFreshEfficiency = Number(value.toFixed(2));
    state.media.vocCalibratedAt = Date.now();
    state.media.sgpCalibrationRevision = vm.sgpCalibrationRevision;
    if (!state.media.installedAt) state.media.installedAt = Date.now();
    await persistMedia(true);
    render();
  }

  async function collectValues(getter, durationMs, statusMessage) {
    const values = [];
    const started = Date.now();
    while (Date.now() - started < durationMs) {
      const value = getter();
      if (validNumber(value)) values.push(value);
      els.calibrationNote.textContent = statusMessage + " " + Math.max(0, Math.ceil((durationMs - (Date.now() - started)) / 1_000)) + "s";
      await delay(800);
    }
    return values;
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function setFlag(element, active) {
    element.dataset.active = active ? "true" : "false";
  }

  function setComponent(element, active, activeLabel = "ON") {
    element.textContent = active ? activeLabel : "OFF";
    element.classList.toggle("is-active", active);
  }

  function positionThreshold(element, value, max) {
    element.style.left = `${clamp((value / max) * 100, 0, 100)}%`;
  }

  function showToast(message) {
    clearTimeout(toastTimer);
    els.toast.textContent = message;
    els.toast.classList.add("is-visible");
    toastTimer = setTimeout(() => els.toast.classList.remove("is-visible"), 4_000);
  }

  function showHelp(target) {
    const message = target?.dataset?.help;
    if (!message || !els.helpTooltip) return;
    els.helpTooltip.textContent = message;
    els.helpTooltip.hidden = false;
    target.setAttribute("aria-describedby", "helpTooltip");

    const targetRect = target.getBoundingClientRect();
    const tooltipRect = els.helpTooltip.getBoundingClientRect();
    const left = clamp(
      targetRect.left + targetRect.width / 2 - tooltipRect.width / 2,
      8,
      window.innerWidth - tooltipRect.width - 8
    );
    let top = targetRect.top - tooltipRect.height - 9;
    if (top < 8) top = targetRect.bottom + 9;
    els.helpTooltip.style.left = left + "px";
    els.helpTooltip.style.top = top + "px";
  }

  function hideHelp(target) {
    target?.removeAttribute("aria-describedby");
    if (els.helpTooltip) els.helpTooltip.hidden = true;
  }

  function displayEndpoint(endpoint) {
    try {
      return new URL(endpoint).host;
    } catch {
      return endpoint;
    }
  }

  function truthy(value) {
    return value === true || value === 1 || value === "1" || value === "true";
  }

  function validNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
  }

  function numberOr(...values) {
    for (const value of values) {
      const number = Number(value);
      if (value !== null && value !== "" && Number.isFinite(number)) return number;
    }
    return null;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function formatInteger(value) {
    return validNumber(value) ? Math.round(value).toLocaleString() : "—";
  }

  function formatDecimal(value) {
    return validNumber(value) ? value.toFixed(1) : "—";
  }

  function formatDuration(seconds) {
    const total = Math.max(0, Math.round(numberOr(seconds, 0)));
    const hours = Math.floor(total / 3_600);
    const minutes = Math.floor((total % 3_600) / 60);
    if (hours > 0) return hours + "h " + String(minutes).padStart(2, "0") + "m";
    return minutes + "m";
  }

  function titleCase(value) {
    return String(value || "")
      .replace(/_/g, " ")
      .toLowerCase()
      .replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  els.settingsButton.addEventListener("click", () => {
    els.endpointInput.value = state.endpoint || localStorage.getItem(STORAGE_KEY) || "";
    els.settingsDialog.showModal();
    requestAnimationFrame(() => els.endpointInput.focus());
  });

  els.settingsForm.addEventListener("submit", (event) => {
    if (event.submitter?.value !== "connect") return;
    event.preventDefault();
    els.settingsDialog.close();
    connect(els.endpointInput.value);
  });

  els.demoButton.addEventListener("click", () => {
    els.settingsDialog.close();
    startDemo();
  });

  els.confirmForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const accepted = event.submitter?.value === "confirm";
    const resolver = state.confirmResolver;
    state.confirmResolver = null;
    els.confirmDialog.close();
    resolver?.(accepted);
  });

  els.confirmDialog.addEventListener("cancel", () => {
    const resolver = state.confirmResolver;
    state.confirmResolver = null;
    resolver?.(false);
  });

  els.controlLockButton.addEventListener("click", async () => {
    if (!state.controlsLocked) {
      setControlsLocked(true);
      return;
    }
    const confirmed = await askConfirmation({
      eyebrow: "CONTROL LOCK",
      title: "Unlock manual Nevermore controls?",
      message: "Unlocked controls can disable automation or energize Nevermore outputs. They will lock again automatically after five minutes.",
      accept: "Unlock controls",
    });
    if (confirmed) setControlsLocked(false);
  });

  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-action]");
    if (!button || button.disabled) return;
    handleControlAction(button.dataset.action);
  });

  document.addEventListener("pointerover", (event) => {
    const target = event.target.closest("[data-help]");
    if (target && !target.contains(event.relatedTarget)) showHelp(target);
  });

  document.addEventListener("pointerout", (event) => {
    const target = event.target.closest("[data-help]");
    if (target && !target.contains(event.relatedTarget)) hideHelp(target);
  });

  document.addEventListener("focusin", (event) => {
    const target = event.target.closest("[data-help]");
    if (target) showHelp(target);
  });

  document.addEventListener("focusout", (event) => {
    const target = event.target.closest("[data-help]");
    if (target) hideHelp(target);
  });

  els.newMediaButton.addEventListener("click", markNewMedia);
  els.pressureCalibrateButton.addEventListener("click", calibratePressure);
  els.vocCalibrateButton.addEventListener("click", calibrateVoc);
  els.sgpCalibrationButton.addEventListener("click", handleSgpCalibration);

  els.workspaceTabs.addEventListener("click", (event) => {
    const button = event.target.closest("[data-view]");
    if (button) setCurrentView(button.dataset.view);
  });

  document.querySelector(".header-link")?.addEventListener("click", (event) => {
    event.preventDefault();
    setCurrentView("controls");
  });

  els.chartMetric.addEventListener("click", (event) => {
    const button = event.target.closest("[data-metric]");
    if (!button) return;
    state.historyMetric = button.dataset.metric;
    els.chartMetric.querySelectorAll("button").forEach((item) => item.classList.toggle("is-active", item === button));
    renderChart();
  });

  els.chartRange.addEventListener("click", (event) => {
    const button = event.target.closest("[data-minutes]");
    if (!button) return;
    state.historyMinutes = Number(button.dataset.minutes);
    els.chartRange.querySelectorAll("button").forEach((item) => item.classList.toggle("is-active", item === button));
    renderChart();
  });

  els.historyChart.addEventListener("pointermove", showChartTooltip);
  els.historyChart.addEventListener("pointerleave", () => { els.chartTooltip.hidden = true; });
  window.addEventListener("resize", () => requestAnimationFrame(renderChart));

  setInterval(renderAge, 1_000);
  setInterval(loadCollectorHistory, 60_000);
  setInterval(renderChart, 30_000);
  loadLocalFeatureState();
  setCurrentView("live");
  render();

  const query = new URLSearchParams(location.search);
  const endpoint = initialEndpoint();
  if (query.get("demo") === "1") {
    startDemo();
  } else if (endpoint) {
    connect(endpoint);
  } else {
    startDemo();
  }
})();
