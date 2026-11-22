import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import type { QueueIO, QueueRow } from "./execute.ts";
import { credentialResolver, readCredentialExport } from "./credential-export.ts";

type QueueNode = Parameters<QueueIO["readSheet"]>[0];
type Connections = { io: QueueIO; env: Record<string, string> };
const coderOrigin = "http://assistant-coder:3000";
const managerOrigin = "http://assistant-n8n:5678";
const managerPath = "/webhook/manager-task-complete";
const publicKeys = ["GOOGLE_SHEET_ID", "ADMIN_CHAT_ID", "GITHUB_OWNER", "PROJECT_REPO",
  "MAX_PARALLEL_TASKS", "MAX_STALL_RETRIES", "STALL_TIMEOUT_HOURS"];

function object(value: unknown): QueueRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object");
  return value as QueueRow;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`Missing ${label}`);
  return value;
}

function origin(value: string): string {
  const url = new URL(value);
  if (!["https:", "http:"].includes(url.protocol) || url.origin !== value.replace(/\/$/, "")) {
    throw new Error("Expected an HTTP(S) origin without a path or credentials");
  }
  return url.origin;
}

function route(method: string, raw: string, coder: string, manager: string) {
  const url = new URL(raw);
  // Match the original spelling too: URL parsing normalizes dot segments and backslashes.
  if (raw === url.origin + url.pathname) {
    if (url.origin === coderOrigin || url.origin === coder) {
      if (method === "POST" && url.pathname === "/execute") return { service: "coder", url: coder + url.pathname };
      if (method === "DELETE" && /^\/session\/[a-zA-Z0-9_-][a-zA-Z0-9._-]{0,159}$/.test(url.pathname)) {
        return { service: "session", url: coder + url.pathname };
      }
    }
    if ((url.origin === managerOrigin || url.origin === manager) && method === "POST" && url.pathname === managerPath) {
      return { service: "manager", url: manager + managerPath };
    }
  }
  throw new Error("HTTP method or destination is outside the queue configuration");
}

// Coder can take 15 minutes to send headers. Node fetch has a shorter headers timeout.
function postToCoder(url: string, body: BodyInit | null | undefined, signal: AbortSignal) {
  const request = url.startsWith("https:") ? httpsRequest : httpRequest;
  return new Promise<Response>((resolve, reject) => {
    const req = request(url, { method: "POST", headers: { "Content-Type": "application/json" }, signal }, incoming => {
      const code = incoming.statusCode ?? 502;
      const status = code >= 200 && code <= 599 ? code : 502;
      if (status >= 300 || status === 204 || status === 205) {
        incoming.destroy();
        resolve(new Response(null, { status }));
      } else {
        resolve(new Response(Readable.toWeb(incoming) as ReadableStream<Uint8Array>, { status }));
      }
    });
    req.on("error", reject);
    req.end(body);
  });
}

async function responseBody(service: string, response: Response, limit: number): Promise<QueueRow> {
  if (!response.body) return {};
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) {
        await reader.cancel();
        throw new Error();
      }
      chunks.push(value);
    }
    return size ? object(JSON.parse(Buffer.concat(chunks).toString("utf8"))) : {};
  } catch {
    throw new Error(`${service} returned an incomplete, oversized or invalid JSON response`);
  }
}

async function requestJson(service: string, url: string, init: RequestInit, timeout = 30_000): Promise<QueueRow> {
  let response: Response;
  try {
    const signal = AbortSignal.timeout(timeout);
    response = service === "coder" ? await postToCoder(url, init.body, signal) : await fetch(url, { ...init, redirect: "error", signal });
  } catch {
    throw new Error(`${service} request failed or timed out`);
  }
  if (response.ok) return responseBody(service, response, 8 * 1024 * 1024);
  if (service === "Google OAuth") {
    const error: QueueRow = await responseBody(service, response, 8192).catch(() => ({}));
    const codes = ["invalid_grant", "invalid_client", "invalid_scope", "unauthorized_client", "invalid_request", "temporarily_unavailable", "unsupported_grant_type", "access_denied"];
    if (typeof error.error === "string" && codes.includes(error.error)) throw new Error(`Google OAuth returned HTTP ${response.status} (${error.error})`);
  } else {
    await response.body?.cancel();
  }
  throw new Error(`${service} returned HTTP ${response.status}`);
}

function checkSheet(doc: string, sheet: string, configured: string, update = false) {
  if (doc !== configured || (sheet !== "tasks" && (update || sheet !== "projects"))) {
    throw new Error("Spreadsheet or sheet is outside the queue configuration");
  }
}

