import { readFile } from "node:fs/promises";

const [html, css, app, recorder, service, installer] = await Promise.all([
  readFile(new URL("./index.html", import.meta.url), "utf8"),
  readFile(new URL("./styles.css", import.meta.url), "utf8"),
  readFile(new URL("./app.js", import.meta.url), "utf8"),
  readFile(new URL("./nevermore_history.py", import.meta.url), "utf8"),
  readFile(new URL("./nevermore-history.service.template", import.meta.url), "utf8"),
  readFile(new URL("../scripts/install.sh", import.meta.url), "utf8"),
]);

const failures = [];
const assert = (condition, message) => {
  if (!condition) failures.push(message);
};

const htmlIds = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
const duplicateIds = htmlIds.filter((id, index) => htmlIds.indexOf(id) !== index);
assert(duplicateIds.length === 0, `Duplicate HTML ids: ${duplicateIds.join(", ")}`);

const elementBlock = app.match(/const els = Object\.fromEntries\(\s*\[([\s\S]*?)\]\.map/);
assert(elementBlock, "Could not locate dashboard element registry");
if (elementBlock) {
  const registeredIds = [...elementBlock[1].matchAll(/"([A-Za-z][A-Za-z0-9]+)"/g)].map((match) => match[1]);
  const missingIds = registeredIds.filter((id) => !htmlIds.includes(id));
  assert(missingIds.length === 0, `Registered element ids missing from HTML: ${missingIds.join(", ")}`);
}

const requiredObjects = [
  "gcode_macro SM_LED_STATE",
  "fan_generic Filter",
  "temperature_sensor BME_IN",
  "temperature_sensor BME_OUT",
  "bme280 BME_IN",
  "bme280 BME_OUT",
  "temperature_sensor SGP_IN",
  "temperature_sensor SGP_OUT",
  "temperature_sensor _SM_PCB",
  "temperature_sensor _SM_MCU",
  "print_stats",
  "webhooks",
];
for (const objectName of requiredObjects) {
  assert(app.includes(objectName), `Dashboard missing Moonraker object: ${objectName}`);
  if (objectName !== "webhooks") assert(recorder.includes(objectName), `Recorder missing printer object: ${objectName}`);
}

const rpcMethods = [...app.matchAll(/\.call\("([^"]+)"/g)].map((match) => match[1]);
const allowedRpcMethods = new Set([
  "server.info",
  "printer.objects.subscribe",
  "server.database.get_item",
  "server.database.post_item",
  "printer.gcode.script",
]);
const unexpectedRpcMethods = rpcMethods.filter((method) => !allowedRpcMethods.has(method));
assert(unexpectedRpcMethods.length === 0, `Unexpected Moonraker RPC methods: ${unexpectedRpcMethods.join(", ")}`);

const requiredMacros = [
  "NEVERMORE_MANUAL",
  "NEVERMORE_FILTER",
  "NEVERMORE_UV",
  "NEVERMORE_PELTIER",
  "NEVERMORE_OFF",
  "NEVERMORE_AUTO_ENABLE",
  "NEVERMORE_EMERGENCY_OFF",
  "NEVERMORE_CLEAR_ERROR",
  "VENT_OPEN",
  "VENT_CLOSE",
  "NEVERMORE_SGP_CALIBRATION_START",
  "NEVERMORE_SGP_CALIBRATION_CANCEL",
];
for (const macro of requiredMacros) assert(app.includes(macro), `Missing guarded macro: ${macro}`);
assert(!/SET_PIN|SET_FAN_SPEED|printer\.emergency_stop|\bM112\b/.test(app), "Dashboard contains a direct hardware or printer emergency command");
assert(!/printer\/gcode|gcode\/script/.test(recorder), "History recorder must not use a G-code endpoint");

const views = [...html.matchAll(/data-view="([^"]+)"/g)].map((match) => match[1]);
for (const view of ["live", "history", "media", "controls"]) {
  assert(views.includes(view), `Missing compact console view: ${view}`);
  assert(html.includes(`data-view-panel="${view}"`), `Missing view panel: ${view}`);
}

assert(html.includes('<link rel="stylesheet" href="./styles.css"'), "Stylesheet link is missing");
assert(html.includes('<script src="./app.js" defer>'), "Dashboard script link is missing");
assert(html.includes('<link rel="icon" href="./favicon.svg"'), "Dashboard favicon link is missing");
assert(html.includes('src="./nevermore3d-mark.jpg"'), "Official Nevermore3D artwork is missing");
assert(css.includes(".workspace-tabs"), "Compact view tabs are missing");
assert(css.includes(".sm2-fan"), "StealthMax fan design is missing");
assert(css.includes(".media-honeycomb"), "StealthMax media-basket design is missing");
assert(html.includes('class="media-frame-visual"'), "Rounded-octagonal SM2 media frame is missing");
assert(html.includes('class="media-frame-rail"'), "SM2 red perimeter rail is missing");
assert(html.includes('class="media-fasteners"'), "SM2 perimeter fasteners are missing");
assert(css.includes("--sm2-red-deep"), "Red/graphite SM2 palette is missing");
assert(!css.includes("rotate(45deg) scale(.82)"), "Legacy diamond media housing is still present");
assert(css.includes("@media (max-width: 620px)"), "Mobile layout rules are missing");
assert(css.includes("prefers-reduced-motion"), "Reduced-motion accessibility rule is missing");

assert(recorder.includes("HISTORY") || recorder.includes("retention_hours"), "Recorder retention logic is missing");
assert(recorder.includes("atomic_json_write"), "Recorder atomic-write protection is missing");
assert(recorder.includes("query_server_info"), "Recorder does not verify Klipper readiness");
assert(recorder.includes("RestartGuard"), "Recorder restart quarantine is missing");
assert(recorder.includes("sample_plausibility_error"), "Recorder sensor plausibility checks are missing");
assert(recorder.includes("outlet_voc_restart_error"), "Recorder delayed outlet-VOC restart guard is missing");
assert(app.includes("RESTART_QUARANTINE_MS"), "Browser history restart quarantine is missing");
assert(app.includes("historyPointError"), "Browser history plausibility checks are missing");
assert(app.includes("outletVocRestartError"), "Browser delayed outlet-VOC restart guard is missing");
assert(app.includes("cleanHistorySeries"), "Existing-history cleanup is missing");
assert(app.includes("MAX_CHART_GAP_MS"), "Restart gaps are not preserved in chart rendering");
assert(app.includes("ventOpen"), "Dashboard does not expose commanded vent state");
assert(app.includes("peltierCooldown"), "Dashboard does not expose Peltier cooldown state");
assert(app.includes("peltierPending"), "Dashboard does not expose pending Peltier state");
assert(app.includes("ventClosedReady"), "Dashboard does not expose the servo close-ready guard");
assert(html.includes('id="interlockFlag"'), "Dashboard interlock flag is missing");
assert(html.includes('id="peltierInterlockText"'), "Dashboard Peltier interlock detail is missing");
assert(html.includes('id="sgpCalibrationButton"'), "Dashboard SGP40 calibration control is missing");
assert(html.includes('id="helpTooltip"'), "Dashboard rollover help surface is missing");
assert((html.match(/data-help=/g) || []).length >= 20, "Dashboard does not contain the promised concise rollover descriptions");
assert(!/vent_open:\s*1[^\n]*peltier:\s*1/.test(app), "Demo data contains unsafe vent-open and Peltier-on state");
assert(recorder.includes('"vent": truthy(sm.get("vent_open"))'), "Recorder does not retain commanded vent state");
assert(recorder.includes('"cal": truthy(sm.get("sgp40_calibration_active"))'), "Recorder does not tag SGP40 calibration windows");
assert(recorder.includes('"sgp": number(sm.get("sgp40_calibration_revision"))'), "Recorder does not retain the SGP40 baseline revision");
assert(app.includes("point.cal !== 1"), "Media health does not exclude SGP40 calibration samples");
assert(app.includes("sampleMatchesSgpRevision"), "Media health does not separate pre/post-calibration VOC samples");
assert(!app.includes("const value = Number(point[key]);"), "History sanitizer still converts null values to zero");
assert(service.includes("NoNewPrivileges=true"), "Recorder service hardening is missing");
assert(service.includes("--restart-quarantine-seconds 90 --stable-samples 3"), "Recorder service restart guard is not configured");
assert(installer.includes("nevermore-history.service"), "Installer does not enable the recorder service");
assert(installer.includes("systemctl restart nevermore-history.service"), "Installer does not restart the updated recorder");

if (failures.length) {
  failures.forEach((failure) => console.error(`FAIL: ${failure}`));
  process.exit(1);
}

console.log(`Validated ${htmlIds.length} elements, ${requiredObjects.length} live objects, four compact views, guarded controls, and the rolling recorder.`);
