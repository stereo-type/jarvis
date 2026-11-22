import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

const origin = 'http://localhost:8080';
assert.equal((await fetch(origin + '/health')).status,200);
assert.match(await (await fetch(origin + '/')).text(), /Jarvis · Кино/);
const entries = new URLSearchParams({ auth_date: String(Math.floor(Date.now()/1000)), user: '{"id":42}' });
const check = [...entries].map(([k,v])=>k+'='+v).join('\n');
const key = createHmac('sha256','WebAppData').update(process.env.JARVIS_BOT_TOKEN).digest();
entries.set('hash',createHmac('sha256',key).update(check).digest('hex'));
const session=await fetch(origin+'/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({initData:entries.toString()})});
assert.equal(session.status,200);
const headers={authorization:'Bearer '+(await session.json()).token,'content-type':'application/json'};
assert.deepEqual(await (await fetch(origin+'/api/me',{headers})).json(),{telegramUserId:'42',canEdit:false,reason:'admins_not_configured'});
assert.deepEqual(await (await fetch(origin+'/api/cinema',{headers})).json(),{enabled:false});
assert.equal((await fetch(origin+'/api/runs',{method:'POST',headers,body:'{}'})).status,503);
assert.deepEqual(await (await fetch(origin+'/api/runs',{headers})).json(),[]);
console.log('Автономный Jarvis: вход и история работают, поиск без подключённого сервиса закрыт.');
