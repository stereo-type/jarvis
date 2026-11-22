import { Pool } from 'pg';
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
  const server = miniAppServer(runner,auth,() => pool.query('SELECT 1'),process.env.JARVIS_CINEMA_ENABLED === 'true');
  server.listen(Number(process.env.PORT ?? 8080),'0.0.0.0',() => console.log('Mini App готова'));
  const stop = () => server.close(() => { void pool.end(); });
  process.once('SIGTERM',stop);
  process.once('SIGINT',stop);
} catch (error) {
  await pool.end();
  throw error;
}
