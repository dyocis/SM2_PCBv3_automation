#!/usr/bin/env python3
"""Rolling Nevermore telemetry recorder for Moonraker.

Uses only the Python standard library. It polls Moonraker's printer-object API,
retains a bounded 24-hour history, and writes an atomic JSON snapshot for the
static dashboard. No G-code or printer-control endpoint is used.
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any


OBJECTS = {
    "gcode_macro SM_LED_STATE": None,
    "fan_generic Filter": ["speed", "rpm"],
    "temperature_sensor BME_IN": ["temperature"],
    "temperature_sensor BME_OUT": ["temperature"],
    "bme280 BME_IN": ["pressure", "humidity", "temperature"],
    "bme280 BME_OUT": ["pressure", "humidity", "temperature"],
    "temperature_sensor SGP_IN": ["temperature"],
    "temperature_sensor SGP_OUT": ["temperature"],
    "temperature_sensor _SM_PCB": ["temperature"],
    "temperature_sensor _SM_MCU": ["temperature"],
    "print_stats": ["state", "filename"],
    "webhooks": ["state", "state_message"],
}

STOP_REQUESTED = False
DEFAULT_RESTART_QUARANTINE_SECONDS = 90.0
DEFAULT_STABLE_SAMPLES = 3
OUTLET_VOC_STEP_LIMIT = 120.0
OUTLET_VOC_INVERSION_LIMIT = 80.0


def stop_handler(_signum: int, _frame: Any) -> None:
    global STOP_REQUESTED
    STOP_REQUESTED = True


def request_json(url: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    data = None
    headers = {"Accept": "application/json"}
    if payload is not None:
        data = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=data, headers=headers, method="POST" if data else "GET")
    with urllib.request.urlopen(request, timeout=8) as response:
        return json.load(response)


def query_status(endpoint: str) -> dict[str, Any]:
    payload = request_json(
        endpoint.rstrip("/") + "/printer/objects/query",
        {"objects": OBJECTS},
    )
    return payload.get("result", {}).get("status", {})


def query_server_info(endpoint: str) -> dict[str, Any]:
    payload = request_json(endpoint.rstrip("/") + "/server/info")
    result = payload.get("result", {})
    return result if isinstance(result, dict) else {}


def query_media(endpoint: str) -> dict[str, Any] | None:
    params = urllib.parse.urlencode({"namespace": "nevermore_dashboard", "key": "media"})
    try:
        payload = request_json(endpoint.rstrip("/") + "/server/database/item?" + params)
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return None
        raise
    value = payload.get("result", {}).get("value")
    return value if isinstance(value, dict) else None


def number(value: Any) -> float | None:
    try:
        converted = float(value)
    except (TypeError, ValueError):
        return None
    return converted if converted == converted and abs(converted) != float("inf") else None


def truthy(value: Any) -> int:
    return int(value is True or value == 1 or value == "1" or value == "true")


def make_sample(status: dict[str, Any], timestamp_ms: int) -> dict[str, Any]:
    sm = status.get("gcode_macro SM_LED_STATE", {})
    fan = status.get("fan_generic Filter", {})
    bme_in_temp = status.get("temperature_sensor BME_IN", {})
    bme_out_temp = status.get("temperature_sensor BME_OUT", {})
    bme_in = status.get("bme280 BME_IN", {})
    bme_out = status.get("bme280 BME_OUT", {})
    sgp_in = status.get("temperature_sensor SGP_IN", {})
    sgp_out = status.get("temperature_sensor SGP_OUT", {})
    pcb = status.get("temperature_sensor _SM_PCB", {})
    mcu = status.get("temperature_sensor _SM_MCU", {})

    return {
        "t": timestamp_ms,
        "vi": number(sgp_in.get("temperature", sm.get("voc_in"))),
        "vo": number(sgp_out.get("temperature", sm.get("voc_out"))),
        "ti": number(bme_in_temp.get("temperature", sm.get("temp_in"))),
        "to": number(bme_out_temp.get("temperature", sm.get("temp_out"))),
        "pi": number(bme_in.get("pressure")),
        "po": number(bme_out.get("pressure")),
        "hi": number(bme_in.get("humidity")),
        "ho": number(bme_out.get("humidity")),
        "fs": number(fan.get("speed", sm.get("last_filter_speed"))) or 0.0,
        "rpm": number(fan.get("rpm", sm.get("last_rpm"))) or 0.0,
        "uv": truthy(sm.get("uv")),
        "pel": truthy(sm.get("peltier")),
        "vent": truthy(sm.get("vent_open")),
        "cal": truthy(sm.get("sgp40_calibration_active")),
        "sgp": number(sm.get("sgp40_calibration_revision")) or 0.0,
        "pcb": number(pcb.get("temperature")),
        "mcu": number(mcu.get("temperature")),
        "mode": str(sm.get("auto_reason", sm.get("current_state", "IDLE"))).strip('"'),
    }


def value_in_range(value: Any, minimum: float, maximum: float) -> bool:
    converted = number(value)
    return converted is not None and minimum <= converted <= maximum


def sample_plausibility_error(sample: dict[str, Any]) -> str | None:
    """Return why a sample looks like startup data, or None when usable.

    These deliberately broad limits reject missing initialization values and
    physically impossible BME differentials without hiding a legitimate zero
    VOC index, real hot chamber, or high-VOC event. SGP40 VOC Index 0 is valid
    once the restart quarantine and stable-sample checks have completed.
    """

    for key in ("vi", "vo"):
        if not value_in_range(sample.get(key), 0.0, 500.0):
            return f"{key} is missing or outside the SGP40 VOC-index range"

    for key in ("ti", "to"):
        if not value_in_range(sample.get(key), 1.0, 110.0):
            return f"{key} is missing or outside the environmental temperature range"

    for key in ("pi", "po"):
        if not value_in_range(sample.get(key), 300.0, 1200.0):
            return f"{key} is missing or outside the BME280 pressure range"

    pressure_in = number(sample.get("pi"))
    pressure_out = number(sample.get("po"))
    if pressure_in is None or pressure_out is None or abs(pressure_in - pressure_out) > 20.0:
        return "BME280 differential pressure exceeds the physical guardrail"

    for key in ("hi", "ho"):
        value = number(sample.get(key))
        if value is not None and not 0.0 <= value <= 100.0:
            return f"{key} is outside the humidity range"

    if not value_in_range(sample.get("fs"), 0.0, 1.05):
        return "fan command is outside the expected range"
    if not value_in_range(sample.get("rpm"), 0.0, 30_000.0):
        return "fan RPM is outside the expected range"

    vent = number(sample.get("vent"))
    if vent is not None and vent not in (0.0, 1.0):
        return "vent state is outside the expected range"

    calibration = number(sample.get("cal"))
    if calibration is not None and calibration not in (0.0, 1.0):
        return "SGP40 calibration state is outside the expected range"

    revision = number(sample.get("sgp"))
    if revision is not None and not 0.0 <= revision <= 1_000_000.0:
        return "SGP40 calibration revision is outside the expected range"

    for key in ("pcb", "mcu"):
        value = number(sample.get(key))
        if value is not None and not 1.0 <= value <= 125.0:
            return f"{key} is outside the controller temperature range"

    return None


def outlet_voc_restart_error(
    previous: dict[str, Any] | None,
    current: dict[str, Any],
) -> str | None:
    """Detect the delayed outlet-only SGP startup spike seen after MCU restarts.

    A real chamber VOC event should reach the inlet sensor first.  The restart
    artifact instead makes the outlet jump sharply while it is far above the
    inlet.  Requiring both conditions avoids rejecting legitimate clean-air
    zeroes and inlet-led VOC events.
    """

    if not isinstance(previous, dict):
        return None

    previous_out = number(previous.get("vo"))
    current_in = number(current.get("vi"))
    current_out = number(current.get("vo"))
    if previous_out is None or current_in is None or current_out is None:
        return None

    outlet_step = current_out - previous_out
    outlet_inversion = current_out - current_in
    if outlet_step >= OUTLET_VOC_STEP_LIMIT and outlet_inversion >= OUTLET_VOC_INVERSION_LIMIT:
        return "outlet VOC restart spike"
    return None


def clean_existing_history(
    raw_samples: Any,
    quarantine_seconds: float = DEFAULT_RESTART_QUARANTINE_SECONDS,
) -> tuple[list[dict[str, Any]], int]:
    """Remove recorded restart artifacts and the following sensor warmup span."""

    if not isinstance(raw_samples, list):
        return [], 0

    ordered = sorted(
        (point for point in raw_samples if isinstance(point, dict) and number(point.get("t")) is not None),
        key=lambda point: number(point.get("t")) or 0.0,
    )
    clean: list[dict[str, Any]] = []
    quarantine_until_ms = 0.0
    removed = 0
    quarantine_ms = max(0.0, quarantine_seconds) * 1000.0
    previous_plausible: dict[str, Any] | None = None

    for point in ordered:
        timestamp_ms = number(point.get("t")) or 0.0
        error = sample_plausibility_error(point)
        if error:
            quarantine_until_ms = max(quarantine_until_ms, timestamp_ms + quarantine_ms)
            previous_plausible = None
            removed += 1
            continue
        transient = outlet_voc_restart_error(previous_plausible, point)
        previous_plausible = point
        if transient:
            quarantine_until_ms = max(quarantine_until_ms, timestamp_ms + quarantine_ms)
            removed += 1
            continue
        if timestamp_ms < quarantine_until_ms:
            removed += 1
            continue
        clean.append(point)

    return clean, removed


@dataclass
class RestartGuard:
    quarantine_seconds: float = DEFAULT_RESTART_QUARANTINE_SECONDS
    stable_samples_required: int = DEFAULT_STABLE_SAMPLES
    ready_since: float | None = None
    consecutive_plausible: int = 0
    skipped_samples: int = 0
    reason: str = "Waiting for Klipper"
    state: str = "quarantine"
    previous_plausible: dict[str, Any] | None = None

    def mark_unready(self, reason: str = "Klipper is not ready") -> None:
        self.ready_since = None
        self.consecutive_plausible = 0
        self.previous_plausible = None
        self.reason = reason
        self.state = "quarantine"

    def allow_sample(self, sample: dict[str, Any], now_monotonic: float) -> bool:
        error = sample_plausibility_error(sample)
        if error:
            # An impossible sensor value is itself treated as a restart marker,
            # even if Moonraker did not expose the brief non-ready transition.
            self.ready_since = now_monotonic
            self.consecutive_plausible = 0
            self.previous_plausible = None
            self.skipped_samples += 1
            self.reason = "Sensor startup transient: " + error
            self.state = "quarantine"
            return False

        transient = outlet_voc_restart_error(self.previous_plausible, sample)
        self.previous_plausible = sample
        if transient:
            self.ready_since = now_monotonic
            self.consecutive_plausible = 0
            self.skipped_samples += 1
            self.reason = "Sensor startup transient: " + transient
            self.state = "quarantine"
            return False

        if self.ready_since is None:
            self.ready_since = now_monotonic
            self.consecutive_plausible = 0

        remaining = max(0.0, self.quarantine_seconds - (now_monotonic - self.ready_since))
        if remaining > 0:
            self.skipped_samples += 1
            self.reason = f"Restart quarantine ({remaining:.0f}s remaining)"
            self.state = "quarantine"
            return False

        self.consecutive_plausible += 1
        required = max(1, int(self.stable_samples_required))
        if self.consecutive_plausible < required:
            self.skipped_samples += 1
            self.reason = f"Validating sensors ({self.consecutive_plausible}/{required})"
            self.state = "validating"
            return False

        self.reason = "Recording stable telemetry"
        self.state = "recording"
        return True

    def metadata(self) -> dict[str, Any]:
        return {
            "state": self.state,
            "reason": self.reason,
            "restart_quarantine_seconds": self.quarantine_seconds,
            "stable_samples_required": max(1, int(self.stable_samples_required)),
            "skipped_samples": self.skipped_samples,
        }


def load_json(path: Path, default: Any) -> Any:
    try:
        with path.open("r", encoding="utf-8") as handle:
            return json.load(handle)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return default


def atomic_json_write(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temp_name = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(value, handle, separators=(",", ":"), allow_nan=False)
            handle.flush()
            os.fsync(handle.fileno())
            os.fchmod(handle.fileno(), 0o644)
        os.replace(temp_name, path)
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)


def history_payload(
    timestamp_ms: int,
    args: argparse.Namespace,
    lifetime: dict[str, Any],
    samples: list[dict[str, Any]],
    guard: RestartGuard,
) -> dict[str, Any]:
    return {
        "schema": 2,
        "generated_at": timestamp_ms,
        "retention_hours": args.retention_hours,
        "sample_seconds": args.sample_seconds,
        "lifetime": lifetime,
        "guard": guard.metadata(),
        "samples": samples,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Record rolling Nevermore history from Moonraker")
    parser.add_argument("--moonraker", default="http://127.0.0.1:7125")
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--sample-seconds", type=float, default=10.0)
    parser.add_argument("--write-seconds", type=float, default=60.0)
    parser.add_argument("--retention-hours", type=float, default=24.0)
    parser.add_argument(
        "--restart-quarantine-seconds",
        type=float,
        default=DEFAULT_RESTART_QUARANTINE_SECONDS,
    )
    parser.add_argument("--stable-samples", type=int, default=DEFAULT_STABLE_SAMPLES)
    args = parser.parse_args()

    signal.signal(signal.SIGTERM, stop_handler)
    signal.signal(signal.SIGINT, stop_handler)

    state_path = args.output.with_name("recorder_state.json")
    previous = load_json(args.output, {})
    raw_samples = previous.get("samples", []) if isinstance(previous, dict) else []
    samples, removed_samples = clean_existing_history(raw_samples, args.restart_quarantine_seconds)
    lifetime = load_json(
        state_path,
        {"installed_at": None, "fan_seconds": 0.0, "voc_exposure_index_seconds": 0.0},
    )
    guard = RestartGuard(
        quarantine_seconds=max(0.0, args.restart_quarantine_seconds),
        stable_samples_required=max(1, args.stable_samples),
    )
    last_sample_time = time.monotonic()
    last_write_time = 0.0
    next_sample_time = time.monotonic()
    next_media_check = 0.0
    last_guard_reason = ""

    # Persist the cleaned history immediately so an old restart spike cannot
    # keep distorting the charts while the new post-restart quarantine runs.
    startup_timestamp_ms = int(time.time() * 1000)
    try:
        atomic_json_write(args.output, history_payload(startup_timestamp_ms, args, lifetime, samples, guard))
        atomic_json_write(state_path, lifetime)
        if removed_samples:
            print(
                f"Nevermore recorder removed {removed_samples} restart/startup history samples.",
                flush=True,
            )
    except Exception as error:
        print("Nevermore recorder startup write failed: " + str(error), file=sys.stderr, flush=True)

    while not STOP_REQUESTED:
        now_monotonic = time.monotonic()
        if now_monotonic < next_sample_time:
            time.sleep(min(0.5, next_sample_time - now_monotonic))
            continue

        next_sample_time = now_monotonic + max(0.25, args.sample_seconds)
        elapsed = min(max(now_monotonic - last_sample_time, 0.0), args.sample_seconds * 2)
        last_sample_time = now_monotonic

        try:
            server_info = query_server_info(args.moonraker)
            klippy_state = str(server_info.get("klippy_state", "unknown")).lower()
            if klippy_state != "ready":
                guard.mark_unready("Klipper is " + klippy_state)
                if guard.reason != last_guard_reason:
                    print("Nevermore recorder guard: " + guard.reason, flush=True)
                    last_guard_reason = guard.reason
                continue

            status = query_status(args.moonraker)
            webhook_state = str(status.get("webhooks", {}).get("state", "ready")).lower()
            if webhook_state != "ready":
                guard.mark_unready("Printer webhooks state is " + webhook_state)
                if guard.reason != last_guard_reason:
                    print("Nevermore recorder guard: " + guard.reason, flush=True)
                    last_guard_reason = guard.reason
                continue

            timestamp_ms = int(time.time() * 1000)
            sample = make_sample(status, timestamp_ms)
        except Exception as error:  # keep the recorder alive across Moonraker restarts
            guard.mark_unready("Moonraker/Klipper query unavailable")
            print("Nevermore recorder query failed: " + str(error), file=sys.stderr, flush=True)
            continue

        if not guard.allow_sample(sample, now_monotonic):
            if guard.reason != last_guard_reason:
                print("Nevermore recorder guard: " + guard.reason, flush=True)
                last_guard_reason = guard.reason
            continue

        if guard.reason != last_guard_reason:
            print("Nevermore recorder guard: " + guard.reason, flush=True)
            last_guard_reason = guard.reason

        if now_monotonic >= next_media_check:
            next_media_check = now_monotonic + 60.0
            try:
                media = query_media(args.moonraker)
                installed_at = number(media.get("installedAt")) if media else None
                if installed_at and installed_at != number(lifetime.get("installed_at")):
                    lifetime = {
                        "installed_at": installed_at,
                        "fan_seconds": 0.0,
                        "voc_exposure_index_seconds": 0.0,
                    }
            except Exception as error:
                print("Nevermore recorder media lookup failed: " + str(error), file=sys.stderr, flush=True)

        if number(lifetime.get("installed_at")) and (sample.get("fs") or 0) > 0:
            lifetime["fan_seconds"] = number(lifetime.get("fan_seconds")) or 0.0
            lifetime["fan_seconds"] += elapsed
            voc_excess = max((sample.get("vi") or 0) - 100, 0)
            lifetime["voc_exposure_index_seconds"] = number(lifetime.get("voc_exposure_index_seconds")) or 0.0
            lifetime["voc_exposure_index_seconds"] += voc_excess * elapsed

        samples.append(sample)
        cutoff = timestamp_ms - int(args.retention_hours * 3_600_000)
        samples = [point for point in samples if number(point.get("t")) and point["t"] >= cutoff]

        if now_monotonic - last_write_time >= max(args.sample_seconds, args.write_seconds):
            last_write_time = now_monotonic
            payload = history_payload(timestamp_ms, args, lifetime, samples, guard)
            try:
                atomic_json_write(args.output, payload)
                atomic_json_write(state_path, lifetime)
            except Exception as error:
                print("Nevermore recorder write failed: " + str(error), file=sys.stderr, flush=True)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
