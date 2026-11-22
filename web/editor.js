import htm from '/htm.js';
const h = htm.bind(React.createElement);
const {useEffect, useRef, useState} = React;
const types = {
  'ui.form':'Форма', 'service.call':'Вызов сервиса', 'flow.hasItems':'Условие',
  'ui.choice':'Выбор', 'ui.result':'Результат',
};
const ports = {'ui.form':['submit'], 'service.call':['success','error'], 'flow.hasItems':['yes','no'], 'ui.choice':['select','cancel','expired'], 'ui.result':[]};
const structural = ['id','type','position','on'];
const params = node => Object.fromEntries(Object.entries(node).filter(([key])=>!structural.includes(key)));
const pretty = value => JSON.stringify(value,null,2);
const isN8n = graph => graph?.schemaVersion==='jarvis.n8n/v1';
const typeLabel = node => types[node.type] ?? node.type.replace(/^n8n\./,'');
const displayName = node => [node.name,node.title,node.operationId,node.id].find(value=>typeof value==='string');
function portList(node) {
  let outputs=ports[node.type] ?? ['out0'];
  if(node.type==='n8n.if') outputs=['out0','out1'];
  if(node.type==='n8n.switch' && Array.isArray(node.parameters?.rules?.values)) {
    const count=node.parameters.rules.values.length+(node.parameters.options?.fallbackOutput==='extra'?1:0);
    outputs=Array.from({length:count},(_,i)=>'out'+i);
  }
  return [...new Set([...outputs,...Object.keys(node.on ?? {})])];
}

function initialParams(type, operation) {
  switch(type) {
    case 'ui.form': return {title:'Новая форма',fields:[{key:'text',label:'Текст',type:'string'}]};
    case 'ui.result': return {title:'Готово'};
    case 'flow.hasItems': return {items:{$ref:''}};
    case 'ui.choice': return {title:'Выберите вариант',items:{$ref:''},expiresAt:{$ref:''},valueField:'id',labelField:'title',detailFields:[]};
    case 'service.call': return {service:operation.service, apiMajor:operation.apiMajor, operationId:operation.operationId, args:{}};
  }
}

function Canvas({graph, selected, select, move, disabled, zoom, linking, connect}) {
  const drag = useRef(null);
  const offsetX = 28 - Math.min(0,...graph.nodes.map(n=>n.position[0]));
  const offsetY = 28 - Math.min(0,...graph.nodes.map(n=>n.position[1]));
  const width = Math.max(500,offsetX+Math.max(0,...graph.nodes.map(n=>n.position[0]))+224);
  const height = Math.max(310,offsetY+Math.max(0,...graph.nodes.map(n=>n.position[1]))+134);
  const byId = new Map(graph.nodes.map(n=>[n.id,n]));
  const lines = [];
  for (const source of graph.nodes) {
    const names = portList(source);
    names.forEach((port,index)=>{
      const target = byId.get(source.on?.[port]);
      if (!target) return;
      const x = offsetX+source.position[0]+184, y=offsetY+source.position[1]+80*(index+1)/(names.length+1);
      const tx=offsetX+target.position[0], ty=offsetY+target.position[1]+40;
      const bend=Math.max(34,Math.min(130,Math.abs(tx-x)/2));
      lines.push(h`<g key=${source.id+':'+port} className=${source.id===selected?'outgoing':''}>
        <title>${source.id} · ${port} → ${target.id}</title>
        <path d=${'M '+x+' '+y+' C '+(x+bend)+' '+y+', '+(tx-bend)+' '+ty+', '+(tx-3)+' '+ty} markerEnd="url(#arrow)" />
        <circle cx=${x} cy=${y} r="3"/></g>`);
    });
  }
  function start(event,node) {
    if (disabled || linking || event.button!==0) return;
    select(node.id);
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current={id:node.id, pointer:event.pointerId, x:event.clientX, y:event.clientY, position:node.position, minX:28-offsetX,minY:28-offsetY};
  }
  function update(event) {
    const d=drag.current;
    if (!d || disabled || event.pointerId!==d.pointer) return;
    const dx=(event.clientX-d.x)/zoom, dy=(event.clientY-d.y)/zoom;
    if (Math.abs(dx)+Math.abs(dy)<3) return;
    move(d.id,[Math.min(100000,Math.max(d.minX,Math.round(d.position[0]+dx))),Math.min(100000,Math.max(d.minY,Math.round(d.position[1]+dy)))]);
  }
  return h`<div className="graph-viewport" aria-label="Полотно workflow" tabIndex="0"><div style=${{width:width*zoom,height:height*zoom}}>
    <div className="graph-plane" style=${{width,height,transform:'scale('+zoom+')'}}>
    <svg className="graph-links" width=${width} height=${height} aria-hidden="true"><defs><marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 L8 4 L0 8z"/></marker></defs>${lines}</svg>
    ${graph.nodes.map(n=>h`<button key=${n.id} className=${'graph-node kind-'+n.type.split('.')[0]} aria-pressed=${selected===n.id} data-node=${n.id}
       disabled=${disabled || (linking && selected===n.id)} style=${{left:offsetX+n.position[0],top:offsetY+n.position[1]}} onClick=${()=>linking?connect(n.id):select(n.id)}
       onPointerDown=${e=>start(e,n)} onPointerMove=${update} onLostPointerCapture=${()=>{drag.current=null;}}>
       <small>${typeLabel(n)}${graph.entry===n.id?' · Вход':''}</small>
       <strong>${displayName(n)}</strong><code>${n.id}</code></button>`)}
    </div></div></div>`;
}

