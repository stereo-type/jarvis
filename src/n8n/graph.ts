import { Script } from 'node:vm';
import { z } from 'zod';
import { HttpError } from '../telegram/auth.ts';

const versions = {cron:1,googleSheets:4,code:2,if:2,noOp:1,httpRequest:4.2,switch:3,errorTrigger:1,telegram:1.2};
const credential = z.object({id:z.string(),name:z.string()}).strict();
const point = z.tuple([z.number().finite().min(-100000).max(100000),z.number().finite().min(-100000).max(100000)]);
const common = {
  name:z.string().min(1).max(160), type:z.string(), typeVersion:z.number(), position:point,
  parameters:z.record(z.unknown()), credentials:z.record(credential).optional(),
  alwaysOutputData:z.boolean().optional(), continueOnFail:z.boolean().optional(),
};
const node = z.object({...common,id:z.string().regex(/^n[\w-]+$/),on:z.record(z.string())}).strict();
export const queueGraph = z.object({
  schemaVersion:z.literal('jarvis.n8n/v1'), id:z.string().regex(/^n8n\.[\w-]+$/), revision:z.number().int().nonnegative(),
  entry:z.string(),title:z.string().min(1).max(200),nodes:z.array(node).min(1).max(300),
}).strict();
export type QueueNode = z.infer<typeof node>;
export type QueueGraph = z.infer<typeof queueGraph>;
const exportedNode = z.object({...common,id:z.string().regex(/^[\w-]+$/),webhookId:z.string().optional()}).strict();
const target = z.object({node:z.string(),type:z.literal('main'),index:z.literal(0)}).strict();
const exported = z.object({
  id:z.string().regex(/^[\w-]+$/),name:z.string(),nodes:z.array(z.unknown()).min(1).max(300),
  connections:z.record(z.object({main:z.array(z.array(target))}).strict()),
  settings:z.object({executionOrder:z.literal('v1').optional(),binaryMode:z.literal('separate').optional()}).strict().optional(),
  pinData:z.object({}).strict().optional(),
});
const empty=z.object({}).strict();
const locator=z.object({__rl:z.literal(true),value:z.string(),mode:z.enum(['id','name'])}).strict();
const conditions=z.object({
  options:z.object({caseSensitive:z.literal(true),leftValue:z.literal(''),typeValidation:z.literal('strict'),version:z.literal(1)}).strict(),
  conditions:z.array(z.object({id:z.string(),leftValue:z.string(),rightValue:z.union([z.string(),z.boolean()]),
    operator:z.object({type:z.enum(['boolean','string']),operation:z.literal('equals')}).strict()}).strict()).min(1),
  combinator:z.enum(['and','or']),
}).strict();
const sheetFields={documentId:locator,sheetName:locator,options:empty};
const schemas:Record<string,z.ZodTypeAny>={
  cron:empty,noOp:empty,errorTrigger:empty,
  code:z.object({jsCode:z.string().min(1).max(80000)}).strict(),
  if:z.object({conditions,options:empty}).strict(),
  switch:z.object({rules:z.object({values:z.array(z.object({conditions,renameOutput:z.boolean(),outputKey:z.string()}).strict()).min(1)}).strict(),
    options:z.object({fallbackOutput:z.literal('extra')}).strict()}).strict(),
  googleSheets:z.union([z.object({...sheetFields,operation:z.literal('read').optional()}).strict(),
    z.object({...sheetFields,operation:z.literal('update'),columns:z.object({mappingMode:z.literal('defineBelow'),value:z.record(z.unknown()),
      matchingColumns:z.tuple([z.string().min(1)]),schema:z.array(z.record(z.unknown()))}).strict()}).strict()]),
  httpRequest:z.object({method:z.enum(['POST','DELETE']),url:z.string().min(1),sendBody:z.literal(true).optional(),specifyBody:z.literal('json').optional(),
    jsonBody:z.string().optional(),options:z.object({timeout:z.number().int().positive().max(900000).optional(),
    response:z.object({response:z.object({responseFormat:z.literal('json')}).strict()}).strict().optional()}).strict()}).strict(),
  telegram:z.object({chatId:z.string(),text:z.string(),additionalFields:z.object({appendAttribution:z.literal(false),parse_mode:z.literal('HTML')}).strict()}).strict(),
};
function fail(messages:string[]):never {throw new HttpError(422,messages.join('\n'));}
function syntax(code:string) { new Script('(function(){\n'+code+'\n})'); }
function expressions(value:unknown) {
  if (value && typeof value==='object') {for(const child of Object.values(value)) expressions(child);return;}
  if(typeof value==='string' && value.startsWith('=')) {
    const matches=[...value.matchAll(/{{([\s\S]*?)}}/g)];
    if(!matches.length)throw Error('expression');
    for(const m of matches) syntax('return ('+m[1]+');');
  }
}
export function validateQueue(graph:QueueGraph) {
  const errors:string[]=[];
  const ids=new Set(graph.nodes.map(n=>n.id));
  const names=new Set(graph.nodes.map(n=>n.name));
  if(ids.size!==graph.nodes.length || names.size!==graph.nodes.length)errors.push('Повторяется имя или ID узла.');
  const triggers=graph.nodes.filter(n=>n.type==='n8n.cron');
  const handlers=graph.nodes.filter(n=>n.type==='n8n.errorTrigger');
  if(triggers.length!==1 || triggers[0]?.id!==graph.entry || handlers.length>1)errors.push('Требуются один вход Cron и не более одного Error Trigger.');
  const incoming=new Map(graph.nodes.map(n=>[n.id,0]));
  for(const n of graph.nodes){
    const kind=n.type.slice(4);
    if(!n.type.startsWith('n8n.') || !Object.hasOwn(versions,kind) || versions[kind as keyof typeof versions]!==n.typeVersion){
      errors.push(n.name+': тип или версия не поддерживается ('+n.type+' v'+n.typeVersion+').');continue;
    }
    const result=schemas[kind]!.safeParse(n.parameters);
    if(!result.success){errors.push(n.name+': неподдерживаемые параметры ('+result.error.issues.map(i=>i.path.join('.')||i.message).join(', ')+').');continue;}
    const p=result.data;
    const outputs=kind==='if'?2:kind==='switch'?p.rules.values.length+1:1;
    const expectedCredential=kind==='googleSheets'?'googleSheetsOAuth2Api':kind==='telegram'?'telegramApi':undefined;
    if(expectedCredential && !n.credentials?.[expectedCredential])errors.push(n.name+': отсутствует ссылка '+expectedCredential);
    if(Object.keys(n.credentials??{}).some(k=>k!==expectedCredential))errors.push(n.name+': неподдерживаемый вид credentials.');
    if(kind==='httpRequest' && (p.method==='POST' ? !p.sendBody || p.specifyBody!=='json' || !p.jsonBody : p.sendBody||p.specifyBody||p.jsonBody))errors.push(n.name+': неверное тело HTTP-запроса.');
    try{if(kind==='code')syntax(p.jsCode);else expressions(n.parameters);}catch{errors.push(n.name+': синтаксическая ошибка в коде или выражении.');}
    for(const [port,to] of Object.entries(n.on)){
      const m=/^out(0|[1-9]\d*)(?:\.[1-9]\d*)?$/.exec(port);
      if(!m || Number(m[1])>=outputs || !ids.has(to))errors.push(n.name+': неверный переход '+port);
      else incoming.set(to,incoming.get(to)!+1);
    }
  }
  const starts=[...triggers,...handlers];
  const startIds=new Set(starts.map(n=>n.id));
  if(graph.nodes.some(n=>(incoming.get(n.id)===0)!==startIds.has(n.id)))errors.push('Есть узел без входа или переход в триггер.');
  const queue=starts.slice(), byId=new Map(graph.nodes.map(n=>[n.id,n]));
  for(let i=0;i<queue.length && i<graph.nodes.length;i++){
    for(const dest of Object.values(queue[i]!.on)){
      const count=(incoming.get(dest)??0)-1;incoming.set(dest,count);
      if(count===0 && byId.has(dest))queue.push(byId.get(dest)!);
    }
  }
  if(queue.length!==graph.nodes.length)errors.push('В графе есть цикл или недостижимые узлы.');
  if(errors.length)fail(errors);
}
export function importQueue(raw:unknown):QueueGraph {
  const parsed=exported.safeParse(raw);
  if(!parsed.success)fail(parsed.error.issues.map(i=>'Экспорт n8n · '+i.path.join('.')+': '+i.message));
  const src=parsed.data, errors:string[]=[], nodes:QueueNode[]=[];
  for(const [index,value] of src.nodes.entries()){
    const result=exportedNode.safeParse(value);
    if(!result.success){errors.push('nodes['+index+']: '+result.error.issues.map(i=>i.path.join('.')+' '+i.message).join(', '));continue;}
    const {webhookId:_,type,id,...rest}=result.data;
    nodes.push({...rest,id:'n'+id,type:type.replace(/^n8n-nodes-base\./,'n8n.'),on:{}});
  }
  const names=new Map(nodes.map(n=>[n.name,n]));
  for(const [from,edges] of Object.entries(src.connections)){
    const source=names.get(from);
    if(!source){errors.push('Неизвестный источник '+from);continue;}
    edges.main.forEach((links,index)=>links.forEach((edge,branch)=>{
      const dest=names.get(edge.node);
      if(!dest)errors.push(from+': неизвестная цель '+edge.node);
      else source.on['out'+index+(branch?'.'+branch:'')]=dest.id;
    }));
  }
  if(errors.length)fail(errors);
  const graph=queueGraph.parse({schemaVersion:'jarvis.n8n/v1',id:'n8n.'+src.id,title:src.name,revision:0,entry:nodes.find(n=>n.type==='n8n.cron')?.id??'',nodes});
  validateQueue(graph);
  return graph;
}
