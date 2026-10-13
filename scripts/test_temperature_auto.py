#!/usr/bin/env python3
"""Software-only tests for temperature-driven Nevermore Peltier automation."""

from __future__ import annotations

import re
import unittest
from pathlib import Path

from test_peltier_thermal import JINJA, MACROS as CONTROL, make_printer


ROOT = Path(__file__).resolve().parents[1]
AUTOMATION_SOURCE = (ROOT / "config/SM2_Automation.cfg").read_text(encoding="utf-8")
SECTIONS = re.findall(
    r"^\[(?:gcode_macro|delayed_gcode) ([^]]+)\]\s*\n(.*?)(?=^\[|\Z)",
    AUTOMATION_SOURCE, re.M | re.S,
)
AUTOMATION = {}
for name, body in SECTIONS:
    match = re.search(r"(?m)^gcode:\s*$", body)
    if match:
        AUTOMATION[name] = body[match.end():]


def build(
    temp=47.0, voc=8.0, auto_enabled=1, thermal_enabled=1,
    demand=0, active=0, pending=0, cooldown=0, installed=True,
    print_active=1, chamber_target=55.0, chamber_latched=0,
    auto_mode=1, manual_override=0, purge_active=0, fault=0,
):
    p = make_printer(
        installed=installed, enabled=bool(thermal_enabled),
        active=bool(active), pending=bool(pending), cooldown=bool(cooldown)
    )
    sm = p["gcode_macro SM_LED_STATE"]
    sm.update({
        "auto_mode": auto_mode, "manual_override": manual_override,
        "purge_active": purge_active, "fault": fault,
        "print_active": print_active, "peltier_auto_demand": demand,
        "peltier_auto_state": "STANDBY", "auto_reason": "PRINT FILTRATION",
        "chamber_target": chamber_target, "chamber_hysteresis": 5,
        "chamber_cooling_latched": chamber_latched, "voc_state": 0,
        "voc_warning": 120, "voc_high": 220, "voc_emergency": 400,
        "voc_idle_hysteresis": 20, "print_filter": 1,
        "last_filter_speed": 1, "fan_ready": 1, "transition_count": 0,
    })
    p["gcode_macro SM2_SETTINGS"].update({
        "peltier_auto_enabled": auto_enabled,
        "peltier_auto_on_temp": 45,
        "peltier_auto_off_temp": 40,
    })
    p["temperature_sensor BME_IN"] = {"temperature": temp}
    p["temperature_sensor SGP_IN"] = {"temperature": voc}
    p["print_stats"] = {"total_duration": 1000, "state": "printing"}
    return p


def render(name: str, printer: dict, **params: object) -> str:
    source = AUTOMATION.get(name, CONTROL.get(name))
    if source is None:
        raise KeyError(name)
    return JINJA.from_string(source).render(printer=printer, params=params)


