#!/usr/bin/env python3
"""Validate fast door capture, settle filtering, and clustered door use."""
from __future__ import annotations

from nevermore_history import DoorEventTracker, history_payload
from argparse import Namespace
from nevermore_history import RestartGuard


def main() -> None:
    tracker = DoorEventTracker(settle_seconds=0.75, reopen_merge_seconds=12.0)
    events: list[dict] = []

    def sample(state: int | None, at: float) -> bool:
        return tracker.observe(state, at, int(at * 1000), events)

    assert not sample(0, 0.0)
    assert not sample(0, 1.0)  # establish CLOSED baseline, no synthetic event
    assert not events

    assert not sample(1, 2.0)
    assert not sample(0, 2.3)  # fast contact bounce, shorter than settle window
    assert not events

    assert not sample(1, 3.0)
    assert sample(1, 4.0)  # short legitimate open, independently from 10s VOC samples
    assert events == [{"t": 4000, "state": 1}]

    assert not sample(0, 5.0)
    assert sample(0, 6.0)
    assert events == [{"t": 4000, "state": 1}, {"t": 6000, "state": 0}]

    assert not sample(1, 7.0)
    assert sample(1, 8.0)
    assert events == [{"t": 4000, "state": 1}], "Quick reopen should remove premature close"

    assert not sample(0, 9.0)
    assert sample(0, 10.0)
    assert events == [{"t": 4000, "state": 1}, {"t": 10000, "state": 0}]

    assert not sample(1, 25.0)
    assert sample(1, 26.0)
    assert not sample(0, 28.0)
    assert sample(0, 29.0)
    assert events == [
        {"t": 4000, "state": 1}, {"t": 10000, "state": 0},
        {"t": 26000, "state": 1}, {"t": 29000, "state": 0},
    ], "Separate visits more than 12 seconds apart must remain separate"

    # Sensor unavailable / service restart: never infer an opening from
    # the initial post-restart reading.
    tracker.reset()
    assert not sample(1, 50.0)
    assert not sample(1, 51.0)
    assert len(events) == 4
    assert not sample(None, 52.0)
    assert not sample(0, 53.0)
    assert not sample(0, 54.0)
    assert len(events) == 4

    # The event stream is additive and coexists with schema-2 samples.
    args = Namespace(sample_seconds=10.0, retention_hours=24.0)
    payload = history_payload(54000, args, {}, [], RestartGuard(), events)
    assert payload["schema"] == 2
    assert payload["samples"] == []
    assert payload["door_events"] == events

    print("Door events verified: 0.75s settle, 12s reopen grouping, quick access, outage guard, and persistent payload.")


if __name__ == "__main__":
    main()
