#!/usr/bin/env python3
"""Fast structural checks for the first firmware milestone."""

from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]

EXPECTED_OBJECTS = {
    "gcode_macro SM_LED_STATE",
    "fan_generic Filter",
    "temperature_sensor BME_IN",
    "temperature_sensor BME_OUT",
    "temperature_sensor SGP_IN",
    "temperature_sensor SGP_OUT",
    "print_stats",
    "webhooks",
}


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def main() -> int:
    source = (ROOT / "src" / "moonraker_client.cpp").read_text(encoding="utf-8")
    subscribed = set(re.findall(r'objects(?:\.createNestedArray)?\("([^"]+)"\)', source))
    # The macro object is assigned with operator[] rather than createNestedArray.
    subscribed.update(re.findall(r'objects\["([^"]+)"\]', source))
    require(subscribed == EXPECTED_OBJECTS,
            f"subscription mismatch: expected {sorted(EXPECTED_OBJECTS)}, got {sorted(subscribed)}")

    config = (ROOT / "include" / "app_config.h").read_text(encoding="utf-8")
    require("#define NEVERMORE_DEMO_MODE true" in config,
            "firmware must default to non-networked demo mode")
    require('NEVERMORE_WIFI_PASSWORD ""' in config,
            "default configuration must not contain credentials")

    pins = (ROOT / "include" / "board_pins.h").read_text(encoding="utf-8")
    require("lcd_width = 480" in pins and "lcd_height = 480" in pins,
            "display must target the Waveshare 480 x 480 panel")
    require("touch_address = 0x15" in pins,
            "CST820 must use the Waveshare-documented I2C address")
    require("tca9554_address = 0x20" in pins,
            "TCA9554 must use the Waveshare-documented I2C address")
    require("38" in pins and "39" in pins and "40" in pins and "41" in pins,
            "RGB timing pins are missing from the board definition")

    display = (ROOT / "src" / "display_device.cpp").read_text(encoding="utf-8")
    require("esp_lcd_new_rgb_panel" in display,
            "ST7701S must be driven through the ESP32-S3 RGB peripheral")
    require("beginTouch" in display and "CST820" in display,
            "integrated CST820 touch driver is missing")

    platform = (ROOT / "platformio.ini").read_text(encoding="utf-8")
    require("waveshare_s3_touch_lcd_2_1b" in platform,
            "PlatformIO environment does not identify the 2.1B target")

    # Split sentinel strings so this validator does not match its own source.
    forbidden = ["YOUR_REAL_" + "PASSWORD"]
    all_text = "\n".join(
        path.read_text(encoding="utf-8", errors="ignore")
        for path in ROOT.rglob("*")
        if path.is_file() and ".pio" not in path.parts
    )
    for token in forbidden:
        require(token not in all_text, f"forbidden token present: {token}")

    print("PASS: Nevermore firmware project structure and data contract")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except AssertionError as error:
        print(f"FAIL: {error}", file=sys.stderr)
        raise SystemExit(1)
