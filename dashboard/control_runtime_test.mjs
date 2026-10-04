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
    peltier_interlock_state: "READY", print_active: 0, purge_active: 0,
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
byId("controlLockButton").click();
await acceptDialog();
assert(byId("controlLockButton").dataset.locked === "false", "Control console did not unlock");

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
