#!/usr/bin/env python3
"""Read anonymous Codex Thread Health funnel counters.

A missing counter is reported as zero. This script never mutates counters.
"""

from __future__ import annotations

import json
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
BASELINE = Path(__file__).with_name("launch-baseline.json")


def read_counter(event: str) -> int:
    url = f"https://api.counterapi.dev/v1/{NAMESPACE}/{event}/"
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 CodexThreadHealth/0.1"})
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            return int(json.load(response).get("count", 0))
    except urllib.error.HTTPError as exc:
        if exc.code == 400:
            return 0
        raise


def main() -> int:
    baseline = json.loads(BASELINE.read_text(encoding="utf-8"))["counters"]
    current = {event: read_counter(event) for event in EVENTS}
    delta = {event: current[event] - int(baseline.get(event, 0)) for event in EVENTS}
    output = {
        "namespace": NAMESPACE,
        "baseline": baseline,
        "current": current,
        "delta_since_owner_verification": delta,
        "warning": "Anonymous counters are spoofable and cannot prove an external user by themselves.",
    }
    print(json.dumps(output, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
