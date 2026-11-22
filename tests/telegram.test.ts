import assert from 'node:assert/strict';
import { test } from 'node:test';
import { telegramAuth, HttpError } from '../src/telegram/auth.ts';
import { launchData, bot } from './miniapp/init-data.ts';

test('Telegram: подпись, срок, whitelist и срок сессии', () => {
  let now=1800000000;
  const auth=telegramAuth(bot,'42',()=>now);
  const denied=(status:number)=>(e:unknown)=>e instanceof HttpError && e.status===status;
  const signed=launchData(42,now);
  const token=auth.login(signed);
  assert.equal(auth.actor('Bearer '+token),'42');
  assert.throws(()=>auth.login(launchData(43,now)),denied(403));
  assert.throws(()=>auth.login(launchData(42,now-301)),denied(401));
  assert.throws(()=>auth.login(launchData(42,now+31)),denied(401));
  assert.throws(()=>auth.login(signed.replace('fixture','changed')),denied(401));
  assert.throws(()=>auth.login(signed+'&user=%7B%7D'),denied(401));
  assert.throws(()=>auth.actor('Bearer '+token.replace('42.','43.')),denied(401));
  assert.throws(()=>telegramAuth(bot,'',()=>now).actor('Bearer '+token),denied(403));
  now+=3600;
  assert.throws(()=>auth.actor('Bearer '+token),denied(401));
});
