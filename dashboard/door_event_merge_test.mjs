import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

const [html, app] = await Promise.all([
  readFile(new URL("./index.html", import.meta.url), "utf8"),
  readFile(new URL("./app.js", import.meta.url), "utf8"),
]);
const now = Date.now();
const point = (secondsAgo, changes = {}) => ({
  t: now - secondsAgo * 1000, vi: 140, vo: 80, ti: 40, to: 35,
  pth: 38, ptc: 28, uvt: 42, pi: 1008.4, po: 1008.2,
  hi: 35, ho: 30, fs: 1, rpm: 9650,
  uv: 0, pel: 0, vent: 0, door: null, cal: 0, sgp: 1,
  mode: "PRINT FILTRATION", ...changes,
});
// Interleaved browser readings must not interrupt Pi door transitions.
const browser = [
  point(195), point(185), point(175), point(165),
  point(155), point(145), point(135),
];
const pi = [
  point(200, { door: 0 }),
  point(190, { door: 0 }),
  point(180, { door: 0 }),
  point(170, { door: 1 }),
  point(160, { door: 0 }),
  point(150, { door: 1 }),
  point(140, { door: 0 }),
  point(130, { door: 0 }),
];
// Fast recorder has already grouped the rapid close/reopen bounce into
// one interval. The dashboard must not re-add 10-second sample markers.
const direct = [
  { t: now - 169000, state: 1 },
  { t: now - 139000, state: 0 },
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
  emit(type, event) {
    for (const fn of this.handlers.get(type) || []) fn(event);
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
    else throw new Error("Unexpected mutation or RPC " + req.method);
    this.emit("message", { data: JSON.stringify({
      jsonrpc: "2.0", id: req.id, result,
    }) });
  }
  close() { this.readyState = 3; }
}
window.WebSocket = FakeWebSocket;
window.fetch = async () => ({
  ok: true,
  json: async () => ({ samples: pi, door_events: direct, guard: { state: "recording" } }),
});
window.eval(app);
const assert = (value, message) => { if (!value) throw new Error(message); };
await new Promise((resolve) => setTimeout(resolve, 100));
window.document.querySelector('[data-view="history"]').click();
await new Promise((resolve) => setTimeout(resolve, 40));
const canvas = window.document.getElementById("historyChart");
const meta = canvas._chartMeta;
assert(meta, "Chart did not render");
assert(meta.doorEvents.length === 2, `Expected grouped open/close, got ${meta.doorEvents.length} events`);
assert(meta.doorEvents[0].state === 1 && meta.doorEvents[1].state === 0,
  "Grouped interval order or state is incorrect");
assert(meta.doorEvents[0].t === direct[0].t && meta.doorEvents[1].t === direct[1].t,
  "Chart did not prefer authoritative fast recorder timestamps");
assert(meta.samples.some((item) => item.src === "browser") &&
  meta.samples.some((item) => item.src === "pi"),
  "History sample origins were not preserved");

const xAt = (t) => meta.plot.left + ((t - meta.start) / (meta.end - meta.start)) *
  (meta.plot.right - meta.plot.left);
canvas.dispatchEvent(new window.MouseEvent("pointermove", {
  bubbles: true, clientX: xAt(direct[0].t), clientY: 150,
}));
assert(window.document.getElementById("chartTooltip").textContent.includes("Chamber door transition"),
  "Fast recorder door event was not visible in the tooltip");
// Pi environmental samples include a brief CLOSED reading at -160s, but the
// independent recorder grouped the rapid close/reopen as one OPEN interval.
// Hovering an interleaved browser sample must not contradict that interval.
canvas.dispatchEvent(new window.MouseEvent("pointermove", {
  bubbles: true, clientX: xAt(now - 155000), clientY: 150,
}));
assert(window.document.getElementById("chartTooltip").textContent.includes("Chamber door OPEN"),
  "Tooltip contradicted the recorder's grouped door-open interval");
dom.window.close();
console.log("Recorder fast-event authority, interleaved browser samples, and tooltip verified.");
