#include "ui.h"

#include <cmath>

#include "app_config.h"
#include "board_pins.h"

namespace {
void configureLabel(lv_obj_t* label, const lv_font_t* font, lv_color_t color, int y) {
  lv_obj_set_style_text_font(label, font, 0);
  lv_obj_set_style_text_color(label, color, 0);
  lv_obj_align(label, LV_ALIGN_TOP_MID, 0, y);
}
}  // namespace

NevermoreUi::NevermoreUi() = default;

bool NevermoreUi::begin() {
  if (!display_.begin()) return false;
  display_.setBrightness(app_config::backlight_percent);

  lv_init();
  last_tick_ms_ = millis();
  constexpr size_t kBufferPixels = board_pins::lcd_width * 24;
  constexpr size_t kBufferBytes = kBufferPixels * sizeof(lv_color_t);
  buffer_1_ = static_cast<lv_color_t*>(heap_caps_malloc(kBufferBytes, MALLOC_CAP_DMA));
  buffer_2_ = static_cast<lv_color_t*>(heap_caps_malloc(kBufferBytes, MALLOC_CAP_DMA));
  if (buffer_1_ == nullptr || buffer_2_ == nullptr) return false;

  lv_disp_draw_buf_init(&draw_buffer_, buffer_1_, buffer_2_, kBufferPixels);
  lv_disp_drv_init(&display_driver_);
  display_driver_.hor_res = board_pins::lcd_width;
  display_driver_.ver_res = board_pins::lcd_height;
  display_driver_.flush_cb = flush;
  display_driver_.draw_buf = &draw_buffer_;
  display_driver_.user_data = &display_;
  lv_disp_drv_register(&display_driver_);

  lv_indev_drv_init(&input_driver_);
  input_driver_.type = LV_INDEV_TYPE_POINTER;
  input_driver_.read_cb = readTouch;
  input_driver_.user_data = &display_;
  lv_indev_drv_register(&input_driver_);

  lv_obj_t* screen = lv_scr_act();
  lv_obj_set_style_bg_color(screen, lv_color_hex(0x05070A), 0);
  lv_obj_set_style_bg_opa(screen, LV_OPA_COVER, 0);

  ring_ = lv_arc_create(screen);
  lv_obj_set_size(ring_, 462, 462);
  lv_obj_center(ring_);
  lv_arc_set_rotation(ring_, 270);
  lv_arc_set_bg_angles(ring_, 0, 360);
  lv_arc_set_range(ring_, 0, 100);
  lv_arc_set_value(ring_, 100);
  lv_obj_remove_style(ring_, nullptr, LV_PART_KNOB);
  lv_obj_clear_flag(ring_, LV_OBJ_FLAG_CLICKABLE);
  lv_obj_set_style_arc_width(ring_, 14, LV_PART_MAIN);
  lv_obj_set_style_arc_width(ring_, 14, LV_PART_INDICATOR);
  lv_obj_set_style_arc_color(ring_, lv_color_hex(0x1B222B), LV_PART_MAIN);

  connection_ = lv_label_create(screen);
  configureLabel(connection_, &lv_font_montserrat_16, lv_color_hex(0x95A3B3), 35);

  mode_ = lv_label_create(screen);
  configureLabel(mode_, &lv_font_montserrat_28, lv_color_hex(0xE8EEF5), 70);
  lv_obj_set_width(mode_, 350);
  lv_obj_set_style_text_align(mode_, LV_TEXT_ALIGN_CENTER, 0);
  lv_label_set_long_mode(mode_, LV_LABEL_LONG_DOT);

  voc_caption_ = lv_label_create(screen);
  configureLabel(voc_caption_, &lv_font_montserrat_16, lv_color_hex(0x8390A0), 130);
  lv_label_set_text(voc_caption_, "VOC IN");

  voc_value_ = lv_label_create(screen);
  configureLabel(voc_value_, &lv_font_montserrat_48, lv_color_hex(0xFFFFFF), 157);

  voc_detail_ = lv_label_create(screen);
  configureLabel(voc_detail_, &lv_font_montserrat_24, lv_color_hex(0xC5D0DB), 235);

  fan_detail_ = lv_label_create(screen);
  configureLabel(fan_detail_, &lv_font_montserrat_20, lv_color_hex(0xC5D0DB), 287);

  temp_detail_ = lv_label_create(screen);
  configureLabel(temp_detail_, &lv_font_montserrat_20, lv_color_hex(0xC5D0DB), 328);

  system_detail_ = lv_label_create(screen);
  configureLabel(system_detail_, &lv_font_montserrat_16, lv_color_hex(0x8390A0), 378);

  lv_timer_handler();
  return true;
}

