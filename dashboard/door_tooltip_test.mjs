import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

// End-to-end regression for tooltips where browser and Pi readings alternate
// at near-identical times. Browser telemetry has no chamber-door signal.
const [html, app] = await Promise.all([
  readFile(new URL("./index.html", import.meta.url), "utf8"),
  readFile(new URL("./app.js", import.meta.url), "utf8"),
]);
const now = Date.now();
const sample = (msAgo, changes = {}) => ({
  t: now - msAgo, vi: 110, vo: 85, ti: 28.4, to: 27.8,
  pth: 28.1, ptc: 28.2, uvt: 27.1, pi: 1008.4, po: 1008.3,
  hi: 40, ho: 36, fs: 0, rpm: 0, uv: 0, pel: 0, vent: 0,
  door: null, cal: 0, sgp: 2, mode: "IDLE", ...changes,
});
const pi = [];
for (let seconds = 260; seconds >= 90; seconds -= 10) {
  const door = seconds === 120 || seconds === 110 ? null :
    seconds <= 100 ? 1 : seconds <= 160 && seconds >= 170 ? 1 : 0;
  pi.push(sample(seconds * 1000, { door }));
}
// Two short, direct events between environmental samples; the click-through
// tooltip must honor their timestamps rather than its browser-only row.
const direct = [
  { t: now - 175000, state: 1 },
  { t: now - 155000, state: 0 },
];
const browser = [
  sample(245000), sample(179800), sample(173000),
  sample(165000), sample(153000), sample(115000),
  sample(95000), sample(10000),
];
const dom = new JSDOM(html, {
  runScripts: "outside-only", pretendToBeVisual: true,
  url: "http://printer.local:7131/",
});
const { window } = dom;
window.localStorage.setItem("nevermore-dashboard-history-v2", JSON.stringify(browser));
window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
window.HTMLDialogElement.prototype.close = function () { this.open = false; };
window.HTMLCanvasElement.prototype.getContext = () => ({
  setTransform() {}, clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {},
  stroke() {}, fillText() {}, fillRect() {}, save() {}, restore() {}, setLineDash() {},
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
  emit(type, value) {
    for (const handler of this.handlers.get(type) || []) handler(value);
  }
  send(text) {
    const req = JSON.parse(text);
    let result = {};
    if (req.method === "server.info") result = { klippy_state: "ready" };
    else if (req.method === "printer.objects.subscribe") result = {
      status: {
        "gcode_macro SM_LED_STATE": { current_state: "IDLE", auto_reason: "IDLE" },
        "fan_generic Filter": { speed: 0, rpm: 0 },
        print_stats: { state: "standby" },
        webhooks: { state: "ready" },
      },
    };
    else if (req.method === "server.database.get_item") result = { value: null };
    else throw new Error("Unexpected RPC " + req.method);
    this.emit("message", { data: JSON.stringify({ jsonrpc: "2.0",
      id: req.id, result }) });
  }
  close() { this.readyState = 3; }
}
window.WebSocket = FakeWebSocket;
window.fetch = async () => ({
  ok: true,
  json: async () => ({ samples: pi, door_events: direct,
    guard: { state: "recording" } }),
});
window.eval(app);
const assert = (ok, message) => { if (!ok) throw new Error(message); };
await new Promise((resolve) => setTimeout(resolve, 120));
window.document.querySelector('[data-view="history"]').click();
await new Promise((resolve) => setTimeout(resolve, 40));
const byId = (id) => window.document.getElementById(id);
const meta = byId("historyChart")._chartMeta;
assert(meta && meta.samples.some((point) => point.src === "browser") &&
  meta.samples.some((point) => point.src === "pi"),
"Did not merge independent Pi and browser samples");

function hover(msAgo, expected, label) {
  const selected = now - msAgo;
  const x = meta.plot.left + ((selected - meta.start) /
    (meta.end - meta.start)) * (meta.plot.right - meta.plot.left);
  byId("historyChart").dispatchEvent(new window.MouseEvent("pointermove", {
    bubbles: true, clientX: x, clientY: 150,
  }));
  const visible = byId("chartTooltip").textContent;
  assert(visible.includes("Chamber door " + expected),
    label + ": expected door " + expected + ", got " + visible);
}

hover(245000, "CLOSED", "Between two closed Pi readings");
hover(179800, "CLOSED", "Browser point 200ms after confirmed closed");
hover(173000, "OPEN", "Fast door-open event after a closed Pi sample");
hover(165000, "OPEN", "Interleaved browser point while open");
hover(153000, "CLOSED", "Fast close event between Pi readings");
hover(115000, "UNKNOWN", "Explicit missing Pi door state must stay unknown");
hover(95000, "OPEN", "New valid Pi observation after missing state");
hover(10000, "UNKNOWN", "Long gap without Pi samples must stay unknown");

assert(meta.doorEvents.length >= 2 &&
  meta.doorEvents.some((event) => event.state === 1) &&
  meta.doorEvents.some((event) => event.state === 0),
  "Fast chamber door event markers were damaged");

dom.window.close();
console.log("Door tooltip source isolation, fast events, and gap-safe UNKNOWN behavior verified.");
