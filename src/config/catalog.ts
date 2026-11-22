import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { id, map, parse, readJson, readShape, resolveComponent, type Shape } from './schema.ts';

const envName = z.string().regex(/^[A-Z_][A-Z0-9_]*$/);
const connection = z.object({
  schemaVersion: z.literal('jarvis.connection/v1'), id, title: z.string().min(1),
  apiMajor: z.number().int().positive(), baseUrlEnv: envName,
  credential: z.object({ type: z.literal('bearer'), tokenEnv: envName }).strict(),
  requiredHeaders: z.array(z.enum(['X-Jarvis-User-Id', 'X-Request-Id'])).default([]),
  contractFile: z.string().min(1), operations: z.array(id).min(1),
}).strict();
const security = z.array(z.record(z.array(z.string())));
const apiDocument = z.object({
  openapi: z.string().regex(/^3\.1\.\d+$/), info: z.object({ version: z.string().regex(/^\d+\.\d+\.\d+$/) }),
  security, components: z.record(map), paths: z.record(map),
});
const operationSpec = z.object({
  operationId: id, parameters: z.array(z.unknown()).default([]), requestBody: map.optional(),
  responses: z.record(map), 'x-jarvis-idempotency': z.literal('required').optional(),
  summary: z.string().optional(), description: z.string().optional(),
}).strict();
const parameter = z.object({
  name: z.string().min(1), in: z.enum(['query', 'header']), required: z.boolean().default(false),
  schema: map, description: z.string().optional(),
}).strict();
export type Operation = { input: Map<string, Shape>; required: Set<string>; output: Shape; idempotent: boolean;
  method: string; path: string; status: number; headers: Set<string>; failures: Map<string, Shape> };
export type Catalog = { service: string; major: number; operations: Map<string, Operation> };
type Api = z.infer<typeof apiDocument>;

function jsonShape(message: Record<string, unknown>, api: Api, at: string): Shape {
  const content = parse(z.object({ 'application/json': z.object({ schema: map }).strict() }).strict(), message.content, at);
  return readShape(content['application/json'].schema, api.components, at);
}

function readOperation(raw: unknown, method: string, path: string, api: Api, at: string, requiredHeaders: string[]): Operation {
  const op = parse(operationSpec, raw, at);
  const input = new Map<string, Shape>();
  const required = new Set<string>();
  const headers = new Set<string>();
  for (const value of op.parameters) {
    const p = parse(parameter, resolveComponent(value, 'parameters', api.components, at).data, at);
    const shape = readShape(p.schema, api.components, `${at}.${p.name}`);
    if (p.in === 'header') {
      const name = p.name.toLowerCase();
      if (!['x-request-id', 'x-jarvis-user-id', 'idempotency-key'].includes(name) || shape.type !== 'string' || !p.required || headers.has(name)) {
        throw new Error(`${at}: неподдерживаемый или повторный заголовок ${p.name}`);
      }
      headers.add(name);
    } else {
      if (method !== 'get' || input.has(p.name) || !['string', 'integer', 'boolean'].includes(shape.type)) throw new Error(`${at}: неподдерживаемый query-параметр ${p.name}`);
      input.set(p.name, shape);
      if (p.required) required.add(p.name);
    }
  }
  for (const name of requiredHeaders) {
    if (!headers.has(name.toLowerCase())) throw new Error(`${at}: отсутствует обязательный заголовок ${name}`);
  }
  if (headers.has('idempotency-key') !== (op['x-jarvis-idempotency'] === 'required') || (method === 'get' && headers.has('idempotency-key'))) {
    throw new Error(`${at}: несовместимая политика Idempotency-Key`);
  }
  if (method === 'post') {
    if (!op.requestBody || op.requestBody.required !== true) throw new Error(`${at}: POST требует обязательное JSON-тело`);
    const body = jsonShape(op.requestBody, api, `${at}.body`);
    if (!body.properties) throw new Error(`${at}: тело должно быть объектом`);
    for (const [key, shape] of body.properties) input.set(key, shape);
    for (const key of body.required ?? []) required.add(key);
  } else if (op.requestBody) throw new Error(`${at}: тело у GET не поддерживается`);

  const successes = Object.keys(op.responses).filter(k => k.startsWith('2'));
  if (successes.length !== 1 || !/^2\d\d$/.test(successes[0]!)) throw new Error(`${at}: требуется один явный успешный HTTP-статус`);
  const success = resolveComponent(op.responses[successes[0]!], 'responses', api.components, at);
  const output = jsonShape(success.data, api, `${at}.response`);
  if (output.type !== 'object') throw new Error(`${at}: ответ должен быть JSON-объектом`);
  if (!Object.hasOwn(op.responses, 'default')) throw new Error(`${at}: требуется default для ошибок сервиса`);
  const failures = new Map<string, Shape>();
  for (const [status, rawResponse] of Object.entries(op.responses)) {
    if (status === successes[0]) continue;
    if (status !== 'default' && !/^[45]\d\d$/.test(status)) throw new Error(`${at}: неподдерживаемый статус ${status}`);
    const response = resolveComponent(rawResponse, 'responses', api.components, at);
    const failure = jsonShape(response.data, api, `${at}.response.${status}`);
    failures.set(status, failure);
    for (const field of ['code', 'message', 'requestId']) {
      if (!failure.required?.has(field) || failure.properties?.get(field)?.type !== 'string') throw new Error(`${at}: ошибка должна содержать строковое поле ${field}`);
    }
  }
  return { input, required, output, method, path, headers, failures, status: Number(successes[0]),
    idempotent: method === 'get' || headers.has('idempotency-key') };
}