void NevermoreUi::loop() {
  const uint32_t now = millis();
  lv_tick_inc(now - last_tick_ms_);
  last_tick_ms_ = now;
  lv_timer_handler();
}

void NevermoreUi::render(const NevermoreState& state) {
  lv_label_set_text(connection_, linkStateLabel(state.link));
  lv_label_set_text(mode_, state.mode.c_str());

  const String voc_in = valueOrDash(state.voc_in);
  lv_label_set_text(voc_value_, voc_in.c_str());

  const String voc_out = valueOrDash(state.voc_out);
  const String efficiency = valueOrDash(state.efficiency());
  const String voc_line = String("OUT ") + voc_out + "   |   " + efficiency + "%";
  lv_label_set_text(voc_detail_, voc_line.c_str());

  const String fan_line = String("FAN ") + state.fanPercent() + "%   |   " +
                          valueOrDash(state.rpm) + " RPM";
  lv_label_set_text(fan_detail_, fan_line.c_str());

  const String temp_line = String("IN ") + valueOrDash(state.temp_in, 1) + " C   |   OUT " +
                           valueOrDash(state.temp_out, 1) + " C";
  lv_label_set_text(temp_detail_, temp_line.c_str());

  String system_line;
  if (state.link == LinkState::Offline || state.link == LinkState::Stale ||
      state.link == LinkState::Fault) {
    system_line = "CONNECTION LOST - VALUES STALE";
  } else if (state.fault) {
    system_line = state.fault_message.length() ? state.fault_message : "SYSTEM FAULT";
  } else if (state.calibration_phase != "IDLE") {
    system_line = String("SGP40 ") + state.calibration_phase;
  } else if (state.print_state.length()) {
    system_line = String("PRINTER ") + state.print_state;
  } else {
    system_line = "NEVERMORE READY";
  }
  lv_obj_set_width(system_detail_, 340);
  lv_obj_set_style_text_align(system_detail_, LV_TEXT_ALIGN_CENTER, 0);
  lv_label_set_long_mode(system_detail_, LV_LABEL_LONG_DOT);
  lv_label_set_text(system_detail_, system_line.c_str());

  const lv_color_t color = modeColor(state);
  lv_obj_set_style_arc_color(ring_, color, LV_PART_INDICATOR);
  lv_obj_set_style_text_color(voc_value_, color, 0);
}

void NevermoreUi::flush(lv_disp_drv_t* driver, const lv_area_t* area, lv_color_t* pixels) {
  auto* display = static_cast<DisplayDevice*>(driver->user_data);
  display->drawBitmap(area->x1, area->y1, area->x2, area->y2, pixels);
  lv_disp_flush_ready(driver);
}

void NevermoreUi::readTouch(lv_indev_drv_t* driver, lv_indev_data_t* data) {
  auto* display = static_cast<DisplayDevice*>(driver->user_data);
  uint16_t x = 0;
  uint16_t y = 0;
  if (display->readTouch(x, y)) {
    data->state = LV_INDEV_STATE_PR;
    data->point.x = x;
    data->point.y = y;
  } else {
    data->state = LV_INDEV_STATE_REL;
  }
}

lv_color_t NevermoreUi::modeColor(const NevermoreState& state) {
  if (state.fault || state.voc_state == 3) return lv_color_hex(0xFF3B30);
  if (state.link != LinkState::Live && state.link != LinkState::Demo) {
    return lv_color_hex(0x617083);
  }
  if (state.calibration_phase != "IDLE") return lv_color_hex(0xA970FF);
  if (state.chamber_latched) return lv_color_hex(0x00B8D9);
  if (state.voc_state == 2) return lv_color_hex(0xFFB020);
  if (state.voc_state == 1 || state.fanPercent() > 0) return lv_color_hex(0x32D583);
  return lv_color_hex(0x617083);
}

String NevermoreUi::valueOrDash(float value, uint8_t decimals) {
  return std::isfinite(value) ? String(value, static_cast<unsigned int>(decimals)) : String("--");
}
