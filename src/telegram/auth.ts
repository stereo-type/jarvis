import { createHmac, timingSafeEqual } from 'node:crypto';

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

function unauthorized(): never { throw new HttpError(401, 'Откройте Jarvis заново из Telegram.'); }

function equal(a: Buffer, b: Buffer) {
  return a.length === b.length && timingSafeEqual(a, b);
}

export function telegramAuth(botToken: string, whitelist: string, now = () => Math.floor(Date.now() / 1000)) {
  if (!botToken.trim()) throw new Error('Требуется JARVIS_BOT_TOKEN');
  const allowed = new Set(whitelist.split(',').map(s => s.trim()).filter(Boolean));
  if ([...allowed].some(id => !/^[1-9][0-9]*$/.test(id))) throw new Error('Некорректный JARVIS_ALLOWED_USER_IDS');
  const telegramKey = createHmac('sha256','WebAppData').update(botToken).digest();
  const sessionKey = createHmac('sha256',botToken).update('jarvis-mini-app/session/v1').digest();
  function authorize(actor: string) {
    if (!allowed.has(actor)) throw new HttpError(403, 'Доступ к Jarvis ограничен.');
    return actor;
  }
  function sign(payload: string) {
    return createHmac('sha256',sessionKey).update(payload).digest();
  }
  return {
    login(raw: string) {
      const fields = new URLSearchParams(raw);
      if (new Set(fields.keys()).size !== fields.size) unauthorized();
      const hash = fields.get('hash') ?? '';
      if (!/^[0-9a-f]{64}$/.test(hash)) unauthorized();
      fields.delete('hash');
      fields.sort();
      const canonical = [...fields].map(([k,v]) => k + '=' + v).join('\n');
      if (!equal(createHmac('sha256',telegramKey).update(canonical).digest(), Buffer.from(hash,'hex'))) unauthorized();
      const date = Number(fields.get('auth_date'));
      const time = now();
      if (!Number.isSafeInteger(date) || date < time-300 || date > time+30) unauthorized();
      let user;
      try { user = JSON.parse(fields.get('user') ?? 'null'); } catch { unauthorized(); }
      if (!Number.isSafeInteger(user?.id) || user.id <= 0) unauthorized();
      const payload = authorize(String(user.id)) + '.' + (time+3600);
      return payload + '.' + sign(payload).toString('base64url');
    },
    actor(header: string | undefined) {
      const match = /^Bearer ([1-9][0-9]*)\.(\d+)\.([a-zA-Z0-9_-]{43})$/.exec(header ?? '');
      if (!match || !equal(sign(match[1]+'.'+match[2]), Buffer.from(match[3]!, 'base64url')) || Number(match[2]) <= now()) unauthorized();
      return authorize(match[1]!);
    },
  };
}
