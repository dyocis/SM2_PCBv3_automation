#!/usr/bin/env python3
"""Exercise installer file writers in temporary fixtures, without services or hardware."""
import re
import shlex
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class SelectiveRegenerationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.config = Path(self.temp.name) / "config"
        self.config.mkdir()
        self.printer = self.config / "printer.cfg"
        self.printer.write_text("[printer]\nkinematics: corexy\n#*# <---------------------- SAVE_CONFIG ---------------------->\n#*# saved calibration\n")
        self.moonraker = self.config / "moonraker.conf"
        self.moonraker.write_text("[authorization]\ncors_domains:\n  http://mainsail.local\n")
        # Load real function bodies only; skip argument parsing, root guard and main.
        source = (ROOT / "scripts/install.sh").read_text()
        self.functions = source[source.index("confirm() {"):source.rindex("\nmain\n")]
        self.target = self.config / "SM2_PCBv3_automation"

    def run_writers(self, extra=""):
        values = dict(PROJECT_NAME="SM2_PCBv3_automation", CONFIG_ROOT=str(self.config),
                      INSTALL_DIR=str(ROOT), MOONRAKER_CONFIG=str(self.moonraker),
                      PROJECT_BRANCH="main", REPO_URL="https://github.com/dyocis/SM2_PCBv3_automation.git",
                      MCU_SERIAL="/dev/serial/by-id/test", CANBUS_UUID="", ASSUME_YES="1",
                      WITH_UV="0", WITH_PELTIER="0", WITH_VENT_SERVO="0")
        script = "set -Eeuo pipefail\n" + "\n".join(k + "=" + shlex.quote(v) for k, v in values.items())
        script += "\nlog() { :; }; warn() { :; }; die() { echo \"$*\" >&2; exit 1; }\n"
        script += self.functions + "\n" + extra + "\nwrite_local_config\nwrite_moonraker_updater\n"
        subprocess.run(["bash", "-c", script], check=True, capture_output=True, text=True)

    def test_fresh_install_and_repeat_preserve_user_data(self):
        self.run_writers()
        hardware = self.target / "SM2_Local_Hardware.cfg"
        hardware.write_text(hardware.read_text() + "\n# custom hardware setting\n")
        saved = self.config / "sm2_saved_variables.cfg"
        saved.write_text("[Variables]\ncalibration = 123\n")
        history = self.config.parent / "nevermore-dashboard" / "history.json"
        history.parent.mkdir()
        history.write_text('{"samples": [123]}')
        protected = [hardware, saved, history, self.printer, self.moonraker,
                     Path(str(self.printer) + ".before-sm2-install"),
                     Path(str(self.moonraker) + ".before-sm2-install")]
        before = {p: p.read_bytes() for p in protected}
        self.run_writers("WITH_UV=1; WITH_PELTIER=1; WITH_VENT_SERVO=1")
        self.assertEqual(before, {p: p.read_bytes() for p in protected})
        self.assertEqual(self.printer.read_text().count("[include SM2_PCBv3.cfg]"), 1)
        self.assertLess(self.printer.read_text().index("[include SM2_PCBv3.cfg]"), self.printer.read_text().index("#*# <"))

    def test_repairs_only_managed_files(self):
        self.run_writers()
        hardware = self.target / "SM2_Local_Hardware.cfg"
        original = hardware.read_bytes()
        aggregator = self.config / "SM2_PCBv3.cfg"
        expected = aggregator.read_bytes()
        aggregator.write_text("stale generated file\n")
        shared = self.target / "SM2_Control.cfg"
        shared.unlink()
        shared.symlink_to(self.config / "wrong.cfg")
        updater = self.target / "moonraker_update.conf"
        updater.write_text("stale updater\n")
        self.run_writers()
        self.assertEqual(hardware.read_bytes(), original)
        self.assertEqual(aggregator.read_bytes(), expected)
        self.assertEqual(shared.resolve(), ROOT / "config/SM2_Control.cfg")
        self.assertIn("primary_branch: main", updater.read_text())
        self.assertTrue((self.target / "SM2_Save_Variables.cfg").exists())

    def test_existing_save_variables_prevents_duplicate(self):
        (self.config / "user.cfg").write_text("[save_variables]\nfilename: ~/existing.cfg\n")
        self.run_writers()
        self.assertFalse((self.target / "SM2_Save_Variables.cfg").exists())
        self.assertNotIn("SM2_Save_Variables.cfg", (self.config / "SM2_PCBv3.cfg").read_text())

    def test_feature_branch_does_not_register_stable_updater(self):
        self.run_writers("PROJECT_BRANCH=feature/tabbed-dashboard-cors")
        self.assertFalse((self.target / "moonraker_update.conf").exists())
        self.assertNotIn("moonraker_update.conf", self.moonraker.read_text())


if __name__ == "__main__":
    unittest.main()
