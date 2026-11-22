import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { loadCatalog } from '../src/config/catalog.ts';
import { validateWorkflow } from '../src/config/workflow.ts';

const connectionPath = resolve('examples/services/filmobot.connection.json');
const apiPath = resolve('examples/services/filmobot.openapi.json');
const workflowPath = resolve('examples/workflows/cinema-search.json');
const graphFile = await readFile(workflowPath, 'utf8');
const apiFile = await readFile(apiPath, 'utf8');
const connectionFile = await readFile(connectionPath, 'utf8');
const catalog = await loadCatalog(connectionPath);

test('настоящий граф проходит без переменных окружения и соединения с Filmobot', () => {
  assert.deepEqual([...catalog.operations.keys()], ['searchReleases', 'enqueueDownload']);
  assert.deepEqual(validateWorkflow(JSON.parse(graphFile), catalog, workflowPath), {
    id: 'cinema.search-and-download', revision: 1, nodes: 11,
  });
  const result = spawnSync(process.execPath, ['src/validate.ts', connectionPath, workflowPath], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /проверено узлов — 11/);
});

test('значения, операция, схема и переходы проверяются перед публикацией', () => {
  const cases: [string, (g: MutableGraph) => void, RegExp][] = [
    ['лимит', g => { g.nodes[1]!.args = { query: 'Солярис', limit: 8 }; }, /search.args.limit/],
    ['пропуск', g => { g.nodes[1]!.args = { limit: 5 }; }, /аргумент query/],
    ['тип', g => { g.nodes[1]!.args = { query: 7 }; }, /search.args.query/],
    ['лишний аргумент', g => { g.nodes[1]!.args = { query: 'Солярис', other: 1 }; }, /аргумент other/],
    ['неизвестная операция', g => { g.nodes[1]!.operationId = 'missing'; }, /search.*missing/],
    ['major', g => { g.nodes[1]!.apiMajor = 2; }, /filmobot\/v2/],
    ['нет назначения', g => { g.nodes[0]!.on!.submit = 'missing'; }, /цели перехода missing/],
    ['обязательный порт', g => { delete g.nodes[0]!.on!.submit; }, /переход submit/],
    ['неизвестный порт', g => { g.nodes[0]!.on!.other = 'search'; }, /порт other/],
    ['ссылка вперёд', g => { g.nodes[1]!.args = { query: { $ref: 'choose.value' } }; }, /choose.value/],
    ['неверный тип ссылки', g => { g.nodes[4]!.args.releaseId = { $ref: 'search.releases' }; }, /enqueue.args.releaseId/],
    ['ссылка после слияния', g => { g.nodes[10]!.receipt = { $ref: 'search.searchId' }; }, /failure.*search.searchId/],
    ['выход при ошибке', g => { g.nodes[1]!.on!.error = 'found'; }, /found.*search.releases/],
    ['поле выбора', g => { g.nodes[3]!.valueField = 'sizeMissing'; }, /choose.*sizeMissing/],
    ['UUID вместо срока выбора', g => { g.nodes[3]!.expiresAt = { $ref: 'search.searchId' }; }, /choose.*date-time/],
    ['цикл', g => { g.nodes[1]!.on!.success = 'search'; }, /цикл/],
    ['повтор id', g => { g.nodes[1]!.id = 'query'; }, /повтор id query/],
  ];
  for (const [label, change, expected] of cases) {
    const graph = JSON.parse(graphFile) as MutableGraph;
    change(graph);
    assert.throws(() => validateWorkflow(graph, catalog, workflowPath), expected, label);
  }
});

type MutableGraph = { nodes: Array<{
  id: string; on?: Record<string, string>; args: Record<string, unknown>; operationId?: string;
  apiMajor?: number; receipt?: { $ref: string }; valueField?: string; expiresAt?: { $ref: string }; requireIdempotency?: boolean;
}> };

test('длина запроса в кодовых точках соответствует OpenAPI', () => {
  const graph = JSON.parse(graphFile) as MutableGraph;
  graph.nodes[1]!.args.query = '🎬'.repeat(200);
  validateWorkflow(graph, catalog, workflowPath);
  graph.nodes[1]!.args.query = '🎬'.repeat(201);
  assert.throws(() => validateWorkflow(graph, catalog, workflowPath), /search.args.query/);
});

test('контракт разрешается рядом с connection, неподдерживаемые структуры отклоняются', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-contract-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'connection.json');
  await writeFile(file, connectionFile);
  const contract = join(dir, 'filmobot.openapi.json');
  const cases: [string, (api: ReturnType<typeof apiFixture>) => void, RegExp][] = [
    ['major', api => { api.info.version = '2.0.0'; }, /apiMajor/],
    ['неизвестная операция', api => { delete api.paths['/v1/releases']; }, /searchReleases/],
    ['path-параметр', api => { api.paths['/v1/{id}'] = api.paths['/v1/releases']!; delete api.paths['/v1/releases']; }, /фиксированный путь/],
    ['повтор операции', api => { api.paths['/v1/other'] = api.paths['/v1/releases']!; }, /повтор operationId/],
    ['внешняя ссылка', api => { api.components.schemas.SearchId = { $ref: 'https://invalid.example/schema' }; }, /внешняя ссылка/],
    ['цикл ссылок', api => { api.components.schemas.SearchId = { $ref: '#/components/schemas/SearchId' }; }, /цикл \$ref/],
    ['защита API', api => { api.security = []; }, /bearer/],
    ['actor', api => {
      const get = api.paths['/v1/releases']!.get!;
      get.parameters = get.parameters.filter(p => p.$ref !== '#/components/parameters/Actor');
    }, /searchReleases.*X-Jarvis-User-Id/],
    ['request ID', api => {
      const post = api.paths['/v1/downloads']!.post!;
      post.parameters = post.parameters.filter(p => p.$ref !== '#/components/parameters/RequestId');
    }, /enqueueDownload.*X-Request-Id/],
  ];
  for (const [label, change, expected] of cases) {
    const api = apiFixture();
    change(api);
    await writeFile(contract, JSON.stringify(api));
    await assert.rejects(loadCatalog(file), expected, label);
  }
  const api = apiFixture();
  const post = api.paths['/v1/downloads']!.post!;
  post.parameters = post.parameters.filter(p => p.name !== 'Idempotency-Key');
  delete post['x-jarvis-idempotency'];
  await writeFile(contract, JSON.stringify(api));
  const unprotected = await loadCatalog(file);
  const graph = JSON.parse(graphFile) as MutableGraph;
  assert.throws(() => validateWorkflow(graph, unprotected, workflowPath), /enqueue.*идемпотентность/);
  delete graph.nodes[4]!.requireIdempotency;
  validateWorkflow(graph, unprotected, workflowPath);
});

function apiFixture() {
  return JSON.parse(apiFile) as {
    info: { version: string }; paths: Record<string, Record<string, {
      parameters: { $ref?: string; name?: string }[]; 'x-jarvis-idempotency'?: string;
    }>>;
    components: { schemas: Record<string, unknown> }; security: unknown[];
  };
}

test('CLI возвращает ненулевой статус для неподходящего файла', () => {
  const result = spawnSync(process.execPath, ['src/validate.ts', connectionPath, apiPath], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /schemaVersion/);
});
