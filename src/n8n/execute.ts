import { getQuickJS } from 'quickjs-emscripten';
import type { QueueGraph, QueueNode } from './graph.ts';

export type QueueRow = Record<string, unknown>;

export interface QueueIO {
  readSheet(node: QueueNode, doc: string, sheet: string): Promise<QueueRow[]>;
  updateSheet(node: QueueNode, doc: string, sheet: string, key: string, row: QueueRow): Promise<QueueRow>;
  http(node: QueueNode, method: string, url: string, body: unknown): Promise<QueueRow>;
  telegram(node: QueueNode, chat: string, text: string, options: QueueRow): Promise<QueueRow>;
}

export interface QueueStep {
  nodeId: string;
  node: string;
  input: number;
  output: number;
  status: 'done' | 'continued' | 'failed';
}

export interface QueueResult {
  status: 'done' | 'failed';
  steps: number;
  trace: QueueStep[];
  error?: string;
}

const maxSteps = 512;
const maxItems = 2048;
const maxOutputBytes = 1024 * 1024;
const maxContextBytes = 6 * maxOutputBytes;
const maxRunBytes = 32 * maxOutputBytes;

class QueueError extends Error {}

function row(value: unknown): QueueRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new QueueError('Expected a JSON object');
  return value as QueueRow;
}

function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new QueueError('Expected a list');
  return value;
}

function string(value: unknown): string {
  if (typeof value !== 'string') throw new QueueError('Expected a string');
  return value;
}

type Origin = { rows: QueueRow[]; index: number };
type Batch = { nodeId: string; rows: QueueRow[]; origins: Map<string, Origin> };
type NodeOutput = { port: number; rows: QueueRow[]; split?: boolean; continued?: boolean };

function expression(value: string): string {
  if (!value.startsWith('=')) return JSON.stringify(value);
  const source = value.slice(1);
  const parts: string[] = [];
  let offset = 0;
  for (const match of source.matchAll(/\{\{([\s\S]*?)\}\}/g)) {
    const code = match[1]?.trim();
    if (!code) throw new QueueError('Empty expression');
    if (match.index === 0 && match[0].length === source.length) return '(' + code + ')';
    parts.push(JSON.stringify(source.slice(offset, match.index)), 'String(' + code + ')');
    offset = match.index + match[0].length;
  }
  if (!parts.length) throw new QueueError('Invalid expression');
  return '(' + [...parts, JSON.stringify(source.slice(offset))].join(' + ') + ')';
}

function parameterSource(value: unknown): string {
  if (typeof value === 'string') return expression(value);
  if (Array.isArray(value)) return '[' + value.map(parameterSource).join(',') + ']';
  if (value && typeof value === 'object') {
    const fields = Object.entries(value).map(([key, child]) => '[' + JSON.stringify(key) + ']:' + parameterSource(child));
    return '({' + fields.join(',') + '})';
  }
  return JSON.stringify(value) ?? 'undefined';
}

async function evaluate(source: string, input: Batch, env: Record<string, string>): Promise<unknown> {
  const context = JSON.stringify({ input: input.rows, origins: Object.fromEntries(input.origins), env });
  if (Buffer.byteLength(context) > maxContextBytes || Buffer.byteLength(source) > maxOutputBytes) {
    throw new QueueError('Script input limit exceeded');
  }
  const quickjs = await getQuickJS();
  const vm = quickjs.newContext();
  try {
    vm.runtime.setMemoryLimit(32 * 1024 * 1024);
    vm.runtime.setMaxStackSize(256 * 1024);
    const deadline = Date.now() + 500;
    vm.runtime.setInterruptHandler(() => Date.now() > deadline);
    const program = `
      (() => {
        const { input, origins, env: $env } = JSON.parse(${JSON.stringify(context)});
        const items = input.map(json => ({ json }));
        const $input = { all: () => items, first: () => items[0], item: items[0] };
        const $json = items[0].json;
        const $ = name => {
          if (!Object.hasOwn(origins, name)) throw new Error("Unknown linked node");
          const { rows, index } = origins[name];
          return {
            all: () => rows.map(json => ({ json })),
            first: () => ({ json: rows[0] }),
            item: { json: rows[index] }
          };
        };
        const encode = JSON.stringify;
        const value = ${source};
        const encoded = encode(value);
        if (typeof encoded !== 'string' || encoded.length > ${maxOutputBytes}) throw new Error("Invalid output");
        return encoded;
      })()
    `;
    const result = vm.evalCode(program, 'workflow.js', { type: 'global' });
    if (result.error) {
      result.error.dispose();
      throw new QueueError('Script or expression failed');
    }
    try {
      if (vm.typeof(result.value) !== 'string') throw new QueueError('Invalid script result');
      const encoded = vm.getString(result.value);
      if (Buffer.byteLength(encoded) > maxOutputBytes) throw new QueueError('Script output limit exceeded');
      return JSON.parse(encoded);
    } finally {
      result.value.dispose();
    }
  } finally {
    vm.dispose();
  }
}