class PeltierAutoTests(unittest.TestCase):
    def test_automation_routes_voc_emergency_to_vent_not_peltier(self):
        normal = render("NEVERMORE_AUTO_CONTROL", build(temp=47, voc=10))
        self.assertIn("NEVERMORE_AUTO_PELTIER ALLOW=1", normal)
        self.assertNotIn("NEVERMORE_PELTIER VALUE=1", normal)
        emergency = render("NEVERMORE_AUTO_CONTROL", build(temp=47, voc=480))
        self.assertIn("NEVERMORE_FILTER SPEED=1", emergency)
        self.assertIn("NEVERMORE_UV VALUE=1 AUTO=1", emergency)
        self.assertIn("VENT_OPEN AUTO=1", emergency)
        self.assertIn("NEVERMORE_AUTO_PELTIER ALLOW=0", emergency)
        self.assertNotIn("NEVERMORE_PELTIER VALUE=1", emergency)

    def test_on_threshold_is_independent_of_normal_voc_bands(self):
        # No VOC index is read by the cooler macro.
        for voc in (5, 150, 290):
            with self.subTest(voc=voc):
                output = render("NEVERMORE_AUTO_PELTIER", build(voc=voc), ALLOW=1)
                self.assertIn("VARIABLE=peltier_auto_demand VALUE=1", output)
                self.assertIn("NEVERMORE_PELTIER VALUE=1 AUTO=1", output)

    def test_hysteresis_avoids_repeated_chatter(self):
        for temp, old_demand, expected in (
            (39.9, 0, 0), (40, 1, 0), (40.1, 1, 1),
            (44.9, 1, 1), (44.9, 0, 0), (45, 0, 1),
        ):
            with self.subTest(temp=temp, old_demand=old_demand):
                out = render("NEVERMORE_AUTO_PELTIER",
                             build(temp=temp, demand=old_demand), ALLOW=1)
                self.assertIn(f"VARIABLE=peltier_auto_demand VALUE={expected}", out)

    def test_disable_or_unsafe_config_never_requests_cooling(self):
        variants = [
            {"auto_enabled": 0},
            {"thermal_enabled": 0},
            {"installed": False},
            {"auto_mode": 0},
            {"manual_override": 1},
            {"purge_active": 1},
            {"fault": 1},
            {"chamber_latched": 1},
        ]
        for changes in variants:
            with self.subTest(changes=changes):
                output = render("NEVERMORE_AUTO_PELTIER", build(**changes), ALLOW=1)
                self.assertNotIn("NEVERMORE_PELTIER VALUE=1 AUTO=1", output)

    def test_temperature_safety_and_settings_must_be_valid(self):
        p = build()
        p["gcode_macro SM2_SETTINGS"]["peltier_auto_off_temp"] = 47
        self.assertIn("INVALID LIMITS", render("NEVERMORE_AUTO_PELTIER", p))
        p = build()
        p["temperature_sensor SM_Peltier_Hot_Side"]["temperature"] = 99
        self.assertIn("THERMAL INHIBIT", render("NEVERMORE_AUTO_PELTIER", p))
        p = build()
        p["gcode_macro SM_LED_STATE"]["peltier_thermal_fault"] = 1
        self.assertIn("THERMAL FAULT", render("NEVERMORE_AUTO_PELTIER", p))
        self.assertNotIn("NEVERMORE_PELTIER VALUE=1", render("NEVERMORE_AUTO_PELTIER", p))

    def test_chamber_vent_and_voc_emergency_take_priority(self):
        auto = render("NEVERMORE_AUTO_CONTROL", build(temp=57, voc=7))
        self.assertIn("VENT_OPEN AUTO=1", auto)
        self.assertIn("NEVERMORE_AUTO_PELTIER ALLOW=0", auto)
        request = render("NEVERMORE_AUTO_PELTIER", build(temp=47), ALLOW=0)
        self.assertIn("VENT PRIORITY", request)
        self.assertNotIn("NEVERMORE_PELTIER VALUE=1", request)

    def test_cooling_stop_does_not_stop_filtration(self):
        output = render("NEVERMORE_AUTO_PELTIER",
                        build(temp=37, demand=1, active=1), ALLOW=1)
        self.assertIn("NEVERMORE_PELTIER VALUE=0 AUTO=1", output)
        self.assertNotIn("NEVERMORE_OFF", output)
        off = render("NEVERMORE_PELTIER", build(active=1), VALUE=0, AUTO=1)
        self.assertIn("SET_PIN PIN=peltier VALUE=0", off)
        self.assertIn("VARIABLE=peltier_cooldown_active VALUE=1", off)
        self.assertIn("NEVERMORE_FILTER SPEED=1", off)
        self.assertIn("DURATION=60", off)
        self.assertNotIn("NEVERMORE_UV VALUE=0", off)

    def test_fan_speed_cannot_drop_while_peltier_needs_airflow(self):
        for change in ({"active": 1}, {"pending": 1}, {"cooldown": 1}):
            with self.subTest(change=change):
                out = render("NEVERMORE_FILTER", build(**change), SPEED=0)
                self.assertIn("SET_FAN_SPEED FAN=Filter SPEED=1.0", out)
        out = render("NEVERMORE_FILTER", build(active=0, pending=0, cooldown=0), SPEED=0)
        self.assertIn("SET_FAN_SPEED FAN=Filter SPEED=0.0", out)

    def test_manual_mode_does_not_shutdown_manually_commanded_peltier(self):
        out = render("NEVERMORE_AUTO_PELTIER",
                     build(auto_mode=0, active=1), ALLOW=1)
        self.assertNotIn("NEVERMORE_PELTIER VALUE=0 AUTO=1", out)


if __name__ == "__main__":
    unittest.main(verbosity=2)
