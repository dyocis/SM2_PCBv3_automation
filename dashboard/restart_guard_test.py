#!/usr/bin/env python3
from __future__ import annotations

from copy import deepcopy

from nevermore_history import (
    RestartGuard,
    clean_existing_history,
    outlet_voc_restart_error,
    sample_plausibility_error,
)


VALID_SAMPLE = {
    "t": 1_000,
    "vi": 164.0,
    "vo": 112.0,
    "ti": 36.7,
    "to": 30.9,
    "pi": 1008.42,
    "po": 1008.31,
    "hi": 31.2,
    "ho": 29.8,
    "fs": 1.0,
    "rpm": 9640.0,
    "uv": 0,
    "pel": 0,
    "vent": 0,
    "pcb": 40.1,
    "mcu": 43.2,
    "mode": "PRINT FILTRATION",
}


def at(timestamp_ms: int, **changes: float | None) -> dict:
    sample = deepcopy(VALID_SAMPLE)
    sample["t"] = timestamp_ms
    sample.update(changes)
    return sample


def main() -> None:
    assert sample_plausibility_error(VALID_SAMPLE) is None

    missing_temperature = at(2_000, ti=None)
    assert "temperature" in (sample_plausibility_error(missing_temperature) or "")

    zero_voc = at(3_000, vi=0, vo=0)
    assert sample_plausibility_error(zero_voc) is None

    missing_voc = at(3_500, vi=None)
    assert "VOC" in (sample_plausibility_error(missing_voc) or "")

    outlet_spike = at(3_750, vi=45, vo=320)
    assert outlet_voc_restart_error(at(3_700, vi=40, vo=32), outlet_spike)
    inlet_led_event = at(3_800, vi=350, vo=250)
    assert outlet_voc_restart_error(at(3_700, vi=40, vo=32), inlet_led_event) is None

    impossible_pressure = at(4_000, po=350.0)
    assert sample_plausibility_error(impossible_pressure) is not None

    guard = RestartGuard(quarantine_seconds=90, stable_samples_required=3)
    assert not guard.allow_sample(VALID_SAMPLE, 0.0)
    assert not guard.allow_sample(VALID_SAMPLE, 89.0)
    assert not guard.allow_sample(VALID_SAMPLE, 90.0)
    assert not guard.allow_sample(VALID_SAMPLE, 100.0)
    assert guard.allow_sample(VALID_SAMPLE, 110.0)
    assert guard.state == "recording"
    assert guard.allow_sample(zero_voc, 111.0)

    # A delayed, in-range outlet spike is a known SGP restart shape.  It must
    # restart quarantine even though every individual VOC value is within
    # the nominal 0-500 range.
    assert not guard.allow_sample(outlet_spike, 120.0)
    assert not guard.allow_sample(VALID_SAMPLE, 209.0)
    assert not guard.allow_sample(VALID_SAMPLE, 210.0)
    assert not guard.allow_sample(VALID_SAMPLE, 220.0)
    assert guard.allow_sample(VALID_SAMPLE, 230.0)

    # An impossible value restarts the full quarantine even if Klipper's brief
    # non-ready state was missed between polling cycles.
    assert not guard.allow_sample(missing_temperature, 240.0)
    assert not guard.allow_sample(VALID_SAMPLE, 329.0)
    assert not guard.allow_sample(VALID_SAMPLE, 330.0)
    assert not guard.allow_sample(VALID_SAMPLE, 340.0)
    assert guard.allow_sample(VALID_SAMPLE, 350.0)

    history = [
        at(1_000),
        at(11_000, ti=None),
        at(21_000),
        at(91_000),
        at(101_000),
        at(111_000, vi=0, vo=0),
    ]
    cleaned, removed = clean_existing_history(history, quarantine_seconds=90)
    assert [sample["t"] for sample in cleaned] == [1_000, 101_000, 111_000]
    assert cleaned[-1]["vi"] == 0 and cleaned[-1]["vo"] == 0
    assert removed == 3

    spike_history = [
        at(1_000, vi=40, vo=32),
        at(11_000, vi=45, vo=320),
        at(21_000, vi=52, vo=105),
        at(91_000, vi=48, vo=90),
        at(101_000, vi=42, vo=38),
        at(111_000, vi=0, vo=0),
        at(121_000, vi=350, vo=250),
    ]
    cleaned_spike, removed_spike = clean_existing_history(spike_history, quarantine_seconds=90)
    assert [sample["t"] for sample in cleaned_spike] == [1_000, 101_000, 111_000, 121_000]
    assert removed_spike == 3

    print("Restart guard verified readiness quarantine, delayed outlet-spike rejection, valid zero VOC, and history cleanup.")


if __name__ == "__main__":
    main()
