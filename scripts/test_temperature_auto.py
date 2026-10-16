#!/usr/bin/env python3
"""Software-only tests for temperature-driven Nevermore Peltier automation."""

from __future__ import annotations

import re
import unittest
from pathlib import Path

from test_peltier_thermal import JINJA, MACROS as CONTROL, make_printer


ROOT = Path(__file__).resolve().parents[1]
AUTOMATION_SOURCE = (ROOT / "config/SM2_Automation.cfg").read_text(encoding="utf-8")
HARDWARE_SOURCE = (ROOT / "config/SM2_Hardware_Control.cfg").read_text(encoding="utf-8")
SECTIONS = re.findall(
    r"^\[(?:gcode_macro|delayed_gcode) ([^]]+)\]\s*\n(.*?)(?=^\[|\Z)",
    AUTOMATION_SOURCE, re.M | re.S,
)
AUTOMATION = {}
for name, body in SECTIONS:
    match = re.search(r"(?m)^gcode:\s*$", body)
    if match:
        AUTOMATION[name] = body[match.end():]

# Test the actual vent-close macro, not a mock of the startup behavior.
for name, body in re.findall(
    r"^\[(?:gcode_macro|delayed_gcode) ([^]]+)\]\s*\n(.*?)(?=^\[|\Z)",
    HARDWARE_SOURCE, re.M | re.S
):
    match = re.search(r"(?m)^gcode:\s*$", body)
    if match:
        AUTOMATION[name] = body[match.end():]


