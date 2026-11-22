import htm from '/htm.js';
import { WorkflowEditor } from '/editor.js';
const h = htm.bind(React.createElement);
const {useState,useEffect,useRef} = React;
const tg = window.Telegram?.WebApp;
const launch = 'https://t.me/assitant_ai_bot/JarvisApp';
const labels = {query:'Ожидает запроса',search:'Идёт поиск',found:'Идёт поиск',choose:'Выбор раздачи',enqueue:'Передаётся',submitted:'Передано',empty:'Ничего не найдено',cancelled:'Отменено',expired:'Выбор истёк',uncertain:'Требует сверки',failure:'Ошибка'};

function WorkflowForm({run, busy, enabled, submit}) {
  const [values,setValues]=useState({});
  function value(field) {
    const raw=Object.hasOwn(values,field.key)?values[field.key]:'';
    return field.trim?raw.trim():raw;
  }
  const valid=run.fields.every(field=>{
    const size=Array.from(value(field)).length;
    return size>=(field.minLength??0) && size<=(field.maxLength??Infinity);
  });
  const cinema=run.fields.length===1 && run.fields[0].key==='query';
  return h`<section className="panel"><h1>${run.title}</h1><form onSubmit=${e=>{
    e.preventDefault();
    if(valid && enabled && !busy)submit(Object.fromEntries(run.fields.map(f=>[f.key,value(f)])));
  }}>
    ${run.fields.map(f=>h`<label key=${f.key}>${f.label}<input type=${cinema?'search':'text'} placeholder=${cinema?'Например, Солярис':''}
      value=${Object.hasOwn(values,f.key)?values[f.key]:''} onChange=${e=>{const text=e.target.value;setValues(v=>({...v,[f.key]:text}));}}/></label>`)}
    <button className="primary" disabled=${busy || !enabled || !valid}>${cinema?'Найти раздачи':'Продолжить'}</button></form></section>`;
}

