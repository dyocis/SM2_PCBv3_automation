#!/usr/bin/env python3
"""Printer-free opt-in UV LED thermistor and safety regression tests.

No actual UV or Peltier outputs are activated. This renders the public
Klipper/Jinja macro branches against representative mocked printer states.
"""

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

JINJA = Environment(
    undefined=StrictUndefined, variable_start_string="{", variable_end_string="}"
)


def printer_state(
    uv_installed=True,
    sensor=True,
    enabled=True,
    led_temp=45,
    uv_active=False,
    cooldown=False,
    fault=False,
    peltier=False,
    peltier_hot=48,
    rpm=9600,
    uv_max=100,
):
    sm = dict(
        uv=int(uv_active),
        uv_thermal_fault=int(fault),
        uv_cooldown_active=int(cooldown),
        uv_thermal_state="FAULT" if fault else "READY",
        uv_led_temp=led_temp if sensor else -1,
        peltier=int(peltier),
        peltier_pending_on=0,
        peltier_cooldown_active=0,
        peltier_thermal_fault=0,
        sgp40_calibration_active=0,
        fault=0,
        fan_ready=1,
        vent_open=0,
        peltier_cooldown_stop_fan=0,
        last_filter_speed=1.0,
        manual_override=0,
        auto_mode=1,
    )
    settings = dict(
        uv_thermal_enabled=int(enabled),
        uv_thermal_min_temp=0,
        uv_thermal_max_temp=uv_max,
        uv_thermal_reset_margin=5,
        uv_cooldown_seconds=60,
        peltier_thermal_enabled=1,
        peltier_hot_min_temp=0,
        peltier_hot_max_temp=70,
        peltier_cold_min_temp=0,
        peltier_cold_max_temp=70,
        pcb_max_temp=70,
        mcu_max_temp=75,
        fan_spinup_seconds=5,
        minimum_safe_rpm=2000,
        peltier_cooldown_seconds=60,
    )
    data = {
        "gcode_macro SM_LED_STATE": sm,
        "gcode_macro SM2_SETTINGS": settings,
        "fan_generic Filter": dict(speed=1.0, rpm=rpm),
        "temperature_sensor _SM_PCB": dict(temperature=35),
        "temperature_sensor _SM_MCU": dict(temperature=39),
        "print_stats": dict(total_duration=120),
    }
    if uv_installed:
        data["output_pin uv"] = {}
    if sensor:
        data["temperature_sensor SM_UV_LEDs"] = dict(temperature=led_temp)
    if peltier:
        data["output_pin peltier"] = {}
        data["temperature_sensor SM_Peltier_Hot_Side"] = dict(temperature=peltier_hot)
        data["temperature_sensor SM_Peltier_Cold_Side"] = dict(temperature=30)
    return data


def rendered(name, printer, **params):
    return JINJA.from_string(MACROS[name]).render(printer=printer, params=params)


