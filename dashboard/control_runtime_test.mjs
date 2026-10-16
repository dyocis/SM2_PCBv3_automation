import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

const [html, app] = await Promise.all([
  readFile(new URL("./index.html", import.meta.url), "utf8"),
  readFile(new URL("./app.js", import.meta.url), "utf8"),
]);

const scripts = [];
const status = {
  "gcode_macro SM_LED_STATE": {
    auto_reason: "IDLE", current_state: "IDLE", auto_mode: 1, manual_override: 0,
    fault: 0, fan_ready: 1, uv: 0, peltier: 0, vent_open: 0, vent_closed_ready: 1,
    vent_pending_open: 0, peltier_pending_on: 0, peltier_cooldown_active: 0,
    peltier_interlock_state: "READY", peltier_auto_state: "DISABLED", peltier_auto_demand: 0,
    print_active: 0, purge_active: 0,
    post_print_vent_target_temp: 35, post_print_vent_max_minutes: 60,
    post_print_vent_active: 0, post_print_vent_window_target: 35,
    sgp40_calibration_active: 0, sgp40_calibration_hold: 0,
    sgp40_calibration_phase: "IDLE", sgp40_calibration_remaining: 0,
    sgp40_calibration_duration: 86400, sgp40_calibration_revision: 0,
    chamber_target: 60, chamber_hysteresis: 5, voc_warning: 120, voc_high: 220,
    voc_emergency: 400, voc_state: 0, chamber_cooling_latched: 0,
  },
  "fan_generic Filter": { speed: 1, rpm: 9640 },
  "temperature_sensor BME_IN": { temperature: 36.7 },
  "temperature_sensor BME_OUT": { temperature: 30.9 },
  "bme280 BME_IN": { temperature: 36.7, pressure: 1008.42, humidity: 31.2 },
  "bme280 BME_OUT": { temperature: 30.9, pressure: 1008.31, humidity: 29.8 },
  "temperature_sensor SGP_IN": { temperature: 164 },
  "temperature_sensor SGP_OUT": { temperature: 112 },
  "temperature_sensor _SM_PCB": { temperature: 40.1 },
  "temperature_sensor _SM_MCU": { temperature: 43.2 },
  print_stats: { state: "standby", filename: "" },
  webhooks: { state: "ready", state_message: "Printer is ready" },
};

class FakeWebSocket {
  static OPEN = 1;
  constructor() {
    FakeWebSocket.instance = this;
    this.readyState = FakeWebSocket.OPEN;
    this.listeners = new Map();
    setTimeout(() => this.emit("open", {}), 0);
  }
  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(callback);
  }
  emit(type, event) {
    (this.listeners.get(type) || []).forEach((callback) => callback(event));
  }
  send(text) {
    const request = JSON.parse(text);
    let response;
    if (request.method === "server.info") response = { klippy_state: "ready" };
    else if (request.method === "printer.objects.subscribe") response = { status };
    else if (request.method === "server.database.get_item") {
      this.emit("message", { data: JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { message: "not found" } }) });
      return;
    } else if (request.method === "printer.gcode.script") {
      scripts.push(request.params.script);
      response = "ok";
    } else if (request.method === "server.database.post_item") response = request.params;
    else throw new Error("Unexpected RPC method: " + request.method);
    this.emit("message", { data: JSON.stringify({ jsonrpc: "2.0", id: request.id, result: response }) });
  }
  close() { this.readyState = 3; }
}

const dom = new JSDOM(html, {
  runScripts: "outside-only",
  pretendToBeVisual: true,
  url: "http://printer.local/",
});
const { window } = dom;
window.WebSocket = FakeWebSocket;
window.fetch = async () => ({ ok: false, json: async () => ({}) });
window.HTMLDialogElement.prototype.showModal = function showModal() { this.open = true; };
window.HTMLDialogElement.prototype.close = function close() { this.open = false; };
window.HTMLCanvasElement.prototype.getContext = () => ({
  setTransform() {}, clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
  fillText() {}, fillRect() {}, save() {}, restore() {}, setLineDash() {},
  set lineWidth(_value) {}, set font(_value) {}, set fillStyle(_value) {},
  set strokeStyle(_value) {}, set globalAlpha(_value) {},
});
window.HTMLCanvasElement.prototype.getBoundingClientRect = () => ({ width: 900, height: 390, left: 0, top: 0 });

window.eval(app);
await new Promise((resolve) => setTimeout(resolve, 50));

const byId = (id) => window.document.getElementById(id);
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const acceptDialog = async () => {
  byId("confirmAcceptButton").click();
  await new Promise((resolve) => setTimeout(resolve, 15));
};

