#pragma once

#include <Arduino.h>
#include <lvgl.h>

#include "esp_lcd_panel_ops.h"
#include "esp_lcd_panel_rgb.h"
#include "driver/spi_master.h"

class DisplayDevice final {
 public:
  bool begin();
  void setBrightness(uint8_t percent);
  void drawBitmap(int x1, int y1, int x2, int y2, const lv_color_t* pixels);
  bool readTouch(uint16_t& x, uint16_t& y);

 private:
  bool beginI2cAndExpander();
  bool beginPanel();
  bool beginTouch();
  bool writeExpander(uint8_t reg, uint8_t value);
  bool setExpanderPin(uint8_t pin, bool high);
  bool readTouchRegisters(uint8_t reg, uint8_t* data, size_t length);
  void resetPanel();
  void writeCommand(uint8_t command);
  void writeData(uint8_t data);
  void writeCommandData(uint8_t command, const uint8_t* data, size_t length);

  spi_device_handle_t spi_{nullptr};
  esp_lcd_panel_handle_t panel_{nullptr};
  uint8_t expander_output_{0x07};
  bool touch_ready_{false};
};
