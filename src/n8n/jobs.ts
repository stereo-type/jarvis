import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import type { Pool } from 'pg';
import { z } from 'zod';
import { HttpError } from '../telegram/auth.ts';
import type { QueueGraph } from './graph.ts';
import type { QueueResult } from './execute.ts';

const command=z.object({mode:z.enum(['test','live']),revision:z.number().int().positive(),requestId:z.string().uuid()}).strict();
type Mode=z.infer<typeof command>['mode'];
const fields='id, workflow, revision, mode, status, result';
type Job={id:string;workflow:string;revision:number;mode:Mode;status:string;result:QueueResult|null};
function failed(error:string):QueueResult{return {status:'failed',steps:0,trace:[],error};}

export class QueueJobs {
  private pool:Pool;
  readonly liveEnabled:boolean;
  constructor(pool:Pool,liveEnabled:boolean){this.pool=pool;this.liveEnabled=liveEnabled;}

  async start(workflow:string,actor:string,raw:unknown) {
    const {mode,revision,requestId}=command.parse(raw);
    if(mode==='live' && !this.liveEnabled)throw new HttpError(403,'Рабочий режим очереди отключён.');
    const db=await this.pool.connect();
    try {
      await db.query('BEGIN');
      // Replays use the original run even when a newer definition has appeared.
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',[actor+requestId]);
      let row=(await db.query<Job>('SELECT '+fields+' FROM jarvis_queue_runs WHERE actor=$1 AND request_id=$2',[actor,requestId])).rows[0];
      if(row && (row.workflow!==workflow || row.revision!==revision || row.mode!==mode))throw new HttpError(409,'Ключ запуска уже использован с другими параметрами.');
      if(!row){
        const pub=await db.query(`SELECT revision,snapshot->'graph'->>'schemaVersion' AS format FROM jarvis_definitions WHERE workflow=$1 ORDER BY revision DESC LIMIT 1`,[workflow]);
        if(pub.rows[0]?.format!=='jarvis.n8n/v1')throw new HttpError(404,'Импортированный workflow не опубликован.');
        if(pub.rows[0].revision!==revision)throw new HttpError(409,'Откройте актуальную опубликованную версию.');
        row=(await db.query<Job>(`INSERT INTO jarvis_queue_runs(id,actor,workflow,revision,request_id,mode,status) VALUES($1,$2,$3,$4,$5,$6,'queued') ON CONFLICT DO NOTHING RETURNING `+fields,
          [randomUUID(),actor,workflow,revision,requestId,mode])).rows[0];
        if(!row)throw new HttpError(409,'Для этой таблицы уже выполняется рабочий запуск.');
      }
      await db.query('COMMIT');return row;
    } catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
  }

  async view(workflow:string,actor:string,id:string) {
    const {rows}=await this.pool.query<Job>('SELECT '+fields+' FROM jarvis_queue_runs WHERE workflow=$1 AND actor=$2 AND id=$3',[workflow,actor,id]);
    if(!rows[0])throw new HttpError(404,'Запуск не найден.');
    return rows[0];
  }

  async tick(stop:AbortSignal) {
    // A lost worker may have already submitted a remote command. Never replay it automatically.
    await this.pool.query(`UPDATE jarvis_queue_runs SET status='failed',result=$1 WHERE status='running' AND heartbeat<now()-interval '90 seconds'`,
      [failed('Потеряна связь с worker. Перед повторным запуском проверьте внешние операции.')]);
    if(stop.aborted)return false;
    const {rows}=await this.pool.query<Job & {graph:QueueGraph}>(`WITH pending AS (
      SELECT id FROM jarvis_queue_runs WHERE status='queued' ORDER BY created LIMIT 1 FOR UPDATE SKIP LOCKED
    ) UPDATE jarvis_queue_runs r SET status='running',heartbeat=now() FROM pending p, jarvis_definitions d
    WHERE r.id=p.id AND d.workflow=r.workflow AND d.revision=r.revision RETURNING r.id,r.mode,d.snapshot->'graph' AS graph`);
    const job=rows[0];
    if(!job)return false;
    const cancel=new AbortController();
    const heartbeat=setInterval(()=>{
      void this.pool.query("UPDATE jarvis_queue_runs SET heartbeat=now() WHERE id=$1 AND status='running'",[job.id])
        .then(res=>{if(!res.rowCount)cancel.abort();}).catch(()=>cancel.abort());
    },10000);
    let result:QueueResult;
    try {
      result=job.mode==='live' && !this.liveEnabled?failed('Подключения рабочего режима отключены у worker.'):
        await runChild(job.graph,job.mode,AbortSignal.any([stop,cancel.signal]));
    } finally {clearInterval(heartbeat);}
    await this.pool.query("UPDATE jarvis_queue_runs SET status=$2,result=$3 WHERE id=$1 AND status='running'",[job.id,result.status,result]);
    return true;
  }
}

function runChild(graph:QueueGraph,mode:Mode,signal:AbortSignal):Promise<QueueResult> {
  return new Promise(resolve=>{
    if(signal.aborted){resolve(failed('Запуск остановлен.'));return;}
    const child=fork(new URL('./process.ts',import.meta.url),[],{execArgv:['--max-old-space-size=160'],stdio:['ignore','ignore','ignore','ipc'],env:mode==='test'?{}:process.env});
    let result:QueueResult|undefined;
    const abort=()=>{result=failed('Выполнение прервано. Сверьте результат внешних операций.');child.kill('SIGKILL');};
    const timeout=setTimeout(abort,mode==='test'?30000:30*60000);
    signal.addEventListener('abort',abort,{once:true});
    child.on('message',(message:QueueResult)=>{if(!result && ['done','failed'].includes(message.status))result=message;});
    function finish(){
      clearTimeout(timeout);signal.removeEventListener('abort',abort);
      resolve(result??failed('Процесс исполнения остановлен. Сверьте результат внешних операций.'));
    }
    child.once('error',finish);
    child.once('exit',finish);
    child.send({graph,mode},err=>{if(err)abort();});
  });
}
