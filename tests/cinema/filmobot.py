"""Local Docker fixture: deliver Telegram updates to the real Filmobot application."""
import asyncio
import base64
import hashlib
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
from uuid import uuid4

sys.path.insert(0, "/app")

from telegram import Update
from telegram.request import HTTPXRequest

import bot
from database import init_db

SENDER = {"id": 1000, "is_bot": True, "first_name": "Jarvis", "username": "jarvis_bot"}
RECEIVER = {"id": 2000, "is_bot": True, "first_name": "Filmobot", "username": "filmobot_bot"}


class TelegramFixture:
    def __init__(self, watch):
        self.watch = watch
        self.app = None
        self.update_id = 0
        self.receipt = None
        self.body = b""
        self.file_id = None

    async def restart(self):
        if self.app:
            await self.app.shutdown()
        self.app = bot.build_application("2000:local-test", None)
        await self.app.initialize()

    async def telegram(self, url, request_data=None, **kwargs):
        if url.endswith("/getMe"):
            result = RECEIVER
        elif url.endswith("/getFile") and request_data.parameters["file_id"] == self.file_id:
            result = {"file_id": self.file_id, "file_unique_id": self.file_id,
                      "file_size": len(self.body), "file_path": f"documents/{self.file_id}"}
        elif self.file_id and url.endswith(f"/documents/{self.file_id}"):
            return 200, self.body
        elif url.endswith("/sendMessage"):
            data = request_data.parameters
            assert int(data["chat_id"]) == SENDER["id"]
            self.receipt = data["text"]
            result = {"message_id": self.update_id + 1, "date": 1, "chat": {"id": SENDER["id"], "type": "private"},
                      "from": RECEIVER, "text": self.receipt}
        else:
            raise AssertionError("Unexpected request to Telegram fixture")
        return 200, json.dumps({"ok": True, "result": result}).encode()

    async def send(self, payload):
        self.update_id += 1
        self.receipt = None
        self.body = base64.b64decode(payload["bytes"], validate=True)
        self.file_id = uuid4().hex
        digest = payload["digest"]
        message = {"message_id": self.update_id, "date": 1, "chat": {"id": SENDER["id"], "type": "private"},
                   "from": SENDER, "caption": f"jarvis.torrent/1 {payload['command']} {digest}",
                   "document": {"file_id": self.file_id, "file_unique_id": self.file_id, "file_name": "input.torrent",
                                "file_size": len(self.body)}}
        update = Update.de_json({"update_id": self.update_id, "message": message}, self.app.bot)
        await self.app.process_update(update)
        files = list(self.watch.glob("*.torrent"))
        stored = next((p for p in files if p.name == f"jarvis-{digest}.torrent"), None)
        return {"text": self.receipt, "files": len(files),
                "storedDigest": hashlib.sha256(stored.read_bytes()).hexdigest() if stored else None}


def handler(fixture, loop):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):
            pass

        def respond(self, status, data):
            encoded = json.dumps(data).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

        def do_GET(self):
            if self.path == "/health":
                self.respond(200, {"ready": True})
            else:
                self.respond(404, {})

        def do_POST(self):
            try:
                if self.path == "/send":
                    length = int(self.headers.get("Content-Length", 0))
                    if not 0 < length <= 24 * 1024 * 1024:
                        return self.respond(400, {})
                    payload = json.loads(self.rfile.read(length))
                    result = loop.run_until_complete(fixture.send(payload))
                elif self.path == "/consume":
                    for torrent in fixture.watch.glob("*.torrent"):
                        torrent.unlink()
                    result = {"files": 0}
                elif self.path == "/restart":
                    loop.run_until_complete(fixture.restart())
                    result = {"ready": True}
                else:
                    return self.respond(404, {})
                self.respond(200, result)
            except Exception as exc:
                self.respond(500, {"error": type(exc).__name__, "message": str(exc)})
    return Handler


def main():
    if os.getenv("DB_NAME") != "jarvis_test" or os.getenv("DB_HOST") != "db":
        raise RuntimeError("Bridge requires the isolated db/jarvis_test database")
    init_db()
    with TemporaryDirectory() as folder, asyncio.Runner() as runner:
        fixture = TelegramFixture(Path(folder))
        with (patch.object(bot, "JARVIS_BOT_IDS", frozenset({SENDER["id"]})),
              patch.object(bot, "TORRENT_SAVE_PATH", folder),
              patch.object(HTTPXRequest, "do_request", side_effect=fixture.telegram)):
            runner.run(fixture.restart())
            try:
                with HTTPServer(("0.0.0.0", 8080), handler(fixture, runner.get_loop())) as server:
                    server.serve_forever()
            finally:
                runner.run(fixture.app.shutdown())


if __name__ == "__main__":
    main()
