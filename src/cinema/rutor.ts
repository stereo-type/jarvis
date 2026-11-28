import { createHash } from "node:crypto";
import { load } from "cheerio/slim";
import { fetchTracker } from "./tracker-fetch.ts";

export interface Release {
  releaseId: string;
  title: string;
  size: string;
  seeds: number;
  leeches: number;
  infoHash: string;
}

const searchOrigins = ["https://rutor.is", "https://rutor.info"] as const;
const downloadOrigins = ["https://d.rutor.info", "https://d.rutor.is"] as const;
const maxTorrentBytes = 16 * 1024 * 1024;
const maxSearchBytes = 2 * 1024 * 1024;

export class TrackerError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

function trackerError(error: unknown): TrackerError {
  if (error instanceof TrackerError) return error;
  const cause = error instanceof Error ? error.cause as NodeJS.ErrnoException | undefined : undefined;
  const code = cause?.code ?? '';
  if (['ENOTFOUND','EAI_AGAIN'].includes(code)) return new TrackerError('RUTOR_DNS','DNS не вернул адрес RuTor.',true);
  if (error instanceof Error && error.name==='TimeoutError' || ['UND_ERR_CONNECT_TIMEOUT','ETIMEDOUT'].includes(code))
    return new TrackerError('RUTOR_TIMEOUT','Истекло время ожидания ответа RuTor.',true);
  if (/CERT|TLS|SSL/.test(code)) return new TrackerError('RUTOR_TLS','Ошибка защищённого соединения с RuTor.');
  return new TrackerError('RUTOR_NETWORK','Не удалось получить ответ от RuTor.',true);
}

async function readLimited(response: Response, limit: number): Promise<Buffer> {
  if (!response.body) throw new TrackerError('RUTOR_RESPONSE',"Пустой ответ RuTor.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    if (Number(response.headers.get("content-length")) > limit) throw new TrackerError('RUTOR_RESPONSE',"Ответ RuTor превышает допустимый размер.");
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > limit) throw new TrackerError('RUTOR_RESPONSE',"Ответ RuTor превышает допустимый размер.");
      chunks.push(chunk.value);
    }
    return Buffer.concat(chunks, length);
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

async function getBytes(url: URL, origins: readonly string[], limit: number, signal: AbortSignal, fetcher: typeof fetch): Promise<Buffer> {
  for (let redirects = 0; redirects <= 3; redirects++) {
    if (!origins.includes(url.origin) || url.username || url.password) throw new TrackerError('RUTOR_REDIRECT',"Неизвестный адрес перенаправления RuTor.");
    const response = await fetcher(url, { redirect: "manual", signal });
    if (response.status === 200) return readLimited(response, limit);
    await response.body?.cancel();
    const location = response.headers.get("location");
    if (![301, 302, 303, 307, 308].includes(response.status) || !location)
      throw new TrackerError('RUTOR_HTTP_'+response.status,"Ошибка HTTP RuTor " + response.status,response.status>=500 || response.status===408);
    url = new URL(location, url);
  }
  throw new TrackerError('RUTOR_REDIRECT',"Слишком много перенаправлений RuTor.");
}

function peerCount(value: string): number | undefined {
  const digits = value.replace(/\s/g, "");
  const count = Number(digits);
  if (/^\d+$/.test(digits) && Number.isSafeInteger(count)) return count;
}

function parseResults(html: Buffer, limit: number): Release[] {
  const $ = load(html.toString("utf8"));
  const table = $("#index").first();
  const results: Release[] = [];
  for (const row of table.find("tr").toArray()) {
    const cells = $(row).children("td");
    const link = $(row).find('a[href^="/torrent/"]').first();
    const id = /^\/torrent\/(\d+)(?:\/.*)?$/.exec(link.attr("href") ?? "")?.[1];
    const magnet = $(row).find('a[href^="magnet:?"]').first().attr("href");
    if (cells.length < 4 || !id || !magnet) continue;
    const xt = new URLSearchParams(magnet.slice("magnet:?".length)).getAll("xt").find(value => /^urn:btih:[a-f0-9]{40}$/i.test(value));
    const seeds = peerCount($(row).find(".green").first().text());
    const leeches = peerCount($(row).find(".red").first().text());
    const title = link.text().replace(/\s+/g, " ").trim();
    const size = cells.eq(-2).text().trim();
    if (!xt || !title || !size || seeds === undefined || leeches === undefined) continue;
    results.push({ releaseId: "rutor:" + id, title, size, seeds, leeches, infoHash: xt.slice(9).toLowerCase() });
    if (results.length === limit) break;
  }
  if (results.length || (table.length && /Результатов поиска\s+0\b/i.test($.root().text()))) return results;
  throw new TrackerError('RUTOR_RESPONSE',"Не удалось прочитать страницу результатов RuTor.");
}