assert(byId("connectionText").textContent === "Live", "Fake Moonraker did not reach Live state");
assert(byId("peltierAutoState").textContent === "DISABLED", "Peltier automatic state was not rendered");
assert(byId("uvLedTemp").textContent === "N/A", "Absent optional UV sensor must display N/A");
assert(byId("uvThermalReadout").textContent.includes("N/A"), "UV live component must display absent sensor");
byId("controlLockButton").click();
await acceptDialog();
assert(byId("controlLockButton").dataset.locked === "false", "Control console did not unlock");

// Post-print vent settings share the guarded control lock and G-code channel.
assert(byId("postPrintVentTarget").value === "35", "Default exhaust temperature did not render");
assert(byId("postPrintVentMinutes").value === "60", "Default vent timeout did not render");
assert(byId("postPrintVentSave").disabled === false, "Unlocked vent-settings save is disabled");
const submitVent = () => {
  byId("postPrintVentForm").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
};
const editVent = (target, minutes) => {
  byId("postPrintVentTarget").value = target;
  byId("postPrintVentTarget").dispatchEvent(new window.Event("input", { bubbles: true }));
  byId("postPrintVentMinutes").value = minutes;
  byId("postPrintVentMinutes").dispatchEvent(new window.Event("input", { bubbles: true }));
};
const beforeInvalid = scripts.length;
editVent("81", "60");
submitVent();
await new Promise((resolve) => setTimeout(resolve, 20));
assert(scripts.length === beforeInvalid, "Invalid vent target escaped to Klipper");
assert(byId("confirmDialog").open === false, "Out-of-range vent target reached confirmation");

editVent("35", "241");
submitVent();
await new Promise((resolve) => setTimeout(resolve, 20));
assert(scripts.length === beforeInvalid, "Invalid vent timeout escaped to Klipper");
assert(byId("confirmDialog").open === false, "Out-of-range vent time reached confirmation");

editVent("38.5", "90");
submitVent();
await acceptDialog();
assert(scripts.includes("NEVERMORE_POST_PRINT_VENT_SETTINGS TARGET=38.5 MAX_MINUTES=90"),
  "Post-print setting changes did not invoke the guarded G-code macro");
FakeWebSocket.instance.emit("message", { data: JSON.stringify({
  jsonrpc: "2.0",
  method: "notify_status_update",
  params: [{ "gcode_macro SM_LED_STATE": {
    post_print_vent_target_temp: 38.5, post_print_vent_max_minutes: 90,
    post_print_vent_active: 1,
  } }],
}) });
assert(byId("postPrintVentCurrent").textContent.includes("38.5°C"),
  "Post-print settings were not refreshed from Klipper");
assert(byId("postPrintVentNote").textContent.includes("current target and timeout stay unchanged"),
  "The active cooling window must be identified as unaffected by settings changes");

byId("controlLockButton").click();
assert(byId("postPrintVentSave").disabled === true, "Locked vent settings were editable");
const scriptsBeforeLock = scripts.length;
submitVent();
await new Promise((resolve) => setTimeout(resolve, 15));
assert(scripts.length === scriptsBeforeLock, "Locked vent settings escaped to Klipper");
byId("controlLockButton").click();
await acceptDialog();

window.document.querySelector('[data-action="fan-60"]').click();
await acceptDialog();
assert(scripts.includes("NEVERMORE_MANUAL\nNEVERMORE_FILTER SPEED=0.6"), "Fan control did not use guarded macros");

window.document.querySelector('[data-action="vent-toggle"]').click();
await acceptDialog();
assert(scripts.includes("VENT_OPEN"), "Vent control did not use the state-aware vent macro");

window.document.querySelector('[data-action="uv-toggle"]').click();
await acceptDialog();
await new Promise((resolve) => setTimeout(resolve, 30));
const uvIndex = scripts.indexOf("NEVERMORE_UV VALUE=1");
const airflowIndex = scripts.lastIndexOf("NEVERMORE_MANUAL\nNEVERMORE_FILTER SPEED=1", uvIndex);
assert(uvIndex > airflowIndex && airflowIndex >= 0, "UV request was not sequenced after full airflow");

window.document.querySelector('[data-action="peltier-toggle"]').click();
await acceptDialog();
await new Promise((resolve) => setTimeout(resolve, 30));
const peltierIndex = scripts.indexOf("NEVERMORE_PELTIER VALUE=1");
const peltierAirflowIndex = scripts.lastIndexOf("NEVERMORE_MANUAL\nNEVERMORE_FILTER SPEED=1", peltierIndex);
assert(peltierIndex > peltierAirflowIndex && peltierAirflowIndex >= 0,
  "Peltier request was not handed to the printer interlock after dashboard airflow verification");

