import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { executeQueue, type QueueIO, type QueueRow } from '../src/n8n/execute.ts';
import { importQueue } from '../src/n8n/graph.ts';

const fixture = new URL('./fixtures/queue_v9.json', import.meta.url);
async function loadQueue() {
  return importQueue(JSON.parse(await readFile(fixture, 'utf8')));
}

const env = { GOOGLE_SHEET_ID: 'fixture', PROJECT_TOKEN: 'private-fixture-value', ADMIN_CHAT_ID: '123' };

function harness(tasks: QueueRow[], coder: (task: QueueRow) => QueueRow = () => ({})) {
  const updates: QueueRow[] = [];
  const requests: { node: string; method: string; url: string; body: unknown }[] = [];
  const messages: string[] = [];
  const projects = [{ ID: 'project', TokenEnvVar: 'PROJECT_TOKEN', Owner: 'owner', Repo: 'repo' }];
  const io: QueueIO = {
    async readSheet(_node, doc, sheet) {
      assert.equal(doc, 'fixture');
      return sheet === 'projects' ? projects : tasks;
    },
    async updateSheet(_node, _doc, sheet, key, values) {
      assert.equal(sheet, 'tasks');
      assert.equal(key, 'ID');
      updates.push(values);
      return values;
    },
    async http(node, method, url, body) {
      requests.push({ node: node.name, method, url, body });
      return node.name === 'Call Coder' ? coder(body as QueueRow) : {};
    },
    async telegram(_node, chat, text) {
      assert.equal(chat, '123');
      messages.push(text);
      return {};
    },
  };
  return { io, updates, requests, messages };
}

test('queue_v9 links each task across ready, stalled, HTTP and sheet branches', async () => {
  const graph = await loadQueue();
  const old = '2000-01-01T00:00:00Z';
  const { io, updates, requests } = harness([
    { ID: 'A', Status: 'NEW', ProjectID: 'project', Title: 'first' },
    { ID: 'B', Status: 'NEEDS_REVISION', ProjectID: 'project', ReviewerComment: 'fix typo' },
    { ID: 'A1', Status: 'NEW', ParentTaskID: 'A', Title: 'child' },
    { ID: 'blocked', Status: 'NEW', DependsOn: 'missing' },
    { ID: 'retry', Status: 'IN_PROGRESS', StartDatetime: old, RetryCount: '1' },
    { ID: 'stalled', Status: 'IN_PROGRESS', StartDatetime: old, RetryCount: '3' },
  ], task => task.taskId === 'A' ? { status: 'PR_CREATED', prUrl: 'https://example.invalid/pull/17' } : { status: 'FAILED', rateLimited: true, resetAt: 'later' });
  const result = await executeQueue(graph, io, env);
  assert.equal(result.status, 'done', result.error);
  assert.equal(result.steps, result.trace.length);
  assert.deepEqual(updates.map(r => [r.ID, r.Status]).sort(), [
    ['A', 'IN_PROGRESS'], ['A', 'IN_REVIEW'], ['B', 'IN_PROGRESS'], ['B', 'RATE_LIMITED'], ['retry', 'NEW'], ['stalled', 'STALLED'],
  ].sort());
  assert.equal(updates.find(r => r.Status === 'IN_REVIEW')?.PrNumber, '17');
  assert.equal(updates.find(r => r.Status === 'RATE_LIMITED')?.RetryAfter, 'later');
  assert.equal(updates.find(r => r.Status === 'NEW')?.RetryCount, '2');
  const inputs = requests.filter(r => r.node === 'Call Coder').map(r => r.body as QueueRow);
  assert.deepEqual(inputs.map(r => r.taskId), ['A', 'B']);
  assert.deepEqual(inputs[0]?.subTasks, [{ id: 'A1', title: 'child', description: '' }]);
  assert.equal(inputs[1]?.reviewComment, 'fix typo');
  assert.equal(inputs[0]?.token, env.PROJECT_TOKEN);
  assert.ok(requests.some(r => r.method === 'DELETE' && r.url.endsWith('/retry')));
  assert.ok(requests.some(r => r.method === 'DELETE' && r.url.endsWith('/B')));
  assert.ok(!JSON.stringify(result).includes(env.PROJECT_TOKEN));
});

