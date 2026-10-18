import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

const [html, app] = await Promise.all([
  readFile(new URL("./index.html", import.meta.url), "utf8"),
  readFile(new URL("./app.js", import.meta.url), "utf8"),
]);
const now = Date.now();
const point = (secondsAgo) => ({
  t: now - secondsAgo * 1000, vi: 180, vo: 120, ti: 52, to: 39,
  pth: 72.3, ptc: 41.7, uvt: 35, pi: 1008.4, po: 1008.2,
  hi: 35, ho: 30, fs: 1, rpm: 9612, uv: 0, pel: 1,
  vent: 0, door: 0, cal: 0, sgp: 2, mode: "PRINT FILTRATION",
});
const history = [point(180), point(150), point(120), point(90), point(60)];
const fault = {
  t: now - 125000, seq: 1, reason: "TEMPERATURE LIMIT",
  hot: 72.3, cold: 41.7, hot_min: 0, hot_max: 70,
  cold_min: 0, cold_max: 70, chamber: 52.1,
  fan_rpm: 9612, fan_speed: 1, was_active: 1,
  sensors_present: 1, vent_open: 0,
};
const assert = (condition, reason) => { if (!condition) throw new Error(reason); };

async function runDashboard(faultEvents) {
  const dom = new JSDOM(html, {
    runScripts: "outside-only", pretendToBeVisual: true,
    url: "http://printer.local:7131/",
  });
  const { window } = dom;
  const labels = [];
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  window.HTMLCanvasElement.prototype.getContext = () => ({
    setTransform() {}, clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {},
    stroke() {}, fillRect() {}, save() {}, restore() {}, setLineDash() {},
    fillText(value) { labels.push(value); },
    set lineWidth(_value) {}, set font(_value) {}, set fillStyle(_value) {},
    set strokeStyle(_value) {}, set globalAlpha(_value) {},
  });
  window.HTMLCanvasElement.prototype.getBoundingClientRect = () => ({
    width: 900, height: 390, left: 0, top: 0,
  });
  class FakeWebSocket {
    static OPEN = 1;
    constructor() {
      this.readyState = FakeWebSocket.OPEN;
      this.handlers = new Map();
      setTimeout(() => this.emit("open", {}), 0);
    }
    addEventListener(type, fn) {
      if (!this.handlers.has(type)) this.handlers.set(type, []);
      this.handlers.get(type).push(fn);
    }
    emit(type, event) {
      for (const fn of this.handlers.get(type) || []) fn(event);
    }
    send(text) {
      const request = JSON.parse(text);
      let result;
      if (request.method === "server.info") result = { klippy_state: "ready" };
      else if (request.method === "printer.objects.subscribe") result = {
        status: {
          "gcode_macro SM_LED_STATE": { auto_reason: "IDLE", current_state: "IDLE" },
          "fan_generic Filter": { speed: 0, rpm: 0 },
          print_stats: { state: "standby" },
          webhooks: { state: "ready" },
        },
      };
      else if (request.method === "server.database.get_item") result = { value: null };
      else throw new Error("Unexpected RPC " + request.method);
      this.emit("message", { data: JSON.stringify({
        jsonrpc: "2.0", id: request.id, result,
      }) });
    }
    close() { this.readyState = 3; }
  }
  window.WebSocket = FakeWebSocket;
  window.fetch = async () => ({
    ok: true,
    json: async () => ({ samples: history, door_events: [],
      peltier_fault_events: faultEvents, guard: { state: "recording" } }),
  });
  window.eval(app);
  await new Promise((resolve) => setTimeout(resolve, 120));
  window.document.querySelector('[data-view="history"]').click();
  await new Promise((resolve) => setTimeout(resolve, 40));
  const byId = (id) => window.document.getElementById(id);
  return { dom, window, byId, labels };
}

const valid = await runDashboard([fault]);
let { window, byId, labels } = valid;
const meta = byId("historyChart")._chartMeta;
assert(meta.faultEvents.length === 1, "Chart did not load persisted fault evidence");
assert(meta.faultEvents[0].hot === 72.3, "Chart lost hot-side capture");
assert(labels.includes("PELTIER TRIP"), "Fault marker not drawn on history chart");
assert(!byId("peltierFaultHistory").hidden, "Fault history card hidden");
assert(byId("peltierFaultList").textContent.includes("TEMPERATURE LIMIT"),
  "Fault reason missing from history panel");
assert(byId("peltierFaultList").textContent.includes("72.3°C") &&
  byId("peltierFaultList").textContent.includes("70.0°C") &&
  byId("peltierFaultList").textContent.includes("9612 RPM"),
  "Fault measurements and fan RPM missing from history panel");
const x = meta.plot.left + (fault.t - meta.start) /
  (meta.end - meta.start) * (meta.plot.right - meta.plot.left);
byId("historyChart").dispatchEvent(new window.MouseEvent("pointermove", {
  bubbles: true, clientX: x, clientY: 140,
}));
assert(byId("chartTooltip").textContent.includes("PELTIER TRIP") &&
  byId("chartTooltip").textContent.includes("72.3°C"),
  "Fault marker tooltip missing");
valid.dom.window.close();

const legacy = await runDashboard([]);
assert(legacy.byId("peltierFaultHistory").hidden,
  "Dashboard must hide fault details when an older recorder has no events");
assert(legacy.byId("historyChart")._chartMeta.faultEvents.length === 0);
legacy.dom.window.close();

const invalid = await runDashboard([{ ...fault, reason: "<script>alert(1)</script>" }]);
assert(invalid.byId("peltierFaultHistory").hidden,
  "Unrecognized fault reason should not enter the dashboard");
invalid.dom.window.close();
console.log("Dashboard verified Peltier trip marker, detailed evidence, tooltip, and safe older-recorder fallback.");