function createTest(): Connections {
  const env = { GOOGLE_SHEET_ID: "fixture", ADMIN_CHAT_ID: "42", GITHUB_OWNER: "example", PROJECT_REPO: "demo", GITHUB_TOKEN: "fixture-reference" };
  const sheets: Record<string, QueueRow[]> = {
    projects: [{ ID: "DEMO", Owner: "example", Repo: "demo", Platform: "github" }],
    tasks: [{ ID: "TEST-1", ProjectID: "DEMO", Title: "Проверить очередь", Description: "Тестовый запуск Jarvis", Status: "NEW" }],
  };
  return { env, io: {
    async readSheet(_node, doc, sheet) {
      checkSheet(doc, sheet, env.GOOGLE_SHEET_ID);
      return structuredClone(sheets[sheet]!);
    },
    async updateSheet(_node, doc, sheet, key, row) {
      checkSheet(doc, sheet, env.GOOGLE_SHEET_ID, true);
      const task = sheets[sheet]!.find(item => item[key] === row[key]);
      if (key !== "ID" || !row.ID || !task) throw new Error("Task ID missing from fixture");
      Object.assign(task, row);
      return structuredClone(row);
    },
    async http(_node, method, url) {
      const { service } = route(method, url, coderOrigin, managerOrigin);
      return service === "coder" ? { status: "PR_CREATED", prUrl: "https://github.com/example/demo/pull/1" } : { ok: true };
    },
    async telegram(_node, chat) {
      if (chat !== env.ADMIN_CHAT_ID) throw new Error("Telegram chat is outside the queue configuration");
      return { ok: true };
    },
  } };
}

function column(index: number): string {
  let letters = "";
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) {
    letters = String.fromCharCode(65 + (value - 1) % 26) + letters;
  }
  return letters;
}

