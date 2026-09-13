#include "demo_source.h"

#include <ArduinoJson.h>

namespace {
struct DemoFrame {
  const char* mode;
  uint8_t voc_state;
  float fan_speed;
  float rpm;
  float temp_in;
  float temp_out;
  float voc_in;
  float voc_out;
  bool print_active;
  bool purge_active;
  bool chamber_latched;
  bool uv;
  bool peltier;
  const char* calibration_phase;
  uint32_t duration_ms;
};

constexpr DemoFrame kFrames[] = {
    {"IDLE", 0, 0.0F, 0, 27.1F, 27.5F, 99, 99, false, false, false, false, false, "IDLE", 4000},
    {"PRINT FILTRATION", 1, 1.0F, 9640, 36.7F, 30.9F, 164, 112, true, false, false, false, false, "IDLE", 6000},
    {"CHAMBER COOLING", 1, 1.0F, 9590, 60.3F, 48.7F, 176, 118, true, false, true, false, true, "IDLE", 5000},
    {"POST PRINT PURGE", 2, 1.0F, 9625, 48.2F, 39.4F, 246, 137, false, true, false, true, false, "IDLE", 5000},
    {"POST PRINT PURGE", 1, 0.6F, 7620, 39.4F, 34.8F, 114, 101, false, true, false, false, false, "IDLE", 5000},
    {"SGP40 CALIBRATION", 0, 0.0F, 0, 24.8F, 25.1F, 100, 100, false, false, false, false, false, "CALIBRATING", 5000},
    {"VOC EMERGENCY", 3, 1.0F, 9700, 42.4F, 35.0F, 465, 210, false, true, false, true, false, "IDLE", 5000},
};
}

void DemoSource::begin() {
  state_.link = LinkState::Demo;
  frame_ = 0;
  applyFrame(frame_);
}

void DemoSource::loop() {
  if (static_cast<int32_t>(millis() - next_frame_ms_) < 0) return;
  frame_ = (frame_ + 1) % (sizeof(kFrames) / sizeof(kFrames[0]));
  applyFrame(frame_);
}

void DemoSource::applyFrame(size_t index) {
  const DemoFrame& frame = kFrames[index];
  StaticJsonDocument<2048> document;
  JsonObject status = document.to<JsonObject>();
  JsonObject sm = status.createNestedObject("gcode_macro SM_LED_STATE");
  sm["auto_reason"] = frame.mode;
  sm["current_state"] = frame.mode;
  sm["auto_mode"] = 1;
  sm["manual_override"] = 0;
  sm["print_active"] = frame.print_active;
  sm["purge_active"] = frame.purge_active;
  sm["chamber_cooling_latched"] = frame.chamber_latched;
  sm["voc_state"] = frame.voc_state;
  sm["uv_installed"] = 1;
  sm["peltier_installed"] = 1;
  sm["vent_servo_installed"] = 1;
  sm["uv"] = frame.uv;
  sm["peltier"] = frame.peltier;
  sm["vent_open"] = 0;
  sm["fault"] = 0;
  sm["sgp40_calibration_active"] = strcmp(frame.calibration_phase, "IDLE") != 0;
  sm["sgp40_calibration_hold"] = strcmp(frame.calibration_phase, "IDLE") != 0;
  sm["sgp40_calibration_phase"] = frame.calibration_phase;
  sm["sgp40_calibration_remaining"] = 82740;
  sm["chamber_target"] = 60;
  sm["chamber_hysteresis"] = 5;
  sm["voc_warning"] = 120;
  sm["voc_high"] = 220;
  sm["voc_emergency"] = 400;
  sm["transition_count"] = index;

  JsonObject fan = status.createNestedObject("fan_generic Filter");
  fan["speed"] = frame.fan_speed;
  fan["rpm"] = frame.rpm;
  status.createNestedObject("temperature_sensor BME_IN")["temperature"] = frame.temp_in;
  status.createNestedObject("temperature_sensor BME_OUT")["temperature"] = frame.temp_out;
  status.createNestedObject("temperature_sensor SGP_IN")["temperature"] = frame.voc_in;
  status.createNestedObject("temperature_sensor SGP_OUT")["temperature"] = frame.voc_out;

  JsonObject print = status.createNestedObject("print_stats");
  print["state"] = frame.print_active ? "printing" : (frame.purge_active ? "complete" : "standby");
  print["filename"] = frame.print_active ? "Nevermore_Display_Test.gcode" : "";
  status.createNestedObject("webhooks")["state"] = "ready";

  state_.applyStatus(status);
  state_.link = LinkState::Demo;
  state_.markUpdated();
  next_frame_ms_ = millis() + frame.duration_ms;
}

