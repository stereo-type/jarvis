import assert from 'node:assert/strict';
import { createHash,createHmac } from 'node:crypto';
import test from 'node:test';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { Pool } from 'pg';
import { CinemaBridge, type CinemaAdapters } from '../../src/cinema/bridge.ts';
import { downloadTorrent,searchReleases } from '../../src/cinema/rutor.ts';
import { sendTorrentDocument } from '../../src/cinema/telegram.ts';
import { receiptPath } from '../../src/cinema/webhook.ts';
import { Runner } from '../../src/runner/engine.ts';
import { migrate } from '../../src/runner/storage.ts';
import { telegramAuth } from '../../src/telegram/auth.ts';
import { miniAppServer } from '../../src/telegram/server.ts';
import { WorkflowEditor } from '../../src/editor.ts';
import { QueueJobs } from '../../src/n8n/jobs.ts';

const info = Buffer.from('d6:lengthi1e4:name11:fixture.bin12:piece lengthi16384e6:pieces20:01234567890123456789e');
const file = Buffer.concat([Buffer.from('d4:info'),info,Buffer.from('e')]);
const hash = createHash('sha1').update(info).digest('hex');
const digest = createHash('sha256').update(file).digest('hex');
const token='1000:fixture';
const secret='isolated_test_secret';

async function filmobot(path:string,payload?:object) {
  const res=await fetch('http://filmobot:8080/'+path,{method:'POST',body:JSON.stringify(payload??{})});
  const result=await res.json();
  assert.equal(res.status,200,JSON.stringify(result));
  return result;
}

test('Mini App → RuTor → Telegram document → Filmobot watch folder → authenticated receipt after restart and redelivery',async t=>{
  const pool=new Pool({connectionString:process.env.DATABASE_URL});
  t.after(()=>pool.end());
  await migrate(pool);
  const replies:{text:string;files:number;storedDigest:string|null}[]=[];
  let downloads=0;
  const adapters:CinemaAdapters={
    search:(query,limit)=>searchReleases(query,limit,async()=>new Response('<table id="index"><tr><td>date</td><td><a href="/torrent/7/a">Fixture</a><a href="magnet:?xt=urn:btih:'+hash+'">M</a></td><td>1 B</td><td><span class="green">1</span><span class="red">0</span></td></tr></table>')),
    download:(id,h)=>downloadTorrent(id,h,async()=>{downloads++;return new Response(Uint8Array.from(file));}),
    send:(bot,peer,command,sum,bytes)=>sendTorrentDocument(bot,peer,command,sum,bytes,async(_url,init)=>{
      const form=init?.body as FormData;
      const caption=String(form.get('caption'));
      const [,wireCommand,wireDigest]=caption.split(' ');
      const attachment=form.get('document') as File;
      replies.push(await filmobot('send',{command:wireCommand,digest:wireDigest,bytes:Buffer.from(await attachment.arrayBuffer()).toString('base64')}));
      return Response.json({ok:true,result:{message_id:71,chat:{type:'private',id:Number(form.get('chat_id'))},caption,document:{file_id:'doc'}}});
    })
  };
  const env={JARVIS_CINEMA_TRANSPORT:'telegram',JARVIS_BOT_TOKEN:token,JARVIS_FILMOBOT_ID:'2000'};
  const fresh=()=>new Runner(pool,env,new CinemaBridge(pool,env,adapters));
  let runner=fresh();
  await runner.publish('examples/services/filmobot.connection.json','examples/workflows/cinema-search.json');
  const auth=telegramAuth(token,'42');
  const server=miniAppServer(runner,auth,async()=>{},true,new WorkflowEditor(pool),new Set(),new QueueJobs(pool,false),secret);
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  const base='http://127.0.0.1:'+(server.address() as AddressInfo).port;
  const init=new URLSearchParams({auth_date:String(Math.floor(Date.now()/1000)),user:'{"id":42}'});
  init.set('hash',createHmac('sha256',createHmac('sha256','WebAppData').update(token).digest()).update([...init].map(([k,v])=>k+'='+v).join('\n')).digest('hex'));
  const session=await fetch(base+'/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({initData:init.toString()})});
  assert.equal(session.status,200);
  const bearer=(await session.json()).token;
  async function api(path:string,data?:object){
    const res=await fetch(base+path,{method:data?'POST':'GET',headers:{authorization:'Bearer '+bearer,'content-type':'application/json'},...(data&&{body:JSON.stringify(data)})});
    assert.ok(res.ok,'Mini App returned '+res.status);
    return res.json();
  }
  const run=await api('/api/runs',{});
  const path='/api/runs/'+run.id;
  await api(path+'/actions',{step:'query',event:'submit',data:{query:'Fixture'}});
  await runner.tick();await runner.tick();
  const choice=await api(path);
  assert.equal(choice.choices[0].value,'rutor:7');
  runner=fresh();
  const select=()=>api(path+'/actions',{step:'choose',event:'select',data:{value:'rutor:7'}});
  await Promise.all([select(),select()]);
  await runner.tick();
  assert.equal(replies.length,1);
  assert.equal(replies[0]!.files,1);
  assert.equal(replies[0]!.storedDigest,digest);
  assert.equal((await api(path)).step,'enqueue');
  const original=replies[0]!.text;
  const [,command]=original.split(' ');
  assert.equal(original,'filmobot.torrent/1 '+command+' '+digest+' stored');
  async function webhook(text:string,peer:number,key=secret) {
    const res=await fetch(base+receiptPath,{method:'POST',headers:{'content-type':'application/json','x-telegram-bot-api-secret-token':key},body:JSON.stringify({message:{chat:{type:'private',id:peer},from:{id:peer,is_bot:true},text}})});
    return res.status;
  }
  assert.equal(await webhook(original,2000,'wrong'),403);
  assert.equal(await webhook(original,2001),200);
  assert.equal(await webhook(original.replace(digest,'0'.repeat(64)),2000),200);
  assert.equal((await pool.query('SELECT receipt FROM jarvis_cinema_deliveries')).rows[0].receipt,null);
  await filmobot('consume');await filmobot('restart');
  await pool.query('UPDATE jarvis_cinema_deliveries SET next_send=now()');
  await pool.query('UPDATE jarvis_runs SET due=now() WHERE id=$1',[run.id]);
  runner=fresh();
  await runner.tick();
  assert.equal(replies[1]!.text,original);
  assert.equal(replies[1]!.files,0);
  assert.equal(downloads,1);
  // A confirmed write can arrive after Jarvis has already displayed the timeout.
  await pool.query('UPDATE jarvis_cinema_deliveries SET deadline=now()');
  await pool.query('UPDATE jarvis_runs SET due=now() WHERE id=$1',[run.id]);
  await runner.tick();
  assert.equal((await api(path)).step,'uncertain');
  assert.equal(await webhook(original,2000),200);
  await runner.tick();
  assert.equal((await api(path)).step,'submitted');
  assert.equal((await api(path)).receipt,command);
  assert.equal(await webhook(original,2000),200);
  assert.equal(await runner.tick(),false);
  assert.equal(replies.length,2);
  assert.equal((await pool.query('SELECT document FROM jarvis_cinema_deliveries')).rows[0].document,null);
});
