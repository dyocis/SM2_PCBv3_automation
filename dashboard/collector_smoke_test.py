#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import stat
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


STATUS = {
    "gcode_macro SM_LED_STATE": {
        "auto_reason": "SGP40 CALIBRATION",
        "uv": 0,
        "peltier": 0,
        "peltier_hot_temp": 71.2,
        "peltier_cold_temp": 36.4,
        "uv_led_temp": 42.7,
        "vent_open": 0,
        "sgp40_calibration_active": 1,
        "sgp40_calibration_revision": 3,
    },
    "fan_generic Filter": {"speed": 1.0, "rpm": 9640},
    "temperature_sensor BME_IN": {"temperature": 36.7},
    "temperature_sensor BME_OUT": {"temperature": 30.9},
    "bme280 BME_IN": {"pressure": 1008.42, "humidity": 31.2},
    "bme280 BME_OUT": {"pressure": 1008.31, "humidity": 29.8},
    "temperature_sensor SGP_IN": {"temperature": 164},
    "temperature_sensor SGP_OUT": {"temperature": 112},
    "temperature_sensor _SM_PCB": {"temperature": 40.1},
    "temperature_sensor _SM_MCU": {"temperature": 43.2},
    "print_stats": {"state": "printing", "filename": "test.gcode"},
    "webhooks": {"state": "ready", "state_message": "Printer is ready"},
    "gcode_button chamber_door": {"state": "RELEASED"},
}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, _format: str, *_args: object) -> None:
        return

    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length", "0"))
        self.rfile.read(length)
        self.send_json({"result": {"status": STATUS}})

    def do_GET(self) -> None:
        if self.path.startswith("/server/info"):
            self.send_json({"result": {"klippy_state": "ready"}})
            return
        if self.path.startswith("/printer/objects/list"):
            self.send_json({"result": {"objects": list(STATUS)}})
            return
        self.send_json({"result": {"value": {"installedAt": 1234567890}}})

    def send_json(self, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main() -> None:
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "history.json"
            recorder = Path(__file__).with_name("nevermore_history.py")
            process = subprocess.Popen(
                [
                    sys.executable, os.fspath(recorder),
                    "--moonraker", f"http://127.0.0.1:{server.server_port}",
                    "--output", os.fspath(output),
                    "--sample-seconds", "0.25",
                    "--write-seconds", "0.25",
                    "--retention-hours", "1",
                    "--restart-quarantine-seconds", "0",
                    "--stable-samples", "1",
                ]
            )
            # The recorder first writes an empty startup/quarantine snapshot.
            # Wait for telemetry, not merely file creation, before stopping it.
            payload = None
            try:
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline:
                    if output.exists():
                        candidate = json.loads(output.read_text())
                        if candidate.get("samples"):
                            payload = candidate
                            break
                    if process.poll() is not None:
                        raise AssertionError(f"Recorder exited early: {process.returncode}")
                    time.sleep(0.1)
                assert payload is not None, "Recorder wrote no samples within 5 seconds"

                # Exercise real recorder polling, not only tracker unit tests.
                # First let the door establish a stable CLOSED baseline.
                time.sleep(1.3)
                STATUS["gcode_button chamber_door"]["state"] = "PRESSED"
                time.sleep(1.7)  # enough for a 0.75s stable OPEN observation
                STATUS["gcode_button chamber_door"]["state"] = "RELEASED"
                captured = None
                deadline = time.monotonic() + 4
                while time.monotonic() < deadline:
                    candidate = json.loads(output.read_text())
                    if len(candidate.get("door_events", [])) >= 2:
                        captured = candidate["door_events"]
                        break
                    if process.poll() is not None:
                        raise AssertionError(f"Recorder exited before door events: {process.returncode}")
                    time.sleep(0.1)
                assert captured is not None, "Recorder missed stable short door OPEN/CLOSED events"
                assert [event["state"] for event in captured] == [1, 0], captured

                # The first completed trip is frozen in Klipper macro state.
                # The recorder must persist its evidence immediately, while
                # normal VOC sampling continues and the door stream remains.
                STATUS["gcode_macro SM_LED_STATE"].update({
                    "peltier_fault_seq": 1,
                    "peltier_fault_reason": "TEMPERATURE LIMIT",
                    "peltier_fault_hot": 72.3,
                    "peltier_fault_cold": 41.7,
                    "peltier_fault_hot_min": 0,
                    "peltier_fault_hot_max": 70,
                    "peltier_fault_cold_min": 0,
                    "peltier_fault_cold_max": 70,
                    "peltier_fault_chamber": 52.1,
                    "peltier_fault_fan_rpm": 9612,
                    "peltier_fault_fan_speed": 1.0,
                    "peltier_fault_was_active": 1,
                    "peltier_fault_sensors_present": 1,
                    "peltier_fault_vent_open": 0,
                })
                fault_evidence = None
                deadline = time.monotonic() + 4
                while time.monotonic() < deadline:
                    candidate = json.loads(output.read_text())
                    if candidate.get("peltier_fault_events"):
                        fault_evidence = candidate["peltier_fault_events"]
                        break
                    if process.poll() is not None:
                        raise AssertionError(f"Recorder exited before fault snapshot: {process.returncode}")
                    time.sleep(0.1)
                assert fault_evidence is not None, "Recorder did not persist a Peltier snapshot"
                assert len(fault_evidence) == 1
                assert fault_evidence[0]["hot"] == 72.3
                assert fault_evidence[0]["cold"] == 41.7
                assert fault_evidence[0]["fan_rpm"] == 9612
                assert fault_evidence[0]["reason"] == "TEMPERATURE LIMIT"
                time.sleep(1.2)
                unchanged = json.loads(output.read_text())
                assert len(unchanged["peltier_fault_events"]) == 1, "Snapshot duplicated during polling"
                assert len(unchanged["door_events"]) == 2, "Fault event damaged existing door history"
            finally:
                process.terminate()
                process.wait(timeout=5)

            assert payload["samples"], "Recorder wrote no samples"
            assert payload["door_events"] == [], "New recorder must not fabricate a door transition"
            sample = payload["samples"][-1]
            assert sample["rpm"] == 9640
            assert sample["pi"] == 1008.42
            assert sample["mode"] == "SGP40 CALIBRATION"
            assert sample["vent"] == 0
            assert sample["door"] == 0
            assert sample["cal"] == 1
            assert sample["sgp"] == 3
            assert sample["pth"] == 71.2
            assert sample["ptc"] == 36.4
            assert sample["uvt"] == 42.7
            # Optional sensors do not disrupt VOC history if not installed.
            from nevermore_history import make_sample, query_available_door, query_status
            endpoint = f"http://127.0.0.1:{server.server_port}"
            assert query_available_door(endpoint)
            assert query_status(endpoint, include_door=True)["gcode_button chamber_door"]["state"] == "RELEASED"
            assert make_sample({**STATUS, "gcode_button chamber_door": {"state": "RELEASED"}}, 123)["door"] == 0
            assert make_sample({**STATUS, "gcode_button chamber_door": {"state": "UNKNOWN"}}, 123)["door"] is None
            assert make_sample({key: value for key, value in STATUS.items() if key != "gcode_button chamber_door"}, 123)["door"] is None
            absent = {
                **STATUS,
                "gcode_macro SM_LED_STATE": {
                    **STATUS["gcode_macro SM_LED_STATE"],
                    "peltier_hot_temp": -1,
                    "peltier_cold_temp": -1,
                    "uv_led_temp": -1,
                },
            }
            assert make_sample(absent, 123)["pth"] is None
            assert make_sample(absent, 123)["ptc"] is None
            assert make_sample(absent, 123)["uvt"] is None
            assert payload["schema"] == 2
            assert payload["guard"]["state"] == "recording"
            assert payload["lifetime"]["installed_at"] == 1234567890
            assert stat.S_IMODE(output.stat().st_mode) == 0o644
    finally:
        server.shutdown()
        server.server_close()

    print("Recorder smoke test verified 0.5s door polling and durable OPEN/CLOSED events, plus sensor telemetry and atomic output.")


if __name__ == "__main__":
    main()
