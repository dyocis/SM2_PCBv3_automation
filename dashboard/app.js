(() => {
  "use strict";

  const STORAGE_KEY = "nevermore-dashboard-endpoint";
  const STALE_AFTER_MS = 20_000;
  const OBJECTS = {
    "gcode_macro SM_LED_STATE": null,
    "fan_generic Filter": ["speed", "rpm"],
    "temperature_sensor BME_IN": ["temperature"],
    "temperature_sensor BME_OUT": ["temperature"],
    "temperature_sensor SGP_IN": ["temperature"],
    "temperature_sensor SGP_OUT": ["temperature"],
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
    DISABLED: "Nevermore automatic control is disabled.",
    FAULT: "A safety condition requires attention.",
    "SGP40 PREPARING": "Preparing a stable, idle printer for sensor calibration.",
    "SGP40 CALIBRATION": "SGP40 calibration is running; printing and automatic outputs are paused.",
    "SGP40 COOLING": "Preparing a stable, idle printer for sensor calibration.",
    "SGP40 CALIBRATING": "SGP40 calibration is running; printing and automatic outputs are paused.",
    "SGP40 FINALIZING": "Saving the completed SGP40 calibration data.",
    "SGP40 COMPLETE": "Calibration is complete and waiting for acknowledgement.",
    "SGP40 CANCELLED": "Calibration was cancelled and requires acknowledgement.",
    "SGP40 INTERRUPTED": "Calibration was interrupted and requires acknowledgement.",
  };

  const MAINTENANCE_COPY = {
    COOLING: ["SGP40 calibration preparing", "Waiting for the printer to become safe and idle."],
    CALIBRATING: ["SGP40 calibration running", "Do not print, heat, or restart Klipper during calibration."],
    FINALIZING: ["SGP40 calibration finalizing", "Calibration data is being saved."],
    COMPLETE: ["SGP40 calibration complete", "Run NEVERMORE_SGP_CALIBRATION_ACKNOWLEDGE to resume automation."],
    CANCELLED: ["SGP40 calibration cancelled", "Run NEVERMORE_SGP_CALIBRATION_ACKNOWLEDGE after checking the sensors."],
    INTERRUPTED: ["SGP40 calibration interrupted", "Run NEVERMORE_SGP_CALIBRATION_ACKNOWLEDGE after checking the sensors."],
  };

  const VOC_LABELS = ["CLEAR", "FILTERING", "HEAVY", "EMERGENCY"];

  const $ = (id) => document.getElementById(id);
  const els = Object.fromEntries(
    [
      "connectionChip", "connectionText", "settingsButton", "settingsDialog", "settingsForm",
      "endpointInput", "demoButton", "toast", "faultBanner", "faultMessage", "maintenanceBanner",
      "maintenanceTitle", "maintenanceMessage", "maintenanceCountdown", "statusBeacon",
      "profileLabel", "modeTitle", "modeDescription", "autoFlag", "printFlag", "purgeFlag",
      "latchFlag", "fanGauge", "fanPercent", "fanRpm", "vocStatePill", "vocIn", "vocOut",
      "vocDelta", "efficiency", "vocFill", "warningMarker", "highMarker", "emergencyMarker",
      "warningLabel", "highLabel", "emergencyLabel", "coolingPill", "tempIn", "tempOut",
      "tempDelta", "hysteresisRange", "temperaturePosition", "coolingOffLabel", "coolingOnLabel",
      "fanIcon", "fanComponentText", "fanComponentState", "uvComponentState",
      "peltierComponentState", "lastAction", "lastActionClock", "transitionCount", "printState",
      "filename", "dataAge", "priorityStack", "footerEndpoint",
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
    const sgpIn = state.objects["temperature_sensor SGP_IN"] || {};
    const sgpOut = state.objects["temperature_sensor SGP_OUT"] || {};
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
    const calibrationPhase = String(sm.sgp40_calibration_phase || "IDLE").replace(/^"|"$/g, "").toUpperCase();
    const calibrationActive = truthy(sm.sgp40_calibration_active);
    const calibrationHold = truthy(sm.sgp40_calibration_hold);

    return {
      mode: fault ? "FAULT" : mode,
      sourceMode: mode,
      fault,
      faultMessage: webhooks.state_message || "Nevermore safety state is active.",
      calibrationPhase,
      calibrationActive,
      calibrationHold,
      calibrationRemaining: numberOr(sm.sgp40_calibration_remaining, 0),
      calibrationRevision: numberOr(sm.sgp40_calibration_revision, 0),
      automation: truthy(sm.auto_mode),
      manual: truthy(sm.manual_override),
      printActive: truthy(sm.print_active),
      purgeActive: truthy(sm.purge_active),
      chamberLatched: truthy(sm.chamber_cooling_latched),
      fanSpeed,
      rpm: numberOr(fan.rpm, sm.last_rpm, 0),
      uv: truthy(sm.uv),
      peltier: truthy(sm.peltier),
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
      lastAction: String(sm.last_action || "NONE").replace(/^"|"$/g, ""),
      lastActionClock: String(sm.last_action_clock || "").replace(/^"|"$/g, ""),
      transitions: Math.round(numberOr(sm.transition_count, 0)),
      printState: String(print.state || (truthy(sm.print_active) ? "printing" : "standby")),
      filename: String(print.filename || "—").split("/").pop(),
    };
  }

  function render() {
    const vm = buildViewModel();
    const tone = vm.fault || vm.vocState === 3 ? "danger" : vm.vocState === 2 ? "warning" : "idle";
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
    els.fanIcon.classList.toggle("is-running", fanPercent > 0);
    els.fanComponentText.textContent = fanPercent > 0 ? `${formatInteger(vm.rpm)} RPM measured` : "Stopped";
    document.querySelector(".uv-icon")?.classList.toggle("is-active", vm.uv);
    document.querySelector(".peltier-icon")?.classList.toggle("is-active", vm.peltier);

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
    const maintenanceVisible = vm.calibrationActive || vm.calibrationHold || vm.calibrationPhase !== "IDLE";
    const maintenanceCopy = MAINTENANCE_COPY[vm.calibrationPhase] || [
      "SGP40 maintenance active",
      "Nevermore automation is intentionally paused.",
    ];
    els.maintenanceBanner.hidden = !maintenanceVisible;
    els.maintenanceTitle.textContent = maintenanceCopy[0];
    els.maintenanceMessage.textContent = maintenanceCopy[1];
    els.maintenanceCountdown.textContent = vm.calibrationPhase === "CALIBRATING"
      ? formatDuration(vm.calibrationRemaining)
      : vm.calibrationPhase === "COMPLETE"
        ? `REV ${formatInteger(vm.calibrationRevision)}`
        : vm.calibrationPhase;
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
    state.connection = connection;
    state.connectionLabel = label;
    renderConnection();
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
      sm: { auto_reason: "IDLE", current_state: "IDLE", auto_mode: 1, print_active: 0, purge_active: 0, voc_state: 0, chamber_cooling_latched: 0, last_action: "PURGE COMPLETE", last_action_clock: "0s", transition_count: 4, uv: 0, peltier: 0 },
      fan: { speed: 0, rpm: 0 }, sensors: [27.1, 27.5, 99, 99], print: { state: "standby", filename: "" },
    },
    {
      duration: 6_000,
      sm: { auto_reason: "PRINT FILTRATION", current_state: "PRINT FILTRATION", auto_mode: 1, print_active: 1, purge_active: 0, voc_state: 1, chamber_cooling_latched: 0, last_action: "PRINT FILTRATION", last_action_clock: "615s", transition_count: 5, uv: 0, peltier: 0 },
      fan: { speed: 1, rpm: 9640 }, sensors: [36.7, 30.9, 164, 112], print: { state: "printing", filename: "OrcaToleranceTest_ASA_17m34s.gcode" },
    },
    {
      duration: 5_000,
      sm: { auto_reason: "CHAMBER COOLING", current_state: "CHAMBER COOLING", auto_mode: 1, print_active: 1, purge_active: 0, voc_state: 1, chamber_cooling_latched: 1, last_action: "CHAMBER COOLING", last_action_clock: "1284s", transition_count: 6, uv: 0, peltier: 1 },
      fan: { speed: 1, rpm: 9590 }, sensors: [60.3, 48.7, 176, 118], print: { state: "printing", filename: "OrcaToleranceTest_ASA_17m34s.gcode" },
    },
    {
      duration: 5_000,
      sm: { auto_reason: "POST PRINT PURGE", current_state: "POST PRINT PURGE", auto_mode: 1, print_active: 0, purge_active: 1, voc_state: 2, chamber_cooling_latched: 0, last_action: "POST PRINT PURGE", last_action_clock: "1510s", transition_count: 7, uv: 1, peltier: 0 },
      fan: { speed: 1, rpm: 9625 }, sensors: [48.2, 39.4, 246, 137], print: { state: "complete", filename: "OrcaToleranceTest_ASA_17m34s.gcode" },
    },
    {
      duration: 5_000,
      sm: { auto_reason: "POST PRINT PURGE", current_state: "POST PRINT PURGE", auto_mode: 1, print_active: 0, purge_active: 1, voc_state: 1, chamber_cooling_latched: 0, last_action: "POST PRINT PURGE", last_action_clock: "1510s", transition_count: 7, uv: 0, peltier: 0 },
      fan: { speed: 0.6, rpm: 7620 }, sensors: [39.4, 34.8, 114, 101], print: { state: "complete", filename: "OrcaToleranceTest_ASA_17m34s.gcode" },
    },
    {
      duration: 5_000,
      sm: { auto_reason: "SGP40 CALIBRATION", current_state: "SGP40 CALIBRATION", auto_mode: 1, print_active: 0, purge_active: 0, voc_state: 0, chamber_cooling_latched: 0, last_action: "SGP40 CALIBRATION", last_action_clock: "0s", transition_count: 8, uv: 0, peltier: 0, sgp40_calibration_active: 1, sgp40_calibration_hold: 1, sgp40_calibration_phase: "CALIBRATING", sgp40_calibration_remaining: 82_740 },
      fan: { speed: 0, rpm: 0 }, sensors: [24.8, 25.1, 100, 100], print: { state: "standby", filename: "" },
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
          sgp40_calibration_active: 0,
          sgp40_calibration_hold: 0,
          sgp40_calibration_phase: "IDLE",
          sgp40_calibration_remaining: 0,
          sgp40_calibration_revision: 1,
          ...frame.sm,
        },
        "fan_generic Filter": frame.fan,
        "temperature_sensor BME_IN": { temperature: frame.sensors[0] },
        "temperature_sensor BME_OUT": { temperature: frame.sensors[1] },
        "temperature_sensor SGP_IN": { temperature: frame.sensors[2] },
        "temperature_sensor SGP_OUT": { temperature: frame.sensors[3] },
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

  function formatDuration(value) {
    const seconds = Math.max(0, Math.round(numberOr(value, 0)));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${hours}h ${String(minutes).padStart(2, "0")}m`;
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

  setInterval(renderAge, 1_000);
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
