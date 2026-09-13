#pragma once

#include <Arduino.h>

namespace board_pins {

// Waveshare ESP32-S3-Touch-LCD-2.1B (SKU 30697). The ST7701S is configured
// over this two-wire SPI bus, then receives pixels over the 16-bit RGB bus.
inline constexpr int lcd_config_sclk = 2;
inline constexpr int lcd_config_mosi = 1;
inline constexpr int lcd_backlight = 6;

inline constexpr int i2c_sda = 15;
inline constexpr int i2c_scl = 7;
inline constexpr int touch_interrupt = 16;

inline constexpr uint8_t tca9554_address = 0x20;
inline constexpr uint8_t touch_address = 0x15;
inline constexpr uint8_t expander_lcd_reset = 1;
inline constexpr uint8_t expander_touch_reset = 2;
inline constexpr uint8_t expander_lcd_cs = 3;

inline constexpr int rgb_hsync = 38;
inline constexpr int rgb_vsync = 39;
inline constexpr int rgb_de = 40;
inline constexpr int rgb_pclk = 41;
inline constexpr int rgb_data[16] = {
    5, 45, 48, 47, 21, 14, 13, 12,
    11, 10, 9, 46, 3, 8, 18, 17,
};

inline constexpr int lcd_width = 480;
inline constexpr int lcd_height = 480;

}  // namespace board_pins
