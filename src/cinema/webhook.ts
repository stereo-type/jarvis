import { timingSafeEqual } from 'node:crypto';

export const receiptPath = '/telegram/cinema/receipt';

export function checkSecret(secret: string, value: string | string[] | undefined) {
  if (!secret || typeof value !== 'string') return false;
  const expected = Buffer.from(secret);
  const actual = Buffer.from(value);
  return actual.length===expected.length && timingSafeEqual(actual,expected);
}

// Telegram has a single update consumer per bot. An existing webhook on another URL belongs to its owner.
export async function registerCinemaWebhook(env:NodeJS.ProcessEnv, http:typeof fetch=fetch) {
  const token = env.JARVIS_BOT_TOKEN;
  const secret = env.JARVIS_CINEMA_WEBHOOK_SECRET;
  const peer = env.JARVIS_FILMOBOT_ID ?? '';
  const url = new URL(env.JARVIS_PUBLIC_URL ?? '');
  if (url.protocol!=='https:' || url.username || url.password || url.pathname!=='/' || url.search || url.hash ||
      !token || !secret || !/^[a-zA-Z0-9_-]{16,256}$/.test(secret) || !/^[1-9]\d*$/.test(peer) || peer===token.split(':')[0]) {
    throw new Error('Проверьте настройки Telegram для экрана Кино');
  }
  url.pathname = receiptPath;
  const api = async (method:string,params:object) => {
    const res = await http('https://api.telegram.org/bot'+token+'/'+method,{
      method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),headers:{'content-type':'application/json'},body:JSON.stringify(params)
    });
    if (!res.ok) throw new Error('Telegram отклонил '+method);
    const data = await res.json() as {ok:boolean;result:unknown};
    if (data.ok!==true) throw new Error('Ошибка Telegram при '+method);
    return data.result;
  };
  const current = await api('getWebhookInfo',{}) as {url:string};
  if (typeof current?.url!=='string' || current.url && current.url!==url.href) {
    throw new Error('У бота уже зарегистрирован другой webhook. Проверьте токен Jarvis.');
  }
  await api('setWebhook',{url:url.href,secret_token:secret,allowed_updates:['message'],drop_pending_updates:false});
}
