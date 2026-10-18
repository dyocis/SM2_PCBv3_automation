#!/usr/bin/env python3
"""Fault snapshot ingestion is read-only, validated and restart-safe."""
from __future__ import annotations

from argparse import Namespace

from nevermore_history import (
    RestartGuard, extract_peltier_fault_event, fault_signature, history_payload,
)


def snapshot(**changes):
    data = {
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
    }
    data.update(changes)
    return data


def main():
    assert extract_peltier_fault_event({}, 1000) is None, "Old installation must stay optional"
    assert extract_peltier_fault_event(snapshot(peltier_fault_seq=0), 1000) is None
    assert extract_peltier_fault_event(snapshot(peltier_fault_seq=1.5), 1000) is None
    assert extract_peltier_fault_event(snapshot(peltier_fault_hot=float("nan")), 1000) is None
    assert extract_peltier_fault_event(snapshot(peltier_fault_fan_speed=5), 1000) is None
    assert extract_peltier_fault_event(snapshot(peltier_fault_was_active=2), 1000) is None
    assert extract_peltier_fault_event(snapshot(peltier_fault_reason="INVALID"), 1000) is None
    assert extract_peltier_fault_event(snapshot(peltier_fault_cold_max=None), 1000) is None

    first = extract_peltier_fault_event(snapshot(), 12345678)
    assert first["t"] == 12345678
    assert first["seq"] == 1
    assert first["hot"] == 72.3 and first["hot_max"] == 70
    assert first["cold"] == 41.7 and first["cold_max"] == 70
    assert first["chamber"] == 52.1
    assert first["fan_rpm"] == 9612 and first["fan_speed"] == 1.0
    assert first["was_active"] == 1 and first["vent_open"] == 0
    assert first["reason"] == "TEMPERATURE LIMIT"

    # Polling the frozen snapshot with a new observer timestamp is NOT a new trip.
    next_poll = extract_peltier_fault_event(snapshot(), 12346678)
    assert fault_signature(first) == fault_signature(next_poll)
    other_trip = extract_peltier_fault_event(
        snapshot(peltier_fault_seq=2, peltier_fault_hot=73.5), 12347000
    )
    assert fault_signature(first) != fault_signature(other_trip)
    assert extract_peltier_fault_event(
        snapshot(peltier_fault_hot=-1, peltier_fault_cold=-1,
                 peltier_fault_sensors_present=0), 5000
    ) is not None

    guard = RestartGuard()
    payload = history_payload(12347000, Namespace(retention_hours=24, sample_seconds=10),
                              {}, [], guard, [], [first, other_trip])
    assert payload["schema"] == 2
    assert payload["samples"] == [] and payload["door_events"] == []
    assert payload["peltier_fault_events"] == [first, other_trip]
    print("Peltier fault evidence: strict decoding, snapshot signature, and history persistence verified.")


if __name__ == "__main__":
    main()
