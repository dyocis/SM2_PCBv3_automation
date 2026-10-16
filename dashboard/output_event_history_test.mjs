import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

const [html, app] = await Promise.all([
  readFile(new URL("./index.html", import.meta.url), "utf8"),
  readFile(new URL("./app.js", import.meta.url), "utf8"),
]);

const now = Date.now();
const point = (secondsAgo, changes = {}) => ({
  t: now - secondsAgo * 1000,
  vi: 140, vo: 80,
  ti: 40, to: 35, pth: 38, ptc: 28, uvt: 42,
  pi: 1008.4, po: 1008.2, hi: 35, ho: 30,
  fs: 1, rpm: 9650, uv: 0, pel: 0, vent: 0, cal: 0, sgp: 1,
  mode: "PRINT FILTRATION",
  ...changes,
});

// Samples are chronologically ordered. The 70-second gap (150->80)
// must NOT be interpreted as an ON event, even though both outputs changed.
const history = [
  point(200),
  point(190, { uv: 1 }),
  point(180, { uv: 1, pel: 1 }),
  point(170, { uv: 1, pel: 1, vi: 240, vo: 210 }),
  point(160, { pel: 1 }),
  point(150),
  point(80, { uv: 1, pel: 1 }),
  point(70, { uv: 1, pel: 1 }),
  point(60),
  point(50, { pel: null }),
  point(40, { uv: 1, pel: 1 }),
  point(30, { uv: null, pel: 1 }),
  point(20),
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
const canvasCalls = [];
window.HTMLCanvasElement.prototype.getContext = () => ({
  setTransform() {},
  clearRect() {},
  beginPath() {},
  moveTo() {},
  lineTo() {},
  stroke() {},
  fillText(text) { canvasCalls.push(["text", text]); },
  fillRect(x, y, width, height) { canvasCalls.push(["fill", x, y, width, height]); },
  save() {},
  restore() {},
  setLineDash() {},
  set lineWidth(_value) {},
  set font(_value) {},
  set fillStyle(_value) {},
  set strokeStyle(_value) {},
  set globalAlpha(_value) {},
});
window.HTMLCanvasElement.prototype.getBoundingClientRect = () => ({
  width: 900, height: 390, left: 0, top: 0,
});

window.eval(app);
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const byId = (id) => window.document.getElementById(id);
const historyButton = window.document.querySelector('[data-view="history"]');
const uvButton = window.document.querySelector('[data-metric="uv-led"]');
const peltierButton = window.document.querySelector('[data-metric="peltier"]');
const canvas = byId("historyChart");
historyButton.click();
await new Promise((resolve) => setTimeout(resolve, 30));

function checkMetric(button, expectedKey, expectedIndices) {
  canvasCalls.length = 0;
  button.click();
  const meta = canvas._chartMeta;
  assert(meta.outputKey === expectedKey, "Wrong tracked output for metric " + expectedKey);
  const events = meta.outputEvents;
  assert(events.length === expectedIndices.length,
    `Expected ${expectedIndices.length} ${expectedKey} events; found ${events.length}`);
  assert(events.every((item, i) => item.index === expectedIndices[i]),
    `Unexpected ${expectedKey} event indices: ${events.map((e) => e.index)}`);
  assert(events.every((item) => item.t === meta.samples[item.index].t),
    "Transitions must be anchored to recorded sample timestamps");
  assert(events.every((item) => item.label === (item.state ? "ON" : "OFF")),
    "Transitions do not match recorded switch state");
  assert(!events.some((item) => item.index === 6),
    "Transition falsely inferred from history gap/restart");
  assert(byId("chartLegend").textContent.includes("ON/OFF event lines"),
    "ON/OFF marker legend missing");
  assert(canvasCalls.filter((item) => item[0] === "text" && ["ON", "OFF"].includes(item[1])).length
    === events.length, "Each confirmed event must have one visible label");
  return meta;
}

const uv = checkMetric(uvButton, "uv", [1, 4, 8, 10]);
const uvVoc = uv.definition.series.find((series) => series.label === "VOC outlet (index)");
assert(uvVoc?.axis === "voc", "UV chart does not use a separate outlet VOC axis");
assert(uvVoc.values[3] === 210, "UV chart did not read the recorded VOC outlet field");
assert(uv.definition.series[0].values[3] === 42, "UV LED temperature trace changed");
assert(uv.vocMax >= 210 && uv.vocMax <= 500, "VOC axis did not scale to its recorded range");
assert(uv.plot.right === 900 - 58, "UV chart did not reserve room for right-side VOC labels");
assert(byId("chartLegend").textContent.includes("VOC outlet (index)"),
  "UV chart is missing VOC outlet legend");
assert(canvasCalls.some((item) => item[0] === "text" && item[1] === "VOC"),
  "UV chart is missing its VOC axis title");
assert(!uv.outputEvents.some((event) => event.index === 12),
  "Unknown UV state falsely inferred a shutoff");
const on = uv.outputEvents[0];
let x = uv.plot.left + ((on.t - uv.start) / (uv.end - uv.start)) *
  (uv.plot.right - uv.plot.left);
canvas.dispatchEvent(new window.MouseEvent("pointermove", {
  clientX: x, clientY: 150, bubbles: true,
}));
assert(byId("chartTooltip").textContent.includes("UV LEDs"),
  "UV tooltip missing output state");
assert(byId("chartTooltip").textContent.includes("VOC outlet (index)") &&
  byId("chartTooltip").textContent.includes("80"),
  "UV tooltip missing outlet VOC Index reading");
assert(byId("chartTooltip").textContent.includes("Recorded transition"),
  "UV tooltip missing state-change information");

const peltier = checkMetric(peltierButton, "pel", [2, 5, 8, 12]);
assert(peltier.vocMax === null && !peltier.definition.series.some((series) => series.axis === "voc"),
  "Peltier temperature chart unexpectedly received VOC overlay");
assert(!peltier.outputEvents.some((event) => event.index === 10),
  "Unknown Peltier state falsely inferred startup");
const off = peltier.outputEvents.at(-1);
x = peltier.plot.left + ((off.t - peltier.start) / (peltier.end - peltier.start)) *
  (peltier.plot.right - peltier.plot.left);
canvas.dispatchEvent(new window.MouseEvent("pointermove", {
  clientX: x, clientY: 150, bubbles: true,
}));
assert(byId("chartTooltip").textContent.includes("Peltier"),
  "Peltier tooltip missing output state");
assert(byId("chartTooltip").textContent.includes("OFF"),
  "Peltier tooltip missing OFF state");

window.document.querySelector('[data-metric="voc"]').click();
assert(canvas._chartMeta.outputKey === null, "VOC chart received output-event markings");
assert(canvas._chartMeta.outputEvents.length === 0,
  "VOC chart accidentally included output transitions");
assert(canvas._chartMeta.vocMax === null, "Ordinary VOC graph unexpectedly uses two axes");

dom.window.close();
console.log("UV and Peltier event history verified; UV also overlays outlet VOC Index on a separate axis.");
