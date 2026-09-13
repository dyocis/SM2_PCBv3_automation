#pragma once

#include <Arduino.h>
#include <WebSocketsClient.h>

#include "nevermore_state.h"

class MoonrakerClient {
 public:
  explicit MoonrakerClient(NevermoreState& state);

  void begin(const char* host, uint16_t port, const char* api_key = "");
  void loop();
  bool connected() const;
  bool runGcode(const String& script);

 private:
  NevermoreState& state_;
  WebSocketsClient socket_;
  uint32_t next_id_{1};
  uint32_t server_info_id_{0};
  uint32_t subscribe_id_{0};
  bool websocket_connected_{false};

  void onEvent(WStype_t type, uint8_t* payload, size_t length);
  void handleMessage(const uint8_t* payload, size_t length);
  void requestServerInfo();
  void subscribe();
  uint32_t sendRequest(const char* method, JsonVariantConst params = JsonVariantConst());
};