function App() {
  const [token,setToken] = useState('');
  const [authError,setAuthError] = useState('');
  const [error,setError] = useState('');
  const [run,setRun] = useState(null);
  const [recent,setRecent] = useState(null);
  const [cinemaEnabled,setCinemaEnabled]=useState(null);
  const [me,setMe]=useState(null);
  const [meError,setMeError]=useState('');
  const [accessCheck,setAccessCheck]=useState(0);
  const [editing,setEditing]=useState(false);
  const [busy,setBusy] = useState(false);
  const [journal,setJournal] = useState(null);
  const [expired,setExpired] = useState(false);
  const [slow,setSlow] = useState(false);
  const lock = useRef(false);

  async function api(path, data) {
    const headers = token ? {Authorization:'Bearer '+token} : {};
    const init = {headers};
    if (data !== undefined) {
      headers['Content-Type']='application/json';
      init.method='POST';
      init.body=JSON.stringify(data);
    }
    const res = await fetch('/api/'+path,init);
    const result = await res.json().catch(()=>null);
    if (!res.ok) {
      const message=result?.error ?? 'Ошибка запроса';
      if (res.status === 401 || (res.status === 403 && !path.startsWith('workflows'))) setAuthError(message);
      throw new Error('HTTP '+res.status+' · '+message);
    }
    if(result===null)throw new Error('Сервер вернул некорректный ответ.');
    return result;
  }
  useEffect(() => {
    tg?.ready(); tg?.expand();
    const theme = () => { document.documentElement.dataset.theme=tg?.colorScheme ?? 'dark'; };
    theme(); tg?.onEvent('themeChanged',theme);
    if (!tg?.initData) setAuthError('Откройте приложение из Telegram.');
    else {
      const launchHash = new URLSearchParams(tg.initData).get('hash');
      let cached;
      try { cached=JSON.parse(sessionStorage.getItem('jarvis.session')); } catch {}
      if(launchHash && cached?.hash===launchHash && cached.until>Date.now()) setToken(cached.token);
      else api('session',{initData:tg.initData}).then(r=>{
        try { sessionStorage.setItem('jarvis.session',JSON.stringify({hash:launchHash,token:r.token,until:Date.now()+3590000})); } catch {}
        setToken(r.token);
      }).catch(e=>setAuthError(e.message));
    }
    return () => tg?.offEvent('themeChanged',theme);
  },[]);
  useEffect(() => {
    if (!token || run) return;
    let live=true;
    Promise.all([api('runs'),api('cinema')]).then(([rows,cinema])=>{
      if(live){setRecent(rows);setCinemaEnabled(cinema.enabled);}
    }).catch(e=>{if(live)setError(e.message);});
    return ()=>{live=false;};
  },[token,run?.id]);
  useEffect(()=>{
    if(!token || run || editing)return;
    let live=true;
    setMe(null);setMeError('');
    api('me').then(profile=>{
      if(typeof profile.canEdit!=='boolean')throw new Error('В ответе отсутствует поле canEdit.');
      if(live)setMe(profile);
    }).catch(e=>{if(live)setMeError(e.message);});
    return ()=>{live=false;};
  },[token,run?.id,editing,accessCheck]);
  useEffect(() => {
    if (!run || run.status!=='ready') return;
    let live=true, timer;
    async function poll() {
      try {
        const state=await api('runs/'+run.id);
        if (!live) return;
        setRun(state); setError('');
        if (state.status!=='ready') return;
      } catch(e){ if(live)setError(e.message); }
      if(live) timer=setTimeout(poll,1000);
    }
    timer=setTimeout(poll,250);
    return ()=>{live=false;clearTimeout(timer);};
  },[run?.id,run?.status,token]);

  useEffect(()=>{
    setSlow(false);
    if(run?.status!=='ready') return;
    const timer=setTimeout(()=>setSlow(true),20000);
    return ()=>clearTimeout(timer);
  },[run?.id,run?.step,run?.status]);
  useEffect(()=>{
    setExpired(false);
    if(!run?.choices || !run.expiresAt) return;
    let live=true, timer;
    async function refresh() {
      setExpired(true);
      try {
        const state=await api('runs/'+run.id);
        if(!live)return;
        setRun(state);
        if(!state.choices)return;
      } catch(e){if(live)setError(e.message);}
      if(live)timer=setTimeout(refresh,2000);
    }
    timer=setTimeout(refresh,Math.max(0,Date.parse(run.expiresAt)-Date.now()));
    return ()=>{live=false;clearTimeout(timer);};
  },[run?.id,run?.step,run?.expiresAt]);

  function home() {
    setRun(null); setJournal(null); setError(''); setRecent(null);
  }
  useEffect(()=>{
    if(!tg?.BackButton || !run) return;
    const back=()=>{if(!lock.current)home();};
    tg.BackButton.show(); tg.BackButton.onClick(back);
    return ()=>{tg.BackButton.offClick(back);tg.BackButton.hide();};
  },[run?.id]);

  async function doAction(fn) {
    if(lock.current)return;
    lock.current=true;setBusy(true);setError('');
    try {await fn();} catch(e){setError(e.message || 'Ошибка соединения');}
    finally{lock.current=false;setBusy(false);}
  }
  const open = id => doAction(async()=>{setRun(await api(id?'runs/'+id:'runs',id?undefined:{}));setJournal(null);});
  const act = (event,data={}) => doAction(async()=>setRun(await api('runs/'+run.id+'/actions',{step:run.step,event,data})));
  const button = (text,fn,secondary=false)=>h`<button disabled=${busy} className=${secondary?'secondary':'primary'} onClick=${fn}>${text}</button>`;
  let content;
  if(authError) content=h`<section className="panel"><h1>Доступ к Jarvis</h1><p role="alert">${authError}</p><a className="primary" href=${launch}>Открыть в Telegram</a></section>`;
  else if(!token) content=h`<p role="status">Подключаемся к Telegram…</p>`;
  else if(editing) content=h`<${WorkflowEditor} api=${api} leave=${()=>setEditing(false)} telegram=${tg}/>`;
  else if(!run) content=h`<section className="feature">
      <div className="feature-copy"><h1>Кино</h1><p>${cinemaEnabled===false?'Сервис поиска пока не подключён.':'Найти фильм и передать раздачу в uTorrent.'}</p>
      <button className="primary" disabled=${busy || !cinemaEnabled} onClick=${()=>open()}>Найти фильм</button></div>
      <img className="robot" src="/robot.jpg" alt="" /></section>
    ${me?.canEdit && h`<button className="editor-entry" onClick=${()=>setEditing(true)}><span aria-hidden="true">⑂</span><strong>Редактор workflow</strong><b aria-hidden="true">→</b></button>`}
    <section className="recent" aria-label="Доступ к редактору"><h2>Доступ к редактору</h2>
      ${me ? h`<p>Telegram ID на сервере · <code>${me.telegramUserId ?? 'сервер не вернул ID'}</code><br/>
        <code>/api/me</code> · <code>${'canEdit: '+me.canEdit}</code></p>
        ${!me.canEdit && h`<p>${me.reason==='admins_not_configured'
          ? 'Список администраторов JARVIS_ADMIN_USER_IDS на сервере пуст.'
          : me.reason==='user_not_admin' ? 'Этого Telegram ID нет в серверном списке JARVIS_ADMIN_USER_IDS.'
          : 'Сервер не предоставил доступ к редактору.'}</p>`}`
        : meError ? h`<p role="alert">Не удалось проверить права через /api/me. ${meError}</p>`
        : h`<p role="status">Проверяем права через /api/me…</p>`}
      <button className="secondary" disabled=${!me && !meError} onClick=${()=>setAccessCheck(n=>n+1)}>Проверить снова</button>
    </section>
    <section className="recent"><h2>Последние запуски</h2>
    ${recent===null ? h`<p role="status">Загружаем историю…</p>` : !recent.length ? h`<p>Здесь появятся ваши поиски и квитанции.</p>` : recent.map(r=>h`
      <button key=${r.id} disabled=${busy} className="row" onClick=${()=>open(r.id)}>
        <span><strong>${r.query || 'Новый поиск'}</strong><small>${new Date(r.createdAt).toLocaleString('ru-RU',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}</small></span>
        <span className="tag">${labels[r.step] ?? 'В работе'}</span></button>`)}</section>`;
  else if(run.fields) content=h`<${WorkflowForm} key=${run.id+':'+run.step} run=${run} busy=${busy} enabled=${cinemaEnabled} submit=${data=>act('submit',data)}/>`;
  else if(run.choices) content=h`<section className="panel"><h1>${run.title}</h1>
    <p>${expired?'Время выбора истекло. Обновляем статус…':'Выбранный файл .torrent будет передан в uTorrent.'}</p>
    ${run.choices.map(c=>h`<button key=${c.value} className="row" disabled=${busy || expired || !cinemaEnabled} onClick=${()=>act('select',{value:c.value})}>
      <span><strong>${c.label}</strong><small>${Object.entries(c.details).map(([k,v])=>k==='size'?v:k==='seeds'?'Сиды '+v:k+' '+v).join(' · ')}</small></span><span aria-hidden="true">→</span></button>`)}
    ${button('Отменить выбор',()=>act('cancel'),true)}</section>`;
  else if(run.status==='done') content=h`<section className="panel result">
    ${run.receipt && h`<span aria-hidden="true" className="check">✓</span>`}
    <h1>${run.title}</h1>${run.receipt && h`<p>Квитанция</p><code data-testid="receipt">${run.receipt}</code>`}
    <div className="actions">${cinemaEnabled && button('Новый поиск',()=>open())}
    ${button('Журнал запуска',()=>doAction(async()=>setJournal(await api('runs/'+run.id+'/history'))),true)}</div>
    ${journal && h`<ul>${journal.map(j=>h`<li key=${j.request}>${j.operation} · ${j.outcome==='success'?'Успешно':j.outcome ?? 'Ответ не получен'}</li>`)}</ul>`}</section>`;
  else content=h`<section className="panel" role="status"><h1>${run.step==='enqueue'?'Передаём раздачу…':'Ищем раздачи…'}</h1><progress />
    ${slow && h`<p>Обработка занимает больше времени. Результат можно открыть позже в истории.</p>`}</section>`;
  return h`<main className=${editing?'editor-main':''}><header><span className="brand"><i aria-hidden="true"></i>Jarvis</span>
    ${run && button('На главную',home,true)}</header>${content}
    ${error && !authError && h`<p className="error" role="alert">${error}</p>`}</main>`;
}
ReactDOM.createRoot(document.getElementById('root')).render(h`<${App}/>`);
