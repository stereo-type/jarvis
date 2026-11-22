import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { InvalidAction, Runner, RunNotFound } from '../runner/engine.ts';
import { HttpError, telegramAuth } from './auth.ts';
import type { WorkflowEditor } from '../editor.ts';
import type { QueueJobs } from '../n8n/jobs.ts';

const cinema = 'cinema.search-and-download';
const assets = new Map<string, [string, string]>([
  ['/', ['web/index.html','text/html; charset=utf-8']],
  ['/app.js', ['web/app.js','text/javascript']],
  ['/editor.js', ['web/editor.js','text/javascript']],
  ['/editor.css', ['web/editor.css','text/css']],
  ['/style.css', ['web/style.css','text/css']],
  ['/robot.jpg', ['jarvis-robot-640x360.jpg','image/jpeg']],
  ['/react.js', ['node_modules/react/umd/react.production.min.js','text/javascript']],
  ['/react-dom.js', ['node_modules/react-dom/umd/react-dom.production.min.js','text/javascript']],
  ['/htm.js', ['node_modules/htm/dist/htm.module.js','text/javascript']],
]);

async function body(req: IncomingMessage, limit = 16384) {
  if (req.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') throw new HttpError(415,'Ожидается JSON');
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > limit) throw new HttpError(413,'Слишком большой запрос');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
  catch { throw new HttpError(400,'Некорректный JSON'); }
}
function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, {'Content-Type':'application/json; charset=utf-8'}).end(JSON.stringify(data));
}

export function miniAppServer(runner: Runner, auth: ReturnType<typeof telegramAuth>, healthy: () => Promise<unknown>, cinemaEnabled: boolean, editor: WorkflowEditor, admins: ReadonlySet<string>, jobs:QueueJobs) {
  const action = z.object({ step:z.string().max(100), event:z.enum(['submit','select','cancel']), data:z.record(z.unknown()).default({}) }).strict();
  return createServer(async (req,res) => {
    res.setHeader('Cache-Control','no-store');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' https://telegram.org; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-src https://web.telegram.org https://telegram.org");
    try {
      const path = req.url?.split('?')[0] ?? '';
      const asset = assets.get(path);
      if (req.method === 'GET' && asset) {
        const bytes = await readFile(asset[0]);
        res.writeHead(200,{'Content-Type':asset[1]}).end(bytes);
        return;
      }
      if (path === '/health' && req.method === 'GET') { await healthy(); return json(res,200,{ok:true}); }
      if (path === '/api/session' && req.method === 'POST') {
        const {initData} = z.object({initData:z.string()}).strict().parse(await body(req));
        return json(res,200,{token:auth.login(initData)});
      }
      if (!path.startsWith('/api/')) throw new HttpError(404,'Страница не найдена');
      const actor = auth.actor(req.headers.authorization);
      if (path === '/api/me' && req.method === 'GET') return json(res,200,{canEdit:admins.has(actor)});
      if (path === '/api/workflows' || path.startsWith('/api/workflows/')) {
        if (!admins.has(actor)) throw new HttpError(403,'Редактор доступен администраторам Jarvis.');
        if (path === '/api/workflows' && req.method === 'GET') return json(res,200,await editor.list());
        if (path === '/api/workflows/import-n8n' && req.method === 'POST') {
          return json(res,200,{...await editor.import(await body(req,524288)),liveEnabled:jobs.liveEnabled});
        }
        const runPath=/^\/api\/workflows\/(n8n\.[\w-]+)\/runs\/([\w-]+)$/.exec(path);
        if(runPath && req.method==='GET' && z.string().uuid().safeParse(runPath[2]).success) {
          return json(res,200,await jobs.view(runPath[1]!,actor,runPath[2]!));
        }
        const match = /^\/api\/workflows\/([A-Za-z][\w.-]*)(?:\/(draft|publish|discard|run))?$/.exec(path);
        if (match) {
          const workflow = match[1]!;
          const op = match[2];
          if (!op && req.method === 'GET') return json(res,200,{...await editor.read(workflow),liveEnabled:jobs.liveEnabled});
          if(op==='run' && req.method==='POST')return json(res,202,await jobs.start(workflow,actor,await body(req)));
          if ((op === 'draft' || op === 'publish' || op === 'discard') && req.method === 'POST') {
            return json(res,200,{...await editor.write(workflow,op,await body(req,op === 'draft' ? 524288 : 16384)),liveEnabled:jobs.liveEnabled});
          }
        }
        throw new HttpError(404,'Маршрут редактора не найден.');
      }
      if (path === '/api/cinema' && req.method === 'GET') return json(res,200,{enabled:cinemaEnabled});
      if (path === '/api/runs') {
        if (req.method === 'GET') return json(res,200,await runner.recent(actor,cinema));
        if (req.method === 'POST') {
          if (!cinemaEnabled) throw new HttpError(503,'Сервис поиска пока не подключён.');
          z.object({}).strict().parse(await body(req));
          const id = await runner.start(cinema,actor);
          return json(res,201,await runner.view(id,actor));
        }
      }
      const route = /^\/api\/runs\/([^/]+)(\/actions|\/history)?$/.exec(path);
      if (route && z.string().uuid().safeParse(route[1]).success) {
        const id = route[1]!;
        if (!route[2] && req.method === 'GET') return json(res,200,await runner.view(id,actor));
        if (route[2] === '/history' && req.method === 'GET') return json(res,200,await runner.history(id,actor));
        if (route[2] === '/actions' && req.method === 'POST') {
          const input = action.parse(await body(req));
          if (!cinemaEnabled && input.event !== 'cancel') throw new HttpError(503,'Сервис поиска пока не подключён.');
          await runner.act(id,actor,input.step,input.event,input.data);
          return json(res,200,await runner.view(id,actor));
        }
      }
      throw new HttpError(404,'Страница не найдена');
    } catch (error) {
      if (error instanceof HttpError) return json(res,error.status,{error:error.message});
      if (error instanceof RunNotFound) return json(res,404,{error:error.message});
      if (error instanceof InvalidAction || error instanceof z.ZodError) return json(res,400,{error:'Проверьте введённые данные.'});
      console.error('Ошибка запроса Mini App', {method:req.method, type:error instanceof Error ? error.name : 'unknown'});
      json(res,500,{error:'Jarvis временно недоступен. Попробуйте ещё раз.'});
    }
  });
}
