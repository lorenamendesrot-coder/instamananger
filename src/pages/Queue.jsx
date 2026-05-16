// Queue.jsx — Fila de agendamentos com layout em tabs (igual ao Warmup)
import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useScheduler, useAccounts } from "../App.jsx";
import Modal from "../Modal.jsx";

const QUEUE_TABS = [
  { id: "fila",    icon: "📋", label: "Fila"    },
  { id: "monitor", icon: "📊", label: "Monitor" },
];

const SORT_OPTIONS = [
  { value: "time_asc",   label: "🕐 Mais cedo primeiro"  },
  { value: "time_desc",  label: "🕐 Mais tarde primeiro" },
  { value: "type",       label: "🏷 Por tipo de post"    },
  { value: "account",    label: "👤 Por conta"           },
  { value: "status",     label: "📊 Por status"          },
];

function sortItems(items, sortBy) {
  const copy = [...items];
  if (sortBy === "time_asc")  return copy.sort((a, b) => a.scheduledAt - b.scheduledAt);
  if (sortBy === "time_desc") return copy.sort((a, b) => b.scheduledAt - a.scheduledAt);
  if (sortBy === "type")      return copy.sort((a, b) => (a.postType || "").localeCompare(b.postType || ""));
  if (sortBy === "account")   return copy.sort((a, b) => ((a.accounts||[])[0]?.username||"").localeCompare((b.accounts||[])[0]?.username||""));
  if (sortBy === "status") {
    const ORDER = { running: 0, error: 1, pending: 2, done: 3 };
    return copy.sort((a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9));
  }
  return copy;
}

function matchesSearch(item, q) {
  if (!q) return true;
  const lq = q.toLowerCase();
  return (item.caption||"").toLowerCase().includes(lq) ||
         (item.mediaUrl||"").toLowerCase().includes(lq) ||
         (item.postType||"").toLowerCase().includes(lq) ||
         (item.accounts||[]).some(a => a.username?.toLowerCase().includes(lq));
}

const STATUS_INFO = {
  pending: { label: "Agendado", color: "var(--info)",    bg: "rgba(56,189,248,0.08)"  },
  running: { label: "Rodando",  color: "var(--warning)", bg: "rgba(245,158,11,0.08)"  },
  done:    { label: "Publicado", color: "var(--success)", bg: "rgba(34,197,94,0.06)"   },
  error:   { label: "Erro",     color: "var(--danger)",  bg: "rgba(239,68,68,0.06)"   },
};

function startOfDay(date) { const d=new Date(date); d.setHours(0,0,0,0); return d.getTime(); }
function endOfDay(date)   { const d=new Date(date); d.setHours(23,59,59,999); return d.getTime(); }
function dateLabel(ts) {
  const today=startOfDay(new Date()), tom=today+86400000, da=today+2*86400000, ds=startOfDay(new Date(ts));
  if(ds===today) return "Hoje";
  if(ds===tom)   return "Amanhã";
  if(ds===da)    return "Depois de amanhã";
  return new Date(ts).toLocaleDateString("pt-BR",{weekday:"short",day:"2-digit",month:"2-digit"});
}
function buildDayGroups(items) {
  const map={};
  for(const item of items){
    const s=startOfDay(new Date(item.scheduledAt));
    if(!map[s]) map[s]={startMs:s,endMs:endOfDay(new Date(s)),count:0};
    map[s].count++;
  }
  return Object.values(map).sort((a,b)=>a.startMs-b.startMs).map(g=>({...g,label:dateLabel(g.startMs)}));
}

