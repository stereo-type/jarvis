import { timingSafeEqual } from 'node:crypto';

export const receiptPath = '/telegram/cinema/receipt';
export type CinemaStatus = {enabled:boolean; canSend:boolean; message?:string};

export class WebhookSetupError extends Error {}

export function initialCinemaStatus(mode:string|undefined, telegram:boolean):CinemaStatus {
  if (mode==='true') return telegram
    ? {enabled:true,canSend:false,message:'Подключаем Telegram для передачи в Filmobot.'}
    : {enabled:true,canSend:true};
  if (telegram && (mode===undefined || mode==='search')) return {
    enabled:true,canSend:false,message:'Доступен поиск. Для передачи в Filmobot включите JARVIS_CINEMA_ENABLED=true на Ubuntu.'
  };
  return {enabled:false,canSend:false,message:'Кино выключено на Ubuntu. Для поиска задайте JARVIS_CINEMA_ENABLED=search, для поиска и передачи — true.'};
}

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
  const url = URL.parse(env.JARVIS_PUBLIC_URL ?? '');
  if (!url || url.protocol!=='https:' || url.username || url.password || url.pathname!=='/' || url.search || url.hash)
    throw new WebhookSetupError('Для передачи укажите HTTPS-домен Jarvis в JARVIS_PUBLIC_URL.');
  if (!token || !/^[1-9]\d*$/.test(peer) || peer===token.split(':')[0])
    throw new WebhookSetupError('Проверьте JARVIS_FILMOBOT_ID на Ubuntu. Нужен числовой ID Filmobot.');
  if (!secret || !/^[a-zA-Z0-9_-]{16,256}$/.test(secret))
    throw new WebhookSetupError('Задайте JARVIS_CINEMA_WEBHOOK_SECRET на Ubuntu согласно .env.example.');
  url.pathname = receiptPath;
  const api = async (method:string,params:object) => {
    const res = await http('https://api.telegram.org/bot'+token+'/'+method,{
      method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),headers:{'content-type':'application/json'},body:JSON.stringify(params)
    });
    if (!res.ok) throw new WebhookSetupError('Telegram отклонил '+method+' (HTTP '+res.status+').');
    const data = await res.json() as {ok:boolean;result:unknown};
    if (data.ok!==true) throw new Error('Ошибка Telegram при '+method);
    return data.result;
  };
  const current = await api('getWebhookInfo',{}) as {url:string};
  if (typeof current?.url!=='string' || current.url && current.url!==url.href) {
    throw new WebhookSetupError('У бота уже зарегистрирован другой webhook. Проверьте токен Jarvis.');
  }
  await api('setWebhook',{url:url.href,secret_token:secret,allowed_updates:['message'],drop_pending_updates:false});
}
