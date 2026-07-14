#!/usr/bin/env python3
"""Read anonymous Codex Thread Health funnel counters.

A missing counter is reported as zero. This script never mutates counters.
"""

from __future__ import annotations

import argparse
import json
import time
import urllib.error
import urllib.request
from pathlib import Path

NAMESPACE = "codex-thread-health-prod-v1"
EVENTS = [
    "page_view",
    "sample_loaded",
    "file_selected",
    "scan_succeeded",
    "scan_failed",
    "receipt_copied",
    "feedback_clicked",
]
DEFAULT_BASELINE = Path(__file__).with_name("outreach-baseline-33008.json")
DEFAULT_OWNER_EVENTS = Path(__file__).with_name("owner-events-after-outreach.json")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Read privacy-minimized funnel counters without mutating them.")
    parser.add_argument("--baseline", type=Path, default=DEFAULT_BASELINE)
    parser.add_argument("--owner-events", type=Path, default=DEFAULT_OWNER_EVENTS)
    return parser.parse_args()


def read_counter(event: str) -> int:
    url = f"https://api.counterapi.dev/v1/{NAMESPACE}/{event}/"
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 CodexThreadHealth/0.1"})
    last_error: Exception | None = None
    for attempt in range(4):
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return int(json.load(response).get("count", 0))
        except urllib.error.HTTPError as exc:
            if exc.code == 400:
                return 0
            last_error = exc
        except (TimeoutError, urllib.error.URLError) as exc:
            last_error = exc
        if attempt < 3:
            time.sleep(2 ** attempt)
    raise RuntimeError(f"failed to read counter {event!r} after 4 attempts") from last_error


def main() -> int:
    args = parse_args()
    payload = json.loads(args.baseline.read_text(encoding="utf-8"))
    baseline = payload["counters"]
    owner_events = {event: 0 for event in EVENTS}
    if args.owner_events.exists():
        owner_payload = json.loads(args.owner_events.read_text(encoding="utf-8"))
        owner_events.update({event: int(value) for event, value in owner_payload.get("events", {}).items()})
    current = {event: read_counter(event) for event in EVENTS}
    raw_delta = {event: current[event] - int(baseline.get(event, 0)) for event in EVENTS}
    corrected_delta = {event: raw_delta[event] - owner_events[event] for event in EVENTS}
    output = {
        "namespace": NAMESPACE,
        "baseline_file": str(args.baseline),
        "baseline_stage": payload.get("stage"),
        "baseline": baseline,
        "current": current,
        "raw_delta_after_outreach": raw_delta,
        "known_owner_events_after_outreach": owner_events,
        "corrected_unattributed_delta": corrected_delta,
        "warning": "Corrected deltas remain unattributed and spoofable; they cannot prove an external user by themselves.",
    }
    print(json.dumps(output, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
