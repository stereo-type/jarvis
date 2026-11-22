import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createQueueIO } from "../src/n8n/io.ts";
import type { QueueNode } from "../src/n8n/graph.ts";

const node: QueueNode = {
  id: "n1", name: "Test", type: "n8n-nodes-base.googleSheets", typeVersion: 4,
  position: [0, 0], on: {}, parameters: {},
  credentials: {
    googleSheetsOAuth2Api: { id: "old", name: "Google Sheets account" },
    telegramApi: { id: "tg", name: "Telegram account" },
  },
};

test("test adapters isolate each run and persist mapped fields within it", async () => {
  const first = createQueueIO("test");
  const doc = first.env.GOOGLE_SHEET_ID!;
  await first.io.updateSheet(node, doc, "tasks", "ID", { ID: "TEST-1", Status: "IN_REVIEW" });
  assert.equal((await first.io.readSheet(node, doc, "tasks"))[0]!.Status, "IN_REVIEW");
  const second = createQueueIO("test");
  assert.equal((await second.io.readSheet(node, doc, "tasks"))[0]!.Status, "NEW");
  await assert.rejects(second.io.http(node, "POST", "http://example.invalid/execute", {}), /destination/);
});

test("live adapters bind credentials, task cells, and HTTP destinations", async t => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-n8n-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "credentials.json");
  await writeFile(file, JSON.stringify([
    { id: "new", name: "Google Sheets account", type: "googleSheetsOAuth2Api", data: {
      clientId: "fixture-client", clientSecret: "fixture-secret", oauthTokenData: { refresh_token: "fixture-refresh" },
    } },
    { id: "tg", name: "Telegram account", type: "telegramApi", data: { accessToken: "123:fixture" } },
  ]));
  let redirect = false;
  let coderCalls = 0;
  let receivedToken: unknown;
  const server = createServer(async (req, res) => {
    coderCalls++;
    let raw = "";
    for await (const chunk of req) raw += chunk.toString();
    receivedToken = JSON.parse(raw).token;
    if (redirect) res.writeHead(307, { Location: "/redirected" });
    res.end(JSON.stringify({ status: "PR_CREATED" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const settings = {
    JARVIS_N8N_LIVE_ENABLED: "true", JARVIS_N8N_CREDENTIALS_FILE: file,
    JARVIS_N8N_CODER_ORIGIN: `http://127.0.0.1:${address.port}`, JARVIS_N8N_MANAGER_ORIGIN: "http://manager",
    GOOGLE_SHEET_ID: "test-doc", ADMIN_CHAT_ID: "42", GITHUB_TOKEN: "private-fixture-token",
    JARVIS_N8N_PROJECT_TOKEN_NAMES: "", JARVIS_N8N_GIT_ORIGINS: "",
  };
  const saved = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]));
  Object.assign(process.env, settings);
  t.after(() => { for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  } });
  const { io, env } = createQueueIO("live");
  assert.ok(env.GITHUB_TOKEN && env.GITHUB_TOKEN !== settings.GITHUB_TOKEN);
  assert.equal(env.JARVIS_N8N_CREDENTIALS_FILE, undefined);
  const payload = { taskId: "TASK-1", owner: "example", repo: "demo", platform: "github", baseUrl: "", token: env.GITHUB_TOKEN };
  const coder = "http://assistant-coder:3000/execute";
  await assert.rejects(io.http(node, "POST", coder, { ...payload, baseUrl: "https://example.invalid" }), /Git origin/);
  await assert.rejects(io.http(node, "POST", coder + "?test", payload), /destination/);
  await assert.rejects(io.http(node, "DELETE", "http://assistant-coder:3000/session/../execute", undefined), /destination/);
  assert.deepEqual(await io.http(node, "POST", coder, payload), { status: "PR_CREATED" });
  assert.equal(receivedToken, settings.GITHUB_TOKEN);
  redirect = true;
  await assert.rejects(io.http(node, "POST", coder, payload), /HTTP 307/);
  assert.equal(coderCalls, 2);

  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    calls.push(url);
    assert.equal(init.redirect, "error");
    if (url === "https://oauth2.googleapis.com/token") {
      assert.equal((init.body as URLSearchParams).get("refresh_token"), "fixture-refresh");
      return Response.json({ access_token: "fixture-access", expires_in: 3600 });
    }
    if (url.endsWith("/values:batchUpdate")) {
      assert.deepEqual(JSON.parse(String(init.body)), { valueInputOption: "RAW", data: [
        { range: "'tasks'!C4", values: [["IN_REVIEW"]] }, { range: "'tasks'!D4", values: [[""]] },
      ] });
      return Response.json({});
    }
    if (url.startsWith("https://sheets.googleapis.com/")) {
      assert.equal(new Headers(init.headers).get("authorization"), "Bearer fixture-access");
      return Response.json({ values: [["ID", "Formula", "Status", "ReviewerComment"], ["OTHER"], [], ["TASK-1", "=1+1", "NEW"]] });
    }
    assert.equal(url, "https://api.telegram.org/bot123:fixture/sendMessage");
    return Response.json({ ok: true });
  });
  const row = { ID: "TASK-1", Status: "IN_REVIEW", ReviewerComment: "" };
  await assert.rejects(io.updateSheet(node, "other", "tasks", "ID", row), /outside/);
  assert.deepEqual(await io.updateSheet(node, "test-doc", "tasks", "ID", row), row);
  await assert.rejects(io.telegram(node, "other", "test", {}), /outside/);
  await io.telegram(node, "42", "test", {});
  assert.equal(calls.length, 4);
});
