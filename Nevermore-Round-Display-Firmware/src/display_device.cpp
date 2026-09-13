#include "display_device.h"

#include <Wire.h>

#include "board_pins.h"
#include "esp_arduino_version.h"
#include "esp_idf_version.h"

namespace {
constexpr uint8_t kTcaOutputRegister = 0x01;
constexpr uint8_t kTcaConfigRegister = 0x03;
constexpr uint8_t kCst820GestureRegister = 0x01;
constexpr uint8_t kCst820VersionRegister = 0x15;
constexpr uint8_t kCst820ChipIdRegister = 0xA7;
constexpr uint8_t kCst820DisableAutoSleepRegister = 0xFE;
constexpr uint8_t kBacklightChannel = 1;
constexpr uint32_t kBacklightFrequency = 20000;
constexpr uint8_t kBacklightResolution = 10;

bool ok(esp_err_t result, const char* operation) {
  if (result == ESP_OK) return true;
  Serial.printf("%s failed: 0x%X\n", operation, static_cast<unsigned>(result));
  return false;
}
}  // namespace

bool DisplayDevice::begin() {
  if (!beginI2cAndExpander()) return false;
  if (!beginPanel()) return false;
  touch_ready_ = beginTouch();
  if (!touch_ready_) Serial.println("Touch unavailable; status display will continue");

#if ESP_ARDUINO_VERSION_MAJOR >= 3
  if (!ledcAttach(board_pins::lcd_backlight, kBacklightFrequency, kBacklightResolution)) {
    Serial.println("Backlight PWM setup failed");
    return false;
  }
#else
  ledcSetup(kBacklightChannel, kBacklightFrequency, kBacklightResolution);
  ledcAttachPin(board_pins::lcd_backlight, kBacklightChannel);
#endif
  return true;
}

bool DisplayDevice::beginI2cAndExpander() {
  if (!Wire.begin(board_pins::i2c_sda, board_pins::i2c_scl)) {
    Serial.println("I2C initialization failed");
    return false;
  }
  Wire.setClock(400000);
  if (!writeExpander(kTcaOutputRegister, expander_output_)) return false;
  if (!writeExpander(kTcaConfigRegister, 0x00)) return false;
  return true;
}

bool DisplayDevice::writeExpander(uint8_t reg, uint8_t value) {
  Wire.beginTransmission(board_pins::tca9554_address);
  Wire.write(reg);
  Wire.write(value);
  if (Wire.endTransmission(true) == 0) return true;
  Serial.printf("TCA9554 write failed at register 0x%02X\n", reg);
  return false;
}

bool DisplayDevice::setExpanderPin(uint8_t pin, bool high) {
  if (pin < 1 || pin > 8) return false;
  const uint8_t mask = static_cast<uint8_t>(1U << (pin - 1));
  if (high) {
    expander_output_ |= mask;
  } else {
    expander_output_ &= static_cast<uint8_t>(~mask);
  }
  return writeExpander(kTcaOutputRegister, expander_output_);
}

void DisplayDevice::resetPanel() {
  setExpanderPin(board_pins::expander_lcd_reset, false);
  delay(10);
  setExpanderPin(board_pins::expander_lcd_reset, true);
  delay(50);
}

void DisplayDevice::writeCommand(uint8_t command) {
  spi_transaction_t transaction{};
  transaction.cmd = 0;
  transaction.addr = command;
  spi_device_transmit(spi_, &transaction);
}

void DisplayDevice::writeData(uint8_t data) {
  spi_transaction_t transaction{};
  transaction.cmd = 1;
  transaction.addr = data;
  spi_device_transmit(spi_, &transaction);
}

void DisplayDevice::writeCommandData(uint8_t command, const uint8_t* data, size_t length) {
  writeCommand(command);
  for (size_t index = 0; index < length; ++index) writeData(data[index]);
}

