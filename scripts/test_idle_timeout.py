#!/usr/bin/env python3
"""Render real output macros; repeated polling must not queue unchanged outputs."""
import copy
import unittest

from test_temperature_auto import build, render


def printer_state(fan=0, uv=0):
    p = build(temp=25, print_active=0, active=0, pending=0, cooldown=0)
    p["fan_generic Filter"]["speed"] = fan
    p["output_pin uv"] = {"value": uv}
    # Used by the newer UV thermal branch when this regression is forward-ported.
    p["gcode_macro SM_LED_STATE"].update(uv=int(uv > 0), uv_thermal_fault=0,
                                        uv_cooldown_active=0)
    return p


class IdleTimeoutTests(unittest.TestCase):
    def test_two_hours_of_idle_polling_do_not_queue_outputs(self):
        p = printer_state()
        for _ in range(480):
            out = render("NEVERMORE_FILTER", p, SPEED=0)
            out += render("NEVERMORE_UV", p, VALUE=0, AUTO=1)
            self.assertNotIn("SET_FAN_SPEED", out)
            self.assertNotIn("SET_PIN", out)
            self.assertIn("UPDATE_SM_STATUS_LEDS", out)

    def test_fan_and_uv_transitions_only_queue_when_needed(self):
        for actual in (0, 0.6, 1):
            for demand in (0, 0.6, 1):
                with self.subTest(actual=actual, demand=demand):
                    p = printer_state(fan=actual, uv=actual)
                    p["gcode_macro SM_LED_STATE"]["uv"] = 0
                    fan = render("NEVERMORE_FILTER", p, SPEED=demand)
                    self.assertEqual("SET_FAN_SPEED" in fan, actual != demand)
                    uv = render("NEVERMORE_UV", p, VALUE=demand, AUTO=1)
                    self.assertEqual("SET_PIN PIN=uv" in uv, actual != demand)
                    if demand > 0:
                        self.assertIn("NEVERMORE_FILTER SPEED=1", uv)

    def test_actual_output_overrides_stale_cached_request(self):
        p = printer_state(fan=0)
        p["gcode_macro SM_LED_STATE"]["last_filter_speed"] = 1
        self.assertIn("SET_FAN_SPEED FAN=Filter SPEED=1.0",
                      render("NEVERMORE_FILTER", p, SPEED=1))

    def test_optional_uv_absence_is_supported(self):
        p = printer_state()
        del p["output_pin uv"]
        self.assertNotIn("SET_PIN", render("NEVERMORE_UV", p, VALUE=0, AUTO=1))

    def test_calibration_still_rejects_starts(self):
        p = printer_state()
        p["gcode_macro SM_LED_STATE"]["sgp40_calibration_active"] = 1
        def reject(message):
            raise RuntimeError(message)
        from test_peltier_thermal import JINJA, MACROS
        for name, params in (("NEVERMORE_FILTER", {"SPEED": 1}),
                             ("NEVERMORE_UV", {"VALUE": 1})):
            with self.subTest(name=name), self.assertRaises(RuntimeError):
                JINJA.from_string(MACROS[name]).render(
                    printer=copy.deepcopy(p), params=params, action_raise_error=reject)

    def test_emergency_shutdown_remains_unconditional(self):
        p = printer_state()
        p["output_pin peltier"] = {"value": 0}
        out = render("NEVERMORE_EMERGENCY_OFF", p)
        self.assertIn("SET_PIN PIN=uv VALUE=0", out)
        self.assertIn("SET_PIN PIN=peltier VALUE=0", out)
        self.assertIn("SET_FAN_SPEED FAN=Filter SPEED=1", out)


if __name__ == "__main__":
    unittest.main()
