// Queue.jsx — Fila de agendamentos com layout em tabs (igual ao Warmup)
import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useScheduler, useAccounts } from "../App.jsx";
import Modal from "../Modal.jsx";
import DrivePicker from "../components/DrivePicker.jsx";

const QUEUE_TABS = [
  { id: "fila",    icon: "📋", label: "Fila"         },
  { id: "drive",   icon: "📂", label: "Google Drive" },
  { id: "monitor", icon: "📊", label: "Monitor"      },
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
  done:    { label: "Feito",    color: "var(--success)", bg: "rgba(34,197,94,0.06)"   },
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
            {icon:"✅",value:doneCount,       label:"feitos",   color:"var(--success)"},
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
                  {id:"done",label:"Feitos",count:doneCount},
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
              <div style={{fontSize:12,marginBottom:18}}>{queue.length===0?"Use a aba Google Drive para agendar vídeos.":"Tente outro filtro acima."}</div>
              {queue.length===0 && <button className="btn btn-ghost btn-sm" onClick={()=>setTab("drive")}>📂 Google Drive</button>}
            </div>
          ) : (
            <QueueList items={filtered} filterDay={filterDay} vfByParent={vfByParent} paByHistory={paByHistory} activeVfParentIds={activeVfParentIds}
              onEdit={openEdit} onRemove={(id)=>setConfirmModal({type:"removeItem",id})} onForce={(item)=>setForceConfirm(item)}
              forcingId={forcingId} selecting={selecting} selected={selected} onToggleSelect={toggleSelect} />
          )}
        </div>
      )}

      {/* ══ TAB: GOOGLE DRIVE ════════════════════════════════════════════════ */}
      {tab==="drive" && (
        <DrivePicker
          accounts={accounts}
          onSchedule={async (items) => { await addBatch(items); window.dispatchEvent(new CustomEvent("sw:queue-update")); setTab("fila"); }}
          onClose={null}
          inline={true}
        />
      )}

      {/* ══ TAB: MONITOR ═════════════════════════════════════════════════════ */}
      {tab==="monitor" && (
        <div>
          {mainQueue.length===0 ? (
            <div className="card" style={{textAlign:"center",padding:"56px 20px",color:"var(--muted)"}}>
              <div style={{fontSize:48,marginBottom:14}}>📊</div>
              <div style={{fontWeight:700,color:"var(--text)",fontSize:15,marginBottom:8}}>Nada para monitorar</div>
              <div style={{fontSize:12}}>Agende posts na aba Google Drive ou em Aquecimento.</div>
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
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {groups.map((group, gi) => (
        <div key={gi}>
          {group.label && (
            <div style={{display:"flex",alignItems:"center",gap:8,margin:gi>0?"14px 0 8px":"0 0 8px"}}>
              <div style={{flex:1,height:1,background:"var(--border)"}} />
              <span style={{fontSize:11,fontWeight:700,color:"var(--muted)",padding:"2px 10px",borderRadius:10,background:"var(--bg2)",border:"1px solid var(--border)",whiteSpace:"nowrap"}}>
                📅 {group.label} — {group.items.length} post(s)
              </span>
              <div style={{flex:1,height:1,background:"var(--border)"}} />
            </div>
          )}
          {group.items.map(item => (
            <QueueItem key={item.id} item={item} vfItems={vfByParent[item.id]} paItems={paByHistory?.[item.historyId]} hasActiveVf={activeVfParentIds?.has(item.id)}
              onEdit={onEdit} onRemove={onRemove} onForce={onForce} forcingId={forcingId} selecting={selecting} isSelected={selected?.has(item.id)} onToggleSelect={onToggleSelect} />
          ))}
        </div>
      ))}
    </div>
  );
}

// ─── QueueItem ────────────────────────────────────────────────────────────────
function QueueItem({ item, vfItems, paItems, hasActiveVf, onEdit, onRemove, onForce, forcingId, selecting, isSelected, onToggleSelect }) {
  const isGroup     = item.type === "group";
  const paTotal     = paItems?.length || 0;
  const paDone      = paItems?.filter(p=>p.status==="done"||p.status==="error").length || 0;
  const paRunning   = paItems?.filter(p=>p.status==="running").length || 0;
  const hasActivePa = paItems?.some(p=>p.status==="pending"||p.status==="running");
  const isPublishingVideos = (item.status==="done"||item.status==="running") && (hasActiveVf||hasActivePa);
  const effectiveStatus    = isPublishingVideos?"running":item.status;
  const info               = STATUS_INFO[effectiveStatus]||STATUS_INFO.pending;
  const scheduledDate      = new Date(item.scheduledAt);
  const isPast             = item.scheduledAt < Date.now();
  const thumbUrl           = item.mediaType==="IMAGE"?item.mediaUrl:null;
  const mediaCount         = item.mediaUrls?.length||1;
  const qty                = item.quantityPerCycle||1;

  return (
    <div style={{background:isSelected?"rgba(124,92,252,0.1)":info.bg,border:`1px solid ${isSelected?"var(--accent)":info.color+"28"}`,borderLeft:`3px solid ${isSelected?"var(--accent)":info.color}`,borderRadius:10,padding:"10px 12px",cursor:selecting?"pointer":"default",transition:"all 0.12s"}} onClick={selecting?()=>onToggleSelect(item.id):undefined}>
      <div style={{display:"flex",alignItems:"center",gap:10}}>
        {selecting && <div style={{width:20,height:20,borderRadius:5,flexShrink:0,border:`2px solid ${isSelected?"var(--accent)":"var(--border2)"}`,background:isSelected?"var(--accent)":"transparent",display:"flex",alignItems:"center",justifyContent:"center",transition:"all 0.12s"}}>{isSelected&&<span style={{color:"#fff",fontSize:12,fontWeight:900}}>✓</span>}</div>}
        {thumbUrl ? (
          <img src={thumbUrl} alt="" style={{width:40,height:40,borderRadius:7,objectFit:"cover",flexShrink:0,border:"1px solid var(--border)"}} onError={e=>{e.target.style.display="none";}} />
        ) : (
          <div style={{width:40,height:40,borderRadius:7,background:"var(--bg3)",flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,position:"relative"}}>
            🎬
            {mediaCount>1 && <span style={{position:"absolute",top:-4,right:-4,background:"var(--accent)",color:"#fff",fontSize:9,fontWeight:700,borderRadius:8,padding:"1px 4px"}}>×{mediaCount}</span>}
          </div>
        )}

        <div style={{flex:1,minWidth:0}}>
          <div style={{display:"flex",alignItems:"center",gap:5,marginBottom:4,flexWrap:"wrap"}}>
            <span style={{fontSize:11,fontWeight:700,color:info.color}}>
              {isPublishingVideos&&isGroup?<>⟳ PUBLICANDO <span style={{fontWeight:400,opacity:0.8}}>{paDone}/{paTotal} contas{paRunning>0?` (${paRunning} agora)`:""}</span></>:isPublishingVideos?<>⟳ PUBLICANDO VÍDEOS <span style={{fontWeight:400,opacity:0.8}}>{(vfItems||[]).filter(v=>v.status==="done").length}/{(vfItems||[]).length}</span></>:<>{effectiveStatus==="running"?"⟳ ":""}{info.label.toUpperCase()}</>}
            </span>
            <span style={{fontSize:10,color:"var(--muted)",background:"var(--bg3)",padding:"1px 6px",borderRadius:4}}>{item.postType}</span>
            <span style={{fontSize:10,color:"var(--muted)"}}>{item.mediaType==="IMAGE"?"🖼":"🎬"}</span>
            {qty>1 && <span style={{fontSize:9,fontWeight:700,color:"var(--accent-light)",background:"#7c5cfc20",border:"1px solid var(--accent)",padding:"0 5px",borderRadius:8}}>×{qty}/ciclo</span>}
            {item.loop && <span style={{fontSize:10,color:"var(--accent-light)"}}>🔁</span>}
            {item.runCount>0 && <span style={{fontSize:9,color:"var(--muted)"}}>run×{item.runCount}</span>}
            <span style={{fontSize:10,marginLeft:"auto",color:isPast&&item.status==="pending"?"var(--warning)":"var(--muted)",fontWeight:isPast&&item.status==="pending"?700:400}}>
              🕐 {scheduledDate.toLocaleString("pt-BR",{day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"})}{isPast&&item.status==="pending"&&" ⚠"}
            </span>
          </div>

          <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap",marginTop:2}}>
            {(item.accounts||[]).slice(0,8).map((a,i) => (
              <div key={a.id||i} style={{display:"flex",alignItems:"center",gap:4,background:"var(--bg3)",border:"1px solid var(--border)",borderRadius:20,padding:"2px 7px 2px 3px"}}>
                {a.profile_picture?<img src={a.profile_picture} alt="" style={{width:16,height:16,borderRadius:"50%",objectFit:"cover",flexShrink:0}} />:<div style={{width:16,height:16,borderRadius:"50%",background:"linear-gradient(135deg,var(--accent),#9b4dfc)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:7,color:"#fff",fontWeight:700,flexShrink:0}}>{(a.username||"?")[0].toUpperCase()}</div>}
                <span style={{fontSize:10,fontWeight:600,color:"var(--text)",whiteSpace:"nowrap"}}>@{a.username||"—"}</span>
              </div>
            ))}
            {(item.accounts||[]).length>8 && <span style={{fontSize:10,color:"var(--muted)",fontWeight:600}}>+{item.accounts.length-8} conta(s)</span>}
            <span style={{fontSize:10,color:"var(--muted)",marginLeft:"auto",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:160}}>{mediaCount>1?`${mediaCount} mídias`:item.mediaUrl?.split("/").pop()?.slice(0,35)}</span>
          </div>

          {item.error && <div style={{fontSize:10,color:"var(--danger)",marginTop:4,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>✗ {item.error}</div>}

          {vfItems?.length>0 && (
            <div style={{display:"flex",flexWrap:"wrap",gap:4,marginTop:6}}>
              {vfItems.map((vf,i)=>{
                const vfColor=vf.status==="done"?"var(--success)":vf.status==="error"?"var(--danger)":vf.status==="running"?"var(--warning)":"var(--info)";
                const vfBg=vf.status==="done"?"rgba(34,197,94,0.08)":vf.status==="error"?"rgba(239,68,68,0.08)":vf.status==="running"?"rgba(245,158,11,0.08)":"rgba(56,189,248,0.08)";
                const vfIcon=vf.status==="done"?"✅":vf.status==="error"?"❌":vf.status==="running"?"⟳":"⏳";
                return <div key={i} title={vf.error||""} style={{fontSize:10,padding:"2px 7px",borderRadius:20,background:vfBg,color:vfColor,border:`1px solid ${vfColor}40`,display:"flex",alignItems:"center",gap:4}}><span>{vfIcon}</span><span>@{vf.username}</span>{vf.attempts>0&&<span style={{opacity:0.65}}>×{vf.attempts+1}</span>}{vf.error&&<span style={{maxWidth:140,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{" — "}{vf.error}</span>}</div>;
              })}
            </div>
          )}

          {isGroup&&paItems?.length>0 && (
            <div style={{display:"flex",flexWrap:"wrap",gap:4,marginTop:6}}>
              {paItems.map((pa,i)=>{
                const paColor=pa.status==="done"?"var(--success)":pa.status==="error"?"var(--danger)":pa.status==="running"?"var(--warning)":"var(--info)";
                const paBg=pa.status==="done"?"rgba(34,197,94,0.08)":pa.status==="error"?"rgba(239,68,68,0.08)":pa.status==="running"?"rgba(245,158,11,0.08)":"rgba(56,189,248,0.08)";
                const paIcon=pa.status==="done"?(pa.awaitingVideoFinish?"🎬":"✅"):pa.status==="error"?"❌":pa.status==="running"?"⟳":"⏳";
                return <div key={i} title={pa.error||(pa.awaitingVideoFinish?"Aguardando processamento do vídeo":"")} style={{fontSize:10,padding:"2px 7px",borderRadius:20,background:paBg,color:paColor,border:`1px solid ${paColor}40`,display:"flex",alignItems:"center",gap:4}}><span>{paIcon}</span><span>@{pa.username}</span>{pa.error&&!pa.skippedForRetry&&<span style={{maxWidth:120,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{" — "}{pa.error}</span>}{pa.skippedForRetry&&<span style={{opacity:0.65}}> retry↻</span>}</div>;
              })}
            </div>
          )}

          {item.results?.length>0 && (()=>{
            const ok=item.results.filter(r=>r.success), retrying=item.results.filter(r=>!r.success&&r.retrying), fail=item.results.filter(r=>!r.success&&!r.retrying);
            return (
              <div style={{marginTop:8,borderTop:"1px solid var(--border)",paddingTop:8}}>
                <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:6,flexWrap:"wrap"}}>
                  <span style={{fontSize:10,fontWeight:700,color:"var(--muted)",textTransform:"uppercase",letterSpacing:"0.05em"}}>Resultado</span>
                  {ok.length>0&&<span style={{fontSize:11,fontWeight:700,color:"var(--success)",background:"rgba(34,197,94,0.1)",border:"1px solid rgba(34,197,94,0.3)",borderRadius:20,padding:"1px 8px"}}>✅ {ok.length} publicado{ok.length>1?"s":""}</span>}
                  {retrying.length>0&&<span style={{fontSize:11,fontWeight:700,color:"var(--warning)",background:"rgba(245,158,11,0.1)",border:"1px solid rgba(245,158,11,0.3)",borderRadius:20,padding:"1px 8px"}}>↻ {retrying.length} retry</span>}
                  {fail.length>0&&<span style={{fontSize:11,fontWeight:700,color:"var(--danger)",background:"rgba(239,68,68,0.1)",border:"1px solid rgba(239,68,68,0.3)",borderRadius:20,padding:"1px 8px"}}>❌ {fail.length} falhou{fail.length>1?"ram":""}</span>}
                  <span style={{fontSize:10,color:"var(--muted)",marginLeft:"auto"}}>{ok.length+fail.length+retrying.length}/{item.accounts?.length||"?"} contas</span>
                </div>
                <div style={{display:"flex",flexDirection:"column",gap:3}}>
                  {item.results.map((r,i)=>{
                    const isRetrying=!r.success&&r.retrying;
                    return (
                      <div key={i} style={{display:"flex",alignItems:"center",gap:6,fontSize:10,padding:"3px 8px",borderRadius:6,background:r.success?"rgba(34,197,94,0.06)":isRetrying?"rgba(245,158,11,0.06)":"rgba(239,68,68,0.06)",border:`1px solid ${r.success?"rgba(34,197,94,0.2)":isRetrying?"rgba(245,158,11,0.2)":"rgba(239,68,68,0.2)"}`}}>
                        <span style={{fontSize:12}}>{r.success?"✅":isRetrying?"↻":"❌"}</span>
                        <span style={{fontWeight:700,color:"var(--text)",minWidth:90}}>@{r.username}</span>
                        {r.success?<><span style={{color:"var(--success)",fontWeight:600}}>Publicado</span>{r.published_at&&<span style={{color:"var(--muted)",marginLeft:"auto"}}>{new Date(r.published_at).toLocaleString("pt-BR",{day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"})}</span>}{r.media_id&&<a href={`https://www.instagram.com/p/${r.media_id}/`} target="_blank" rel="noopener noreferrer" style={{color:"var(--accent-light)",marginLeft:4,textDecoration:"none",fontWeight:600}} title="Ver no Instagram">↗</a>}</>:isRetrying?<span style={{color:"var(--warning)",fontStyle:"italic"}}>Retry em andamento…</span>:<span style={{color:"var(--danger)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:220}}>{r.error||"Erro desconhecido"}</span>}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })()}
        </div>

        <div style={{display:"flex",gap:4,flexShrink:0}}>
          {(item.status==="pending"||item.status==="error")&&<button className="btn btn-ghost btn-xs" onClick={()=>onForce(item)} title="Publicar agora" disabled={forcingId===item.id} style={{padding:"4px 8px",fontSize:12,color:"var(--warning)"}}>{forcingId===item.id?"⟳":"⚡"}</button>}
          {(item.status==="pending"||item.status==="error")&&<button className="btn btn-ghost btn-xs" onClick={()=>onEdit(item)} title="Editar" style={{padding:"4px 8px",fontSize:12}}>✎</button>}
          <button className="btn btn-ghost btn-xs" style={{color:"var(--danger)",padding:"4px 8px",fontSize:12}} onClick={()=>onRemove(item.id)} title="Remover">✕</button>
        </div>
      </div>
    </div>
  );
}