function matches(value: unknown): boolean {
  const group = row(value);
  const options = row(group.options ?? {});
  const checks = list(group.conditions).map(raw => {
    const { operator, leftValue, rightValue } = row(raw);
    const { operation, type } = row(operator);
    if (operation !== 'equals' || !['string', 'boolean', 'number'].includes(String(type))) {
      throw new QueueError('Unsupported condition operator');
    }
    // Missing fields in an HTTP error item take the Switch fallback route.
    if (leftValue == null || rightValue == null) return false;
    if (typeof leftValue !== type || typeof rightValue !== type) throw new QueueError('Condition type mismatch');
    if (type === 'string' && options.caseSensitive === false) {
      return string(leftValue).toLowerCase() === string(rightValue).toLowerCase();
    }
    return leftValue === rightValue;
  });
  if (group.combinator === 'or') return checks.some(Boolean);
  if (group.combinator !== 'and') throw new QueueError('Unsupported condition combinator');
  return checks.every(Boolean);
}

async function ioOutput(node: QueueNode, operation: () => Promise<QueueRow[]>): Promise<NodeOutput> {
  try {
    return { port: 0, rows: await operation() };
  } catch {
    if (!node.continueOnFail) throw new QueueError('I/O operation failed');
    return { port: 0, rows: [{ error: 'I/O operation failed' }], continued: true };
  }
}

async function executeNode(node: QueueNode, input: Batch, io: QueueIO, env: Record<string, string>): Promise<NodeOutput> {
  const p = node.parameters;
  const resolve = (value: unknown) => evaluate(parameterSource(value), input, env);
  const pass = { port: 0, rows: input.rows };
  switch (node.type) {
    case 'n8n.cron':
    case 'n8n.errorTrigger':
    case 'n8n.noOp':
      return pass;
    case 'n8n.code': {
      const result = await evaluate('(() => {\n' + string(p.jsCode) + '\n})()', input, env);
      // A queue Code node emits independent task chains. Sheet reads stay batched for $input.all().
      return { port: 0, rows: list(result).map(item => row(row(item).json)), split: true };
    }
    case 'n8n.if':
      return { ...pass, port: matches(await resolve(p.conditions)) ? 0 : 1 };
    case 'n8n.switch': {
      const rules = list(row(p.rules).values);
      for (const [port, rule] of rules.entries()) {
        if (matches(await resolve(row(rule).conditions))) return { ...pass, port };
      }
      return row(p.options ?? {}).fallbackOutput === 'extra' ? { ...pass, port: rules.length } : { port: 0, rows: [] };
    }
    case 'n8n.googleSheets': {
      const [doc, sheet] = list(await resolve([row(p.documentId).value, row(p.sheetName).value])).map(string);
      if (!doc || !sheet) throw new QueueError('Missing sheet configuration');
      if ((p.operation ?? 'read') === 'read') return ioOutput(node, () => io.readSheet(node, doc, sheet));
      if (p.operation !== 'update') throw new QueueError('Unsupported sheet operation');
      const columns = row(p.columns);
      const keys = list(columns.matchingColumns);
      if (keys.length !== 1) throw new QueueError('Expected one sheet match column');
      const key = string(keys[0]);
      const values = row(await resolve(columns.value));
      if (!Object.hasOwn(values, key) || values[key] == null || values[key] === '') throw new QueueError('Missing sheet match value');
      return ioOutput(node, async () => [await io.updateSheet(node, doc, sheet, key, values)]);
    }
    case 'n8n.httpRequest': {
      const resolved = row(await resolve({ url: p.url, body: p.sendBody ? p.jsonBody : null }));
      let body: unknown = undefined;
      if (p.sendBody) body = typeof resolved.body === 'string' ? JSON.parse(resolved.body) : resolved.body;
      const method = string(p.method ?? 'GET');
      const url = string(resolved.url);
      return ioOutput(node, async () => [await io.http(node, method, url, body)]);
    }
    case 'n8n.telegram': {
      const resolved = row(await resolve({ chat: p.chatId, text: p.text, options: p.additionalFields ?? {} }));
      const chat = string(resolved.chat);
      const text = string(resolved.text);
      const options = row(resolved.options);
      return ioOutput(node, async () => [await io.telegram(node, chat, text, options)]);
    }
    default:
      throw new QueueError('Unsupported workflow node');
  }
}

