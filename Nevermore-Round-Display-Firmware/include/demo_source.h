#pragma once

#include <Arduino.h>

#include "nevermore_state.h"

class DemoSource {
 public:
  explicit DemoSource(NevermoreState& state) : state_(state) {}

  void begin();
  void loop();

 private:
  NevermoreState& state_;
  size_t frame_{0};
  uint32_t next_frame_ms_{0};
  void applyFrame(size_t index);
};

