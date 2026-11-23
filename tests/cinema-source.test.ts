import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { downloadTorrent, searchReleases } from "../src/cinema/rutor.ts";

// Keep the original key order and non-UTF-8 piece hashes to catch hashing a re-encoded dictionary.
const info = Buffer.concat([
  Buffer.from("d6:pieces20:"), Buffer.alloc(20, 0xff),
  Buffer.from("4:name7:fixture6:lengthi1e12:piece lengthi16384ee")
]);
const torrent = Buffer.concat([Buffer.from("d7:comment4:info4:info"), info, Buffer.from("e")]);
const hash = createHash("sha1").update(info).digest("hex");
const title = "Космос & Земля «Луна»";

function row(id: number): string {
  return '<tr class="gai"><td>20 Ноя 26<td>' +
    '<a href="//d.rutor.info/download/' + id + '"><img src="/s/download.gif"></a> ' +
    '<a href="magnet:?dn=test&amp;xt=urn%3Abtih%3A' + hash.toUpperCase() + '"><img src="/s/magnet.gif"></a> ' +
    '<a href="/torrent/' + id + '/film">Космос &amp; Земля &laquo;<b>Луна</b>&raquo;</a>' +
    '<td>3<td>2.9 GB<td><span class="green"><img src="/s/up.gif">1&nbsp;042</span> ' +
    '<span class="red"><img src="/s/down.gif">0</span>';
}

test("RuTor extracts releases from imperfect HTML in tracker order and encodes the search as one path segment", async () => {
  const search = "Космос / 2?x=1 #";
  const releases = await searchReleases(search, 1, async (input, init) => {
    assert.equal(String(input), "https://rutor.is/search/0/0/100/2/" + encodeURIComponent(search) + "/");
    assert.equal(init?.redirect, "manual");
    assert.ok(init?.signal);
    return new Response('<div id="index"><table><tr><th>Размер' + row(42) + row(43) + "</table></div>");
  });
  assert.deepEqual(releases, [{ releaseId: "rutor:42", title, size: "2.9 GB", seeds: 1042, leeches: 0, infoHash: hash }]);
});

test("RuTor distinguishes an explicit empty result from missing or unrecognizable rows", async () => {
  const results = (page: string) => searchReleases("Кино", 5, async () => new Response(page));
  assert.deepEqual(await results('<h2>Результатов поиска 0</h2><div id="index"><table></table></div>'), []);
  await assert.rejects(results("<title>Результатов поиска 0</title>"), /страницу результатов/);
  await assert.rejects(results('<div id="index"><table>' + row(1).replace(hash.toUpperCase(), "invalid") + "</table></div>"), /страницу результатов/);
});

test("RuTor retries a connection failure on the search mirror", async () => {
  const hosts: string[] = [];
  await searchReleases("Кино", 1, async input => {
    hosts.push(new URL(String(input)).hostname);
    if (hosts.length === 1) throw new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } });
    return new Response('<table id="index">' + row(7) + "</table>");
  });
  assert.deepEqual(hosts, ["rutor.is", "rutor.info"]);
});

test("RuTor downloads the selected release and hashes its original binary info dictionary", async () => {
  const calls: string[] = [];
  const downloaded = await downloadTorrent("rutor:42", hash, async (input, init) => {
    calls.push(String(input));
    assert.equal(init?.redirect, "manual");
    assert.ok(init?.signal);
    return calls.length === 1
      ? new Response(null, { status: 302, headers: { location: "https://d.rutor.is/file/42" } })
      : new Response(Uint8Array.from(torrent));
  });
  assert.deepEqual(calls, ["https://d.rutor.info/download/42", "https://d.rutor.is/file/42"]);
  assert.deepEqual(downloaded, torrent);
  await assert.rejects(downloadTorrent("rutor:42", "0".repeat(40), async () => new Response(Uint8Array.from(torrent))), /Infohash/);
});

test("RuTor rejects malformed or ambiguous metadata", async () => {
  for (const data of [
    Buffer.from("<html>Ошибка</html>"), Buffer.from("d4:infodee"), Buffer.from("d4:infol1:aee"),
    torrent.subarray(0, torrent.length - 1), Buffer.concat([torrent, Buffer.from("other")]),
    Buffer.concat([torrent.subarray(0, -1), Buffer.from("4:info"), info, Buffer.from("e")])
  ]) {
    await assert.rejects(downloadTorrent("rutor:42", hash, async () => new Response(Uint8Array.from(data))), /метаданные/);
  }
});

test("RuTor refuses redirects outside the download origins before following them", async () => {
  for (const location of ["http://d.rutor.info/file", "https://example.org/file", "https://user@d.rutor.info/file", "https://d.rutor.info:8000/file"]) {
    let requests = 0;
    await assert.rejects(downloadTorrent("rutor:42", hash, async () => {
      requests++;
      return new Response(null, { status: 307, headers: { location } });
    }), /перенаправления/);
    assert.equal(requests, 1);
  }
});

test("RuTor stops reading when the torrent body crosses 16 MiB without a Content-Length header", async () => {
  let cancelled = false;
  const chunk = new Uint8Array(1024 * 1024);
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(chunk); },
    cancel() { cancelled = true; }
  });
  await assert.rejects(downloadTorrent("rutor:42", hash, async () => new Response(stream)), /размер/);
  assert.ok(cancelled);
});

test("RuTor validates identifiers and search bounds before issuing requests", async () => {
  const unexpectedFetch: typeof fetch = async () => assert.fail("unexpected network request");
  await assert.rejects(searchReleases(" ", 5, unexpectedFetch), /параметры/);
  await assert.rejects(searchReleases("фильм", 6, unexpectedFetch), /параметры/);
  await assert.rejects(downloadTorrent("rutor:42/other", hash, unexpectedFetch), /идентификатор/);
  await assert.rejects(downloadTorrent("rutor:42", "", unexpectedFetch), /идентификатор/);
});