function sheetsIO(configured: string, getCredential: ReturnType<typeof credentialResolver>): Pick<QueueIO, "readSheet" | "updateSheet"> {
  const access = new Map<QueueRow, { value: string; expires: number }>();
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(configured)}/values`;
  async function headers(node: QueueNode) {
    const data = getCredential(node, "googleSheetsOAuth2Api");
    let cached = access.get(data);
    if (!cached || cached.expires <= Date.now() + 60_000) {
      const tokenData = object(data.oauthTokenData);
      const body = new URLSearchParams({
        grant_type: "refresh_token", refresh_token: string(tokenData.refresh_token, "Google refresh token"),
        client_id: string(data.clientId, "Google client ID"), client_secret: string(data.clientSecret, "Google client secret"),
      });
      const token = await requestJson("Google OAuth", "https://oauth2.googleapis.com/token", { method: "POST", body });
      cached = { value: string(token.access_token, "Google access token"), expires: Date.now() + 1000 * Number(token.expires_in || 3600) };
      access.set(data, cached);
    }
    return { Authorization: `Bearer ${cached.value}`, "Content-Type": "application/json" };
  }
  async function table(node: QueueNode, doc: string, sheet: string) {
    checkSheet(doc, sheet, configured);
    const response = await requestJson("Google Sheets", base + "/" + encodeURIComponent(`'${sheet}'`), { headers: await headers(node) });
    const values: unknown = response.values ?? [];
    if (!Array.isArray(values) || !values.every(Array.isArray)) throw new Error("Invalid Google Sheets values");
    const names: string[] = (values[0] ?? []).map(String);
    const named = names.filter(Boolean);
    if (new Set(named).size !== named.length) throw new Error("Duplicate Google Sheets headers");
    const rows: QueueRow[] = values.slice(1).map(cells =>
      Object.fromEntries(names.flatMap((name, index) => name ? [[name, cells[index] ?? ""]] : [])));
    return { names, rows };
  }
  return {
    async readSheet(node, doc, sheet) { return (await table(node, doc, sheet)).rows; },
    async updateSheet(node, doc, sheet, key, row) {
      checkSheet(doc, sheet, configured, true);
      if (key !== "ID" || !row.ID) throw new Error("Google Sheets update requires a task ID");
      const { names, rows } = await table(node, doc, sheet);
      const matches = rows.flatMap((item, index) => String(item.ID) === String(row.ID) ? [index + 2] : []);
      if (matches.length !== 1) throw new Error("Task ID is missing or duplicated in Google Sheets");
      const data = Object.entries(row).filter(([name]) => name !== key).map(([name, value]) => {
        const index = names.indexOf(name);
        if (index < 0) throw new Error(`Missing Google Sheets column ${name}`);
        if (value != null && !["string", "number", "boolean"].includes(typeof value)) throw new Error("Invalid Google Sheets cell value");
        return { range: `'${sheet}'!${column(index)}${matches[0]}`, values: [[value ?? ""]] };
      });
      if (data.length) await requestJson("Google Sheets", base + ":batchUpdate", {
        method: "POST", headers: await headers(node), body: JSON.stringify({ valueInputOption: "RAW", data }),
      });
      return { ...row };
    },
  };
}

export function createSheetReader(configured: string, getCredential: ReturnType<typeof credentialResolver>): QueueIO["readSheet"] {
  return sheetsIO(configured, getCredential).readSheet;
}

function createLive(settings: NodeJS.ProcessEnv): Connections {
  if (settings.JARVIS_N8N_LIVE_ENABLED !== "true") throw new Error("Live queue execution is disabled");
  const configured = string(settings.GOOGLE_SHEET_ID, "GOOGLE_SHEET_ID");
  const chatId = string(settings.ADMIN_CHAT_ID, "ADMIN_CHAT_ID");
  const getCredential = credentialResolver(readCredentialExport(string(settings.JARVIS_N8N_CREDENTIALS_FILE, "JARVIS_N8N_CREDENTIALS_FILE")));
  const coder = origin(string(settings.JARVIS_N8N_CODER_ORIGIN, "JARVIS_N8N_CODER_ORIGIN"));
  const manager = origin(string(settings.JARVIS_N8N_MANAGER_ORIGIN, "JARVIS_N8N_MANAGER_ORIGIN"));
  const gitOrigins = new Set(["https://github.com", "https://gitlab.com", ...(settings.JARVIS_N8N_GIT_ORIGINS || "").split(",").filter(Boolean).map(origin)]);
  const env: Record<string, string> = Object.fromEntries(publicKeys.flatMap(key => settings[key] ? [[key, settings[key]!]] : []));
  const secrets = new Map<string, string>();
  const names = new Set(["GITHUB_TOKEN", ...(settings.JARVIS_N8N_PROJECT_TOKEN_NAMES || "").split(",").map(name => name.trim()).filter(Boolean)]);
  for (const name of names) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name) || publicKeys.includes(name)) throw new Error("Invalid project token environment name");
    const reference = "credential-" + randomUUID();
    const secret = string(settings[name], name);
    env[name] = reference;
    secrets.set(reference, secret);
  }
  return { env, io: {
    ...sheetsIO(configured, getCredential),
    async http(node, method, raw, body) {
      const { service, url } = route(method, raw, coder, manager);
      const timeout = Number(object(node.parameters.options || {}).timeout ?? 30_000);
      if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 900_000) throw new Error("Invalid HTTP timeout");
      let payload = body;
      let secret: string | undefined;
      if (service === "coder") {
        const input = object(body);
        secret = secrets.get(string(input.token, "coder token reference"));
        if (!secret) throw new Error("Unknown coder token reference");
        if ((input.platform !== "github" && input.platform !== "gitlab")
          || (input.baseUrl !== undefined && input.baseUrl !== "" && (typeof input.baseUrl !== "string" || !gitOrigins.has(input.baseUrl.replace(/\/$/, ""))))
          || ![input.owner, input.repo].every(part => typeof part === "string" && part.split("/").every(segment => /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(segment)))) {
          throw new Error("Invalid coder repository or Git origin");
        }
        if (!/^[a-zA-Z0-9_-][a-zA-Z0-9._-]{0,159}$/.test(string(input.taskId, "task ID"))) throw new Error("Invalid coder task ID");
        const fields = ["taskId", "taskTitle", "taskDescription", "chatId", "startDatetime", "projectId",
          "platform", "owner", "repo", "baseUrl", "subTasks", "reviewComment"];
        payload = { ...Object.fromEntries(fields.filter(key => Object.hasOwn(input, key)).map(key => [key, input[key]])), token: secret };
      }
      const init: RequestInit = { method };
      if (payload !== undefined && service !== "session") {
        init.headers = { "Content-Type": "application/json" };
        init.body = JSON.stringify(payload);
      }
      const result = await requestJson(service, url, init, timeout);
      if (secret && JSON.stringify(result).includes(secret)) throw new Error("Coder response contains a credential");
      return result;
    },
    async telegram(node, chat, text, options) {
      if (chat !== chatId) throw new Error("Telegram chat is outside the queue configuration");
      const token = string(getCredential(node, "telegramApi").accessToken, "Telegram bot token");
      if (!/^\d+:[\w-]+$/.test(token)) throw new Error("Invalid Telegram bot token");
      const result = await requestJson("Telegram", `https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chat, text, parse_mode: options.parse_mode }),
      });
      return { ok: result.ok === true };
    },
  } };
}

export function createQueueIO(mode: "test" | "live"): Connections {
  return mode === "test" ? createTest() : createLive(process.env);
}
