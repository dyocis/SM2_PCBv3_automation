#include "nevermore_state.h"

#include <cmath>

namespace {

float clampFloat(float value, float low, float high) {
  return value < low ? low : (value > high ? high : value);
}

bool jsonTruthy(JsonVariantConst value, bool fallback = false) {
  if (value.isNull()) return fallback;
  if (value.is<bool>()) return value.as<bool>();
  if (value.is<int>() || value.is<long>() || value.is<float>() || value.is<double>()) {
    return value.as<double>() != 0.0;
  }
  if (value.is<const char*>()) {
    String text = value.as<const char*>();
    text.trim();
    text.toLowerCase();
    return text == "1" || text == "true" || text == "on" || text == "yes";
  }
  return fallback;
}

float jsonFloat(JsonVariantConst value, float fallback) {
  if (value.isNull()) return fallback;
  if (value.is<float>() || value.is<double>() || value.is<int>() || value.is<long>()) {
    return value.as<float>();
  }
  if (value.is<const char*>()) {
    const String text = value.as<const char*>();
    if (text.length()) return text.toFloat();
  }
  return fallback;
}

String cleanString(JsonVariantConst value, const String& fallback) {
  if (!value.is<const char*>()) return fallback;
  String result = value.as<const char*>();
  result.trim();
  if (result.length() >= 2 && result[0] == '"' && result[result.length() - 1] == '"') {
    result = result.substring(1, result.length() - 1);
  }
  return result.length() ? result : fallback;
}

void applyMacro(NevermoreState& state, JsonObjectConst sm) {
  if (sm.isNull()) return;

  state.source_mode = cleanString(sm["auto_reason"], cleanString(sm["current_state"], state.source_mode));
  state.source_mode.toUpperCase();
  state.automation = jsonTruthy(sm["auto_mode"], state.automation);
  state.manual_override = jsonTruthy(sm["manual_override"], state.manual_override);
  state.print_active = jsonTruthy(sm["print_active"], state.print_active);
  state.purge_active = jsonTruthy(sm["purge_active"], state.purge_active);
  state.chamber_latched = jsonTruthy(sm["chamber_cooling_latched"], state.chamber_latched);
  state.fault = jsonTruthy(sm["fault"], state.fault);
  state.uv_installed = jsonTruthy(sm["uv_installed"], state.uv_installed);
  state.peltier_installed = jsonTruthy(sm["peltier_installed"], state.peltier_installed);
  state.vent_installed = jsonTruthy(sm["vent_servo_installed"], state.vent_installed);
  state.uv = jsonTruthy(sm["uv"], state.uv);
  state.peltier = jsonTruthy(sm["peltier"], state.peltier);
  state.vent_open = jsonTruthy(sm["vent_open"], state.vent_open);
  state.calibration_active = jsonTruthy(sm["sgp40_calibration_active"], state.calibration_active);
  state.calibration_hold = jsonTruthy(sm["sgp40_calibration_hold"], state.calibration_hold);
  state.calibration_phase = cleanString(sm["sgp40_calibration_phase"], state.calibration_phase);
  state.calibration_phase.toUpperCase();
  state.calibration_remaining = jsonFloat(sm["sgp40_calibration_remaining"], state.calibration_remaining);
  state.fan_speed = clampFloat(jsonFloat(sm["last_filter_speed"], state.fan_speed), 0.0F, 1.0F);
  state.rpm = jsonFloat(sm["last_rpm"], state.rpm);
  state.temp_in = jsonFloat(sm["temp_in"], state.temp_in);
  state.temp_out = jsonFloat(sm["temp_out"], state.temp_out);
  state.voc_in = jsonFloat(sm["voc_in"], state.voc_in);
  state.voc_out = jsonFloat(sm["voc_out"], state.voc_out);
  state.chamber_target = jsonFloat(sm["chamber_target"], state.chamber_target);
  state.chamber_hysteresis = jsonFloat(sm["chamber_hysteresis"], state.chamber_hysteresis);
  state.voc_warning = jsonFloat(sm["voc_warning"], state.voc_warning);
  state.voc_high = jsonFloat(sm["voc_high"], state.voc_high);
  state.voc_emergency = jsonFloat(sm["voc_emergency"], state.voc_emergency);
  state.voc_state = constrain(static_cast<int>(lroundf(jsonFloat(sm["voc_state"], state.voc_state))), 0, 3);
  state.transition_count = static_cast<uint32_t>(jsonFloat(sm["transition_count"], state.transition_count));
  state.last_action = cleanString(sm["last_action"], state.last_action);
}

}  // namespace