bool DisplayDevice::beginPanel() {
  resetPanel();

  spi_bus_config_t bus_config{};
  bus_config.mosi_io_num = board_pins::lcd_config_mosi;
  bus_config.miso_io_num = -1;
  bus_config.sclk_io_num = board_pins::lcd_config_sclk;
  bus_config.quadwp_io_num = -1;
  bus_config.quadhd_io_num = -1;
  bus_config.max_transfer_sz = 64;
  esp_err_t result = spi_bus_initialize(SPI2_HOST, &bus_config, SPI_DMA_CH_AUTO);
  if (result != ESP_OK && result != ESP_ERR_INVALID_STATE) {
    return ok(result, "ST7701 SPI bus initialization");
  }

  spi_device_interface_config_t device_config{};
  device_config.command_bits = 1;
  device_config.address_bits = 8;
  device_config.mode = 0;
  device_config.clock_speed_hz = 40000000;
  device_config.spics_io_num = -1;
  device_config.queue_size = 1;
  if (!ok(spi_bus_add_device(SPI2_HOST, &device_config, &spi_), "ST7701 SPI device setup")) {
    return false;
  }

  setExpanderPin(board_pins::expander_lcd_cs, false);

  const uint8_t ff10[] = {0x77, 0x01, 0x00, 0x00, 0x10};
  const uint8_t c0[] = {0x3B, 0x00};
  const uint8_t c1[] = {0x0B, 0x02};
  const uint8_t c2[] = {0x07, 0x02};
  const uint8_t b0_gamma[] = {0x00, 0x11, 0x16, 0x0E, 0x11, 0x06, 0x05, 0x09,
                              0x08, 0x21, 0x06, 0x13, 0x10, 0x29, 0x31, 0x18};
  const uint8_t b1_gamma[] = {0x00, 0x11, 0x16, 0x0E, 0x11, 0x07, 0x05, 0x09,
                              0x09, 0x21, 0x05, 0x13, 0x11, 0x2A, 0x31, 0x18};
  writeCommandData(0xFF, ff10, sizeof(ff10));
  writeCommandData(0xC0, c0, sizeof(c0));
  writeCommandData(0xC1, c1, sizeof(c1));
  writeCommandData(0xC2, c2, sizeof(c2));
  const uint8_t cc[] = {0x10};
  const uint8_t cd[] = {0x08};
  writeCommandData(0xCC, cc, sizeof(cc));
  writeCommandData(0xCD, cd, sizeof(cd));
  writeCommandData(0xB0, b0_gamma, sizeof(b0_gamma));
  writeCommandData(0xB1, b1_gamma, sizeof(b1_gamma));

  const uint8_t ff11[] = {0x77, 0x01, 0x00, 0x00, 0x11};
  writeCommandData(0xFF, ff11, sizeof(ff11));
  const uint8_t b0[] = {0x6D};
  const uint8_t b1[] = {0x37};
  const uint8_t b2[] = {0x81};
  const uint8_t b3[] = {0x80};
  const uint8_t b5[] = {0x43};
  const uint8_t b7[] = {0x85};
  const uint8_t b8[] = {0x20};
  const uint8_t c1p[] = {0x78};
  const uint8_t c2p[] = {0x78};
  const uint8_t d0[] = {0x88};
  writeCommandData(0xB0, b0, sizeof(b0));
  writeCommandData(0xB1, b1, sizeof(b1));
  writeCommandData(0xB2, b2, sizeof(b2));
  writeCommandData(0xB3, b3, sizeof(b3));
  writeCommandData(0xB5, b5, sizeof(b5));
  writeCommandData(0xB7, b7, sizeof(b7));
  writeCommandData(0xB8, b8, sizeof(b8));
  writeCommandData(0xC1, c1p, sizeof(c1p));
  writeCommandData(0xC2, c2p, sizeof(c2p));
  writeCommandData(0xD0, d0, sizeof(d0));

  const uint8_t e0[] = {0x00, 0x00, 0x02};
  const uint8_t e1[] = {0x03, 0xA0, 0x00, 0x00, 0x04, 0xA0, 0x00, 0x00, 0x00, 0x20, 0x20};
  const uint8_t e2[] = {0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                        0x00, 0x00, 0x00, 0x00, 0x00, 0x00};
  const uint8_t e3[] = {0x00, 0x00, 0x11, 0x00};
  const uint8_t e4[] = {0x22, 0x00};
  const uint8_t e5[] = {0x05, 0xEC, 0xA0, 0xA0, 0x07, 0xEE, 0xA0, 0xA0,
                        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00};
  const uint8_t e6[] = {0x00, 0x00, 0x11, 0x00};
  const uint8_t e7[] = {0x22, 0x00};
  const uint8_t e8[] = {0x06, 0xED, 0xA0, 0xA0, 0x08, 0xEF, 0xA0, 0xA0,
                        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00};
  const uint8_t eb[] = {0x00, 0x00, 0x40, 0x40, 0x00, 0x00, 0x00};
  const uint8_t ed[] = {0xFF, 0xFF, 0xFF, 0xBA, 0x0A, 0xBF, 0x45, 0xFF,
                        0xFF, 0x54, 0xFB, 0xA0, 0xAB, 0xFF, 0xFF, 0xFF};
  const uint8_t ef[] = {0x10, 0x0D, 0x04, 0x08, 0x3F, 0x1F};
  writeCommandData(0xE0, e0, sizeof(e0));
  writeCommandData(0xE1, e1, sizeof(e1));
  writeCommandData(0xE2, e2, sizeof(e2));
  writeCommandData(0xE3, e3, sizeof(e3));
  writeCommandData(0xE4, e4, sizeof(e4));
  writeCommandData(0xE5, e5, sizeof(e5));
  writeCommandData(0xE6, e6, sizeof(e6));
  writeCommandData(0xE7, e7, sizeof(e7));
  writeCommandData(0xE8, e8, sizeof(e8));
  writeCommandData(0xEB, eb, sizeof(eb));
  writeCommandData(0xED, ed, sizeof(ed));
  writeCommandData(0xEF, ef, sizeof(ef));

  const uint8_t ff13[] = {0x77, 0x01, 0x00, 0x00, 0x13};
  const uint8_t ef13[] = {0x08};
  const uint8_t ff00[] = {0x77, 0x01, 0x00, 0x00, 0x00};
  const uint8_t madctl[] = {0x00};
  const uint8_t pixel_format[] = {0x66};
  writeCommandData(0xFF, ff13, sizeof(ff13));
  writeCommandData(0xEF, ef13, sizeof(ef13));
  writeCommandData(0xFF, ff00, sizeof(ff00));
  writeCommandData(0x36, madctl, sizeof(madctl));
  writeCommandData(0x3A, pixel_format, sizeof(pixel_format));
  writeCommand(0x11);
  delay(480);
  writeCommand(0x20);
  delay(120);
  writeCommand(0x29);
  setExpanderPin(board_pins::expander_lcd_cs, true);

  esp_lcd_rgb_panel_config_t config{};
#if ESP_IDF_VERSION_MAJOR >= 5
  config.clk_src = LCD_CLK_SRC_DEFAULT;
#else
  config.clk_src = LCD_CLK_SRC_PLL160M;
#endif
  config.timings.pclk_hz = 16 * 1000 * 1000;
  config.timings.h_res = board_pins::lcd_width;
  config.timings.v_res = board_pins::lcd_height;
  config.timings.hsync_pulse_width = 8;
  config.timings.hsync_back_porch = 10;
  config.timings.hsync_front_porch = 50;
  config.timings.vsync_pulse_width = 3;
  config.timings.vsync_back_porch = 8;
  config.timings.vsync_front_porch = 8;
  config.timings.flags.hsync_idle_low = false;
  config.timings.flags.vsync_idle_low = false;
  config.timings.flags.de_idle_high = false;
  config.timings.flags.pclk_active_neg = false;
  config.timings.flags.pclk_idle_high = false;
  config.data_width = 16;
#if ESP_IDF_VERSION_MAJOR >= 5
  config.bits_per_pixel = 16;
  config.num_fbs = 2;
  config.bounce_buffer_size_px = board_pins::lcd_width * 10;
#endif
  config.psram_trans_align = 64;
  config.hsync_gpio_num = board_pins::rgb_hsync;
  config.vsync_gpio_num = board_pins::rgb_vsync;
  config.de_gpio_num = board_pins::rgb_de;
  config.pclk_gpio_num = board_pins::rgb_pclk;
  config.disp_gpio_num = -1;
  for (size_t index = 0; index < 16; ++index) {
    config.data_gpio_nums[index] = board_pins::rgb_data[index];
  }
  config.flags.fb_in_psram = true;
#if ESP_IDF_VERSION_MAJOR >= 5
  config.flags.double_fb = true;
#endif

  if (!ok(esp_lcd_new_rgb_panel(&config, &panel_), "RGB panel allocation")) return false;
  if (!ok(esp_lcd_panel_reset(panel_), "RGB panel reset")) return false;
  if (!ok(esp_lcd_panel_init(panel_), "RGB panel initialization")) return false;
  return true;
}

