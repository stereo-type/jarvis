import { z } from 'zod';
import type { Catalog } from './catalog.ts';
import { id, map, objectShape, parse, type Shape } from './schema.ts';

const reference = z.object({ $ref: z.string().regex(/^[A-Za-z][\w-]*(\.[A-Za-z][\w-]*)+$/) }).strict();
const common = { id, position: z.tuple([z.number().finite(), z.number().finite()]) };
const next = z.record(id);
const label = z.string().trim().min(1);
const field = z.object({
  key: id, label, type: z.literal('string'), trim: z.boolean().optional(),
  minLength: z.number().int().nonnegative().optional(), maxLength: z.number().int().positive().optional(),
}).strict();
const node = z.discriminatedUnion('type', [
  z.object({ ...common, type: z.literal('ui.form'), title: label, fields: z.array(field).min(1), on: next }).strict(),
  z.object({ ...common, type: z.literal('service.call'), service: id, apiMajor: z.number().int().positive(), operationId: id, args: map, requireIdempotency: z.boolean().optional(), on: next }).strict(),
  z.object({ ...common, type: z.literal('flow.hasItems'), items: reference, on: next }).strict(),
  z.object({ ...common, type: z.literal('ui.choice'), title: label, items: reference, expiresAt: reference, valueField: id, labelField: id, detailFields: z.array(id), on: next }).strict(),
  z.object({ ...common, type: z.literal('ui.result'), title: label, receipt: reference.optional() }).strict(),
]);
export type WorkflowNode = z.infer<typeof node>;
const workflow = z.object({
  schemaVersion: z.literal('jarvis.workflow/v1'), id: z.string().regex(/^[A-Za-z][\w.-]*$/),
  revision: z.number().int().positive(), title: label, entry: id, nodes: z.array(z.unknown()).min(1),
}).strict();

function ports(n: WorkflowNode): [string[], string?] {
  switch (n.type) {
    case 'ui.form': return [['submit'], 'submit'];
    case 'service.call': return [['success', 'error'], 'success'];
    case 'ui.choice': return [['select', 'cancel', 'expired'], 'select'];
    case 'flow.hasItems': return [['yes', 'no']];
    case 'ui.result': return [[]];
  }
}

type Available = Map<string, Shape>;
function outputField(ref: { $ref: string }, available: Available, at: string): Shape {
  const [step, ...path] = ref.$ref.split('.');
  let value = available.get(step!);
  for (const key of path) {
    if (!value?.required?.has(key)) throw new Error(`${at}: поле ${ref.$ref} недоступно на всех путях`);
    value = value.properties?.get(key);
  }
  if (!value) throw new Error(`${at}: нет выхода ${ref.$ref}`);
  return value;
}

function checkNode(n: WorkflowNode, available: Available, catalog: Catalog): Shape | undefined {
  const at = n.id;
  switch (n.type) {
    case 'ui.form': {
      const fields = new Map<string, Shape>();
      for (const f of n.fields) {
        if (fields.has(f.key) || (f.minLength ?? 0) > (f.maxLength ?? Infinity)) throw new Error(`${at}: некорректное поле ${f.key}`);
        fields.set(f.key, { type: 'string', check: z.string() });
      }
      return objectShape(fields, new Set(fields.keys()));
    }
    case 'flow.hasItems':
      if (outputField(n.items, available, at).type !== 'array') throw new Error(`${at}: items требует массив`);
      return;
    case 'ui.choice': {
      const item = outputField(n.items, available, at).items;
      if (outputField(n.expiresAt, available, at).format !== 'date-time') throw new Error(`${at}: expiresAt требует формат date-time`);
      for (const key of [n.valueField, n.labelField, ...n.detailFields]) {
        const type = item?.properties?.get(key)?.type;
        const valid = key === n.valueField || key === n.labelField ? type === 'string' : ['string', 'integer', 'boolean'].includes(type ?? '');
        if (!valid || !item?.required?.has(key)) throw new Error(`${at}: неподходящее поле выбора ${key}`);
      }
      return objectShape(new Map([['value', item!.properties!.get(n.valueField)!]]), new Set(['value']));
    }
    case 'ui.result':
      if (n.receipt && outputField(n.receipt, available, at).type !== 'string') throw new Error(`${at}: receipt требует строку`);
      return;
    case 'service.call': {
      const op = catalog.operations.get(n.operationId);
      if (n.service !== catalog.service || n.apiMajor !== catalog.major || !op) throw new Error(`${at}: неизвестная операция ${n.service}/v${n.apiMajor}/${n.operationId}`);
      if (n.requireIdempotency && !op.idempotent) throw new Error(`${at}: операция должна поддерживать идемпотентность`);
      for (const key of op.required) if (!Object.hasOwn(n.args, key)) throw new Error(`${at}: отсутствует аргумент ${key}`);
      for (const [key, value] of Object.entries(n.args)) {
        const expected = op.input.get(key);
        if (!expected) throw new Error(`${at}: неизвестный аргумент ${key}`);
        const where = `${at}.args.${key}`;
        if (typeof value === 'object' && value !== null && '$ref' in value) {
          const actual = outputField(parse(reference, value, where), available, where);
          if (expected.type !== actual.type || ['array', 'object'].includes(actual.type)) throw new Error(`${where}: ссылка должна возвращать совместимый скаляр`);
        } else parse(expected.check, value, where);
      }
      return op.output;
    }
  }
}