assert(byId("peltierHotTemp").textContent === "N/A", "Missing optional Peltier sensor should show N/A");
assert(byId("peltierColdTemp").textContent === "N/A", "Missing optional Peltier sensor should show N/A");
FakeWebSocket.instance.emit("message", { data: JSON.stringify({
  jsonrpc: "2.0",
  method: "notify_status_update",
  params: [{
    "gcode_macro SM_LED_STATE": {
      peltier_hot_temp: 72.1,
      peltier_cold_temp: 39.4,
      peltier_thermal_fault: 1,
      peltier_interlock_state: "THERMAL FAULT",
    },
  }],
}) });
assert(byId("peltierHotTemp").textContent === "72.1°C", "Peltier hot-side temperature not rendered");
FakeWebSocket.instance.emit("message", { data: JSON.stringify({
  jsonrpc: "2.0",
  method: "notify_status_update",
  params: [{ "gcode_macro SM_LED_STATE": { peltier_auto_state: "THERMAL FAULT", peltier_auto_demand: 0 } }],
}) });
assert(byId("peltierAutoState").textContent === "THERMAL FAULT", "Automatic Peltier reason did not update");
assert(byId("peltierColdTemp").textContent === "39.4°C", "Peltier cold-side temperature not rendered");
assert(byId("peltierFaultResetButton").hidden === false, "Peltier-only fault reset not shown");
assert(byId("safetyState").textContent === "PELTIER FAULT", "Peltier-only fault should not become a global fault");
assert(window.document.querySelector('[data-action="peltier-toggle"]').disabled,
  "Peltier activation must be disabled while thermal fault is latched");
byId("peltierFaultResetButton").click();
await acceptDialog();
assert(scripts.includes("NEVERMORE_PELTIER_THERMAL_RESET"), "Peltier-only fault reset did not invoke guarded macro");

FakeWebSocket.instance.emit("message", { data: JSON.stringify({
  jsonrpc: "2.0",
  method: "notify_status_update",
  params: [{
    "gcode_macro SM_LED_STATE": {
      uv_led_temp: 92.3,
      uv_thermal_fault: 1,
      uv_thermal_state: "FAULT",
      uv_cooldown_active: 0,
    },
  }],
}) });
assert(byId("uvLedTemp").textContent === "92.3°C", "Optional UV LED thermistor not displayed");
assert(byId("uvThermalReadout").textContent.includes("92.3°C"), "Live UV component temperature missing");
assert(byId("uvFaultResetButton").hidden === false, "UV thermal reset not shown");
assert(byId("safetyState").textContent === "UV THERMAL FAULT", "UV-only latch not represented independently");
assert(window.document.querySelector('[data-action="uv-toggle"]').disabled,
  "UV activation button must be disabled when UV thermal fault is latched");
byId("uvFaultResetButton").click();
await acceptDialog();
assert(scripts.includes("NEVERMORE_UV_THERMAL_RESET"), "UV-only reset must call guarded macro");
FakeWebSocket.instance.emit("message", { data: JSON.stringify({
  jsonrpc: "2.0",
  method: "notify_status_update",
  params: [{ "gcode_macro SM_LED_STATE": { uv_thermal_fault: 0, uv_thermal_state: "MONITOR ONLY" } }],
}) });
assert(byId("uvThermalState").textContent === "MONITOR ONLY", "UV monitoring state not updated");

byId("sgpCalibrationButton").click();
await acceptDialog();
await new Promise((resolve) => setTimeout(resolve, 20));
assert(scripts.includes("NEVERMORE_SGP_CALIBRATION_START"), "SGP40 calibration button did not use the unattended start macro");

FakeWebSocket.instance.emit("message", { data: JSON.stringify({
  jsonrpc: "2.0",
  method: "notify_status_update",
  params: [{
    "gcode_macro SM_LED_STATE": {
      sgp40_calibration_active: 1,
      sgp40_calibration_hold: 1,
      sgp40_calibration_phase: "CALIBRATING",
      sgp40_calibration_remaining: 86340,
      auto_reason: "SGP40 CALIBRATION",
      current_state: "SGP40 CALIBRATION",
      auto_mode: 0,
      manual_override: 1,
    },
  }],
}) });
await new Promise((resolve) => setTimeout(resolve, 20));
assert(byId("sgpCalibrationButton").textContent === "Cancel SGP40 calibration", "Active calibration did not expose its cancel control");
assert(window.document.querySelector('[data-action="fan-60"]').disabled, "Manual fan control remained available during SGP40 calibration");
assert(byId("postPrintVentSave").disabled, "Vent settings remained editable during calibration");
assert(byId("sgpCalibrationTime").textContent.includes("remaining"), "Calibration countdown was not rendered");

byId("controlLockButton").click();
await acceptDialog();
byId("sgpCalibrationButton").click();
await acceptDialog();
await new Promise((resolve) => setTimeout(resolve, 20));
assert(scripts.includes("NEVERMORE_SGP_CALIBRATION_CANCEL"), "Active SGP40 calibration did not use the cancel macro");
assert(scripts.every((script) => !/SET_PIN|SET_FAN_SPEED/.test(script)), "A direct hardware command escaped the macro boundary");

dom.window.close();
console.log("Control runtime verified guarded outputs plus unattended SGP40 calibration start, progress, lockout, and cancel.");
