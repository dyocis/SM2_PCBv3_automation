#pragma once

#include <Arduino.h>
#include <ArduinoJson.h>

enum class LinkState : uint8_t {
  Demo,
  WifiConnecting,
  MoonrakerConnecting,
  Live,
  Stale,
  Offline,
  Fault,
};

struct NevermoreState {
  String mode{"IDLE"};
  String source_mode{"IDLE"};
  String fault_message;
  String calibration_phase{"IDLE"};
  String print_state{"standby"};
  String filename;
  String last_action{"NONE"};

  LinkState link{LinkState::Demo};
  bool fault{false};
  bool automation{false};
  bool manual_override{false};
  bool print_active{false};
  bool purge_active{false};
  bool chamber_latched{false};
  bool uv_installed{false};
  bool peltier_installed{false};
  bool vent_installed{false};
  bool uv{false};
  bool peltier{false};
  bool vent_open{false};
  bool calibration_active{false};
  bool calibration_hold{false};

  float fan_speed{0.0F};
  float rpm{0.0F};
  float temp_in{NAN};
  float temp_out{NAN};
  float voc_in{NAN};
  float voc_out{NAN};
  float chamber_target{55.0F};
  float chamber_hysteresis{5.0F};
  float voc_warning{120.0F};
  float voc_high{220.0F};
  float voc_emergency{400.0F};
  float calibration_remaining{0.0F};

  int voc_state{0};
  uint32_t transition_count{0};
  uint32_t revision{0};
  uint32_t last_update_ms{0};

  float vocDelta() const;
  float efficiency() const;
  float tempDelta() const;
  int fanPercent() const;
  bool stale(uint32_t now_ms, uint32_t stale_after_ms = 20000) const;

  void applyStatus(JsonObjectConst status);
  void markUpdated();
};

const char* linkStateLabel(LinkState value);