class UVThermalTests(unittest.TestCase):
    def test_normal_uv_start_and_disabled_backward_compatibility(self):
        for args in (dict(enabled=True), dict(enabled=False, sensor=False)):
            with self.subTest(args=args):
                output = rendered("NEVERMORE_UV", printer_state(**args), VALUE=1)
                self.assertIn("NEVERMORE_FILTER SPEED=1", output)
                self.assertIn("SET_PIN PIN=uv VALUE=1", output)

    def test_no_uv_hardware_is_a_noop(self):
        output = rendered("NEVERMORE_UV", printer_state(uv_installed=False, sensor=False), VALUE=1)
        self.assertNotIn("SET_PIN PIN=uv VALUE=1", output)

    def test_disabled_monitoring_still_emits_sensor_telemetry(self):
        output = rendered(
            "NEVERMORE_SAFETY_MONITOR",
            printer_state(enabled=False, sensor=True, led_temp=77, uv_active=True),
        )
        self.assertIn("VARIABLE=uv_led_temp VALUE=77", output)
        self.assertIn('"MONITOR ONLY"', output)
        self.assertNotIn("NEVERMORE_UV_THERMAL_TRIP", output)

    def test_invalid_starts_inhibit_without_latching(self):
        cases = (
            dict(sensor=False),
            dict(led_temp=100),
            dict(led_temp=110),
            dict(led_temp=-1),
            dict(uv_max=0),
        )
        for args in cases:
            with self.subTest(args=args):
                output = rendered("NEVERMORE_UV", printer_state(**args), VALUE=1)
                self.assertNotIn("SET_PIN PIN=uv VALUE=1", output)
                self.assertNotIn("NEVERMORE_UV_THERMAL_TRIP", output)
                self.assertIn("UV start inhibited", output)

    def test_active_uv_at_cutoff_trips_uv_only(self):
        for args in (dict(led_temp=100), dict(sensor=False), dict(led_temp=104)):
            with self.subTest(args=args):
                p = printer_state(uv_active=True, peltier=True, **args)
                out = rendered("NEVERMORE_SAFETY_MONITOR", p)
                self.assertIn("NEVERMORE_UV_THERMAL_TRIP", out)
                self.assertNotIn("NEVERMORE_PELTIER_THERMAL_TRIP", out)
                self.assertNotIn("NEVERMORE_EMERGENCY_OFF", out)
                direct = rendered("NEVERMORE_UV", p, VALUE=1, AUTO=1)
                self.assertIn("NEVERMORE_UV_THERMAL_TRIP", direct)

    def test_100_degree_boundary_is_cutoff_not_after_cutoff(self):
        safe = rendered("NEVERMORE_UV", printer_state(led_temp=99.9), VALUE=1)
        cutoff = rendered("NEVERMORE_UV", printer_state(led_temp=100.0), VALUE=1)
        self.assertIn("SET_PIN PIN=uv VALUE=1", safe)
        self.assertNotIn("SET_PIN PIN=uv VALUE=1", cutoff)

    def test_inactive_overheat_never_latches(self):
        out = rendered("NEVERMORE_SAFETY_MONITOR", printer_state(uv_active=False, led_temp=105))
        self.assertIn("VARIABLE=uv_led_temp VALUE=105", out)
        self.assertIn('"THERMAL INHIBIT"', out)
        self.assertNotIn("NEVERMORE_UV_THERMAL_TRIP", out)

    def test_latched_fault_no_automatic_restart(self):
        for on in (False, True):
            with self.subTest(active=on):
                out = rendered("NEVERMORE_UV", printer_state(fault=True, uv_active=on), VALUE=1, AUTO=1)
                self.assertNotIn("SET_PIN PIN=uv VALUE=1", out)

    def test_uv_only_trip_preserves_peltier_and_full_fan(self):
        p = printer_state(uv_active=True, led_temp=100, peltier=True)
        out = rendered("NEVERMORE_UV_THERMAL_TRIP", p, REASON="TEST")
        self.assertIn("SET_PIN PIN=uv VALUE=0", out)
        self.assertIn("VARIABLE=uv_thermal_fault VALUE=1", out)
        self.assertIn("VARIABLE=uv_cooldown_active VALUE=1", out)
        self.assertIn("NEVERMORE_FILTER SPEED=1", out)
        self.assertIn("DURATION=60", out)
        self.assertNotIn("SET_PIN PIN=peltier VALUE=0", out)
        self.assertNotIn("VARIABLE=fault VALUE=1", out)

    def test_normal_uv_stop_has_independent_cooldown(self):
        out = rendered("NEVERMORE_UV", printer_state(uv_active=True), VALUE=0)
        self.assertIn("SET_PIN PIN=uv VALUE=0", out)
        self.assertIn("VARIABLE=uv_cooldown_active VALUE=1", out)
        self.assertIn("DURATION=60", out)
        out = rendered("NEVERMORE_FILTER", printer_state(cooldown=True), SPEED=0)
        self.assertIn("SET_FAN_SPEED FAN=Filter SPEED=1", out)

    def test_cooldown_does_not_force_fan_off(self):
        out = rendered("NEVERMORE_UV_COOLDOWN_COMPLETE", printer_state(cooldown=True))
        self.assertIn("VARIABLE=uv_cooldown_active VALUE=0", out)
        self.assertNotIn("SET_FAN_SPEED", out)
        self.assertNotIn("SET_PIN PIN=peltier", out)

    def test_reset_guarded_by_safe_reading_and_cooldown(self):
        for args in (
            dict(cooldown=True),
            dict(uv_active=True),
            dict(sensor=False),
            dict(led_temp=95.1),
            dict(uv_max=0),
        ):
            with self.subTest(args=args):
                out = rendered("NEVERMORE_UV_THERMAL_RESET", printer_state(fault=True, **args))
                self.assertNotIn("VARIABLE=uv_thermal_fault VALUE=0", out)
        safe = rendered("NEVERMORE_UV_THERMAL_RESET", printer_state(fault=True, led_temp=95))
        self.assertIn("VARIABLE=uv_thermal_fault VALUE=0", safe)

    def test_global_airflow_fault_takes_priority(self):
        p = printer_state(uv_active=True, led_temp=101, rpm=1000)
        out = rendered("NEVERMORE_SAFETY_MONITOR", p)
        self.assertIn("NEVERMORE_EMERGENCY_OFF", out)
        self.assertNotIn("NEVERMORE_UV_THERMAL_TRIP", out)

    def test_both_faults_can_trip_without_global_failure(self):
        p = printer_state(uv_active=True, led_temp=100, peltier=True, peltier_hot=72)
        out = rendered("NEVERMORE_SAFETY_MONITOR", p)
        self.assertIn("NEVERMORE_UV_THERMAL_TRIP", out)
        self.assertIn("NEVERMORE_PELTIER_THERMAL_TRIP", out)
        self.assertNotIn("NEVERMORE_EMERGENCY_OFF", out)


if __name__ == "__main__":
    unittest.main(verbosity=2)
