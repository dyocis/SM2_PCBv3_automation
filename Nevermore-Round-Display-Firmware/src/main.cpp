#include <Arduino.h>
#include <WiFi.h>

#include "app_config.h"
#include "board_pins.h"
#include "demo_source.h"
#include "moonraker_client.h"
#include "nevermore_state.h"
#include "ui.h"

namespace {
NevermoreState state;
NevermoreUi ui;
DemoSource demo(state);
MoonrakerClient moonraker(state);
uint32_t rendered_revision = UINT32_MAX;
uint32_t last_wifi_attempt_ms = 0;

bool liveModeConfigured() {
  return !app_config::demo_mode && app_config::wifi_ssid[0] != '\0' &&
         app_config::moonraker_host[0] != '\0';
}

void printHardwareReport() {
  Serial.println("\nNevermore Round Display milestone 0.2.0");
  Serial.printf("Chip: %s, cores: %u, revision: %u\n",
                ESP.getChipModel(), ESP.getChipCores(), ESP.getChipRevision());
  Serial.printf("Flash: %u MB\n", ESP.getFlashChipSize() / (1024U * 1024U));
  Serial.printf("PSRAM: %u MB, free: %u bytes\n",
                ESP.getPsramSize() / (1024U * 1024U), ESP.getFreePsram());
  Serial.printf("Heap free: %u bytes\n", ESP.getFreeHeap());
  if (ESP.getFlashChipSize() != 16U * 1024U * 1024U) {
    Serial.println("WARNING: expected 16 MB flash");
  }
  if (ESP.getPsramSize() != 8U * 1024U * 1024U) {
    Serial.println("WARNING: expected 8 MB PSRAM");
  }
}

void beginLiveMode() {
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.begin(app_config::wifi_ssid, app_config::wifi_password);
  state.link = LinkState::WifiConnecting;
  state.markUpdated();
  last_wifi_attempt_ms = millis();
}

void serviceLiveMode() {
  if (WiFi.status() == WL_CONNECTED) {
    if (!moonraker.connected() && state.link == LinkState::WifiConnecting) {
      Serial.printf("Wi-Fi connected: %s\n", WiFi.localIP().toString().c_str());
      moonraker.begin(app_config::moonraker_host,
                      app_config::moonraker_port,
                      app_config::moonraker_api_key);
    }
    moonraker.loop();
    return;
  }

  if (millis() - last_wifi_attempt_ms > 15000) {
    state.link = LinkState::WifiConnecting;
    state.markUpdated();
    WiFi.disconnect();
    WiFi.begin(app_config::wifi_ssid, app_config::wifi_password);
    last_wifi_attempt_ms = millis();
  }
}
}  // namespace

void setup() {
  Serial.begin(115200);
  delay(350);
  printHardwareReport();

  if (!ui.begin()) {
    Serial.println("FATAL: display or LVGL buffer initialization failed");
    while (true) delay(1000);
  }

  if (liveModeConfigured()) {
    Serial.println("Mode: live Moonraker");
    beginLiveMode();
  } else {
    Serial.println("Mode: safe simulated data");
    demo.begin();
  }
}

void loop() {
  if (liveModeConfigured()) {
    serviceLiveMode();
  } else {
    demo.loop();
  }

  if (state.revision != rendered_revision) {
    ui.render(state);
    rendered_revision = state.revision;
  }

  ui.loop();
  delay(5);
}
