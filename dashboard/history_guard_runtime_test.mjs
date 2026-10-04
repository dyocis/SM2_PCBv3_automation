import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

const [html, app] = await Promise.all([
  readFile(new URL("./index.html", import.meta.url), "utf8"),
  readFile(new URL("./app.js", import.meta.url), "utf8"),
]);

const now = Date.now();
const point = (t, changes = {}) => ({
  t,
  vi: 164,
  vo: 112,
  ti: 36.7,
  to: 30.9,
  pi: 1008.42,
  po: 1008.31,
  hi: 31.2,
  ho: 29.8,
  fs: 1,
  rpm: 9640,
  uv: 0,
  pel: 0,
  vent: 0,
  cal: 0,
  sgp: 0,
  mode: "PRINT FILTRATION",
  ...changes,
});

const history = [
  point(now - 500_000, { vi: 60, vo: 40 }),
  point(now - 400_000, { ti: null, pi: null }),
  point(now - 350_000, { vi: 34, vo: 29 }),
  point(now - 300_000, { vi: 70, vo: 45 }),
  point(now - 250_000, { vi: 0, vo: 0 }),
  point(now - 200_000, { vi: 45, vo: 35, cal: 1, sgp: 1 }),
  point(now - 190_000, { vi: 50, vo: 320 }),
  point(now - 150_000, { vi: 82, vo: 105 }),
  point(now - 90_000, { vi: 0, vo: 0 }),
  point(now - 80_000, { vi: 350, vo: 250 }),
];

const dom = new JSDOM(html, {
  runScripts: "outside-only",
  pretendToBeVisual: true,
  url: "http://localhost/nevermore-dashboard/",
});
const { window } = dom;
window.localStorage.setItem("nevermore-dashboard-history-v2", JSON.stringify(history));
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
window.document.querySelector('[data-view="history"]').click();
await new Promise((resolve) => setTimeout(resolve, 30));

const samples = window.document.getElementById("historyChart")._chartMeta?.samples || [];
const assert = (condition, message) => { if (!condition) throw new Error(message); };

assert(samples.length === 6, `Expected six guarded samples, received ${samples.length}`);
assert(samples[0].t === history[0].t, "Valid pre-restart history was not preserved");
assert(samples[1].t === history[3].t, "History did not resume after the 90-second restart quarantine");
assert(samples[2].vi === 0 && samples[2].vo === 0, "Legitimate zero VOC indexes were rejected");
assert(!samples.some((sample) => sample.vo === 320), "Delayed outlet restart spike reached the chart");
assert(samples[4].vi === 0 && samples[4].vo === 0, "Post-spike zero VOC indexes were rejected");
assert(samples[5].vi === 350 && samples[5].vo === 250, "Legitimate inlet-led VOC event was rejected");
assert(samples.every((sample) => sample.ti !== 0 && sample.pi !== 0), "JSON null was converted to a zero spike");
assert(samples.every((sample) => Math.abs(sample.pi - sample.po) <= 20), "Impossible pressure reached the chart");
assert(samples.every((sample) => sample.vent === 0), "Commanded vent state was not preserved in history");
assert(samples.some((sample) => sample.cal === 1 && sample.sgp === 1), "SGP40 calibration window and baseline revision were not preserved");

dom.window.close();
console.log("History runtime verified restart guards plus SGP40 calibration-window and baseline-revision retention.");
