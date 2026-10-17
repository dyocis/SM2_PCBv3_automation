import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

const [html, app] = await Promise.all([
  readFile(new URL("./index.html", import.meta.url), "utf8"),
  readFile(new URL("./app.js", import.meta.url), "utf8"),
]);
const now = Date.now();
const point = (secondsAgo, changes = {}) => ({
  t: now - secondsAgo * 1000,
  vi: 140, vo: 80, ti: 40, to: 35, pth: 38, ptc: 28, uvt: 42,
  pi: 1008.4, po: 1008.2, hi: 35, ho: 30,
  fs: 1, rpm: 9650, uv: 0, pel: 0, vent: 0, door: null, cal: 0, sgp: 1,
  mode: "PRINT FILTRATION",
  ...changes,
});
const history = [
  point(220),
  point(210, { door: 0 }),
  point(205, { door: null, src: "browser" }),
  point(200, { door: 1, src: "pi" }),
  point(195, { door: null, src: "browser" }),
  point(190, { door: 1, src: "pi" }),
  point(185, { door: null, src: "browser" }),
  point(180, { door: 0, src: "pi" }),
  point(80, { door: 1 }), // 100s gap; opening cannot be inferred.
  point(70, { door: 0 }),
  point(60, { door: null, src: "pi" }),
  point(50, { door: 1, src: "pi" }), // Unknown Pi state; skip.
];
const manual = {
  id: "manual-test", t: now - 195_000, kind: "garage-open",
  label: "Garage door opened",
};
const dom = new JSDOM(html, {
  runScripts: "outside-only", pretendToBeVisual: true,
  url: "http://localhost/nevermore-dashboard/",
});
const { window } = dom;
window.localStorage.setItem("nevermore-dashboard-history-v2", JSON.stringify(history));
window.localStorage.setItem("nevermore-dashboard-history-annotations-v1", JSON.stringify([manual]));
window.HTMLDialogElement.prototype.showModal = function showModal() { this.open = true; };
window.HTMLDialogElement.prototype.close = function close() { this.open = false; };
const drawnLabels = [];
window.HTMLCanvasElement.prototype.getContext = () => ({
  setTransform() {}, clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {},
  stroke() {}, fillRect() {}, save() {}, restore() {}, setLineDash() {},
  fillText(value) { drawnLabels.push(value); },
  set lineWidth(_value) {}, set font(_value) {}, set fillStyle(_value) {},
  set strokeStyle(_value) {}, set globalAlpha(_value) {},
});
window.HTMLCanvasElement.prototype.getBoundingClientRect = () => ({
  width: 900, height: 390, left: 0, top: 0,
});
window.eval(app);
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const byId = (id) => window.document.getElementById(id);
byId("annotationOpen").disabled = true; // No live Moonraker connection in this test.
window.document.querySelector('[data-view="history"]').click();
await new Promise((resolve) => setTimeout(resolve, 30));
const canvas = byId("historyChart");
const meta = canvas._chartMeta;
assert(meta, "History chart missing");
assert(meta.doorEvents.map((e) => e.index).join(",") === "3,7,9",
  "Unexpected door transitions or invented gap/unknown events");
assert(meta.doorEvents[0].label === "CHAMBER OPEN" &&
  meta.doorEvents[1].label === "CHAMBER CLOSED", "Door labels reversed");
assert(drawnLabels.includes("DOOR OPEN") && drawnLabels.includes("DOOR CLOSED"),
  "Chamber door markers were not drawn");
assert(drawnLabels.includes("GARAGE OPEN"), "Manual garage door event not drawn");
assert(byId("chartLegend").textContent.includes("Chamber door events") &&
  byId("chartLegend").textContent.includes("Manual events"),
  "Event legends missing");
assert(byId("annotationList").textContent.includes("Garage door opened"),
  "Persisted annotations not shown in history UI");
const xAt = (t) => meta.plot.left + (t - meta.start) /
  (meta.end - meta.start) * (meta.plot.right - meta.plot.left);
canvas.dispatchEvent(new window.MouseEvent("pointermove", {
  clientX: xAt(manual.t), clientY: 160, bubbles: true,
}));
assert(byId("chartTooltip").textContent.includes("Manual event") &&
  byId("chartTooltip").textContent.includes("Garage door opened"),
  "Tooltip did not show manually recorded garage event");
canvas.dispatchEvent(new window.MouseEvent("pointermove", {
  clientX: xAt(meta.doorEvents[0].t), clientY: 160, bubbles: true,
}));
assert(byId("chartTooltip").textContent.includes("Chamber door transition") &&
  byId("chartTooltip").textContent.includes("OPEN"),
  "Tooltip did not describe recorded chamber door opening");
dom.window.close();
console.log("Verified optional door event markers, gap-safe transitions, manually persisted events, and tooltips.");