export function WorkflowEditor({api, leave, telegram}) {
  const [workflows,setWorkflows]=useState([]);
  const [record,setRecord]=useState(null);
  const [graph,setGraph]=useState(null);
  const [selected,setSelected]=useState('');
  const [zoom,setZoom]=useState(.8);
  const [dirty,setDirty]=useState(false);
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState('');
  const [error,setError]=useState('');
  const [json,setJson]=useState(null);
  const [jsonError,setJsonError]=useState('');
  const [palette,setPalette]=useState('ui.result');
  const [customPort,setCustomPort]=useState('');
  const [linking,setLinking]=useState('');
  const [loading,setLoading]=useState(true);
  const [run,setRun]=useState(null);
  const [pollError,setPollError]=useState('');
  const pendingRun=useRef(null);
  const lock=useRef(false), importFile=useRef(null);
  const node=graph?.nodes.find(n=>n.id===selected);
  const n8n=isN8n(graph);
  const running=run && ['queued','running'].includes(run.status);
  const endpoint=id=>'workflows/'+encodeURIComponent(id);
  function install(doc, prefer) {
    setRecord(doc); setGraph(doc.graph); setDirty(false); setJson(null); setJsonError(''); setCustomPort('');setLinking('');
    setRun(null);setPollError('');pendingRun.current=null;
    setSelected(doc.graph.nodes.some(n=>n.id===prefer)?prefer:doc.graph.entry);
  }
  useEffect(()=>{
    let live=true;
    const previousTitle=document.title;
    document.title='Jarvis · Редактор workflow';
    (async()=>{
      const list=await api('workflows');
      if (!live) return;
      setWorkflows(list);
      if (list.length) {
        const doc=await api(endpoint(list[0].id));
        if (live) install(doc);
      } else setMessage('Список workflow пуст.');
    })().catch(e=>{if(live)setError(e.message);}).finally(()=>{if(live)setLoading(false);});
    return ()=>{live=false;document.title=previousTitle;};
  },[]);
  function mayLeave() { return !lock.current && (!dirty || window.confirm('Выйти без сохранения последних изменений?')); }
  function back() { if (mayLeave()) leave(); }
  useEffect(()=>{
    const b=telegram?.BackButton;
    b?.show(); b?.onClick(back);
    const unload=e=>{if(dirty){e.preventDefault();e.returnValue='';}};
    window.addEventListener('beforeunload',unload);
    return ()=>{b?.offClick(back);b?.hide();window.removeEventListener('beforeunload',unload);};
  },[dirty,telegram]);
  async function perform(fn) {
    if(lock.current)return;
    lock.current=true; setBusy(true); setError(''); setMessage('');
    try {await fn();} catch(e){setError(e.message);} finally{lock.current=false;setBusy(false);}
  }
  function change(fn) {setGraph(fn);setDirty(true);setMessage('');setError('');}
  function patchNode(id, fn) {change(g=>({...g,nodes:g.nodes.map(n=>n.id===id?fn(n):n)}));}
  function select(id) {if(jsonError || id===selected)return;setSelected(id);setJson(null);setCustomPort('');setLinking('');}
  function editParams(value) {
    setJson(value);setDirty(true);setMessage('');
    try {
      const data=JSON.parse(value);
      if(!data || Array.isArray(data) || typeof data!=='object') throw Error();
      if(n8n) {
        patchNode(node.id,n=>({...n,parameters:data}));
      } else {
        if(structural.some(k=>Object.hasOwn(data,k))) throw Error();
        const keep=Object.fromEntries(Object.entries(node).filter(([k])=>structural.includes(k)));
        patchNode(node.id,()=>({...data,...keep}));
      }
      setJsonError('');
    } catch {setJsonError(n8n?'Введите JSON-объект параметров.':'Введите JSON-объект параметров. ID, тип, позиция и переходы задаются в редакторе.');}
  }
  function link(port,target) {
    patchNode(node.id,n=>{
      const on={...n.on};
      if(target)on[port]=target;else delete on[port];
      return {...n,on};
    });
  }
  function nextConnection(port) {
    if(!node.on?.[port])return port;
    let index=1;
    while(node.on[port+'.'+index])index++;
    return port+'.'+index;
  }
  function addNode() {
    const operation=record.operations.find(op=>'op:'+op.operationId===palette);
    const type=operation?'service.call':palette;
    const stem=operation?.operationId ?? type.split('.')[1];
    let i=1;while(graph.nodes.some(n=>n.id===stem+i))i++;
    const id=stem+i;
    const position=[(node?.position[0]??0),Math.min(100000,(node?.position[1]??0)+120)];
    const created={id,type,position,...initialParams(type,operation),...(type==='ui.result'?{}:{on:{}})};
    change(g=>({...g,nodes:[...g.nodes,created]}));select(id);
  }
  function remove() {
    if(!window.confirm('Удалить узел '+node.id+' и его переходы?'))return;
    change(g=>({...g,entry:g.entry===node.id?'':g.entry,nodes:g.nodes.filter(n=>n.id!==node.id).map(n=>n.on?
      {...n,on:Object.fromEntries(Object.entries(n.on).filter(([,to])=>to!==node.id))}:n)}));
    setSelected('');setJson(null);setLinking('');setCustomPort('');
  }
  const cursor=doc=>({revision:doc.revision,version:doc.version});
  function remember(doc) {
    setWorkflows(list=>[...list.filter(w=>w.id!==doc.graph.id),{id:doc.graph.id,title:doc.graph.title}]);
  }
  async function persist(publish) {
    let doc=record;
    if(dirty) {
      doc=await api(endpoint(graph.id)+'/draft',{...cursor(record),graph});
      install(doc,selected);remember(doc);
    }
    if(publish) {
      doc=await api(endpoint(graph.id)+'/publish',cursor(doc));install(doc,selected);remember(doc);
    }
    setMessage(publish?'Опубликована версия '+doc.revision+'.':'Черновик сохранён.');
  }
  function download() {
    const url=URL.createObjectURL(new Blob([pretty(graph)+'\n'],{type:'application/json'}));
    const a=document.createElement('a');a.href=url;a.download=graph.id+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  async function importGraph(file) {
    if(!file)return;
    if(file.size>500000)throw Error('Слишком большой JSON.');
    let loaded;try{loaded=JSON.parse(await file.text());}catch{throw Error('Файл содержит некорректный JSON.');}
    if(loaded && Object.hasOwn(loaded,'connections') && Array.isArray(loaded.nodes)) {
      const doc=await api('workflows/import-n8n',loaded);
      install(doc);setDirty(true);setMessage('Workflow n8n импортирован. Сохраните черновик или опубликуйте версию.');return;
    }
    if(!graph || loaded?.id!==graph.id || loaded.schemaVersion!==graph.schemaVersion || typeof loaded.entry!=='string' || typeof loaded.title!=='string' ||
      !Array.isArray(loaded.nodes) || loaded.nodes.length>300 || !loaded.nodes.every(n=>n && typeof n.id==='string' && (n8n?
        typeof n.type==='string' && n.type.startsWith('n8n.') && typeof n.name==='string' && n.parameters && typeof n.parameters==='object' && !Array.isArray(n.parameters)
        :Object.hasOwn(types,n.type)) &&
      Array.isArray(n.position) && n.position.length===2 && n.position.every(v=>Number.isFinite(v)&&Math.abs(v)<=100000) &&
      (n.on===undefined || (n.on && typeof n.on==='object' && !Array.isArray(n.on) && Object.values(n.on).every(v=>typeof v==='string')))) ||
      new Set(loaded.nodes.map(n=>n.id)).size!==loaded.nodes.length) throw Error('Выберите граф Jarvis этого workflow с корректными узлами и координатами.');
    change(()=>({...loaded,revision:record.revision}));setSelected(loaded.entry);setJson(null);setJsonError('');
    setLinking('');
  }
  async function discard() {
    const result=await api(endpoint(graph.id)+'/discard',cursor(record));
    if(!result.deleted) {install(result,selected);remember(result);return;}
    const list=workflows.filter(w=>w.id!==graph.id);
    setWorkflows(list);setRecord(null);setGraph(null);setDirty(false);setRun(null);setJsonError('');
    if(list.length) install(await api(endpoint(list[0].id)));
    setMessage('Черновик удалён.');
  }
  async function startRun(mode) {
    if(mode==='live' && !window.confirm('Запустить рабочую версию '+record.revision+' с обращениями к подключённым сервисам?'))return;
    const key=graph.id+':'+record.revision+':'+mode;
    if(pendingRun.current?.key!==key) pendingRun.current={key,requestId:crypto.randomUUID()};
    const result=await api(endpoint(graph.id)+'/run',{mode,revision:record.revision,requestId:pendingRun.current.requestId});
    pendingRun.current=null;setRun(result);setPollError('');
  }
  useEffect(()=>{
    if(!running)return;
    let active=true,timer;
    async function poll() {
      try {
        const result=await api(endpoint(graph.id)+'/runs/'+encodeURIComponent(run.id));
        if(!active)return;
        setRun(result);setPollError('');
        if(!['running','queued'].includes(result.status))return;
      } catch(e) {if(active)setPollError(e.message);}
      if(active)timer=setTimeout(poll,1000);
    }
    timer=setTimeout(poll,350);
    return ()=>{active=false;clearTimeout(timer);};
  },[graph?.id,run?.id,running]);
  const choices=graph && !workflows.some(w=>w.id===graph.id)?[...workflows,{id:graph.id,title:graph.title}]:workflows;
  const disabled=busy || !!jsonError;
  const runDisabled=disabled || !record?.revision || dirty || !!record?.version || !!running;
  return h`<section className="workflow-editor"><div className="editor-heading"><div><h1>Редактор workflow</h1>
    ${record && h`<p>${record.revision?'Версия '+record.revision:'До первой публикации'} · ${dirty?'Есть несохранённые изменения':record.version?'Сохранённый черновик':'Опубликовано'}</p>`}</div>
    <button className="secondary" disabled=${busy} onClick=${back}>На главную</button></div>
    <div className="graph-tools"><input hidden type="file" accept=".json,application/json" aria-label="Файл workflow JSON" ref=${importFile} onChange=${e=>{const file=e.target.files[0];e.target.value='';if(file && mayLeave())perform(()=>importGraph(file));}}/>
    <button className="secondary" disabled=${busy || loading} onClick=${()=>importFile.current.click()}>Загрузить JSON (Jarvis / n8n)</button></div>
    ${error && h`<p role="alert" className="error">${error}</p>`}${message && h`<p role="status" className="editor-notice">${message}</p>`}
    ${!graph && !error && !message && h`<p role="status">Загружаем граф…</p>`}
    ${graph && h`<fieldset disabled=${busy} className="editor-body"><div className="graph-toolbar">
      ${choices.length>1 && h`<label>Workflow<select value=${graph.id} onChange=${e=>{const id=e.target.value;if(mayLeave())perform(async()=>install(await api(endpoint(id))));}}>
        ${choices.map(w=>h`<option key=${w.id} value=${w.id}>${w.title}</option>`)}</select></label>`}
      <label>Название workflow<input value=${graph.title} onChange=${e=>{const title=e.target.value;change(g=>({...g,title}));}}/></label>
      ${!n8n && h`<label>Входной узел<select value=${graph.entry} onChange=${e=>{const entry=e.target.value;change(g=>({...g,entry}));}}>
        <option value="">Выбрать форму</option>${graph.nodes.filter(n=>n.type==='ui.form').map(n=>h`<option key=${n.id}>${n.id}</option>`)}</select></label>`}</div>
      <div className="graph-tools">${!n8n && h`<label>Новый узел<select value=${palette} onChange=${e=>setPalette(e.target.value)}>
      ${Object.entries(types).filter(([k])=>k!=='service.call').map(([k,v])=>h`<option key=${k} value=${k}>${v}</option>`)}
      ${record.operations.map(op=>h`<option key=${op.operationId} value=${'op:'+op.operationId}>${op.service} · ${op.operationId}</option>`)}</select></label>
      <button className="secondary" disabled=${disabled || graph.nodes.length>=300} onClick=${addNode}>Добавить узел</button>`}
      <label>Масштаб<select value=${zoom} onChange=${e=>setZoom(Number(e.target.value))}>
      ${[.4,.6,.8,1].map(v=>h`<option key=${v} value=${v}>${Math.round(v*100)}%</option>`)}</select></label></div>
      ${linking && h`<div className="graph-tools" role="status"><strong>Выберите цель для ${selected} · ${linking}</strong><button className="secondary" onClick=${()=>setLinking('')}>Отмена</button></div>`}
      <${Canvas} graph=${graph} selected=${selected} select=${select} disabled=${disabled} zoom=${zoom} linking=${linking} connect=${id=>{link(linking,id);setLinking('');}} move=${(id,position)=>patchNode(id,n=>({...n,position}))}/>
      <div className="node-inspector"><label>Выбранный узел<select disabled=${!!jsonError} value=${node?.id??''} onChange=${e=>select(e.target.value)}>
        <option value="">Выберите узел</option>${graph.nodes.map(n=>h`<option key=${n.id} value=${n.id}>${n8n?displayName(n):n.id} · ${typeLabel(n)}</option>`)}</select></label>
        ${node && h`<div className="inspector-grid"><div className="node-params">
        ${typeof node.title==='string' && h`<label>Заголовок узла<input disabled=${!!jsonError} value=${node.title} onChange=${e=>{const title=e.target.value;setJson(null);patchNode(node.id,n=>({...n,title}));}}/></label>`}
        ${node.type==='service.call' && record.operations.find(op=>op.operationId===node.operationId)?.inputs.filter(p=>p.type==='integer' && typeof node.args?.[p.key]!=='object').map(p=>h`
          <label key=${p.key}>${p.key}<input type="number" step="1" disabled=${!!jsonError} value=${node.args?.[p.key]??''} onChange=${e=>{
            const raw=e.target.value;setJson(null);patchNode(node.id,n=>{
              const args={...n.args};if(raw==='')delete args[p.key];else args[p.key]=Number(raw);return {...n,args};
            });
          }}/></label>`)}
        ${node.type==='n8n.code' && h`<label>JavaScript (jsCode)<textarea spellCheck="false" disabled=${!!jsonError} value=${node.parameters.jsCode??''}
          onChange=${e=>{const jsCode=e.target.value;setJson(null);patchNode(node.id,n=>({...n,parameters:{...n.parameters,jsCode}}));}}/></label>`}
        <label>Параметры узла (JSON)<textarea spellCheck="false" value=${json??pretty(n8n?node.parameters:params(node))} onChange=${e=>editParams(e.target.value)}/></label>
        ${jsonError && h`<p role="alert" className="error">${jsonError}</p>`}</div>
        <div className="node-ports"><h2>Переходы</h2>${!portList(node).length && h`<p>Конечный узел</p>`}
        ${portList(node).map(port=>h`<div className="port-row" key=${port}><label>${port}<select aria-label=${port} value=${node.on?.[port]??''} onChange=${e=>{link(port,e.target.value);setLinking('');}}>
        <option value="">Без связи</option>${graph.nodes.filter(n=>n.id!==node.id).map(n=>h`<option key=${n.id} value=${n.id}>${n8n?displayName(n):n.id}</option>`)}</select></label>
        <button className="secondary" aria-label=${'Связать '+port+' на схеме'} disabled=${disabled} onClick=${e=>{setLinking(port);e.currentTarget.closest('fieldset').querySelector('.graph-viewport').scrollIntoView({block:'center'});}}>На схеме</button></div>`)}
        ${n8n && h`<label>Добавить параллельную связь<select value="" disabled=${disabled} onChange=${e=>{
          const port=e.target.value;if(!port)return;
          setLinking(nextConnection(port));e.currentTarget.closest('fieldset').querySelector('.graph-viewport').scrollIntoView({block:'center'});
        }}><option value="">Выберите выход</option>${portList(node).filter(port=>/^out\d+$/.test(port) && node.on?.[port]).map(port=>h`<option key=${port}>${port}</option>`)}</select></label>`}
        ${node.type==='service.call' && h`<label>Ветка ошибки<input placeholder="SELECTION_EXPIRED" value=${customPort} onChange=${e=>setCustomPort(e.target.value)}/></label>
          ${/^[A-Z][A-Z0-9_]*$/.test(customPort) && !node.on?.['error.'+customPort] && h`<label>Цель для ${customPort}<select value="" onChange=${e=>{link('error.'+customPort,e.target.value);setCustomPort('');}}><option value="">Выберите узел</option>
          ${graph.nodes.filter(n=>n.id!==node.id).map(n=>h`<option key=${n.id}>${n.id}</option>`)}</select></label>`}`}
        <button className="editor-text" disabled=${disabled || (n8n && node.id===graph.entry)} onClick=${remove}>Удалить узел</button></div></div>`}</div>
      <div className="editor-save"><button className="secondary" disabled=${disabled || !dirty} onClick=${()=>perform(()=>persist(false))}>Сохранить черновик</button>
      <button className="primary" disabled=${disabled || (!dirty && !record.version)} onClick=${()=>perform(()=>persist(true))}>Опубликовать</button></div>
      ${n8n && h`<section className="workflow-run"><h2>Запуск workflow</h2>
        ${record.revision>0 && !dirty && !record.version?h`<p>Опубликованная версия ${record.revision}. Тест использует демонстрационные данные.</p>`
          :h`<p>Опубликуйте изменения для запуска этой версии.</p>`}
        <div className="graph-tools"><button className="secondary" disabled=${runDisabled} onClick=${()=>perform(()=>startRun('test'))}>Тестовый запуск</button>
        <button className="primary" disabled=${runDisabled || !record.liveEnabled} onClick=${()=>perform(()=>startRun('live'))}>Рабочий запуск</button></div>
        ${!record.liveEnabled && h`<p>Рабочий режим отключён.</p>`}
        ${run && h`<p role="status">${run.mode==='live'?'Рабочий':'Тестовый'} запуск · Версия ${run.revision} · ${run.status==='done'?'Завершён':run.status==='failed'?'Ошибка':run.status==='queued'?'В очереди':'Выполняется'}</p>
          ${run.status==='failed' && h`<p role="alert" className="error">${run.error?.message ?? run.result?.error?.message ?? String(run.error ?? run.result?.error ?? 'Ошибка выполнения workflow.')}</p>`}
          ${pollError && h`<p role="alert" className="error">${pollError}. Повторяем запрос статуса.</p>`}
          ${run.result?.trace?.length>0 && h`<ol aria-label="Журнал узлов" className="run-trace">${run.result.trace.map((step,i)=>h`<li key=${i}>${step.node} · ${step.input} → ${step.output} · ${step.status==='done'?'Готово':step.status==='continued'?'Продолжено после ошибки':'Ошибка'}</li>`)}</ol>`}`}
      </section>`}
      <details className="editor-files"><summary>Файл и версии</summary><div className="graph-tools">
        <button className="secondary" disabled=${!!jsonError} onClick=${download}>Скачать JSON</button>
        ${(record.revision>0 || record.version) && h`<button className="secondary" onClick=${()=>{if(mayLeave())perform(async()=>install(await api(endpoint(graph.id)),selected));}}>Открыть актуальную версию</button>`}
        ${record.version && h`<button className="secondary" onClick=${()=>{if(window.confirm(record.revision?'Удалить черновик и открыть опубликованный граф?':'Удалить неопубликованный workflow?'))perform(discard);}}>Сбросить черновик</button>`}</div></details>
      </fieldset>`}</section>`;
}
