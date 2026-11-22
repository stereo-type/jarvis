import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright-core';
import { launchData } from './init-data.ts';

test('Mini App → runner → Filmobot → квитанция в мобильном Chromium', {timeout:60000}, async t => {
  const app='http://app:8080';
  const login = (initData:string) => fetch(app+'/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({initData})});
  assert.equal((await fetch(app+'/api/runs')).status,401);
  assert.equal((await login(launchData(999))).status,403);
  assert.equal((await login(launchData(42,1))).status,401);
  assert.equal((await login(launchData().replace('fixture','wrong'))).status,401);

  const browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage']});
  t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:375,height:780},isMobile:true,hasTouch:true});
  const errors:string[]=[];
  let logins=0;
  page.on('request',r=>{if(r.url().endsWith('/api/session')) logins++;});
  page.on('pageerror',err=>errors.push(err.message));
  await page.route('https://telegram.org/js/telegram-web-app.js',route=>route.fulfill({
    contentType:'text/javascript',body:'window.Telegram={WebApp:{initData:'+JSON.stringify(launchData())+',colorScheme:"dark",ready(){},expand(){},onEvent(){},offEvent(){}}};',
  }));
  await page.goto(app);
  await page.getByRole('button',{name:'Найти фильм'}).click();
  await page.getByRole('searchbox').fill('Солярис');
  await page.getByRole('button',{name:'Найти раздачи'}).click();
  await page.getByRole('heading',{name:'Выбери раздачу'}).waitFor();
  await page.reload();
  await page.getByRole('button',{name:/Солярис/}).click();
  const choice=page.getByRole('button',{name:/Сиды/}).first();
  await choice.click();
  const receipt=page.getByTestId('receipt');
  await receipt.waitFor();
  const number=await receipt.textContent();
  assert.match(number ?? '',/^[a-f0-9-]{36}$/);
  await page.getByRole('button',{name:'Журнал запуска'}).click();
  await page.getByText('enqueueDownload · Успешно').waitFor();
  await page.getByRole('button',{name:'На главную'}).click();
  await page.getByRole('button',{name:/Солярис.*Передано/}).click();
  assert.equal(await receipt.textContent(),number);
  assert.equal(logins,1);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
  assert.deepEqual(errors,[]);
  const stats=await (await fetch('http://filmobot:8080/fixture')).json();
  assert.equal(stats.files,1);
  assert.equal(stats.history,1);
  assert.equal(stats.requests.length,1);

  const mine=(await (await login(launchData(42))).json()).token;
  const other=(await (await login(launchData(43))).json()).token;
  const call=(path:string,token:string)=>fetch(app+path,{headers:{authorization:'Bearer '+token}});
  const [run]=await (await call('/api/runs',mine)).json();
  assert.deepEqual(await (await call('/api/runs',other)).json(),[]);
  assert.equal((await call('/api/runs/'+run.id,other)).status,404);
  assert.equal((await fetch(app+'/api/runs/'+run.id+'/actions',{method:'POST',headers:{authorization:'Bearer '+other,'content-type':'application/json'},
    body:JSON.stringify({step:'choose',event:'select',data:{value:'rutor:1'}})})).status,404);
});