float NevermoreState::vocDelta() const {
  return std::isfinite(voc_in) && std::isfinite(voc_out) ? voc_in - voc_out : NAN;
}

float NevermoreState::efficiency() const {
  if (!std::isfinite(voc_in) || !std::isfinite(voc_out) || voc_in <= 0.0F) return NAN;
  return clampFloat(((voc_in - voc_out) / voc_in) * 100.0F, 0.0F, 100.0F);
}

float NevermoreState::tempDelta() const {
  return std::isfinite(temp_in) && std::isfinite(temp_out) ? temp_in - temp_out : NAN;
}

int NevermoreState::fanPercent() const {
  return static_cast<int>(lroundf(clampFloat(fan_speed, 0.0F, 1.0F) * 100.0F));
}

bool NevermoreState::stale(uint32_t now_ms, uint32_t stale_after_ms) const {
  return link == LinkState::Live && last_update_ms != 0 && (now_ms - last_update_ms) > stale_after_ms;
}

void NevermoreState::applyStatus(JsonObjectConst status) {
  applyMacro(*this, status["gcode_macro SM_LED_STATE"].as<JsonObjectConst>());

  const JsonObjectConst fan = status["fan_generic Filter"].as<JsonObjectConst>();
  if (!fan.isNull()) {
    fan_speed = clampFloat(jsonFloat(fan["speed"], fan_speed), 0.0F, 1.0F);
    rpm = jsonFloat(fan["rpm"], rpm);
  }

  const JsonObjectConst bme_in = status["temperature_sensor BME_IN"].as<JsonObjectConst>();
  const JsonObjectConst bme_out = status["temperature_sensor BME_OUT"].as<JsonObjectConst>();
  const JsonObjectConst sgp_in = status["temperature_sensor SGP_IN"].as<JsonObjectConst>();
  const JsonObjectConst sgp_out = status["temperature_sensor SGP_OUT"].as<JsonObjectConst>();
  if (!bme_in.isNull()) temp_in = jsonFloat(bme_in["temperature"], temp_in);
  if (!bme_out.isNull()) temp_out = jsonFloat(bme_out["temperature"], temp_out);
  if (!sgp_in.isNull()) voc_in = jsonFloat(sgp_in["temperature"], voc_in);
  if (!sgp_out.isNull()) voc_out = jsonFloat(sgp_out["temperature"], voc_out);

  const JsonObjectConst print = status["print_stats"].as<JsonObjectConst>();
  if (!print.isNull()) {
    print_state = cleanString(print["state"], print_state);
    filename = cleanString(print["filename"], filename);
  }

  const JsonObjectConst webhooks = status["webhooks"].as<JsonObjectConst>();
  if (!webhooks.isNull()) {
    const String klippy_state = cleanString(webhooks["state"], "ready");
    if (klippy_state == "error" || klippy_state == "shutdown") {
      fault = true;
      fault_message = cleanString(webhooks["state_message"], "Klipper is not ready");
    }
  }

  mode = fault ? "FAULT" : source_mode;
  markUpdated();
}

void NevermoreState::markUpdated() {
  last_update_ms = millis();
  ++revision;
}

const char* linkStateLabel(LinkState value) {
  switch (value) {
    case LinkState::Demo: return "DEMO";
    case LinkState::WifiConnecting: return "WIFI";
    case LinkState::MoonrakerConnecting: return "CONNECTING";
    case LinkState::Live: return "LIVE";
    case LinkState::Stale: return "STALE";
    case LinkState::Offline: return "OFFLINE";
    case LinkState::Fault: return "FAULT";
  }
  return "UNKNOWN";
}

