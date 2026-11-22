import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { importQueue,validateQueue } from '../src/n8n/graph.ts';

const fixture=()=>JSON.parse(readFileSync('tests/fixtures/queue_v9.json','utf8'));
test('импорт сохраняет все выходы, координаты и ссылки credentials',()=>{
  const src=fixture(), graph=importQueue(src);
  assert.equal(graph.nodes.length,22);
  assert.equal(graph.revision,0);
  const read=graph.nodes.find(n=>n.name==='Read All Tasks')!;
  assert.deepEqual(Object.keys(read.on),['out0','out0.1']);
  assert.deepEqual(read.position,src.nodes.find((n:{name:string})=>n.name===read.name).position);
  assert.equal(graph.nodes.find(n=>n.name==='Call Coder')?.continueOnFail,true);
  assert.equal(graph.nodes.find(n=>n.name==='Read Projects')?.alwaysOutputData,true);
  assert.equal(read.credentials?.googleSheetsOAuth2Api?.id,'fixture-googleSheetsOAuth2Api');
  assert.equal(Object.keys(graph.nodes.find(n=>n.type==='n8n.switch')!.on).length,4);
});
test('диагностика называет несовместимые узлы до публикации',()=>{
  const src=fixture();
  src.nodes[1].typeVersion=99;src.nodes[2].type='n8n-nodes-base.redis';
  assert.throws(()=>importQueue(src),error=>error instanceof Error && error.message.includes('Read Projects') && error.message.includes('Read All Tasks'));
  const graph=importQueue(fixture());
  const code=graph.nodes.find(n=>n.type==='n8n.code')!;
  code.parameters.jsCode='return (';
  assert.throws(()=>validateQueue(graph),/Filter Ready Tasks/);
  code.parameters.jsCode='return []';
  code.on.out0=graph.entry;
  assert.throws(()=>validateQueue(graph),/триггер|цикл/);
});
test('неподдерживаемые типы входов и флаги не отбрасываются молча',()=>{
  const src=fixture();src.connections['Cron Trigger'].main[0][0].index=2;
  assert.throws(()=>importQueue(src),/connections/);
  const other=fixture();other.nodes[1].retryOnFail=true;
  assert.throws(()=>importQueue(other),/retryOnFail/);
});
