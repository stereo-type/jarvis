import type { Operation } from '../config/catalog.ts';

export type CallResult = { ok: true; data: unknown } | {
  ok: false; code: string; retryable: boolean; ambiguous: boolean; delay: number;
};

export async function callService(op: Operation, args: Record<string, unknown>, actor: string, command: string,
  request: string, base: string | undefined, token: string | undefined): Promise<CallResult> {
  const failure = (code: string, retryable = false, ambiguous = false, delay = 0): CallResult =>
    ({ ok: false, code, retryable, ambiguous, delay });
  if (!base || !token) return failure('CONNECTION_NOT_CONFIGURED');
  if (!/^[\x21-\x7e]+$/.test(token)) return failure('INVALID_CREDENTIAL');
  for (const [key, value] of Object.entries(args)) {
    if (!op.input.get(key)?.check.safeParse(value).success) return failure('INVALID_INPUT');
  }
  if (!URL.canParse(base)) return failure('INVALID_BASE_URL');
  const url = new URL(op.path, base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return failure('INVALID_BASE_URL');
  const headers = new Headers({ Authorization: 'Bearer ' + token });
  if (op.headers.has('x-request-id')) headers.set('X-Request-Id', request);
  if (op.headers.has('x-jarvis-user-id')) headers.set('X-Jarvis-User-Id', actor);
  if (op.headers.has('idempotency-key')) headers.set('Idempotency-Key', command);
  const write = op.method === 'post';
  const init: RequestInit = { method: op.method.toUpperCase(), headers, redirect: 'error', signal: AbortSignal.timeout(60_000) };
  if (write) {
    headers.set('content-type', 'application/json');
    init.body = JSON.stringify(args);
  } else {
    for (const [key, value] of Object.entries(args)) url.searchParams.set(key, String(value));
  }
  try {
    const response = await fetch(url, init);
    const data: unknown = await response.json().catch(() => null);
    if (response.status === op.status) {
      const parsed = op.output.check.safeParse(data);
      return parsed.success ? { ok: true, data: parsed.data } : failure('INVALID_RESPONSE', true, write);
    }
    const schema = op.failures.get(String(response.status)) ?? op.failures.get('default')!;
    const parsed = schema.check.safeParse(data);
    const code: string = parsed.success ? parsed.data.code : 'INVALID_RESPONSE';
    const transient = [429, 502, 503, 504].includes(response.status) || code === 'REQUEST_IN_PROGRESS';
    const ambiguous = write && (response.status >= 500 || response.ok || code === 'REQUEST_IN_PROGRESS');
    const seconds = Number(response.headers.get('retry-after'));
    return failure(code, transient, ambiguous, Number.isSafeInteger(seconds) && seconds > 0 ? Math.min(seconds, 2147483647) : 0);
  } catch {
    return failure('NETWORK_ERROR', true, write);
  }
}