export function compileWorkflow(raw: unknown, catalog: Catalog, file: string) {
  const graph = parse(workflow, raw, file);
  const nodes = new Map<string, WorkflowNode>();
  const incoming = new Map<string, number>();
  for (const [index, value] of graph.nodes.entries()) {
    const name = z.object({ id }).safeParse(value);
    const n = parse(node, value, `${file}: ${name.success ? name.data.id : 'nodes[' + index + ']'}`);
    if (nodes.has(n.id)) throw new Error(`${file}: повтор id ${n.id}`);
    nodes.set(n.id, n);
    incoming.set(n.id, 0);
  }
  if (nodes.get(graph.entry)?.type !== 'ui.form') throw new Error(`${file}: entry должен указывать на ui.form`);
  for (const n of nodes.values()) {
    if (!('on' in n)) continue;
    const [required] = ports(n);
    for (const key of required) if (!Object.hasOwn(n.on, key)) throw new Error(`${n.id}: отсутствует переход ${key}`);
    for (const [port, dest] of Object.entries(n.on)) {
      if (!required.includes(port) && !(n.type === 'service.call' && /^error\.[A-Z][A-Z0-9_]*$/.test(port))) throw new Error(`${n.id}: неизвестный порт ${port}`);
      if (!nodes.has(dest)) throw new Error(`${n.id}: нет цели перехода ${dest}`);
      incoming.set(dest, incoming.get(dest)! + 1);
    }
  }
  if (incoming.get(graph.entry) !== 0) throw new Error(`${file}: входящий переход в entry`);
  const queue = [graph.entry];
  const inputs = new Map<string, Available>([[graph.entry, new Map()]]);
  for (let i = 0; i < queue.length; i++) {
    const n = nodes.get(queue[i]!)!;
    const before = inputs.get(n.id)!;
    const output = checkNode(n, before, catalog);
    if (!('on' in n)) continue;
    const [, outputPort] = ports(n);
    for (const [port, dest] of Object.entries(n.on)) {
      const after = new Map(before);
      if (port === outputPort && output) after.set(n.id, output);
      const seen = inputs.get(dest);
      // В точке слияния доступны только результаты, полученные на каждой из входящих веток.
      if (seen) {
        for (const step of seen.keys()) if (!after.has(step)) seen.delete(step);
      } else inputs.set(dest, after);
      const left = incoming.get(dest)! - 1;
      incoming.set(dest, left);
      if (left === 0) queue.push(dest);
    }
  }
  if (queue.length !== nodes.size) {
    const missing = [...nodes.keys()].filter(key => !queue.includes(key));
    throw new Error(`${file}: цикл или недостижимые узлы: ${missing.join(', ')}`);
  }
  return { id: graph.id, revision: graph.revision, nodes, entry: graph.entry };
}

export function validateWorkflow(raw: unknown, catalog: Catalog, file: string) {
  const graph = compileWorkflow(raw, catalog, file);
  return { id: graph.id, revision: graph.revision, nodes: graph.nodes.size };
}
