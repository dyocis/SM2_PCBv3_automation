#pragma once

#include <Arduino.h>
#include <lvgl.h>

#include "display_device.h"
#include "nevermore_state.h"

class NevermoreUi {
 public:
  NevermoreUi();
  bool begin();
  void loop();
  void render(const NevermoreState& state);

 private:
  DisplayDevice display_;
  lv_disp_draw_buf_t draw_buffer_{};
  lv_disp_drv_t display_driver_{};
  lv_indev_drv_t input_driver_{};
  lv_color_t* buffer_1_{nullptr};
  lv_color_t* buffer_2_{nullptr};
  uint32_t last_tick_ms_{0};

  lv_obj_t* ring_{nullptr};
  lv_obj_t* connection_{nullptr};
  lv_obj_t* mode_{nullptr};
  lv_obj_t* voc_caption_{nullptr};
  lv_obj_t* voc_value_{nullptr};
  lv_obj_t* voc_detail_{nullptr};
  lv_obj_t* fan_detail_{nullptr};
  lv_obj_t* temp_detail_{nullptr};
  lv_obj_t* system_detail_{nullptr};

  static void flush(lv_disp_drv_t* driver, const lv_area_t* area, lv_color_t* pixels);
  static void readTouch(lv_indev_drv_t* driver, lv_indev_data_t* data);
  static lv_color_t modeColor(const NevermoreState& state);
  static String valueOrDash(float value, uint8_t decimals = 0);
};
