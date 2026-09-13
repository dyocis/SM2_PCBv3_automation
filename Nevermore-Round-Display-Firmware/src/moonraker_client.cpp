#include "moonraker_client.h"

#include <ArduinoJson.h>

namespace {
constexpr size_t kIncomingJsonCapacity = 24576;
}

MoonrakerClient::MoonrakerClient(NevermoreState& state) : state_(state) {}

void MoonrakerClient::begin(const char* host, uint16_t port, const char* api_key) {
  state_.link = LinkState::MoonrakerConnecting;
  state_.markUpdated();

  if (api_key != nullptr && api_key[0] != '\0') {
    static String header;
    header = String("X-Api-Key: ") + api_key + "\r\n";
    socket_.setExtraHeaders(header.c_str());
  }

  socket_.onEvent([this](WStype_t type, uint8_t* payload, size_t length) {
    onEvent(type, payload, length);
  });
  socket_.setReconnectInterval(3000);
  socket_.enableHeartbeat(10000, 3000, 2);
  socket_.begin(host, port, "/websocket");
}

void MoonrakerClient::loop() {
  socket_.loop();
  if (state_.stale(millis())) {
    state_.link = LinkState::Stale;
    state_.markUpdated();
  }
}

bool MoonrakerClient::connected() const {
  return websocket_connected_;
}

bool MoonrakerClient::runGcode(const String& script) {
  if (!websocket_connected_) return false;
  StaticJsonDocument<512> params;
  params["script"] = script;
  return sendRequest("printer.gcode.script", params.as<JsonVariantConst>()) != 0;
}

void MoonrakerClient::onEvent(WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      websocket_connected_ = true;
      state_.link = LinkState::MoonrakerConnecting;
      state_.markUpdated();
      requestServerInfo();
      break;
    case WStype_DISCONNECTED:
      websocket_connected_ = false;
      state_.link = LinkState::Offline;
      state_.markUpdated();
      break;
    case WStype_TEXT:
      handleMessage(payload, length);
      break;
    default:
      break;
  }
}

void MoonrakerClient::handleMessage(const uint8_t* payload, size_t length) {
  DynamicJsonDocument message(kIncomingJsonCapacity);
  const DeserializationError error = deserializeJson(message, payload, length);
  if (error) {
    Serial.printf("Moonraker JSON error: %s\n", error.c_str());
    return;
  }

  const uint32_t id = message["id"] | 0U;
  if (id != 0U) {
    if (!message["error"].isNull()) {
      Serial.printf("Moonraker request %lu failed: %s\n",
                    static_cast<unsigned long>(id),
                    message["error"]["message"] | "unknown error");
      state_.link = LinkState::Fault;
      state_.fault_message = message["error"]["message"] | "Moonraker request failed";
      state_.markUpdated();
      return;
    }

    if (id == server_info_id_) {
      const char* klippy_state = message["result"]["klippy_state"] | "unknown";
      if (strcmp(klippy_state, "ready") == 0) {
        subscribe();
      } else {
        Serial.printf("Klipper state: %s\n", klippy_state);
      }
      return;
    }

    if (id == subscribe_id_) {
      const JsonObjectConst status = message["result"]["status"].as<JsonObjectConst>();
      if (!status.isNull()) state_.applyStatus(status);
      state_.link = LinkState::Live;
      state_.markUpdated();
      return;
    }
  }

  const char* method = message["method"] | "";
  if (strcmp(method, "notify_status_update") == 0) {
    const JsonObjectConst patch = message["params"][0].as<JsonObjectConst>();
    if (!patch.isNull()) state_.applyStatus(patch);
    state_.link = LinkState::Live;
    return;
  }

  if (strcmp(method, "notify_klippy_ready") == 0) {
    requestServerInfo();
  } else if (strcmp(method, "notify_klippy_disconnected") == 0 ||
             strcmp(method, "notify_klippy_shutdown") == 0) {
    state_.link = LinkState::Offline;
    state_.markUpdated();
  }
}

void MoonrakerClient::requestServerInfo() {
  server_info_id_ = sendRequest("server.info");
}

void MoonrakerClient::subscribe() {
  StaticJsonDocument<1024> params;
  JsonObject objects = params.createNestedObject("objects");
  objects["gcode_macro SM_LED_STATE"] = nullptr;

  JsonArray fan = objects.createNestedArray("fan_generic Filter");
  fan.add("speed");
  fan.add("rpm");

  objects.createNestedArray("temperature_sensor BME_IN").add("temperature");
  objects.createNestedArray("temperature_sensor BME_OUT").add("temperature");
  objects.createNestedArray("temperature_sensor SGP_IN").add("temperature");
  objects.createNestedArray("temperature_sensor SGP_OUT").add("temperature");

  JsonArray print_stats = objects.createNestedArray("print_stats");
  print_stats.add("state");
  print_stats.add("filename");
  print_stats.add("print_duration");
  print_stats.add("total_duration");

  JsonArray webhooks = objects.createNestedArray("webhooks");
  webhooks.add("state");
  webhooks.add("state_message");

  subscribe_id_ = sendRequest("printer.objects.subscribe", params.as<JsonVariantConst>());
}

uint32_t MoonrakerClient::sendRequest(const char* method, JsonVariantConst params) {
  if (!websocket_connected_) return 0;

  StaticJsonDocument<1536> request;
  const uint32_t id = next_id_++;
  request["jsonrpc"] = "2.0";
  request["method"] = method;
  request["id"] = id;
  if (!params.isNull()) request["params"] = params;

  String payload;
  serializeJson(request, payload);
  socket_.sendTXT(payload);
  return id;
}

