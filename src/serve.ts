import { Pool } from 'pg';
import { WorkflowEditor } from './editor.ts';
import { QueueJobs } from './n8n/jobs.ts';
import { Runner } from './runner/engine.ts';
import { migrate } from './runner/storage.ts';
import { miniAppServer } from './telegram/server.ts';
import { telegramAuth } from './telegram/auth.ts';

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
  const server = miniAppServer(runner,auth,() => pool.query('SELECT 1'),process.env.JARVIS_CINEMA_ENABLED === 'true',new WorkflowEditor(pool),admins,new QueueJobs(pool,process.env.JARVIS_N8N_LIVE_ENABLED==='true'));
  server.listen(Number(process.env.PORT ?? 8080),'0.0.0.0',() => console.log('Mini App готова'));
  const stop = () => server.close(() => { void pool.end(); });
  process.once('SIGTERM',stop);
  process.once('SIGINT',stop);
} catch (error) {
  await pool.end();
  throw error;
}
