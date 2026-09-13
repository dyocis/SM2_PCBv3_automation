#pragma once

// Copy this file to include/user_config.h. That filename is ignored by Git.
// Start in demo mode for display bring-up. Change to false only after the
// display works and the printer address is reachable.
#define NEVERMORE_DEMO_MODE true

#define NEVERMORE_WIFI_SSID "YOUR_WIFI_NAME"
#define NEVERMORE_WIFI_PASSWORD "YOUR_WIFI_PASSWORD"

// Hostname or IP only; do not include http:// or /websocket.
#define NEVERMORE_MOONRAKER_HOST "voron3.local"
#define NEVERMORE_MOONRAKER_PORT 7125

// Leave blank when Moonraker trusts this device on the local network.
#define NEVERMORE_MOONRAKER_API_KEY ""

#define NEVERMORE_BACKLIGHT_PERCENT 70
