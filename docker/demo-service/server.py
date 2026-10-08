import json
import os
import socket
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit


MAX_DELAY_MS = 30_000


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def respond(self):
        length = int(self.headers.get("content-length", "0"))

        if length:
            self.rfile.read(length)

        parsed = urlsplit(self.path)
        delay_ms = 0

        if parsed.path == "/slow":
            raw_delay = parse_qs(parsed.query).get("delay_ms", ["4000"])[0]

            try:
                delay_ms = max(0, min(MAX_DELAY_MS, int(raw_delay)))
            except ValueError:
                self.send_json(400, {"error": "delay_ms must be an integer"})
                return

        started_at = time.monotonic()

        if delay_ms:
            time.sleep(delay_ms / 1000)

        payload = {
            "status": "ok",
            "instance_id": os.environ.get("INSTANCE_ID", "unknown"),
            "hostname": socket.gethostname(),
            "method": self.command,
            "path": parsed.path,
            "delay_ms": delay_ms,
            "elapsed_ms": round((time.monotonic() - started_at) * 1000),
        }

        self.send_json(200, payload)

    def send_json(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.send_header("connection", "close")
        self.end_headers()

        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            # A proxy process may be intentionally interrupted by the lifecycle
            # verifier. The request thread can finish without crashing the demo.
            pass

    do_GET = respond
    do_POST = respond
    do_PUT = respond
    do_PATCH = respond
    do_DELETE = respond

    def log_message(self, *_):
        return


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "3000"))
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    server.daemon_threads = True
    server.serve_forever()