export default function Queue() {
  const { queue, updateItem, removeItem, clearQueue, addBatch, reload: reloadQueue } = useScheduler();
  const { accounts } = useAccounts();

  const [tab,          setTab]          = useState("fila");
  const [editModal,    setEditModal]    = useState(null);
  const [editTime,     setEditTime]     = useState("");
  const [editCaption,  setEditCaption]  = useState("");
  const [confirmModal, setConfirmModal] = useState(null);
  const [filterStatus, setFilterStatus] = useState("all");
  const [filterDay,    setFilterDay]    = useState("all");
  const [sortBy,       setSortBy]       = useState("time_asc");
  const [search,       setSearch]       = useState("");
  const [showSortMenu, setShowSortMenu] = useState(false);
  const [selected,     setSelected]     = useState(new Set());
  const [selecting,    setSelecting]    = useState(false);
  const [forcingId,    setForcingId]    = useState(null);
  const [forceConfirm, setForceConfirm] = useState(null);

  const mainQueue   = useMemo(() => queue.filter((q) => !q.type || q.type === "group"), [queue]);
  const videoFinish = useMemo(() => queue.filter((q) => q.type === "video_finish"), [queue]);
  const perAccount  = useMemo(() => queue.filter((q) => q.type === "per_account"),  [queue]);

  const vfByParent = useMemo(() => {
    const map = {};
    for (const vf of videoFinish) {
      for (const key of [vf.parentId, vf.historyId].filter(Boolean)) {
        if (!map[key]) map[key] = [];
        if (!map[key].find(x => x.id === vf.id)) map[key].push(vf);
      }
    }
    return map;
  }, [videoFinish]);

  const paByHistory = useMemo(() => {
    const map = {};
    for (const pa of perAccount) {
      if (!pa.historyId) continue;
      if (!map[pa.historyId]) map[pa.historyId] = [];
      map[pa.historyId].push(pa);
    }
    return map;
  }, [perAccount]);

  const activeVfParentIds = useMemo(() => {
    const ids = new Set();
    for (const vf of videoFinish) if (vf.status==="pending"||vf.status==="running") { if(vf.parentId) ids.add(vf.parentId); if(vf.historyId) ids.add(vf.historyId); }
    for (const pa of perAccount)  if (pa.status==="pending"||pa.status==="running")  { if(pa.parentId) ids.add(pa.parentId); if(pa.historyId) ids.add(pa.historyId); }
    return ids;
  }, [videoFinish, perAccount]);

  const pendingCount = mainQueue.filter(q=>q.status==="pending").length;
  const runningCount = mainQueue.filter(q=>q.status==="running").length;
  const doneCount    = mainQueue.filter(q=>q.status==="done").length;
  const errorCount   = mainQueue.filter(q=>q.status==="error").length;

  const dayGroups = useMemo(() => buildDayGroups(mainQueue.filter(q=>q.status==="pending"||q.status==="running")), [mainQueue]);

  const filtered = useMemo(() => {
    let items = mainQueue;
    if (filterStatus !== "all") items = items.filter(q => q.status===filterStatus || (q.status==="done" && activeVfParentIds.has(q.id)));
    if (filterDay !== "all") { const s=Number(filterDay); items = items.filter(q => q.scheduledAt>=s && q.scheduledAt<=s+86400000-1); }
    if (search.trim()) items = items.filter(q => matchesSearch(q, search.trim()));
    return sortItems(items, sortBy);
  }, [mainQueue, filterStatus, filterDay, search, sortBy, activeVfParentIds]);

  const toggleSelect   = (id) => setSelected(prev => { const n=new Set(prev); n.has(id)?n.delete(id):n.add(id); return n; });
  const selectAll      = () => setSelected(new Set(filtered.map(i=>i.id)));
  const selectNone     = () => setSelected(new Set());
  const removeSelected = async () => { for(const id of [...selected]) await removeItem(id); setSelected(new Set()); setSelecting(false); setConfirmModal(null); };

  const forcePublish = useCallback(async (item) => {
    setForcingId(item.id);
    try { await updateItem({...item, scheduledAt: Date.now()-1000, status:"pending"}); reloadQueue?.(); }
    finally { setForcingId(null); setForceConfirm(null); }
  }, [updateItem, reloadQueue]);

  const hasPendingChildren = videoFinish.some(v=>v.status==="pending"||v.status==="running") || perAccount.some(p=>p.status==="pending"||p.status==="running");
  const pollRef = useRef(null);
  useEffect(() => {
    if (hasPendingChildren) pollRef.current = setInterval(reloadQueue, 8000);
    else clearInterval(pollRef.current);
    return () => clearInterval(pollRef.current);
  }, [hasPendingChildren, reloadQueue]);

  useEffect(() => { const h=()=>reloadQueue?.(); window.addEventListener("sw:queue-update",h); return ()=>window.removeEventListener("sw:queue-update",h); }, [reloadQueue]);
  useEffect(() => { reloadQueue?.(); }, []);

  const openEdit = (item) => {
    setEditModal(item);
    const d=new Date(item.scheduledAt), offset=d.getTimezoneOffset()*60000, local=new Date(d.getTime()-offset);
    setEditTime(local.toISOString().slice(0,16));
    setEditCaption(item.caption||"");
  };
  const saveEdit = async () => {
    if (!editModal) return;
    await updateItem({...editModal, scheduledAt: new Date(editTime).getTime(), caption: editCaption, status:"pending"});
    setEditModal(null);
  };

  return (
    <div className="page" style={{maxWidth:980}}>

      {/* Header */}
      <div className="page-header">
        <div>
          <h1 className="page-title">🗂 Fila de Agendamentos</h1>
          <p className="page-subtitle">Gerencie e monitore todos os posts agendados — edite, force ou cancele em tempo real.</p>
        </div>
        <div style={{display:"flex",gap:10,flexShrink:0}}>
          {[
            {icon:"📋",value:mainQueue.length,label:"total",    color:"var(--text)"   },
            {icon:"⏳",value:pendingCount,    label:"pendentes",color:"var(--info)"   },
            {icon:"✅",value:doneCount,       label:"publicados",   color:"var(--success)"},
            {icon:"❌",value:errorCount,      label:"erros",    color:"var(--danger)" },
          ].map(({icon,value,label,color}) => (
            <div key={label} className="card card-sm" style={{textAlign:"center",minWidth:72}}>
              <div style={{fontSize:18,fontWeight:800,color}}>{value}</div>
              <div style={{fontSize:9,color:"var(--muted)",marginTop:1}}>{label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Tabs */}
      <div style={{display:"flex",gap:2,marginBottom:24,background:"var(--bg2)",padding:4,borderRadius:12,width:"fit-content",overflowX:"auto"}}>
        {QUEUE_TABS.map(({id,icon,label}) => (
          <button key={id} onClick={()=>setTab(id)} style={{
            padding:"8px 14px",borderRadius:9,fontSize:12,fontWeight:tab===id?700:400,
            background:tab===id?"var(--accent)":"transparent",
            color:tab===id?"#fff":"var(--muted)",
            border:"none",cursor:"pointer",whiteSpace:"nowrap",
            display:"flex",alignItems:"center",gap:5,transition:"all 0.15s",
          }}>
            <span style={{fontSize:13}}>{icon}</span>
            {label}
            {id==="fila" && pendingCount>0 && <span style={{fontSize:10,fontWeight:800,padding:"1px 6px",background:"rgba(255,255,255,0.25)",borderRadius:20}}>{pendingCount}</span>}
            {id==="fila" && errorCount>0   && <span style={{fontSize:10,fontWeight:800,padding:"1px 6px",background:"rgba(239,68,68,0.4)",borderRadius:20}}>{errorCount}❌</span>}
          </button>
        ))}
      </div>

      {/* ══ TAB: FILA ════════════════════════════════════════════════════════ */}
      {tab==="fila" && (
        <div>
          <div style={{display:"flex",gap:8,marginBottom:14,flexWrap:"wrap"}}>
            <button className="btn btn-ghost btn-sm" onClick={()=>reloadQueue?.()}>↻ Atualizar</button>
            {filtered.length>0 && <button className={`btn btn-sm ${selecting?"btn-primary":"btn-ghost"}`} onClick={()=>{setSelecting(p=>!p);setSelected(new Set());}}>{selecting?"✕ Cancelar":"☑ Selecionar"}</button>}
            {queue.length>0 && <button className="btn btn-danger btn-sm" onClick={()=>setConfirmModal({type:"clearQueue"})}>🗑 Limpar tudo</button>}
          </div>

          {selecting && (
            <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap",padding:"10px 14px",borderRadius:10,marginBottom:14,background:"rgba(124,92,252,0.08)",border:"1px solid rgba(124,92,252,0.25)"}}>
              <span style={{fontSize:13,fontWeight:600,color:"var(--accent-light)"}}>{selected.size} selecionado(s)</span>
              <button className="btn btn-ghost btn-sm" style={{fontSize:11}} onClick={selectAll}>✓ Todos ({filtered.length})</button>
              <button className="btn btn-ghost btn-sm" style={{fontSize:11}} onClick={selectNone}>✕ Nenhum</button>
              {selected.size>0 && <button className="btn btn-danger btn-sm" style={{fontSize:12,marginLeft:"auto"}} onClick={()=>setConfirmModal({type:"removeSelected"})}>🗑 Remover {selected.size}</button>}
            </div>
          )}

          {mainQueue.length>0 && (
            <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10,marginBottom:16}}>
              {[
                {label:"Total",     value:mainQueue.length,color:"var(--text)",   fs:"all"    },
                {label:"Pendentes", value:pendingCount,    color:"var(--info)",   fs:"pending"},
                {label:"Publicados",value:doneCount,       color:"var(--success)",fs:"done"   },
                {label:"Erros",     value:errorCount,      color:"var(--danger)", fs:"error"  },
              ].map(({label,value,color,fs}) => (
                <div key={label} className="card card-sm" style={{textAlign:"center",cursor:"pointer"}} onClick={()=>setFilterStatus(fs)}>
                  <div style={{fontSize:22,fontWeight:800,color}}>{value}</div>
                  <div style={{fontSize:11,color:"var(--muted)"}}>{label}</div>
                </div>
              ))}
            </div>
          )}

          {mainQueue.length>0 && (
            <div style={{display:"flex",flexDirection:"column",gap:8,marginBottom:16}}>
              <div style={{display:"flex",gap:8,alignItems:"center"}}>
                <input type="search" placeholder="🔍 Buscar conta, tipo, legenda..." value={search} onChange={e=>setSearch(e.target.value)} style={{flex:1,fontSize:12}} />
                <div style={{position:"relative"}}>
                  <button className="btn btn-ghost btn-sm" style={{fontSize:11}} onClick={()=>setShowSortMenu(p=>!p)}>
                    ⇅ {SORT_OPTIONS.find(o=>o.value===sortBy)?.label.replace(/^[^\s]+\s/,"")||"Ordem"}
                  </button>
                  {showSortMenu && (
                    <div style={{position:"absolute",top:"100%",right:0,zIndex:50,background:"var(--bg2)",border:"1px solid var(--border2)",borderRadius:10,padding:"6px",boxShadow:"0 8px 24px rgba(0,0,0,0.4)",width:200}}>
                      {SORT_OPTIONS.map(o => (
                        <button key={o.value} onClick={()=>{setSortBy(o.value);setShowSortMenu(false);}} style={{display:"block",width:"100%",textAlign:"left",padding:"7px 12px",borderRadius:7,fontSize:12,border:"none",cursor:"pointer",background:sortBy===o.value?"rgba(124,92,252,0.15)":"transparent",color:sortBy===o.value?"var(--accent-light)":"var(--text)",fontWeight:sortBy===o.value?700:400}}>
                          {o.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                {[
                  {id:"all",label:"Todos",count:mainQueue.length},
                  {id:"pending",label:"Pendentes",count:pendingCount},
                  {id:"running",label:"Rodando",count:runningCount},
                  {id:"done",label:"Publicados",count:doneCount},
                  {id:"error",label:"Erros",count:errorCount},
                ].filter(({id,count})=>count>0||id==="all").map(({id,label,count}) => (
                  <button key={id} onClick={()=>setFilterStatus(id)} className={`btn btn-sm ${filterStatus===id?"btn-primary":"btn-ghost"}`} style={{fontSize:12}}>
                    {label} {count>0 && <span style={{marginLeft:4,opacity:0.8}}>({count})</span>}
                  </button>
                ))}
              </div>

              {dayGroups.length>1 && (
                <div style={{display:"flex",gap:6,flexWrap:"wrap",alignItems:"center"}}>
                  <span style={{fontSize:11,color:"var(--muted)",fontWeight:600}}>📅</span>
                  <button onClick={()=>setFilterDay("all")} className={`btn btn-sm ${filterDay==="all"?"btn-primary":"btn-ghost"}`} style={{fontSize:12}}>Todos os dias</button>
                  {dayGroups.map(g => (
                    <button key={g.startMs} onClick={()=>setFilterDay(String(g.startMs))} className={`btn btn-sm ${filterDay===String(g.startMs)?"btn-primary":"btn-ghost"}`} style={{fontSize:12}}>
                      {g.label} <span style={{marginLeft:5,opacity:0.75,fontSize:11}}>({g.count})</span>
                    </button>
                  ))}
                </div>
              )}

              {(filterStatus!=="all"||filterDay!=="all") && (
                <div style={{display:"flex",alignItems:"center",gap:8,fontSize:11,color:"var(--muted)"}}>
                  <span>Exibindo {filtered.length} de {mainQueue.length}</span>
                  <button className="btn btn-ghost btn-xs" style={{fontSize:11}} onClick={()=>{setFilterStatus("all");setFilterDay("all");}}>✕ Limpar filtros</button>
                </div>
              )}
            </div>
          )}

          {filtered.length===0 ? (
            <div className="card" style={{textAlign:"center",padding:"56px 20px",color:"var(--muted)"}}>
              <div style={{fontSize:48,marginBottom:14}}>◷</div>
              <div style={{fontWeight:700,color:"var(--text)",fontSize:15,marginBottom:8}}>{queue.length===0?"Fila vazia":"Nenhum item neste filtro"}</div>
              <div style={{fontSize:12,marginBottom:18}}>{queue.length===0?"Agende posts em Aquecimento ou adicione manualmente.":"Tente outro filtro acima."}</div>
              {queue.length===0 && <button className="btn btn-ghost btn-sm" onClick={()=>{ window.location.href="/aquecimento"; }}>🔥 Ir para Aquecimento</button>}
            </div>
          ) : (
            <QueueList items={filtered} filterDay={filterDay} vfByParent={vfByParent} paByHistory={paByHistory} activeVfParentIds={activeVfParentIds}
              onEdit={openEdit} onRemove={(id)=>setConfirmModal({type:"removeItem",id})} onForce={(item)=>setForceConfirm(item)}
              forcingId={forcingId} selecting={selecting} selected={selected} onToggleSelect={toggleSelect} />
          )}
        </div>
      )}

      {/* ══ TAB: MONITOR ═════════════════════════════════════════════════════ */}
      {tab==="monitor" && (
        <div>
          {mainQueue.length===0 ? (
            <div className="card" style={{textAlign:"center",padding:"56px 20px",color:"var(--muted)"}}>
              <div style={{fontSize:48,marginBottom:14}}>📊</div>
              <div style={{fontWeight:700,color:"var(--text)",fontSize:15,marginBottom:8}}>Nada para monitorar</div>
              <div style={{fontSize:12}}>Agende posts em Aquecimento para começar.</div>
            </div>
          ) : (
            <>
              <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(110px,1fr))",gap:10,marginBottom:20}}>
                {[
                  {label:"Total",     value:mainQueue.length,                               color:"var(--text)"   },
                  {label:"Pendentes", value:mainQueue.filter(q=>q.status==="pending").length,color:"var(--info)"   },
                  {label:"Publicados",value:mainQueue.filter(q=>q.status==="done").length,   color:"var(--success)"},
                  {label:"Rodando",   value:mainQueue.filter(q=>q.status==="running").length, color:"var(--warning)"},
                  {label:"Erros",     value:mainQueue.filter(q=>q.status==="error").length,  color:"var(--danger)" },
                ].map(({label,value,color}) => (
                  <div key={label} className="card card-sm" style={{textAlign:"center"}}>
                    <div style={{fontSize:22,fontWeight:800,color}}>{value}</div>
                    <div style={{fontSize:11,color:"var(--muted)"}}>{label}</div>
                  </div>
                ))}
              </div>

              {buildDayGroups(mainQueue).map(g => {
                const dayItems=mainQueue.filter(q=>q.scheduledAt>=g.startMs&&q.scheduledAt<=g.endMs);
                const dayDone=dayItems.filter(q=>q.status==="done").length;
                const dayErr=dayItems.filter(q=>q.status==="error").length;
                return (
                  <div key={g.startMs} className="card" style={{marginBottom:12}}>
                    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}>
                      <div style={{fontWeight:700,fontSize:13,color:"var(--accent-light)"}}>📅 {g.label}</div>
                      <div style={{display:"flex",gap:8,fontSize:11}}>
                        <span style={{color:"var(--success)"}}>✅ {dayDone}</span>
                        {dayErr>0 && <span style={{color:"var(--danger)"}}>❌ {dayErr}</span>}
                        <span style={{color:"var(--muted)"}}>/ {dayItems.length} posts</span>
                      </div>
                    </div>
                    <div style={{height:6,borderRadius:3,background:"var(--bg3)",overflow:"hidden",marginBottom:10}}>
                      <div style={{height:"100%",borderRadius:3,width:`${Math.round((dayDone/dayItems.length)*100)}%`,background:dayErr>0?"var(--warning)":"var(--success)",transition:"width 0.5s"}} />
                    </div>
                    <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
                      {dayItems.map(item => {
                        const si=STATUS_INFO[item.status]||STATUS_INFO.pending;
                        const acc0=(item.accounts||[])[0];
                        return (
                          <div key={item.id} title={`@${acc0?.username} · ${item.postType} · ${new Date(item.scheduledAt).toLocaleString("pt-BR")}`}
                            style={{fontSize:10,padding:"3px 8px",borderRadius:20,background:si.bg,color:si.color,border:`1px solid ${si.color}30`,display:"flex",alignItems:"center",gap:4}}>
                            {item.status==="done"?"✅":item.status==="error"?"❌":item.status==="running"?"⟳":"⏳"}
                            @{acc0?.username||"?"}
                            <span style={{opacity:0.6}}>{new Date(item.scheduledAt).toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"})}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}

              <div style={{marginTop:12,display:"flex",gap:8}}>
                <button className="btn btn-ghost btn-sm" onClick={()=>reloadQueue?.()}>🔄 Atualizar</button>
                {mainQueue.some(q=>q.status==="pending") && <button className="btn btn-danger btn-sm" onClick={()=>setConfirmModal({type:"clearQueue"})}>🗑 Limpar fila</button>}
              </div>
            </>
          )}
        </div>
      )}

      {/* Modais */}
      {editModal && (
        <div onClick={()=>setEditModal(null)} style={{position:"fixed",inset:0,zIndex:9999,background:"rgba(0,0,0,0.6)",backdropFilter:"blur(6px)",display:"flex",alignItems:"center",justifyContent:"center"}}>
          <div onClick={e=>e.stopPropagation()} style={{background:"var(--bg2)",border:"1px solid var(--border2)",borderRadius:16,padding:28,width:"100%",maxWidth:440,boxShadow:"0 24px 80px rgba(0,0,0,0.5)"}}>
            <div style={{fontWeight:700,fontSize:16,marginBottom:18}}>✎ Editar agendamento</div>
            <div className="form-row"><label>Novo horário</label><input type="datetime-local" value={editTime} onChange={e=>setEditTime(e.target.value)} /></div>
            <div className="form-row"><label>Legenda</label><textarea value={editCaption} onChange={e=>setEditCaption(e.target.value)} style={{minHeight:80,fontSize:13}} /></div>
            <div style={{display:"flex",gap:10,justifyContent:"flex-end"}}>
              <button className="btn btn-ghost btn-sm" onClick={()=>setEditModal(null)}>Cancelar</button>
              <button className="btn btn-primary btn-sm" onClick={saveEdit}>Salvar</button>
            </div>
          </div>
        </div>
      )}

      {forceConfirm && (
        <div onClick={()=>setForceConfirm(null)} style={{position:"fixed",inset:0,zIndex:9999,background:"rgba(0,0,0,0.65)",backdropFilter:"blur(6px)",display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
          <div onClick={e=>e.stopPropagation()} style={{background:"var(--bg2)",border:"1px solid var(--border2)",borderRadius:16,padding:28,width:"100%",maxWidth:420,boxShadow:"0 24px 80px rgba(0,0,0,0.5)"}}>
            <div style={{fontWeight:700,fontSize:16,marginBottom:10}}>⚡ Publicar agora?</div>
            <div style={{fontSize:13,color:"var(--muted)",marginBottom:18,lineHeight:1.6}}>
              O agendamento será publicado <strong style={{color:"var(--text)"}}>imediatamente</strong>, ignorando o horário programado.
              {forceConfirm.accounts?.length>0 && <div style={{marginTop:10,display:"flex",gap:6,flexWrap:"wrap"}}>{forceConfirm.accounts.map(a=><span key={a.id} style={{fontSize:11,background:"var(--bg3)",border:"1px solid var(--border)",borderRadius:20,padding:"2px 8px"}}>@{a.username}</span>)}</div>}
            </div>
            <div style={{display:"flex",gap:10,justifyContent:"flex-end"}}>
              <button className="btn btn-ghost btn-sm" onClick={()=>setForceConfirm(null)}>Cancelar</button>
              <button className="btn btn-primary btn-sm" style={{background:"var(--warning)",borderColor:"var(--warning)"}} onClick={()=>forcePublish(forceConfirm)} disabled={forcingId===forceConfirm?.id}>
                {forcingId===forceConfirm?.id?"Publicando…":"⚡ Publicar agora"}
              </button>
            </div>
          </div>
        </div>
      )}

      <Modal open={confirmModal?.type==="clearQueue"}    title="Limpar fila?"               message="Todos os agendamentos serão removidos permanentemente." confirmLabel="Limpar tudo"           confirmDanger onConfirm={()=>{clearQueue();setConfirmModal(null);}}         onCancel={()=>setConfirmModal(null)} />
      <Modal open={confirmModal?.type==="removeItem"}    title="Remover agendamento?"        message="Este item será removido da fila."                         confirmLabel="Remover"               confirmDanger onConfirm={()=>{removeItem(confirmModal.id);setConfirmModal(null);}} onCancel={()=>setConfirmModal(null)} />
      <Modal open={confirmModal?.type==="removeSelected"} title={`Remover ${selected.size} item(s)?`} message={`${selected.size} agendamento(s) serão removidos.`} confirmLabel={`Remover ${selected.size}`} confirmDanger onConfirm={removeSelected} onCancel={()=>setConfirmModal(null)} />
    </div>
  );
}

// ─── Helpers de cor por status ────────────────────────────────────────────────
function statusStyle(status) {
  if (status === "done")    return { color: "var(--success)", bg: "rgba(34,197,94,0.10)",  border: "rgba(34,197,94,0.25)",  icon: "✅", label: "Publicado" };
  if (status === "error")   return { color: "var(--danger)",  bg: "rgba(239,68,68,0.10)",  border: "rgba(239,68,68,0.25)",  icon: "❌" };
  if (status === "running") return { color: "var(--warning)", bg: "rgba(245,158,11,0.10)", border: "rgba(245,158,11,0.25)", icon: "⟳"  };
  return                           { color: "var(--info)",    bg: "rgba(56,189,248,0.10)", border: "rgba(56,189,248,0.25)", icon: "⏳" };
}

// ─── Avatar pequeno de conta ───────────────────────────────────────────────────
function AccAvatar({ acc, size = 20 }) {
  return (
    <div style={{ width: size, height: size, borderRadius: "50%", flexShrink: 0, overflow: "hidden", border: "1px solid var(--border2)" }}>
      {acc.profile_picture
        ? <img src={acc.profile_picture} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }}
            onError={e => { e.target.style.display = "none"; }} />
        : <div style={{ width: "100%", height: "100%", background: "linear-gradient(135deg,var(--accent),#9b4dfc)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: size * 0.4, color: "#fff", fontWeight: 700 }}>
            {(acc.username || "?")[0].toUpperCase()}
          </div>}
    </div>
  );
}

// ─── QueueList ────────────────────────────────────────────────────────────────
function QueueList({ items, filterDay, vfByParent, paByHistory, activeVfParentIds, onEdit, onRemove, onForce, forcingId, selecting, selected, onToggleSelect }) {
  const groups = useMemo(() => {
    if (filterDay !== "all") return [{ label: null, items }];
    const map = {};
    for (const item of items) {
      const key = String(startOfDay(new Date(item.scheduledAt)));
      if (!map[key]) map[key] = { label: dateLabel(item.scheduledAt), items: [] };
      map[key].items.push(item);
    }
    return Object.entries(map).sort(([a],[b])=>Number(a)-Number(b)).map(([,g])=>g);
  }, [items, filterDay]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {groups.map((group, gi) => (
        <div key={gi}>
          {group.label && (
            <div style={{ display: "flex", alignItems: "center", gap: 10, margin: gi > 0 ? "18px 0 10px" : "0 0 10px" }}>
              <div style={{ flex: 1, height: 1, background: "var(--border)" }} />
              <span style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", padding: "3px 12px", borderRadius: 20, background: "var(--bg2)", border: "1px solid var(--border)", whiteSpace: "nowrap", letterSpacing: "0.03em" }}>
                📅 {group.label} — {group.items.length} post{group.items.length !== 1 ? "s" : ""}
              </span>
              <div style={{ flex: 1, height: 1, background: "var(--border)" }} />
            </div>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {group.items.map(item => (
              <QueueItem key={item.id} item={item}
                vfItems={vfByParent[item.id]}
                paItems={paByHistory?.[item.historyId]}
                hasActiveVf={activeVfParentIds?.has(item.id)}
                onEdit={onEdit} onRemove={onRemove} onForce={onForce}
                forcingId={forcingId} selecting={selecting}
                isSelected={selected?.has(item.id)} onToggleSelect={onToggleSelect} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── QueueItem — card redesenhado ─────────────────────────────────────────────
function QueueItem({ item, vfItems, paItems, hasActiveVf, onEdit, onRemove, onForce, forcingId, selecting, isSelected, onToggleSelect }) {
  const [expanded, setExpanded] = useState(false);

  const isGroup     = item.type === "group";
  const paTotal     = paItems?.length || 0;
  const paDone      = paItems?.filter(p => p.status === "done" || p.status === "error").length || 0;
  const paRunning   = paItems?.filter(p => p.status === "running").length || 0;
  const hasActivePa = paItems?.some(p => p.status === "pending" || p.status === "running");
  const allPaDone   = paTotal > 0 && paDone >= paTotal;

  const isPublishing    = (item.status === "done" || item.status === "running") && (hasActiveVf || hasActivePa) && !allPaDone;
  const effectiveStatus = isPublishing ? "running" : item.status;
  // isPast: horário passou, ainda pending, nunca rodou — badge laranja
  const isOverdue = item.status === "pending" && item.scheduledAt < Date.now() && !item.runCount;
  const ss = isOverdue
    ? { color: "var(--warning)", bg: "rgba(245,158,11,0.10)", border: "rgba(245,158,11,0.30)", icon: "⚠" }
    : statusStyle(effectiveStatus);

  const scheduledDate = new Date(item.scheduledAt);
  const isPast        = isOverdue; // alias mantido para compatibilidade
  const mediaCount    = item.mediaUrls?.length || 1;
  const qty           = item.quantityPerCycle || 1;
  const thumbUrl      = item.mediaType === "IMAGE" ? item.mediaUrl : null;

  // Resultados
  const results  = item.results || [];
  const resOk    = results.filter(r => r.success);
  const resFail  = results.filter(r => !r.success && !r.retrying);
  const resRetry = results.filter(r => !r.success && r.retrying);
  const hasResults = results.length > 0;

  // Progresso de publicação em curso
  const vfDone  = (vfItems  || []).filter(v => v.status === "done").length;
  const vfTotal = (vfItems  || []).length;

  // Sub-items para exibir (vf ou pa, o que for mais relevante)
  const subItems = isGroup && paItems?.length
    ? paItems.map(pa => ({ username: pa.username, status: pa.status, error: pa.error && !pa.skippedForRetry ? pa.error : null, label: pa.awaitingVideoFinish ? "🎬 processando" : null, retrying: pa.skippedForRetry }))
    : (vfItems || []).map(vf => ({ username: vf.username, status: vf.status, error: vf.error || null, attempts: vf.attempts, label: null }));

  const hasSubItems = subItems.length > 0;

  // Contas — colapsa se muitas
  const accs        = item.accounts || [];
  const visibleAccs = accs.slice(0, 6);
  const hiddenAccs  = accs.length - 6;

  return (
    <div style={{
      borderRadius: 12,
      border: `1px solid ${isSelected ? "var(--accent)" : ss.border}`,
      borderLeft: `3px solid ${isSelected ? "var(--accent)" : ss.color}`,
      background: isSelected ? "rgba(124,92,252,0.07)" : "var(--bg2)",
      overflow: "hidden",
      transition: "all 0.15s",
      cursor: selecting ? "pointer" : (hasSubItems || hasResults) ? "pointer" : "default",
    }}>

      {/* ── Linha principal ── */}
      <div
        style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 14px", cursor: selecting ? "pointer" : (hasSubItems || hasResults) ? "pointer" : "default", userSelect: "none" }}
        onClick={selecting ? () => onToggleSelect(item.id) : (hasSubItems || hasResults) ? (e) => { e.stopPropagation(); setExpanded(p => !p); } : undefined}
      >

        {/* Checkbox seleção */}
        {selecting && (
          <div style={{ width: 18, height: 18, borderRadius: 4, flexShrink: 0, border: `2px solid ${isSelected ? "var(--accent)" : "var(--border2)"}`, background: isSelected ? "var(--accent)" : "transparent", display: "flex", alignItems: "center", justifyContent: "center" }}>
            {isSelected && <span style={{ color: "#fff", fontSize: 10, fontWeight: 900 }}>✓</span>}
          </div>
        )}

        {/* Thumbnail / ícone */}
        <div style={{ width: 44, height: 44, borderRadius: 8, flexShrink: 0, overflow: "hidden", background: "var(--bg3)", display: "flex", alignItems: "center", justifyContent: "center", position: "relative", border: "1px solid var(--border)" }}>
          {thumbUrl
            ? <img src={thumbUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} onError={e => { e.target.style.display = "none"; }} />
            : <span style={{ fontSize: 20 }}>🎬</span>}
          {mediaCount > 1 && (
            <span style={{ position: "absolute", bottom: 2, right: 2, background: "rgba(0,0,0,0.7)", color: "#fff", fontSize: 8, fontWeight: 700, borderRadius: 4, padding: "1px 3px" }}>×{mediaCount}</span>
          )}
        </div>

        {/* Corpo central */}
        <div style={{ flex: 1, minWidth: 0 }}>

          {/* Linha 1: status + tipo + horário */}
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6, flexWrap: "wrap" }}>
            {/* Badge de status */}
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 20, background: ss.bg, color: ss.color, border: `1px solid ${ss.border}`, letterSpacing: "0.04em", whiteSpace: "nowrap" }}>
              {isPublishing && isGroup
                ? <>{ss.icon} Publicando {paDone}/{paTotal}{paRunning > 0 ? ` · ${paRunning} agora` : ""}</>
                : isPublishing
                  ? <>{ss.icon} Publicando vídeos {vfDone}/{vfTotal}</>
                  : <>{ss.icon} {effectiveStatus === "done" ? "Publicado" : effectiveStatus === "error" ? "Erro" : effectiveStatus === "running" ? "Rodando" : (item.runCount > 0 ? "Próximo ciclo" : isPast ? "⚠ Atrasado" : "Agendado")}</>}
            </span>

            {/* Tipo de post */}
            <span style={{ fontSize: 10, color: "var(--muted)", background: "var(--bg3)", border: "1px solid var(--border)", padding: "2px 7px", borderRadius: 20, whiteSpace: "nowrap" }}>
              {item.mediaType === "IMAGE" ? "🖼" : "🎬"} {item.postType}
            </span>

            {/* Badges extras */}
            {qty > 1 && <span style={{ fontSize: 9, fontWeight: 700, color: "var(--accent-light)", background: "rgba(124,92,252,0.12)", border: "1px solid rgba(124,92,252,0.3)", padding: "2px 6px", borderRadius: 20 }}>×{qty}/ciclo</span>}
            {item.loop && <span style={{ fontSize: 10, color: "var(--accent-light)", background: "rgba(124,92,252,0.08)", border: "1px solid rgba(124,92,252,0.2)", padding: "2px 6px", borderRadius: 20 }}>🔁 loop</span>}
            {item.runCount > 0 && <span style={{ fontSize: 9, color: "var(--muted)" }}>×{item.runCount} runs</span>}

            {/* Horário — empurrado para direita */}
            <span style={{ marginLeft: "auto", fontSize: 11, fontWeight: isPast ? 700 : 500, color: isPast ? "var(--warning)" : "var(--muted)", whiteSpace: "nowrap", display: "flex", alignItems: "center", gap: 4 }}>
              🕐 {scheduledDate.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
              {isPast && <span style={{ color: "var(--warning)", fontSize: 12 }}>⚠</span>}
            </span>
          </div>

          {/* Linha 2: avatares das contas */}
          <div style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
            {visibleAccs.map((a, i) => (
              <div key={a.id || i} style={{ display: "flex", alignItems: "center", gap: 4, background: "var(--bg3)", border: "1px solid var(--border)", borderRadius: 20, padding: "2px 8px 2px 4px" }}>
                <AccAvatar acc={a} size={18} />
                <span style={{ fontSize: 10, fontWeight: 600, color: "var(--text2)", whiteSpace: "nowrap" }}>@{a.username || "—"}</span>
              </div>
            ))}
            {hiddenAccs > 0 && (
              <span style={{ fontSize: 10, color: "var(--muted)", background: "var(--bg3)", border: "1px solid var(--border)", borderRadius: 20, padding: "2px 8px" }}>
                +{hiddenAccs} conta{hiddenAccs !== 1 ? "s" : ""}
              </span>
            )}
          </div>

          {/* Erro de item (quando o próprio post falhou) */}
          {item.error && effectiveStatus === "error" && (
            <div style={{ marginTop: 6, fontSize: 11, color: "var(--danger)", background: "rgba(239,68,68,0.06)", border: "1px solid rgba(239,68,68,0.2)", borderRadius: 6, padding: "4px 8px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              ✗ {item.error}
            </div>
          )}
        </div>

        {/* Ações — direita */}
        <div style={{ display: "flex", flexDirection: "column", gap: 4, flexShrink: 0, alignItems: "flex-end" }}>
          <div style={{ display: "flex", gap: 4 }}>
            {(item.status === "pending" || item.status === "error") && (
              <button title="Publicar agora" disabled={forcingId === item.id}
                onClick={e => { e.stopPropagation(); onForce(item); }}
                style={{ width: 28, height: 28, borderRadius: 7, border: "1px solid rgba(245,158,11,0.3)", background: "rgba(245,158,11,0.08)", color: "var(--warning)", cursor: "pointer", fontSize: 13, display: "flex", alignItems: "center", justifyContent: "center" }}>
                {forcingId === item.id ? <span className="spinner" style={{ width: 10, height: 10 }} /> : "⚡"}
              </button>
            )}
            {(item.status === "pending" || item.status === "error") && (
              <button title="Editar horário"
                onClick={e => { e.stopPropagation(); onEdit(item); }}
                style={{ width: 28, height: 28, borderRadius: 7, border: "1px solid var(--border)", background: "var(--bg3)", color: "var(--muted)", cursor: "pointer", fontSize: 13, display: "flex", alignItems: "center", justifyContent: "center" }}>
                ✎
              </button>
            )}
            <button title="Remover"
              onClick={e => { e.stopPropagation(); onRemove(item.id); }}
              style={{ width: 28, height: 28, borderRadius: 7, border: "1px solid rgba(239,68,68,0.25)", background: "rgba(239,68,68,0.06)", color: "var(--danger)", cursor: "pointer", fontSize: 13, display: "flex", alignItems: "center", justifyContent: "center" }}>
              ✕
            </button>
          </div>

          {/* Indicador de expandir — clique no card inteiro para expandir */}
          {(hasSubItems || hasResults) && (
            <div style={{ fontSize: 11, color: "var(--muted)", padding: "2px 0", display: "flex", alignItems: "center", gap: 3, pointerEvents: "none" }}>
              {expanded ? "▲" : "▼"}
            </div>
          )}
        </div>
      </div>

      {/* ── Seção expandida: sub-items (per_account / video_finish) ── */}
      {/* ── Seção unificada: todas as contas (em progresso + concluídas) ── */}
      {expanded && (hasSubItems || hasResults) && (() => {
        // Monta lista unificada: subItems (pending/running) + results (done/error)
        // Evita duplicatas: se a conta já está em results, não mostra em subItems
        const resultUsernames = new Set(results.map(r => r.username));
        const pendingSubItems = subItems.filter(s => !resultUsernames.has(s.username));
        const totalContas = accs.length || (pendingSubItems.length + results.length);

        return (
          <div style={{ borderTop: "1px solid var(--border)", background: "var(--bg3)" }}>

            {/* Barra de resumo */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 14px", flexWrap: "wrap" }}>
              {/* Contadores de status */}
              {subItems.filter(s => !resultUsernames.has(s.username) && (s.status === "running")).length > 0 && (
                <span style={{ fontSize: 11, fontWeight: 700, color: "var(--warning)", background: "rgba(245,158,11,0.12)", border: "1px solid rgba(245,158,11,0.3)", borderRadius: 20, padding: "2px 10px" }}>
                  ⟳ {subItems.filter(s => !resultUsernames.has(s.username) && s.status === "running").length} publicando
                </span>
              )}
              {subItems.filter(s => !resultUsernames.has(s.username) && (s.status === "pending")).length > 0 && (
                <span style={{ fontSize: 11, fontWeight: 700, color: "var(--info)", background: "rgba(56,189,248,0.12)", border: "1px solid rgba(56,189,248,0.3)", borderRadius: 20, padding: "2px 10px" }}>
                  ⏳ {subItems.filter(s => !resultUsernames.has(s.username) && s.status === "pending").length} aguardando
                </span>
              )}
              {resOk.length > 0 && (
                <span style={{ fontSize: 11, fontWeight: 700, color: "var(--success)", background: "rgba(34,197,94,0.12)", border: "1px solid rgba(34,197,94,0.3)", borderRadius: 20, padding: "2px 10px" }}>
                  ✅ {resOk.length} publicado{resOk.length > 1 ? "s" : ""}
                </span>
              )}
              {resRetry.length > 0 && (
                <span style={{ fontSize: 11, fontWeight: 700, color: "var(--warning)", background: "rgba(245,158,11,0.12)", border: "1px solid rgba(245,158,11,0.3)", borderRadius: 20, padding: "2px 10px" }}>
                  ↻ {resRetry.length} retry
                </span>
              )}
              {resFail.length > 0 && (
                <span style={{ fontSize: 11, fontWeight: 700, color: "var(--danger)", background: "rgba(239,68,68,0.12)", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 20, padding: "2px 10px" }}>
                  ❌ {resFail.length} falhou{resFail.length > 1 ? "ram" : ""}
                </span>
              )}
              <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--muted)" }}>
                {results.length}/{totalContas} contas
              </span>
            </div>

            {/* Grid unificado: em progresso primeiro, depois concluídos */}
            <div style={{ display: "flex", flexDirection: "column", gap: 3, padding: "0 14px 12px" }}>

              {/* Contas ainda em progresso (pending/running) */}
              {pendingSubItems.map((sub, i) => {
                const s = statusStyle(sub.status);
                return (
                  <div key={"sub-" + i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", borderRadius: 8, background: s.bg, border: `1px solid ${s.border}` }}>
                    <span style={{ fontSize: 14, flexShrink: 0 }}>{sub.label ? "🎬" : s.icon}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text)" }}>@{sub.username}</div>
                      <div style={{ fontSize: 10, color: s.color, display: "flex", alignItems: "center", gap: 6 }}>
                        {sub.status === "running" ? "Publicando…" : sub.status === "pending" ? "Aguardando…" : sub.status === "done" ? "Publicado" : sub.status === "error" ? "Erro" : sub.status}
                        {sub.retrying && <span style={{ color: "var(--warning)" }}>retry</span>}
                        {sub.attempts > 0 && <span style={{ color: "var(--muted)" }}>×{sub.attempts + 1} tentativas</span>}
                      </div>
                      {sub.error && (
                        <div style={{ fontSize: 10, color: "var(--danger)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={sub.error}>
                          {sub.error}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}

              {/* Contas com resultado final */}
              {results.map((r, i) => {
                const isRetrying = !r.success && r.retrying;
                const rs = r.success ? statusStyle("done") : isRetrying ? statusStyle("running") : statusStyle("error");
                return (
                  <div key={"res-" + i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", borderRadius: 8, background: rs.bg, border: `1px solid ${rs.border}` }}>
                    <span style={{ fontSize: 14, flexShrink: 0 }}>{r.success ? "✅" : isRetrying ? "⟳" : "❌"}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text)" }}>@{r.username}</div>
                      {r.success ? (
                        <div style={{ fontSize: 10, color: "var(--success)", display: "flex", alignItems: "center", gap: 6 }}>
                          Publicado
                          {r.published_at && <span style={{ color: "var(--muted)" }}>{new Date(r.published_at).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>}
                          {r.media_id && <a href={`https://www.instagram.com/p/${r.media_id}/`} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent-light)", fontWeight: 700 }} title="Ver no Instagram">↗</a>}
                        </div>
                      ) : isRetrying ? (
                        <div style={{ fontSize: 10, color: "var(--warning)", fontStyle: "italic" }}>Retry em andamento…</div>
                      ) : (
                        <div style={{ fontSize: 10, color: "var(--danger)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.error}>
                          {r.error || "Erro desconhecido"}
                        </div>
                      )}
                    </div>
                    {r.attempts > 1 && (
                      <span style={{ fontSize: 10, color: "var(--muted)", flexShrink: 0, background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 20, padding: "1px 7px" }}>
                        ×{r.attempts} tent.
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}
    </div>
  );
}
