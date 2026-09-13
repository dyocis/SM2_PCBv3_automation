# Nevermore Round Display Firmware

Firmware prototype for a dedicated 2.1-inch Nevermore StealthMax v2 status
display.

## Hardware target

- Waveshare ESP32-S3-Touch-LCD-2.1B, SKU 30697
- 480 x 480 round ST7701S IPS display on a 16-bit RGB bus
- CST820 capacitive touch controller
- TCA9554 I/O expander for LCD reset, touch reset, and LCD chip select
- ESP32-S3 with 16 MB flash and 8 MB PSRAM

The LCD, touch controller, backlight, and ESP32-S3 are integrated on the board.
No external display wiring or separate development board is required.

## Milestone 0.2.0

- Uses Waveshare's documented ST7701S initialization sequence, RGB timings,
  GPIO map, TCA9554 routing, and CST820 address.
- Initializes the 480 x 480 display and registers touch as an LVGL input.
- Presents a rescaled Nevermore instrument screen with a state-colored outer
  ring, VOC, efficiency, fan, RPM, temperature, and system state.
- Starts safely in simulated-data mode when no private configuration exists.
- Cycles through idle, print filtration, chamber cooling, purge, SGP40
  calibration, and VOC emergency states.
- Connects directly to Moonraker over WebSocket in live mode.
- Keeps all Nevermore control and safety logic in Klipper.

The first screen is status-only. Touch is initialized now so later milestones
can add page navigation and guarded controls without changing the hardware
driver.

The hardware mappings and panel command sequence were adapted from Waveshare's
[ESP32-S3-Touch-LCD-2.1 documentation](https://docs.waveshare.com/ESP32-S3-Touch-LCD-2.1)
and its LVGL Arduino example. This build currently uses PlatformIO's
ESP32 Arduino 2.x/ESP-IDF 4.x framework; Waveshare's newer sample uses Arduino
3.x/ESP-IDF 5.x. The 2.x RGB fallback compiles, but frame timing, color order,
touch orientation, and runtime stability still require the physical board test.

## Build

Install PlatformIO, open this directory as a PlatformIO project, and build the
default environment:

```bash
pio run -e waveshare_s3_touch_lcd_2_1b
```

The default build requires no credentials and runs the simulated state
sequence. With the board connected by USB, upload from PlatformIO or run:

```bash
pio run -e waveshare_s3_touch_lcd_2_1b -t upload
pio device monitor -b 115200
```

Select the detected USB port explicitly in PlatformIO if more than one board
is connected. This project has not yet been flashed to a physical 2.1B board.

## Enable live Moonraker mode

Copy `include/user_config.example.h` to `include/user_config.h`, then edit the
private copy:

```cpp
#define NEVERMORE_DEMO_MODE false
#define NEVERMORE_WIFI_SSID "your-network"
#define NEVERMORE_WIFI_PASSWORD "your-password"
#define NEVERMORE_MOONRAKER_HOST "voron3.local"
```

`include/user_config.h` is ignored by Git. Do not place real credentials in the
example file.

Live mode subscribes to:

```text
gcode_macro SM_LED_STATE
fan_generic Filter
temperature_sensor BME_IN
temperature_sensor BME_OUT
temperature_sensor SGP_IN
temperature_sensor SGP_OUT
print_stats
webhooks
```

The client initializes the internal model from
`printer.objects.subscribe`, then merges Moonraker's differential
`notify_status_update` messages into that model.

## First hardware bring-up

1. Connect the Waveshare board by USB only.
2. Build and upload the default demo firmware.
3. Confirm the serial report shows 16 MB flash and 8 MB PSRAM.
4. Confirm the screen cycles through the simulated Nevermore states.
5. Check the serial log for CST820 identity at boot. If touch is not detected,
   the status screen continues, but the controller will need diagnosis before
   touch navigation is enabled. The first milestone has no touch controls yet.
6. Check orientation, color order, and backlight level.
7. Only after the local demo is stable, add a private `user_config.h` and test
   Wi-Fi/Moonraker live mode.

## Safety boundary

This display is a network user interface and observer. It never controls the
Nevermore PCB pins. Future touch controls will invoke existing Klipper macros
through Moonraker, so airflow verification, tachometer checks, cooldown,
maintenance lock, and all other safety interlocks remain authoritative in
Klipper.
