import { readFile } from 'node:fs/promises';
import { z } from 'zod';

export async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function parse<T extends z.ZodTypeAny>(schema: T, value: unknown, at: string): z.output<T> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const details = result.error.issues.map(issue => `${issue.path.join('.') || 'значение'}: ${issue.message}`);
  throw new Error(`${at}: ${details.join(', ')}`);
}

export const map = z.record(z.unknown());
export const id = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/);

export type Shape = {
  type: 'object' | 'array' | 'string' | 'integer' | 'boolean';
  format?: 'date-time' | 'uuid';
  check: z.ZodTypeAny;
  properties?: Map<string, Shape>;
  required?: Set<string>;
  items?: Shape;
};

export function objectShape(properties: Map<string, Shape>, required: Set<string>, closed = false): Shape {
  const entries = [...properties].map(([name, field]) => [name, required.has(name) ? field.check : field.check.optional()]);
  const schema = z.object(Object.fromEntries(entries));
  return { type: 'object', properties, required, check: closed ? schema.strict() : schema.passthrough() };
}

const componentRef = z.object({ $ref: z.string() }).strict();
type Components = Record<string, Record<string, unknown>>;

export function resolveComponent(
  raw: unknown, group: string, components: Components, at: string, visited: ReadonlySet<string> = new Set(),
): { data: Record<string, unknown>; visited: ReadonlySet<string> } {
  let data = parse(map, raw, at);
  const seen = new Set(visited);
  while ('$ref' in data) {
    const ref = parse(componentRef, data, at).$ref;
    const prefix = `#/components/${group}/`;
    const key = ref.slice(prefix.length);
    const values = components[group];
    if (!ref.startsWith(prefix) || !/^[A-Za-z0-9._-]+$/.test(key) || !values || !Object.hasOwn(values, key)) {
      throw new Error(`${at}: неизвестная или внешняя ссылка ${ref}`);
    }
    if (seen.has(ref)) throw new Error(`${at}: цикл $ref ${ref}`);
    seen.add(ref);
    data = parse(map, values[key], ref);
  }
  return { data, visited: seen };
}

const base = { description: z.string().optional() };
const uint = z.number().int().nonnegative();
const schemas = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('object'), properties: map, required: z.array(z.string()).default([]), additionalProperties: z.boolean().optional() }).strict(),
  z.object({ ...base, type: z.literal('array'), items: z.unknown(), maxItems: uint.optional() }).strict(),
  z.object({ ...base, type: z.literal('string'), minLength: uint.optional(), maxLength: uint.optional(), pattern: z.string().optional(), format: z.enum(['uuid', 'date-time']).optional(), const: z.string().optional() }).strict(),
  z.object({ ...base, type: z.literal('integer'), minimum: z.number().int().optional(), maximum: z.number().int().optional(), default: z.number().int().optional() }).strict(),
  z.object({ ...base, type: z.literal('boolean') }).strict(),
]);

export function readShape(raw: unknown, components: Components, at: string, parents?: ReadonlySet<string>): Shape {
  const resolved = resolveComponent(raw, 'schemas', components, at, parents);
  const schema = parse(schemas, resolved.data, at);
  switch (schema.type) {
    case 'object': {
      const props = new Map(Object.entries(schema.properties).map(([k, v]) =>
        [k, readShape(v, components, `${at}.${k}`, resolved.visited)] as const));
      for (const name of schema.required) {
        if (!props.has(name)) throw new Error(`${at}: неизвестное обязательное поле ${name}`);
      }
      return objectShape(props, new Set(schema.required), schema.additionalProperties === false);
    }
    case 'array': {
      const items = readShape(schema.items, components, `${at}[]`, resolved.visited);
      let check = z.array(items.check);
      if (schema.maxItems !== undefined) check = check.max(schema.maxItems);
      return { type: 'array', items, check };
    }
    case 'string': {
      let value = z.string();
      if (schema.minLength !== undefined && schema.maxLength !== undefined && schema.minLength > schema.maxLength) throw new Error(`${at}: minLength > maxLength`);
      if (schema.pattern !== undefined) {
        try { value = value.regex(new RegExp(schema.pattern, 'u')); }
        catch { throw new Error(`${at}: некорректное регулярное выражение`); }
      }
      if (schema.format === 'uuid') value = value.uuid();
      if (schema.format === 'date-time') value = value.datetime({ offset: true });
      const check = value.superRefine((text, ctx) => {
        // JSON Schema измеряет длину в кодовых точках Unicode.
        const length = Array.from(text).length;
        if (schema.minLength !== undefined && length < schema.minLength)
          ctx.addIssue({ code: 'custom', message: `Минимальная длина: ${schema.minLength}` });
        if (schema.maxLength !== undefined && length > schema.maxLength)
          ctx.addIssue({ code: 'custom', message: `Максимальная длина: ${schema.maxLength}` });
        if (schema.const !== undefined && text !== schema.const)
          ctx.addIssue({ code: 'custom', message: `Ожидалась константа ${schema.const}` });
      });
      if (schema.const !== undefined) parse(check, schema.const, at);
      return { type: 'string', check, ...(schema.format && { format: schema.format }) };
    }
    case 'integer': {
      let value = z.number().int().safe();
      if (schema.minimum !== undefined) value = value.min(schema.minimum);
      if (schema.maximum !== undefined) value = value.max(schema.maximum);
      if (schema.minimum !== undefined && schema.maximum !== undefined && schema.minimum > schema.maximum) throw new Error(`${at}: minimum > maximum`);
      if (schema.default !== undefined) parse(value, schema.default, at);
      return { type: 'integer', check: value };
    }
    case 'boolean': return { type: 'boolean', check: z.boolean() };
  }
}
