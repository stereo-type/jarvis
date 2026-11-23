import test from 'node:test';
import assert from 'node:assert/strict';
import { registerCinemaWebhook } from '../src/cinema/webhook.ts';

const env={JARVIS_PUBLIC_URL:'https://jarvis.example/',JARVIS_BOT_TOKEN:'1000:example',JARVIS_FILMOBOT_ID:'2000',JARVIS_CINEMA_WEBHOOK_SECRET:'0123456789abcdef'};

test('webhook registration preserves other webhook consumers and queued updates',async()=>{
  for(const url of ['','https://jarvis.example/telegram/cinema/receipt','https://elsewhere.example/bot']){
    const calls:string[]=[];
    const setup=registerCinemaWebhook(env,async(input,init)=>{
      const method=String(input).split('/').pop()!;
      calls.push(method);
      if(method==='getWebhookInfo')return Response.json({ok:true,result:{url}});
      assert.deepEqual(JSON.parse(String(init?.body)),{url:'https://jarvis.example/telegram/cinema/receipt',secret_token:env.JARVIS_CINEMA_WEBHOOK_SECRET,allowed_updates:['message'],drop_pending_updates:false});
      return Response.json({ok:true,result:true});
    });
    if(url.includes('elsewhere')){
      await assert.rejects(setup,/другой webhook/);
      assert.deepEqual(calls,['getWebhookInfo']);
    } else{
      await setup;
      assert.deepEqual(calls,['getWebhookInfo','setWebhook']);
    }
  }
});