export async function searchReleases(query: string, limit: number, fetcher: typeof fetch = fetchTracker): Promise<Release[]> {
  const term = query.trim();
  if (!term || term.length > 200 || !Number.isInteger(limit) || limit < 1 || limit > 5) throw new Error("Некорректные параметры поиска.");
  // A segment of only one or two dots would be normalized by URL before sending.
  const path = "/search/0/0/100/2/" + encodeURIComponent(/^\.{1,2}$/.test(term) ? term + " " : term) + "/";
  const request = (origin: string) => getBytes(new URL(path, origin), searchOrigins, maxSearchBytes, AbortSignal.timeout(20_000), fetcher);
  let lastError: TrackerError | undefined;
  for (const origin of searchOrigins) {
    try { return parseResults(await request(origin),limit); }
    catch (error) { lastError=trackerError(error); }
  }
  throw lastError;
}

function invalidMetadata(): never {
  throw new Error("RuTor вернул повреждённые метаданные .torrent.");
}

// Skip values in place so that binary strings and the original ordering of info keys survive hashing.
function torrentInfo(data: Buffer): Buffer {
  let pos = 0;
  const dictionary = 0x64, list = 0x6c, integer = 0x69, end = 0x65, colon = 0x3a;
  const digit = (at: number) => data[at] !== undefined && data[at]! >= 0x30 && data[at]! <= 0x39;
  function bytes(): Buffer {
    if (!digit(pos)) invalidMetadata();
    const first = pos;
    let length = 0;
    while (digit(pos)) {
      length = length * 10 + data[pos++]! - 0x30;
      if (length > data.length) invalidMetadata();
    }
    if ((data[first] === 0x30 && pos - first > 1) || data[pos++] !== colon || length > data.length - pos) invalidMetadata();
    const value = data.subarray(pos, pos + length);
    pos += length;
    return value;
  }
  function skip(depth: number): void {
    if (depth > 80) invalidMetadata();
    const type = data[pos];
    if (digit(pos)) {
      bytes();
    } else if (type === integer) {
      pos++;
      const negative = data[pos] === 0x2d;
      if (negative) pos++;
      if (!digit(pos) || (data[pos] === 0x30 && (negative || digit(pos + 1)))) invalidMetadata();
      while (digit(pos)) pos++;
      if (data[pos++] !== end) invalidMetadata();
    } else if (type === list || type === dictionary) {
      pos++;
      while (data[pos] !== end) {
        if (type === dictionary) bytes();
        skip(depth + 1);
      }
      pos++;
    } else {
      invalidMetadata();
    }
  }
  function infoDictionary(): Buffer {
    const first = pos;
    if (data[pos++] !== dictionary) invalidMetadata();
    const required = new Set(["name", "piece length", "pieces"]);
    while (data[pos] !== end) {
      const key = bytes();
      if (key.length <= 12) {
        const field = key.toString("latin1");
        if (field === "name" || field === "piece length" || field === "pieces") {
          const expectedType = field === "piece length" ? data[pos] === integer : digit(pos);
          if (!required.delete(field) || !expectedType) invalidMetadata();
        }
      }
      skip(1);
    }
    pos++;
    if (required.size) invalidMetadata();
    return data.subarray(first, pos);
  }

  if (data[pos++] !== dictionary) invalidMetadata();
  let info: Buffer | undefined;
  while (data[pos] !== end) {
    const key = bytes();
    if (key.length === 4 && key.toString("latin1") === "info") {
      if (info) invalidMetadata();
      info = infoDictionary();
    } else {
      skip(1);
    }
  }
  if (++pos !== data.length || !info) invalidMetadata();
  return info;
}

export async function downloadTorrent(releaseId: string, infoHash: string, fetcher: typeof fetch = fetchTracker): Promise<Buffer> {
  if (!/^rutor:\d+$/.test(releaseId) || !/^[a-f0-9]{40}$/i.test(infoHash)) throw new Error("Некорректный идентификатор раздачи.");
  const url = new URL("/download/" + releaseId.slice(6), downloadOrigins[0]);
  const data = await getBytes(url, downloadOrigins, maxTorrentBytes, AbortSignal.timeout(30_000), fetcher);
  if (createHash("sha1").update(torrentInfo(data)).digest("hex") !== infoHash.toLowerCase()) {
    throw new Error("Infohash файла RuTor отличается от выбранной раздачи.");
  }
  return data;
}
