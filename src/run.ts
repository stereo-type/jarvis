import { setTimeout as sleep } from 'node:timers/promises';
import { writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { Runner } from './runner/engine.ts';
import { migrate } from './runner/storage.ts';
import { QueueJobs } from './n8n/jobs.ts';

async function main(args: string[]) {
  if (!process.env.DATABASE_URL && !process.env.PGHOST) throw new Error('Укажите подключение PostgreSQL');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  pool.on('error', () => console.error('Потеряно свободное соединение с PostgreSQL'));
  const runner = new Runner(pool);
  try {
    const [command, ...rest] = args;
    const [a, b, c, d, json] = rest;
    switch (command) {
      case 'migrate': return await migrate(pool);
      case 'publish': if (a && b) return await runner.publish(a,b); break;
      case 'start': if (a && b) return await runner.start(a,b); break;
      case 'show': if (a && b) return await runner.view(a,b); break;
      case 'history': if (a && b) return await runner.history(a,b); break;
      case 'act': if (a && b && c && d) return await runner.act(a,b,c,d,JSON.parse(json ?? '{}')); break;
      case 'tick': return await runner.tick();
      case 'worker': {
        let stopping = false;
        let lastHeartbeat = 0;
        const heartbeat = process.env.JARVIS_HEARTBEAT_FILE;
        const controller=new AbortController();
        const stop = () => { stopping = true; controller.abort(); };
        process.once('SIGTERM', stop);
        process.once('SIGINT', stop);
        const jobs=new QueueJobs(pool,process.env.JARVIS_N8N_LIVE_ENABLED==='true');
        const queueLoop=(async()=>{
          while(!stopping) {
            try{if(!await jobs.tick(controller.signal))await sleep(1000);}
            catch{console.error('Сбой worker очереди n8n.');await sleep(1000);}
          }
        })();
        while (!stopping) {
          try {
            const worked = await runner.tick();
            if (heartbeat && Date.now()-lastHeartbeat >= 10000) {
              await writeFile(heartbeat,'ok');
              lastHeartbeat=Date.now();
            }
            if (!worked) await sleep(250);
          } catch {
            console.error('Сбой worker. Повтор чтения очереди через секунду.');
            await sleep(1000);
          }
        }
        await queueLoop;
        return;
      }
    }
    throw new Error('Команды: migrate, publish CONNECTION GRAPH, start WORKFLOW ACTOR, show RUN ACTOR, history RUN ACTOR, act RUN ACTOR STEP EVENT [JSON], tick, worker');
  } finally {
    await pool.end();
  }
}

try {
  const result = await main(process.argv.slice(2));
  if (result !== undefined) console.log(JSON.stringify(result));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Ошибка исполнения');
  process.exitCode = 1;
}
