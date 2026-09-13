#pragma once

#include <Arduino.h>

// A private user_config.h may override any setting below. The project builds
// without it and stays in simulation mode, so Wi-Fi credentials are never
// required merely to compile or test the display.
#if __has_include("user_config.h")
#include "user_config.h"
#endif

#ifndef NEVERMORE_DEMO_MODE
#define NEVERMORE_DEMO_MODE true
#endif

#ifndef NEVERMORE_WIFI_SSID
#define NEVERMORE_WIFI_SSID ""
#endif

#ifndef NEVERMORE_WIFI_PASSWORD
#define NEVERMORE_WIFI_PASSWORD ""
#endif

#ifndef NEVERMORE_MOONRAKER_HOST
#define NEVERMORE_MOONRAKER_HOST ""
#endif

#ifndef NEVERMORE_MOONRAKER_PORT
#define NEVERMORE_MOONRAKER_PORT 7125
#endif

#ifndef NEVERMORE_MOONRAKER_API_KEY
#define NEVERMORE_MOONRAKER_API_KEY ""
#endif

#ifndef NEVERMORE_BACKLIGHT_PERCENT
#define NEVERMORE_BACKLIGHT_PERCENT 70
#endif

namespace app_config {
inline constexpr bool demo_mode = NEVERMORE_DEMO_MODE;
inline constexpr char wifi_ssid[] = NEVERMORE_WIFI_SSID;
inline constexpr char wifi_password[] = NEVERMORE_WIFI_PASSWORD;
inline constexpr char moonraker_host[] = NEVERMORE_MOONRAKER_HOST;
inline constexpr uint16_t moonraker_port = NEVERMORE_MOONRAKER_PORT;
inline constexpr char moonraker_api_key[] = NEVERMORE_MOONRAKER_API_KEY;
inline constexpr uint8_t backlight_percent = NEVERMORE_BACKLIGHT_PERCENT;
}  // namespace app_config
