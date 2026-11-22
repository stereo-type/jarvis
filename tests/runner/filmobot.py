"""Тестовый сервер: настоящие маршруты, PostgreSQL, проверка infohash и публикация в watch-папку."""
import asyncio
import os
from pathlib import Path
from unittest.mock import patch

import httpx
from aiohttp import web
from database import DownloadHistory, init_db
from filmobot_api import create_api
from release_service import ReleaseService
from test_rutor import TORRENT, results_page
import torrent_rutor

folder = Path("/tmp/filmobot-test-watch")
folder.mkdir(exist_ok=True)
real_client = httpx.Client
real_async_client = httpx.AsyncClient


def mock_search(request):
    return httpx.Response(200, content=results_page(2))


def mock_download(request):
    return httpx.Response(200, content=TORRENT)


init_db()
app = create_api(ReleaseService(folder), os.environ["FILMOBOT_SERVICE_TOKEN"], frozenset({42}))
state = {"requests": [], "files": 0, "hold": False, "lost": 0}


@web.middleware
async def watch(request, handler):
    if request.path == "/fixture":
        if request.method == "POST":
            if request.query.get("fault") == "unavailable":
                state["lost"] = 3
            else:
                state["hold"] = True
        return web.json_response({**state, "history": DownloadHistory.select().count()})
    response = await handler(request)
    if request.path == "/v1/downloads" and response.status == 201:
        state["requests"].append(request.headers["Idempotency-Key"])
        for file in folder.glob("*.torrent"):
            assert file.read_bytes() == TORRENT
            file.unlink()
            state["files"] += 1
        if state["hold"]:
            state["hold"] = False
            await asyncio.sleep(10)
        if state["lost"]:
            state["lost"] -= 1
            # Первый ответ затерялся за proxy, следующие повторы попадают под ограничение.
            return web.Response(status=503 if state["lost"] == 2 else 429, headers={"Retry-After": "5"})
    return response


app.middlewares.insert(0, watch)
with patch.object(torrent_rutor.httpx, "AsyncClient", side_effect=lambda **kw: real_async_client(
        transport=httpx.MockTransport(mock_search))), patch.object(torrent_rutor.httpx, "Client",
        side_effect=lambda **kw: real_client(transport=httpx.MockTransport(mock_download))):
    web.run_app(app, port=8080)
