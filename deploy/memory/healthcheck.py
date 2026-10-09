"""Readiness probe for the Goblin Hindsight API container.

Run by podman inside the container — `HealthCmd` in
`goblin-memory-api.container`, which mounts this file at
`/opt/goblin-memory-healthcheck.py` (installed beside `start.py` by
`install.py`).

A standalone file, deliberately not a `python -c` one-liner: a quadlet
`HealthCmd` string passes through two lexers — systemd's unit parser,
then podman's CMD-SHELL re-quoting — and podman 5.4 (Debian trixie,
lithium) drops the trailing escaped quote of the one-liner form,
causing `sh: Unterminated quoted string` instead of a readiness result.
`python /opt/goblin-memory-healthcheck.py` carries no shell
metacharacters for any podman/systemd pair to lose.
"""
from __future__ import annotations

import sys
import urllib.request

URL = "http://127.0.0.1:8888/health/ready"
TIMEOUT_SECONDS = 5


def main(url: str = URL) -> int:
    """Exit 0 when `url` answers 2xx within the timeout, 1 otherwise.

    A probe reports; it never raises into the healthcheck runner.
    """
    try:
        with urllib.request.urlopen(url, timeout=TIMEOUT_SECONDS) as response:
            status = response.status
    except Exception as exc:  # noqa: BLE001 — the reason belongs in the log
        print(f"healthcheck: {url}: {exc}", file=sys.stderr)
        return 1
    if not 200 <= status < 300:
        print(f"healthcheck: {url}: unexpected status {status}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
