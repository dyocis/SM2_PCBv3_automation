#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import stat
import subprocess
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
                    os.fspath(recorder),
                    "--moonraker", f"http://127.0.0.1:{server.server_port}",
                    "--output", os.fspath(output),
                    "--sample-seconds", "0.25",
                    "--write-seconds", "0.25",
                    "--retention-hours", "1",
                    "--restart-quarantine-seconds", "0",
                    "--stable-samples", "1",
                ]
            )
            deadline = time.time() + 5
            while time.time() < deadline and not output.exists():
                time.sleep(0.1)
            process.terminate()
            process.wait(timeout=5)

            payload = json.loads(output.read_text())
            assert payload["samples"], "Recorder wrote no samples"
            sample = payload["samples"][-1]
            assert sample["rpm"] == 9640
            assert sample["pi"] == 1008.42
            assert sample["mode"] == "SGP40 CALIBRATION"
            assert sample["vent"] == 0
            assert sample["cal"] == 1
            assert sample["sgp"] == 3
            assert payload["schema"] == 2
            assert payload["guard"]["state"] == "recording"
            assert payload["lifetime"]["installed_at"] == 1234567890
            assert stat.S_IMODE(output.stat().st_mode) == 0o644
    finally:
        server.shutdown()
        server.server_close()

    print("Recorder smoke test verified pressure, vent, SGP40 calibration tags, lifetime reset, and atomic output.")


if __name__ == "__main__":
    main()
