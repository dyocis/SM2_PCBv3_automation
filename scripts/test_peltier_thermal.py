#!/usr/bin/env python3
"""Printer-free Klipper/Jinja Peltier safety tests."""

import re
import unittest
from pathlib import Path
from jinja2 import Environment, StrictUndefined

SOURCE = (Path(__file__).resolve().parents[1] / "config/SM2_Control.cfg").read_text()
SECTIONS = re.findall(
    r"^\[(?:gcode_macro|delayed_gcode) ([^]]+)\]\s*\n(.*?)(?=^\[|\Z)",
    SOURCE, re.M | re.S,
)
MACROS = {}
for name, body in SECTIONS:
    match = re.search(r"(?m)^gcode:\s*$", body)
    if match:
        MACROS[name] = body[match.end():]
# Klipper gcode_macro uses {expression}, not Jinja's default {{expression}}.
JINJA = Environment(
    undefined=StrictUndefined, variable_start_string="{", variable_end_string="}"
)


def make_printer(installed=True, enabled=True, hot=45, cold=30, active=False,
                 pending=False, cooldown=False, hot_min=0, hot_max=80,
                 cold_min=0, cold_max=80):
    sm = dict(uv=0, peltier=int(active), peltier_pending_on=int(pending),
              peltier_cooldown_active=int(cooldown), peltier_thermal_fault=0,
              fault=0, vent_open=0, vent_pending_open=0, vent_closed_ready=1,
              sgp40_calibration_active=0, fan_ready=1)
    settings = dict(peltier_thermal_enabled=int(enabled),
                    peltier_hot_min_temp=hot_min, peltier_hot_max_temp=hot_max,
                    peltier_cold_min_temp=cold_min, peltier_cold_max_temp=cold_max,
                    fan_spinup_seconds=5, peltier_cooldown_seconds=60,
                    minimum_safe_rpm=2000, pcb_max_temp=70, mcu_max_temp=75)
    result = {
        "gcode_macro SM_LED_STATE": sm, "gcode_macro SM2_SETTINGS": settings,
        "output_pin peltier": {}, "servo SM_Vent": {},
        "fan_generic Filter": dict(speed=1.0, rpm=9600),
        "temperature_sensor _SM_PCB": dict(temperature=35),
        "temperature_sensor _SM_MCU": dict(temperature=40),
    }
    if installed:
        result["temperature_sensor SM_Peltier_Hot_Side"] = dict(temperature=hot)
        result["temperature_sensor SM_Peltier_Cold_Side"] = dict(temperature=cold)
    return result


def rendered(name, printer, **params):
    return JINJA.from_string(MACROS[name]).render(printer=printer, params=params)


class PeltierTests(unittest.TestCase):
    def test_good_immediate_and_delayed_start(self):
        self.assertIn("SET_PIN PIN=peltier VALUE=1",
                      rendered("NEVERMORE_PELTIER", make_printer(), VALUE=1))
        self.assertIn("SET_PIN PIN=peltier VALUE=1",
                      rendered("NEVERMORE_PELTIER_ENABLE", make_printer(pending=True)))

    def test_bad_starts_never_energize_or_latch(self):
        cases = [dict(hot=81), dict(cold=81), dict(hot=-1),
                 dict(installed=False), dict(hot_min=90, hot_max=80)]
        for args in cases:
            for name, extra in (("NEVERMORE_PELTIER", dict(VALUE=1)),
                                ("NEVERMORE_PELTIER_ENABLE", {})):
                with self.subTest(case=args, macro=name):
                    p = make_printer(pending=True, **args)
                    output = rendered(name, p, **extra)
                    self.assertNotIn("SET_PIN PIN=peltier VALUE=1", output)
                    self.assertIn("THERMAL INHIBIT", output)
                    self.assertNotIn("NEVERMORE_PELTIER_THERMAL_TRIP", output)

    def test_active_overlimit_routes_to_peltier_trip(self):
        output = rendered("NEVERMORE_SAFETY_MONITOR",
                          make_printer(active=True, hot=81))
        self.assertIn("NEVERMORE_PELTIER_THERMAL_TRIP", output)
        self.assertNotIn("NEVERMORE_EMERGENCY_OFF", output)
        output = rendered("NEVERMORE_PELTIER",
                          make_printer(active=True, hot=81), VALUE=1)
        self.assertIn("NEVERMORE_PELTIER_THERMAL_TRIP", output)

    def test_idle_hot_chamber_does_not_trip(self):
        output = rendered("NEVERMORE_SAFETY_MONITOR",
                          make_printer(active=False, hot=99))
        self.assertNotIn("NEVERMORE_PELTIER_THERMAL_TRIP", output)
        self.assertIn("VARIABLE=peltier_hot_temp VALUE=99", output)

    def test_enabled_missing_sensor_blocks_only_peltier(self):
        output = rendered("NEVERMORE_SAFETY_MONITOR",
                          make_printer(installed=False, active=True))
        self.assertIn("NEVERMORE_PELTIER_THERMAL_TRIP", output)
        self.assertNotIn("NEVERMORE_EMERGENCY_OFF", output)

    def test_disabled_protection_preserves_old_start(self):
        output = rendered("NEVERMORE_PELTIER",
                          make_printer(installed=False, enabled=False), VALUE=1)
        self.assertIn("SET_PIN PIN=peltier VALUE=1", output)

    def test_latched_thermal_fault_cannot_be_masked_by_auto_start(self):
        for name in ("NEVERMORE_PELTIER", "NEVERMORE_PELTIER_ENABLE"):
            with self.subTest(macro=name):
                p = make_printer(pending=True, hot=81)
                p["gcode_macro SM_LED_STATE"]["peltier_thermal_fault"] = 1
                params = dict(VALUE=1, AUTO=1) if name == "NEVERMORE_PELTIER" else {}
                output = rendered(name, p, **params)
                self.assertNotIn("SET_PIN PIN=peltier VALUE=1", output)
                self.assertIn('VARIABLE=peltier_interlock_state VALUE=\'"THERMAL FAULT"\'', output)
                self.assertNotIn("THERMAL INHIBIT", output)

    def test_active_trip_isolated_and_cooled(self):
        output = rendered("NEVERMORE_PELTIER_THERMAL_TRIP",
                          make_printer(active=True), REASON="TEST")
        for expected in ("SET_PIN PIN=peltier VALUE=0",
                         "VARIABLE=peltier_thermal_fault VALUE=1",
                         "NEVERMORE_FILTER SPEED=1",
                         "DURATION=60"):
            self.assertIn(expected, output)
        self.assertNotIn("VARIABLE=fault VALUE=1", output)

    def test_reset_blocked_until_cooldown_complete(self):
        result = rendered("NEVERMORE_PELTIER_THERMAL_RESET",
                          make_printer(cooldown=True))
        self.assertNotIn("VARIABLE=peltier_thermal_fault VALUE=0", result)
        result = rendered("NEVERMORE_PELTIER_THERMAL_RESET", make_printer())
        self.assertIn("VARIABLE=peltier_thermal_fault VALUE=0", result)


if __name__ == "__main__":
    unittest.main(verbosity=2)