export async function loadCatalog(file: string): Promise<Catalog> {
  const snapshot = await readCatalogFiles(file);
  return compileCatalog(snapshot.config, snapshot.api, file);
}

export async function readCatalogFiles(file: string) {
  const config = parse(connection, await readJson(file), file);
  const contract = resolve(dirname(file), config.contractFile);
  return { config, api: await readJson(contract) };
}

export function compileCatalog(raw: unknown, document: unknown, file: string) {
  const config = parse(connection, raw, file);
  const contract = config.contractFile;
  const api = parse(apiDocument, document, contract);
  if (Number(api.info.version.split('.')[0]) !== config.apiMajor) throw new Error(`${file}: apiMajor расходится с версией контракта`);
  const schemes = Object.entries(api.security[0] ?? {});
  const [name, scopes] = schemes[0] ?? [];
  const auth = name && api.components.securitySchemes?.[name];
  if (api.security.length !== 1 || schemes.length !== 1 || scopes?.length || !z.object({ type: z.literal('http'), scheme: z.literal('bearer') }).safeParse(auth).success) {
    throw new Error(`${contract}: требуется единая bearer-аутентификация`);
  }
  const allowed = new Set(config.operations);
  if (allowed.size !== config.operations.length) throw new Error(`${file}: повтор operationId в operations`);
  const operations = new Map<string, Operation>();
  for (const [path, descriptor] of Object.entries(api.paths)) {
    for (const [method, value] of Object.entries(descriptor)) {
      const raw = map.safeParse(value);
      if (!raw.success || typeof raw.data.operationId !== 'string' || !allowed.has(raw.data.operationId)) continue;
      const key = raw.data.operationId;
      const at = `${contract}: ${key} (${method} ${path})`;
      if (operations.has(key)) throw new Error(`${at}: повтор operationId`);
      if (!/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/.test(path) || !['get','post'].includes(method) || ['parameters','servers','$ref'].some(k => k in descriptor)) {
        throw new Error(`${at}: профиль v1 требует GET/POST и фиксированный путь`);
      }
      operations.set(key, readOperation(raw.data, method, path, api, at, config.requiredHeaders));
    }
  }
  for (const key of allowed) if (!operations.has(key)) throw new Error(`${file}: неизвестная операция ${key}`);
  return { service: config.id, major: config.apiMajor, operations, config };
}