test('queue_v9 honors empty sheet output and stored Code edits', async () => {
  const graph = await loadQueue();
  const { io, requests, updates } = harness([]);
  const initial = await executeQueue(graph, io, env);
  assert.equal(initial.status, 'done', initial.error);
  assert.ok(initial.trace.some(s => s.node === 'No Tasks Ready'));
  assert.equal(requests.length, 0);
  assert.equal(updates.length, 0);

  graph.nodes.find(n => n.name === 'Filter Ready Tasks')!.parameters.jsCode =
    "return [{ json: { ID: 'injected', skip: false } }];";
  const edited = await executeQueue(graph, io, env);
  assert.equal(edited.status, 'done', edited.error);
  assert.equal(updates[0]?.ID, 'injected');
});

test('queue_v9 takes switch fallback after a continued HTTP failure', async () => {
  const graph = await loadQueue();
  const { io, requests, updates } = harness([{ ID: 'A', Status: 'NEW' }], () => { throw new Error(env.PROJECT_TOKEN); });
  const result = await executeQueue(graph, io, env);
  assert.equal(result.status, 'done', result.error);
  assert.ok(result.trace.some(s => s.node === 'Call Coder' && s.status === 'continued'));
  assert.equal(updates.at(-1)?.Status, 'FAILED');
  assert.ok(requests.some(r => r.node === 'Notify Manager FAILED'));
  assert.ok(!JSON.stringify([result, updates]).includes(env.PROJECT_TOKEN));
});

test('editing a stored Switch comparison changes the downstream sheet write', async () => {
  const graph = await loadQueue();
  const switchNode = graph.nodes.find(n => n.name === 'Switch On Result')!;
  const rules = switchNode.parameters.rules as { values: { conditions: { conditions: { rightValue: string }[] } }[] };
  rules.values[0]!.conditions.conditions[0]!.rightValue = 'CUSTOM_SUCCESS';
  const { io, updates, requests } = harness([{ ID: 'A', Status: 'NEW' }], () => ({ status: 'CUSTOM_SUCCESS' }));
  const result = await executeQueue(graph, io, env);
  assert.equal(result.status, 'done', result.error);
  assert.equal(updates.at(-1)?.Status, 'IN_REVIEW');
  assert.ok(!requests.some(r => r.node === 'Notify Manager FAILED'));
});

test('queue_v9 enforces strict IF conditions and alerts with a safe diagnostic', async () => {
  const graph = await loadQueue();
  graph.nodes.find(n => n.name === 'Filter Ready Tasks')!.parameters.jsCode = "return [{ json: { skip: 'true' } }];";
  const { io, messages, updates } = harness([]);
  const result = await executeQueue(graph, io, env);
  assert.equal(result.status, 'failed');
  assert.match(result.error ?? '', /IF Skip.*Condition type mismatch/);
  assert.equal(updates.length, 0);
  assert.equal(messages.length, 1);
  assert.match(messages[0]!, /IF Skip/);
});

test('queue scripts have no host globals and are interrupted within the worker', async () => {
  const graph = await loadQueue();
  const filter = graph.nodes.find(n => n.name === 'Filter Ready Tasks')!;
  const { io, messages } = harness([]);
  filter.parameters.jsCode = "return [{ json: { skip: [typeof process, typeof require, typeof fetch].every(x => x === 'undefined') } }];";
  const isolated = await executeQueue(graph, io, env);
  assert.ok(isolated.trace.some(s => s.node === 'No Tasks Ready'));
  filter.parameters.jsCode = 'while (true) {}';
  const result = await executeQueue(graph, io, env);
  assert.equal(result.status, 'failed');
  assert.match(result.error ?? '', /Filter Ready Tasks/);
  assert.equal(messages.length, 1);
  assert.ok(!JSON.stringify([result, messages]).includes(env.PROJECT_TOKEN));
});
