import { createHmac } from 'node:crypto';

export const bot = '1000:fixture';
export function launchData(actor = 42, timestamp = Math.floor(Date.now()/1000)) {
  const user = JSON.stringify({first_name:'Иван',id:actor});
  const canonical = 'auth_date='+timestamp+'\nquery_id=fixture\nuser='+user;
  const key = createHmac('sha256','WebAppData').update(bot).digest();
  const hash = createHmac('sha256',key).update(canonical).digest('hex');
  return new URLSearchParams({user,query_id:'fixture',hash,auth_date:String(timestamp)}).toString();
}