def build(
    temp=47.0, voc=8.0, auto_enabled=1, thermal_enabled=1,
    demand=0, active=0, pending=0, cooldown=0, installed=True,
    print_active=1, chamber_target=55.0, chamber_latched=0,
    auto_mode=1, manual_override=0, purge_active=0, fault=0,
    post_vent_active=0, post_vent_target=35, post_vent_minutes=60,
):
    p = make_printer(
        installed=installed, enabled=bool(thermal_enabled),
        active=bool(active), pending=bool(pending), cooldown=bool(cooldown)
    )
    sm = p["gcode_macro SM_LED_STATE"]
    sm.update({
        "auto_mode": auto_mode, "manual_override": manual_override,
        "purge_active": purge_active, "fault": fault,
        "post_print_vent_active": post_vent_active,
        "post_print_vent_target_temp": post_vent_target,
        "post_print_vent_max_minutes": post_vent_minutes,
        "post_print_vent_window_target": post_vent_target,
        "sgp40_calibration_reset_applied": 0,
        "sgp40_calibration_phase": "IDLE",
        "sgp40_calibration_hold": 0,
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
        "post_print_vent_target_temp": post_vent_target,
        "post_print_vent_max_minutes": post_vent_minutes,
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
    def test_voc_emergency_preserves_treatment_without_automatic_exhaust(self):
        normal = render("NEVERMORE_AUTO_CONTROL", build(temp=47, voc=10))
        self.assertIn("NEVERMORE_AUTO_PELTIER ALLOW=1", normal)
        self.assertNotIn("NEVERMORE_PELTIER VALUE=1", normal)
        emergency = render("NEVERMORE_AUTO_CONTROL", build(temp=47, voc=480))
        self.assertIn("NEVERMORE_FILTER SPEED=1", emergency)
        self.assertIn("NEVERMORE_UV VALUE=1 AUTO=1", emergency)
        self.assertIn("VENT_CLOSE AUTO=1", emergency)
        self.assertNotIn("VENT_OPEN AUTO=1", emergency)
        self.assertIn("NEVERMORE_AUTO_PELTIER ALLOW=0", emergency)
        self.assertNotIn("NEVERMORE_PELTIER VALUE=1", emergency)

    def test_vent_opens_only_for_print_chamber_temperature_not_vocs(self):
        for voc in (8, 150, 290, 480):
            with self.subTest(voc=voc, temp=47):
                output = render("NEVERMORE_AUTO_CONTROL", build(temp=47, voc=voc))
                self.assertIn("VENT_CLOSE AUTO=1", output)
                self.assertNotIn("VENT_OPEN AUTO=1", output)
            with self.subTest(voc=voc, temp=60):
                output = render("NEVERMORE_AUTO_CONTROL", build(temp=60, voc=voc))
                self.assertIn("VENT_OPEN AUTO=1", output)
                self.assertNotIn("VENT_CLOSE AUTO=1", output)

        # After post-print cooling is finished or timed out, ordinary
        # filtration must never reopen the vent merely because it is hot.
        for voc in (8, 150, 290, 480):
            with self.subTest(voc=voc, after_print=True):
                output = render("NEVERMORE_AUTO_CONTROL",
                                build(temp=65, voc=voc, print_active=0))
                self.assertIn("VENT_CLOSE AUTO=1", output)
                self.assertNotIn("VENT_OPEN AUTO=1", output)

    def test_high_voc_uses_guarded_uv_during_print_not_exhaust(self):
        for voc in (240, 480):
            with self.subTest(voc=voc):
                output = render("NEVERMORE_AUTO_CONTROL", build(temp=47, voc=voc))
                self.assertIn("NEVERMORE_FILTER SPEED=1", output)
                self.assertIn("NEVERMORE_UV VALUE=1 AUTO=1", output)
                self.assertIn("VENT_CLOSE AUTO=1", output)
        low = render("NEVERMORE_AUTO_CONTROL", build(temp=47, voc=10))
        self.assertIn("NEVERMORE_UV VALUE=0 AUTO=1", low)

        # The temperature target may still demand exhaust regardless of UV.
        hot = render("NEVERMORE_AUTO_CONTROL", build(temp=60, voc=290))
        self.assertIn("NEVERMORE_UV VALUE=1 AUTO=1", hot)
        self.assertIn("VENT_OPEN AUTO=1", hot)

    def test_chamber_hysteresis_and_material_target_apply_in_voc_emergency(self):
        for temp, latched, expected_open in (
            (59.9, 0, False), (60.0, 0, True),
            (58.0, 1, True), (55.1, 1, True), (55.0, 1, False),
        ):
            with self.subTest(temp=temp, latched=latched):
                output = render("NEVERMORE_AUTO_CONTROL",
                                build(temp=temp, voc=480,
                                      chamber_target=60.0, chamber_latched=latched))
                self.assertIn("VENT_OPEN AUTO=1" if expected_open else "VENT_CLOSE AUTO=1", output)
                self.assertNotIn("VENT_CLOSE AUTO=1" if expected_open else "VENT_OPEN AUTO=1", output)

    def test_post_print_vent_starts_above_target_with_independent_timer(self):
        start = render("NEVERMORE_PRINT_END", build(temp=48, voc=10))
        self.assertIn("VARIABLE=purge_active VALUE=1", start)
        self.assertIn("NEVERMORE_POST_PRINT_VENT_START", start)
        self.assertNotIn("VENT_OPEN AUTO=1", start)

        for voc in (0, 140, 290, 480):
            with self.subTest(voc=voc):
                window = render("NEVERMORE_POST_PRINT_VENT_START",
                                build(temp=48, voc=voc))
                self.assertIn("VARIABLE=post_print_vent_active VALUE=1", window)
                self.assertIn("VENT_OPEN AUTO=1", window)
                self.assertIn("ID=NEVERMORE_POST_PRINT_VENT_TIMEOUT DURATION=3600.0", window)

    def test_post_print_vent_does_not_open_when_cooled_or_disabled(self):
        for changes in (
            {"temp": 35},
            {"temp": 32},
            {"post_vent_minutes": 0},
            {"post_vent_minutes": -3},
            {"post_vent_minutes": 500},
            {"post_vent_target": 150},
        ):
            with self.subTest(changes=changes):
                output = render("NEVERMORE_POST_PRINT_VENT_START", build(voc=490, **changes))
                self.assertNotIn("VENT_OPEN AUTO=1", output)
                self.assertIn("VENT_CLOSE AUTO=1", output)
                self.assertIn("VARIABLE=post_print_vent_active VALUE=0", output)

    def test_post_print_timeout_closes_vent_independent_of_voc(self):
        for voc in (0, 140, 290, 480):
            with self.subTest(voc=voc):
                output = render("NEVERMORE_POST_PRINT_VENT_TIMEOUT",
                                build(temp=48, voc=voc, print_active=0,
                                      purge_active=1, post_vent_active=1))
                self.assertIn("VARIABLE=post_print_vent_active VALUE=0", output)
                self.assertIn("VENT_CLOSE AUTO=1", output)
                self.assertNotIn("NEVERMORE_OFF", output)

    def test_post_print_purge_treats_voc_without_controlling_vent(self):
        # Temperature alone decides whether an active window stays open.
        for voc in (0, 140, 290, 480):
            with self.subTest(voc=voc, vent_window=True):
                purge = render("NEVERMORE_PURGE_CONTROL",
                               build(temp=48, voc=voc, purge_active=1,
                                     print_active=0, post_vent_active=1))
                self.assertIn("VENT_OPEN AUTO=1", purge)
                self.assertNotIn("VENT_CLOSE AUTO=1", purge)
                self.assertIn("NEVERMORE_FILTER SPEED=1", purge)
                self.assertNotIn("VARIABLE=purge_active VALUE=0", purge)

            with self.subTest(voc=voc, vent_window=False):
                purge = render("NEVERMORE_PURGE_CONTROL",
                               build(temp=48, voc=voc, purge_active=1,
                                     print_active=0, post_vent_active=0))
                self.assertIn("VENT_CLOSE AUTO=1", purge)
                self.assertNotIn("VENT_OPEN AUTO=1", purge)
                if voc >= 220:
                    self.assertIn("NEVERMORE_UV VALUE=1 AUTO=1", purge)
                    self.assertIn("NEVERMORE_FILTER SPEED=1", purge)

    def test_post_print_temperature_recovery_ends_vent_before_timeout(self):
        for voc in (0, 140, 290, 480):
            with self.subTest(voc=voc):
                output = render("NEVERMORE_PURGE_CONTROL",
                                build(temp=35, voc=voc, purge_active=1,
                                      print_active=0, post_vent_active=1))
                self.assertIn("VARIABLE=post_print_vent_active VALUE=0", output)
                self.assertIn("ID=NEVERMORE_POST_PRINT_VENT_TIMEOUT DURATION=0", output)
                self.assertIn("VENT_CLOSE AUTO=1", output)
                self.assertNotIn("VENT_OPEN AUTO=1", output)

        done = render("NEVERMORE_PURGE_CONTROL",
                      build(temp=34, voc=0, purge_active=1,
                            print_active=0, post_vent_active=0))
        self.assertIn("NEVERMORE_OFF", done)
        self.assertIn("VARIABLE=purge_active VALUE=0", done)

    def test_config_macro_updates_runtime_without_activating_exhaust(self):
        printer = build()
        result = render("NEVERMORE_POST_PRINT_VENT_SETTINGS", printer,
                        TARGET="38.5", MAX_MINUTES="90")
        self.assertIn("VARIABLE=post_print_vent_target_temp VALUE=38.5", result)
        self.assertIn("VARIABLE=post_print_vent_max_minutes VALUE=90.0", result)
        self.assertNotIn("SAVE_VARIABLE", result)
        self.assertIn("Add [save_variables]", result)
        self.assertNotIn("VENT_OPEN", result)
        self.assertNotIn("UPDATE_DELAYED_GCODE ID=NEVERMORE_POST_PRINT_VENT_TIMEOUT", result)

        # Omitting one or both parameters leaves the existing values alone.
        target_only = render("NEVERMORE_POST_PRINT_VENT_SETTINGS", printer, TARGET="40")
        self.assertIn("VARIABLE=post_print_vent_max_minutes VALUE=60.0", target_only)
        unchanged = render("NEVERMORE_POST_PRINT_VENT_SETTINGS", printer)
        self.assertIn("VARIABLE=post_print_vent_target_temp VALUE=35.0", unchanged)

    def test_config_macro_persists_overrides_when_save_variables_is_installed(self):
        printer = build()
        printer["save_variables"] = {"variables": {}}
        result = render("NEVERMORE_POST_PRINT_VENT_SETTINGS", printer,
                        TARGET="36", MAX_MINUTES="75")
        self.assertIn("SAVE_VARIABLE VARIABLE=nm_post_print_vent_target_temp VALUE=36.0", result)
        self.assertIn("SAVE_VARIABLE VARIABLE=nm_post_print_vent_max_minutes VALUE=75.0", result)
        self.assertIn("Applies to next post-print cycle", result)

    def test_config_macro_rejects_bad_values_without_side_effects(self):
        for target, minutes in (("19", "60"), ("81", "60"), ("35", "-1"),
                                ("35", "241"), ("none", "60"), ("35", "bad"),
                                ("nan", "30"), ("35", "inf")):
            with self.subTest(target=target, minutes=minutes):
                result = render("NEVERMORE_POST_PRINT_VENT_SETTINGS",
                                build(), TARGET=target, MAX_MINUTES=minutes)
                self.assertIn("Post-print vent settings rejected", result)
                self.assertNotIn("SET_GCODE_VARIABLE MACRO=SM_LED_STATE VARIABLE=post_print_vent_target_temp", result)
                self.assertNotIn("SAVE_VARIABLE", result)
        zero = render("NEVERMORE_POST_PRINT_VENT_SETTINGS", build(),
                      TARGET="35", MAX_MINUTES="0")
        self.assertIn("VALUE=0.0", zero)

    def test_saved_override_loading_and_safe_fallback(self):
        printer = build()
        printer["gcode_macro SM2_SETTINGS"].update({
            "post_print_vent_target_temp": 37.5,
            "post_print_vent_max_minutes": 80,
        })
        result = render("NEVERMORE_POST_PRINT_VENT_LOAD_SETTINGS", printer)
        self.assertIn("VARIABLE=post_print_vent_target_temp VALUE=37.5", result)
        self.assertIn("VARIABLE=post_print_vent_max_minutes VALUE=80.0", result)

        printer["save_variables"] = {"variables": {
            "nm_post_print_vent_target_temp": 41,
            "nm_post_print_vent_max_minutes": 105,
        }}
        loaded = render("NEVERMORE_POST_PRINT_VENT_LOAD_SETTINGS", printer)
        self.assertIn("VARIABLE=post_print_vent_target_temp VALUE=41.0", loaded)
        self.assertIn("VARIABLE=post_print_vent_max_minutes VALUE=105.0", loaded)

        printer["save_variables"]["variables"]["nm_post_print_vent_target_temp"] = 500
        printer["save_variables"]["variables"]["nm_post_print_vent_max_minutes"] = -9
        recovered = render("NEVERMORE_POST_PRINT_VENT_LOAD_SETTINGS", printer)
        self.assertIn("VARIABLE=post_print_vent_target_temp VALUE=37.5", recovered)
        self.assertIn("VARIABLE=post_print_vent_max_minutes VALUE=80.0", recovered)

    def test_window_uses_snapshot_of_target_not_midcycle_changes(self):
        printer = build(temp=44, post_vent_target=35, post_vent_minutes=30,
                        print_active=0, purge_active=1, post_vent_active=1)
        started = render("NEVERMORE_POST_PRINT_VENT_START", printer)
        self.assertIn("VARIABLE=post_print_vent_window_target VALUE=35.0", started)
        printer["gcode_macro SM_LED_STATE"]["post_print_vent_target_temp"] = 55
        purge = render("NEVERMORE_PURGE_CONTROL", printer)
        self.assertIn("VENT_OPEN AUTO=1", purge)
        self.assertNotIn("VARIABLE=post_print_vent_active VALUE=0", purge)

    def test_new_print_or_manual_handover_cancels_old_timeout(self):
        for name in ("NEVERMORE_PRINT_START", "NEVERMORE_MANUAL", "NEVERMORE_AUTO_ENABLE", "NEVERMORE_AUTO_DISABLE"):
            with self.subTest(macro=name):
                output = render(name, build(temp=48, voc=0, purge_active=1,
                                            post_vent_active=1))
                self.assertIn("ID=NEVERMORE_POST_PRINT_VENT_TIMEOUT DURATION=0", output)
                self.assertIn("VARIABLE=post_print_vent_active VALUE=0", output)

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

    def test_cooling_can_start_when_idle_and_voc_clear(self):
        # Opt-in is explicitly independent of active printing and VOC load.
        out = render("NEVERMORE_AUTO_PELTIER",
                     build(print_active=0, voc=4, temp=46), ALLOW=1)
        self.assertIn("VARIABLE=peltier_auto_demand VALUE=1", out)
        self.assertIn("NEVERMORE_PELTIER VALUE=1 AUTO=1", out)

    def test_auto_loop_latches_active_thermal_fault(self):
        p = build(active=1)
        p["temperature_sensor SM_Peltier_Hot_Side"]["temperature"] = 88
        out = render("NEVERMORE_AUTO_PELTIER", p, ALLOW=1)
        self.assertIn("NEVERMORE_PELTIER_THERMAL_TRIP", out)
        self.assertNotIn("NEVERMORE_PELTIER VALUE=0 AUTO=1", out)
        self.assertNotIn("NEVERMORE_EMERGENCY_OFF", out)
        p = build(active=0)
        p["temperature_sensor SM_Peltier_Hot_Side"]["temperature"] = 88
        out = render("NEVERMORE_AUTO_PELTIER", p, ALLOW=1)
        self.assertIn("THERMAL INHIBIT", out)
        self.assertNotIn("NEVERMORE_PELTIER_THERMAL_TRIP", out)

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

    def test_startup_closed_vent_completes_readiness_confirmation(self):
        p = build()
        p["gcode_macro SM_LED_STATE"]["vent_open"] = 0
        p["gcode_macro SM_LED_STATE"]["vent_closed_ready"] = 0
        p["gcode_macro SM2_SETTINGS"]["vent_close_angle"] = 67
        out = render("_VENT_CLOSE_NOW", p)
        self.assertIn("SET_SERVO SERVO=SM_Vent ANGLE=67", out)
        self.assertIn("ID=VENT_CLOSE_READY DURATION=6", out)
        # After readiness becomes true, repeated AUTO cycles must not
        # drive the servo needlessly.
        p["gcode_macro SM_LED_STATE"]["vent_closed_ready"] = 1
        settled = render("_VENT_CLOSE_NOW", p)
        self.assertNotIn("SET_SERVO SERVO=SM_Vent ANGLE=67", settled)
        self.assertNotIn("ID=VENT_CLOSE_READY DURATION=6", settled)

    def test_manual_mode_does_not_shutdown_manually_commanded_peltier(self):
        out = render("NEVERMORE_AUTO_PELTIER",
                     build(auto_mode=0, active=1), ALLOW=1)
        self.assertNotIn("NEVERMORE_PELTIER VALUE=0 AUTO=1", out)


if __name__ == "__main__":
    unittest.main(verbosity=2)
