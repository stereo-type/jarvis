import { createQueueIO } from './io.ts';
import { executeQueue } from './execute.ts';
import type { QueueGraph } from './graph.ts';

process.once('message',async({graph,mode}:{graph:QueueGraph;mode:'test'|'live'})=>{
  let result;
  try {
    const {io,env}=createQueueIO(mode);
    result=await executeQueue(graph,io,env);
  } catch {
    result={status:'failed',steps:0,trace:[],error:'Не удалось подготовить подключения или выполнить граф.'};
  }
  process.send!(result,()=>process.disconnect());
});
// Do not continue external writes if the supervising worker dies.
process.on('disconnect',()=>process.exit(0));
