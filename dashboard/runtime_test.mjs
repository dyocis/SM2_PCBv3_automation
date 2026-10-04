import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

const [html, app] = await Promise.all([
  readFile(new URL("./index.html", import.meta.url), "utf8"),
  readFile(new URL("./app.js", import.meta.url), "utf8"),
]);

const dom = new JSDOM(html, {
  runScripts: "outside-only",
  pretendToBeVisual: true,
  url: "http://printer.local/?demo=1",
});

const { window } = dom;
window.HTMLDialogElement.prototype.showModal = function showModal() {
  this.open = true;
};
window.HTMLDialogElement.prototype.close = function close() {
  this.open = false;
};
window.HTMLCanvasElement.prototype.getContext = () => ({
  setTransform() {}, clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
  fillText() {}, save() {}, restore() {}, setLineDash() {},
  set lineWidth(_value) {}, set font(_value) {}, set fillStyle(_value) {},
  set strokeStyle(_value) {}, set globalAlpha(_value) {},
});
window.HTMLCanvasElement.prototype.getBoundingClientRect = () => ({
  width: 900, height: 390, left: 0, top: 0, right: 900, bottom: 390,
});

const installedAt = Date.now() - 3_600_000;
window.localStorage.setItem("nevermore-dashboard-media-v2", JSON.stringify({
  installedAt,
  pressureZeroPa: 0,
  pressureFreshPa: 10,
  vocFreshEfficiency: 30,
  fanSeconds: 1800,
}));
window.localStorage.setItem("nevermore-dashboard-history-v2", JSON.stringify(
  Array.from({ length: 20 }, (_, index) => ({
    t: Date.now() - (20 - index) * 10_000,
    vi: 160, vo: 112, ti: 36, to: 31, pi: 1008.4, po: 1008.3,
    hi: 31, ho: 30, fs: 1, rpm: 9640, uv: 0, pel: 0, vent: 0, mode: "PRINT FILTRATION",
  }))
));

window.eval(app);
await new Promise((resolve) => setTimeout(resolve, 20));

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const byId = (id) => window.document.getElementById(id);

assert(byId("connectionText").textContent === "Demo", "Demo connection did not initialize");
assert(byId("modeTitle").textContent.length > 0, "Live mode did not render");
assert(!window.document.querySelector('[data-view-panel="live"]').hidden, "Live view should be visible initially");
assert(window.document.querySelector('[data-view-panel="history"]').hidden, "History view should be hidden initially");
assert(window.document.querySelector('[data-action="uv-toggle"]').disabled, "Controls must be disabled in demo mode");
assert(byId("pressureIn").textContent !== "—", "BME280 pressure did not render");
assert(byId("ventComponentState").textContent === "CLOSED", "Commanded vent state did not render");

window.document.querySelector('[data-view="history"]').click();
await new Promise((resolve) => setTimeout(resolve, 10));
assert(!window.document.querySelector('[data-view-panel="history"]').hidden, "History tab did not open");
assert(window.document.querySelector('[data-view-panel="live"]').hidden, "Live panels remained visible behind History");

window.document.querySelector('[data-view="media"]').click();
assert(!window.document.querySelector('[data-view-panel="media"]').hidden, "Media tab did not open");
assert(byId("mediaHealthPill").textContent === "HEALTHY", "Calibrated healthy media did not render");

window.document.querySelector('[data-view="controls"]').click();
assert(!window.document.querySelector('[data-view-panel="controls"]').hidden, "Controls tab did not open");
assert(byId("controlLockButton").dataset.locked === "true", "Controls must start locked");

dom.window.close();
console.log("Runtime demo rendered all four compact views with locked controls and live pressure data.");