function consumesOneItem(node: QueueNode | undefined): boolean {
  switch (node?.type) {
    case 'n8n.if':
    case 'n8n.switch':
    case 'n8n.httpRequest':
    case 'n8n.telegram':
      return true;
    case 'n8n.googleSheets':
      return node.parameters.operation === 'update';
    default:
      return false;
  }
}

export async function executeQueue(graph: QueueGraph, io: QueueIO, env: Record<string, string>): Promise<QueueResult> {
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const pending: Batch[] = [{ nodeId: graph.entry, rows: [{}], origins: new Map() }];
  const trace: QueueStep[] = [];
  let error: string | undefined;
  let processedBytes = 0;
  while (pending.length) {
    const input = pending.shift()!;
    const node = nodes.get(input.nodeId);
    if (!node || trace.length >= maxSteps) {
      error ??= node ? 'Workflow step limit exceeded' : 'Missing workflow node';
      break;
    }
    const step: QueueStep = { nodeId: node.id, node: node.name, input: input.rows.length, output: 0, status: 'done' };
    trace.push(step);
    try {
      const output = await executeNode(node, input, io, env);
      if (!output.rows.length && node.alwaysOutputData) output.rows = [{}];
      if (output.rows.length > maxItems) throw new QueueError('Node item limit exceeded');
      output.rows.forEach(row);
      const bytes = Buffer.byteLength(JSON.stringify(output.rows));
      processedBytes += bytes;
      if (bytes > maxOutputBytes || processedBytes > maxRunBytes) throw new QueueError('Workflow data limit exceeded');
      step.output = output.rows.length;
      if (output.continued) step.status = 'continued';
      if (!output.rows.length) continue;
      const port = 'out' + output.port;
      for (const [key, nodeId] of Object.entries(node.on)) {
        if (key !== port && !key.startsWith(port + '.')) continue;
        const split = output.split || consumesOneItem(nodes.get(nodeId));
        const batches = split ? output.rows.map(item => [item]) : [output.rows];
        if (pending.length + batches.length > maxSteps) throw new QueueError('Workflow branch limit exceeded');
        for (const [index, rows] of batches.entries()) {
          const origins = new Map(input.origins);
          if (split && output.rows.length > 1) {
            for (const [name, origin] of origins) {
              if (origin.rows === output.rows) origins.set(name, { rows: origin.rows, index });
            }
          }
          origins.set(node.name, { rows: output.rows, index });
          pending.push({ nodeId, rows, origins });
        }
      }
    } catch (cause) {
      step.status = 'failed';
      const message = cause instanceof QueueError ? cause.message : 'Node execution failed';
      pending.length = 0;
      if (error) break;
      error = node.name + ': ' + message;
      const trigger = graph.nodes.find(candidate => candidate.type === 'n8n.errorTrigger');
      if (trigger && trigger.id !== node.id) {
        const execution = { lastNodeExecuted: node.name, error: { message } };
        pending.push({ nodeId: trigger.id, rows: [{ execution }], origins: new Map() });
      }
    }
  }
  return error === undefined ? { status: 'done', steps: trace.length, trace } : { status: 'failed', steps: trace.length, trace, error };
}
