import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { Pool } from 'pg';
import { chromium } from 'playwright-core';
import { Runner } from '../../src/runner/engine.ts';
import { launchData } from './init-data.ts';

test('редактор на мобильном экране сохраняет черновик, проверяет связи и публикует immutable revision', {timeout:90000}, async t => {
  const app='http://app:8080';
  const workflow='cinema.search-and-download';
  const endpoint='/api/workflows/'+workflow;
  const login=async (actor:number)=>{
    const res=await fetch(app+'/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({initData:launchData(actor)})});
    assert.equal(res.status,200);return (await res.json()).token as string;
  };
  const request=(path:string,token:string,data?:unknown)=>fetch(app+path,{method:data===undefined?'GET':'POST',
    headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(data===undefined?{}:{body:JSON.stringify(data)})});
  const owner=await login(42), member=await login(43);
  assert.equal((await fetch(app+endpoint)).status,401);
  for (const [route,data] of [[endpoint,undefined],[endpoint+'/draft',{}],[endpoint+'/publish',{}],[endpoint+'/discard',{}]] as const) {
    assert.equal((await request(route,member,data)).status,403);
  }
  assert.equal((await fetch(app+'/api/me')).status,401);
  assert.deepEqual(await (await request('/api/me',member)).json(),{telegramUserId:'43',canEdit:false,reason:'user_not_admin'});
  assert.deepEqual(await (await request('/api/me',owner)).json(),{telegramUserId:'42',canEdit:true});
  const cinema=await (await request('/api/cinema',owner)).json();
  assert.equal(cinema.enabled,true);
  assert.equal(cinema.canSend,false);
  const db=new Pool();t.after(()=>db.end());
  const runner=new Runner(db);
  const oldRun=await runner.start(workflow,'42');
  const browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage']});
  t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:390,height:830},isMobile:true,hasTouch:true});
  page.setDefaultTimeout(8000);
  const errors:string[]=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('dialog',d=>d.accept());
  await page.route('https://telegram.org/js/telegram-web-app.js',route=>route.fulfill({contentType:'text/javascript',
    body:'window.Telegram={WebApp:{initData:'+JSON.stringify(launchData())+',ready(){},expand(){},onEvent(){},offEvent(){}}};'}));
  await page.goto(app);
  await page.getByRole('button',{name:'Редактор workflow'}).waitFor();
  assert.equal(await page.getByText(/Доступ к редактору|canEdit:|Telegram ID на сервере/).count(),0);
  const open=()=>page.getByRole('button',{name:'Редактор workflow'}).click();
  await open();
  const query=page.locator('[data-node="query"]');
  await query.scrollIntoViewIfNeeded();
  const box=await query.boundingBox();assert.ok(box);
  await page.mouse.move(box.x+18,box.y+18);await page.mouse.down();
  await page.mouse.move(box.x+58,box.y+58,{steps:4});await page.mouse.up();
  const pick=page.getByLabel('Выбранный узел');
  await pick.selectOption('search');
  await page.getByLabel('limit',{exact:true}).fill('3');
  await page.getByLabel('success',{exact:true}).selectOption('');
  await page.getByRole('button',{name:'Сохранить черновик'}).click();
  await page.getByText('Черновик сохранён.',{exact:true}).waitFor();
  const read=async()=> (await request(endpoint,owner)).json();
  const draft=await read();
  assert.equal(draft.revision,1);assert.ok(draft.version);
  assert.notDeepEqual(draft.graph.nodes.find((n:{id:string})=>n.id==='query').position,[0,0]);
  assert.equal((await request(endpoint+'/draft',owner,{version:null,revision:1,graph:draft.graph})).status,409);
  await page.reload();await open();await pick.selectOption('search');
  assert.equal(await page.getByLabel('limit',{exact:true}).inputValue(),'3');
  assert.equal(await page.getByLabel('success',{exact:true}).inputValue(),'');
  await page.getByRole('button',{name:'Опубликовать',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'отсутствует переход success'}).waitFor();
  assert.equal((await read()).version,draft.version);
  await page.getByRole('button',{name:'Связать success на схеме'}).click();
  await page.locator('[data-node="found"]').click();
  assert.equal(await page.getByLabel('success',{exact:true}).inputValue(),'found');
  await page.getByRole('button',{name:'Опубликовать',exact:true}).click();
  await page.getByText('Опубликована версия 2.',{exact:true}).waitFor();
  const published=await read();assert.equal(published.revision,2);assert.equal(published.version,null);
  assert.equal(published.graph.nodes.find((n:{id:string})=>n.id==='search').args.limit,3);
  assert.equal((await runner.view(oldRun,'42')).revision,1);
  assert.equal((await runner.view(await runner.start(workflow,'42'),'42')).revision,2);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
  await page.getByRole('button',{name:'Добавить узел'}).click();
  await page.getByLabel('Заголовок узла').fill('Новый финал');
  assert.equal(await pick.inputValue(),'result1');
  await page.getByRole('button',{name:'Удалить узел'}).click();
  await page.locator('summary').filter({hasText:'Файл и версии'}).click();
  const download=page.waitForEvent('download');
  await page.getByRole('button',{name:'Скачать JSON'}).click();
  const path=await (await download).path();assert.ok(path);
  const fromFile=JSON.parse(await readFile(path,'utf8'));
  assert.deepEqual(fromFile,published.graph);
  const form=fromFile.nodes.find((n:{id:string})=>n.id==='query');
  form.fields.push({key:'year',label:'Год выпуска',type:'string',maxLength:4});
  await page.locator('input[type=file]').setInputFiles({name:'workflow.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(fromFile))});
  await page.getByRole('button',{name:'Опубликовать',exact:true}).click();
  await page.getByText('Опубликована версия 3.',{exact:true}).waitFor();
  const current=await runner.start(workflow,'42');
  const screen=await runner.view(current,'42');
  assert.ok('fields' in screen);assert.equal(screen.fields.length,2);
  await page.getByRole('button',{name:'На главную'}).click();
  await page.reload();
  await page.getByRole('button',{name:/Новый поиск/}).first().click();
  await page.getByLabel('Год выпуска').waitFor();
  assert.deepEqual(errors,[]);

  const latest=await read();
  const command={revision:latest.revision,version:null,graph:latest.graph};
  const saves=await Promise.all([request(endpoint+'/draft',owner,command),request(endpoint+'/draft',owner,command)]);
  assert.deepEqual(saves.map(r=>r.status).sort(),[200,409]);
  const saved=await read();const publish={revision:latest.revision,version:saved.version};
  const concurrent=await Promise.all([request(endpoint+'/publish',owner,publish),request(endpoint+'/publish',owner,publish)]);
  assert.deepEqual(concurrent.map(r=>r.status).sort(),[200,409]);assert.equal((await read()).revision,4);
});

test('сбой истории не блокирует поиск, диагностика прав скрыта от участника', async t=>{
  const browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage']});
  t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:390,height:830}});
  await page.route('https://telegram.org/js/telegram-web-app.js',route=>route.fulfill({contentType:'text/javascript',
    body:'window.Telegram={WebApp:{initData:'+JSON.stringify(launchData(43))+',ready(){},expand(){},onEvent(){},offEvent(){}}};'}));
  await page.route('**/api/runs',route=>route.request().method()==='GET'
    ? route.fulfill({status:503,json:{error:'История недоступна'}}) : route.continue());
  await page.goto('http://app:8080');
  await page.getByText(/История недоступна/).waitFor();
  assert.equal(await page.getByText(/Доступ к редактору|canEdit:|Telegram ID на сервере/).count(),0);
  assert.equal(await page.getByRole('button',{name:'Редактор workflow'}).count(),0);
  await page.getByRole('button',{name:'Найти фильм'}).click();
  await page.locator('form input').first().waitFor();
});
