"""Tests for the container readiness probe (healthcheck.py).

The probe is the memory stack's `Notify=healthy` gate and the watch
timer's restart trigger — a probe that never passes restart-loops a
healthy API (the podman 5.4 quoting bug this file format exists to
avoid). These tests pin the exit-code contract: 0 on 2xx, 1 on anything
else, never an exception.
"""
from __future__ import annotations

import contextlib
import http.server
import io
import socket
import threading
import unittest

import healthcheck


def serve(status: int) -> tuple[http.server.HTTPServer, threading.Thread]:
    """A one-answer HTTP server on an ephemeral loopback port."""

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802 — http.server API
            self.send_response(status)
            self.end_headers()

        def log_message(self, *args: object) -> None:  # keep test output clean
            pass

    server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, thread


def dead_port() -> int:
    """A loopback port with nothing listening: bind, note, close."""
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class HealthcheckTest(unittest.TestCase):
    def assert_probe(self, expected: int, url: str) -> None:
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(healthcheck.main(url), expected)

    def test_2xx_is_healthy(self) -> None:
        server, _thread = serve(200)
        try:
            self.assert_probe(0, f"http://127.0.0.1:{server.server_address[1]}/x")
        finally:
            server.shutdown()

    def test_error_status_is_unhealthy(self) -> None:
        server, _thread = serve(503)
        try:
            self.assert_probe(1, f"http://127.0.0.1:{server.server_address[1]}/x")
        finally:
            server.shutdown()

    def test_connection_refused_is_unhealthy(self) -> None:
        self.assert_probe(1, f"http://127.0.0.1:{dead_port()}/x")


if __name__ == "__main__":
    unittest.main()
