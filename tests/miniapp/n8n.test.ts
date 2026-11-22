import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { chromium } from 'playwright-core';
import { launchData } from './init-data.ts';

test('queue_v9 загружается из n8n, открывается из черновика и запускает изменённую ветку', {timeout:90000}, async t => {
  const app='http://app:8080';
  const file='/input/queue_v9.json';
  const source=JSON.parse(await readFile(file,'utf8'));
  const workflow='n8n.'+source.id;
  const browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:[
    '--no-sandbox','--disable-dev-shm-usage','--unsafely-treat-insecure-origin-as-secure='+app,
  ]});
  t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:390,height:830},isMobile:true,hasTouch:true});
  page.setDefaultTimeout(12000);
  const errors:string[]=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('https://telegram.org/js/telegram-web-app.js',route=>route.fulfill({
    contentType:'text/javascript',
    body:'window.Telegram={WebApp:{initData:'+JSON.stringify(launchData())+',ready(){},expand(){},onEvent(){},offEvent(){}}};',
  }));
  await page.goto(app);
  const open=()=>page.getByRole('button',{name:'Редактор workflow'}).click();
  const save=page.getByRole('button',{name:'Сохранить черновик'});
  const publish=page.getByRole('button',{name:'Опубликовать',exact:true});
  const start=page.getByRole('button',{name:'Тестовый запуск'});
  const scope=page.getByRole('list',{name:'Журнал узлов'});
  async function execute(revision:number) {
    await start.click();
    await page.getByText('Тестовый запуск · Версия '+revision+' · Завершён',{exact:true}).waitFor();
  }
  await open();
  const chooser=page.waitForEvent('filechooser');
  await page.getByRole('button',{name:/Загрузить JSON/}).click();
  await (await chooser).setFiles(file);
  await page.getByText(/Workflow n8n импортирован/).waitFor();
  assert.equal(await page.locator('[data-node]').count(),source.nodes.length);
  assert.equal(await page.getByRole('button',{name:'Добавить узел'}).count(),0);
  assert.ok(await start.isDisabled());
  await save.click();
  await page.getByText('Черновик сохранён.',{exact:true}).waitFor();
  await page.reload();
  await open();
  await page.getByRole('combobox',{name:'Workflow',exact:true}).selectOption(workflow);
  await page.getByText('До первой публикации · Сохранённый черновик',{exact:true}).waitFor();
  await publish.click();
  await page.getByText('Опубликована версия 1.',{exact:true}).waitFor();
  assert.ok(await page.getByRole('button',{name:'Рабочий запуск'}).isDisabled());
  await execute(1);
  await scope.getByText(/Mark IN_REVIEW/).waitFor();
  assert.equal(await scope.getByText(/No Tasks Ready/).count(),0);

  await page.getByLabel('Выбранный узел').selectOption({label:'Filter Ready Tasks · code'});
  const script=page.getByLabel('JavaScript (jsCode)');
  assert.match(await script.inputValue(),/readyTasks/);
  const edited='return [{ json: { skip: true, reason: "Browser test" } }];';
  await script.fill(edited);
  assert.equal(JSON.parse(await page.getByLabel('Параметры узла (JSON)').inputValue()).jsCode,edited);
  assert.ok(await start.isDisabled());
  await save.click();
  await page.getByText('Черновик сохранён.',{exact:true}).waitFor();
  await publish.click();
  await page.getByText('Опубликована версия 2.',{exact:true}).waitFor();
  await execute(2);
  await scope.getByText(/No Tasks Ready/).waitFor();
  assert.equal(await scope.getByText(/Call Coder|Mark IN_REVIEW/).count(),0);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
  assert.deepEqual(errors,[]);

  async function token(actor:number){
    const res=await fetch(app+'/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({initData:launchData(actor)})});
    assert.equal(res.status,200);return (await res.json()).token as string;
  }
  const url=app+'/api/workflows/'+workflow+'/run';
  const owner=await token(42),member=await token(43);
  const submit=(auth:string,data:unknown)=>fetch(url,{method:'POST',headers:{Authorization:'Bearer '+auth,'Content-Type':'application/json'},body:JSON.stringify(data)});
  const command={mode:'test',revision:2,requestId:randomUUID()};
  assert.equal((await submit(member,command)).status,403);
  assert.equal((await submit(owner,{...command,mode:'live'})).status,403);
  assert.equal((await submit(owner,{...command,revision:1})).status,409);
  const pair=await Promise.all([submit(owner,command),submit(owner,command)]);
  assert.deepEqual(pair.map(r=>r.status),[202,202]);
  const records=await Promise.all(pair.map(r=>r.json()));
  assert.equal(records[0].id,records[1].id);
  assert.equal((await submit(owner,{...command,revision:1})).status,409);
});