bool DisplayDevice::beginTouch() {
  pinMode(board_pins::touch_interrupt, INPUT_PULLUP);
  setExpanderPin(board_pins::expander_touch_reset, false);
  delay(10);
  setExpanderPin(board_pins::expander_touch_reset, true);
  delay(50);

  Wire.beginTransmission(board_pins::touch_address);
  Wire.write(kCst820DisableAutoSleepRegister);
  Wire.write(0xFF);
  if (Wire.endTransmission(true) != 0) {
    Serial.println("CST820 not detected at I2C address 0x15");
    return false;
  }

  uint8_t version = 0;
  uint8_t identity[3] = {0, 0, 0};
  readTouchRegisters(kCst820VersionRegister, &version, 1);
  readTouchRegisters(kCst820ChipIdRegister, identity, sizeof(identity));
  Serial.printf("CST820 version 0x%02X, chip 0x%02X, project 0x%02X, firmware 0x%02X\n",
                version, identity[0], identity[1], identity[2]);
  return true;
}

bool DisplayDevice::readTouchRegisters(uint8_t reg, uint8_t* data, size_t length) {
  Wire.beginTransmission(board_pins::touch_address);
  Wire.write(reg);
  if (Wire.endTransmission(true) != 0) return false;
  const size_t received = Wire.requestFrom(board_pins::touch_address, static_cast<uint8_t>(length));
  if (received != length) return false;
  for (size_t index = 0; index < length; ++index) data[index] = Wire.read();
  return true;
}

bool DisplayDevice::readTouch(uint16_t& x, uint16_t& y) {
  if (!touch_ready_) return false;
  uint8_t data[6] = {0, 0, 0, 0, 0, 0};
  if (!readTouchRegisters(kCst820GestureRegister, data, sizeof(data))) return false;
  if (data[1] == 0) return false;
  x = static_cast<uint16_t>(((data[2] & 0x0F) << 8) | data[3]);
  y = static_cast<uint16_t>(((data[4] & 0x0F) << 8) | data[5]);
  return x < board_pins::lcd_width && y < board_pins::lcd_height;
}

void DisplayDevice::drawBitmap(int x1, int y1, int x2, int y2, const lv_color_t* pixels) {
  if (panel_ == nullptr) return;
  esp_lcd_panel_draw_bitmap(panel_, x1, y1, x2 + 1, y2 + 1, pixels);
}

void DisplayDevice::setBrightness(uint8_t percent) {
  if (percent > 100) percent = 100;
  uint32_t duty = static_cast<uint32_t>(percent) * 1023U / 100U;
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  ledcWrite(board_pins::lcd_backlight, duty);
#else
  ledcWrite(kBacklightChannel, duty);
#endif
}
