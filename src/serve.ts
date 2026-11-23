import { Pool } from 'pg';
import { WorkflowEditor } from './editor.ts';
import { QueueJobs } from './n8n/jobs.ts';
import { Runner } from './runner/engine.ts';
import { migrate } from './runner/storage.ts';
import { miniAppServer } from './telegram/server.ts';
import { telegramAuth } from './telegram/auth.ts';
import { registerCinemaWebhook } from './cinema/webhook.ts';
import { setTimeout as sleep } from 'node:timers/promises';

if (!process.env.DATABASE_URL && !process.env.PGHOST) throw new Error('Укажите подключение PostgreSQL');
const auth = telegramAuth(process.env.JARVIS_BOT_TOKEN ?? '',process.env.JARVIS_ALLOWED_USER_IDS ?? '');
const pool = new Pool({connectionString:process.env.DATABASE_URL});
pool.on('error', () => console.error('Потеряно соединение с PostgreSQL'));
try {
  await migrate(pool);
  const runner = new Runner(pool);
  await runner.publish('examples/services/filmobot.connection.json','examples/workflows/cinema-search.json');
  const admins = new Set((process.env.JARVIS_ADMIN_USER_IDS ?? '').split(',').map(id=>id.trim()).filter(Boolean));
  if ([...admins].some(id=>!/^[1-9][0-9]*$/.test(id))) throw new Error('Некорректный JARVIS_ADMIN_USER_IDS');
  const enabled = process.env.JARVIS_CINEMA_ENABLED === 'true';
  const telegram = enabled && process.env.JARVIS_CINEMA_TRANSPORT === 'telegram';
  let ready = enabled && !telegram;
  const shutdown = new AbortController();
  const server = miniAppServer(runner,auth,() => pool.query('SELECT 1'),()=>ready,new WorkflowEditor(pool),admins,new QueueJobs(pool,process.env.JARVIS_N8N_LIVE_ENABLED==='true'),telegram ? process.env.JARVIS_CINEMA_WEBHOOK_SECRET : '');
  server.listen(Number(process.env.PORT ?? 8080),'0.0.0.0',() => console.log('Mini App готова'));
  if (telegram) void (async()=>{
    while (!shutdown.signal.aborted) {
      try { await registerCinemaWebhook(process.env); ready=true; return; }
      catch { console.error('Кино: не удалось зарегистрировать webhook. Проверьте настройки и существующий webhook бота.'); }
      await sleep(60000,undefined,{signal:shutdown.signal}).catch(()=>{});
    }
  })();
  const stop = () => { shutdown.abort(); server.close(() => { void pool.end(); }); };
  process.once('SIGTERM',stop);
  process.once('SIGINT',stop);
} catch (error) {
  await pool.end();
  throw error;
}
