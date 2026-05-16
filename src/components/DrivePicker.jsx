// DrivePicker.jsx
// Navegador de pastas/vídeos do Google Drive com autenticação OAuth.
// Suporta modo inline (embutido na aba) e modo modal.
// Novidades: seleção de contas por checkbox + horário padrão sempre no fuso Brasil (UTC-3).

import { useState, useEffect, useCallback } from "react";
import { useDriveAuth } from "../useDriveAuth.js";

function fmtSize(bytes) {
  if (!bytes) return "";
  if (bytes < 1024*1024) return `${(bytes/1024).toFixed(0)} KB`;
  return `${(bytes/(1024*1024)).toFixed(1)} MB`;
}
function fmtDuration(sec) {
  if (!sec) return "";
  const m=Math.floor(sec/60), s=sec%60;
  return `${m}:${String(s).padStart(2,"0")}`;
}

// Retorna "YYYY-MM-DDTHH:MM" no horario LOCAL do navegador + 60 segundos
function nowLocal(offsetMinutes = 0) {
  const d = new Date(Date.now() + 60 * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Converte o valor do input datetime-local para timestamp UTC real.
// new Date("YYYY-MM-DDTHH:MM") interpreta como horario LOCAL do browser — .getTime() retorna UTC correto.
function localInputToUTC(localStr) {
  if (!localStr) return Date.now();
  return new Date(localStr).getTime();
}

const IconFolder = () => <span style={{fontSize:20}}>📁</span>;
const IconVideo  = () => <span style={{fontSize:18}}>🎬</span>;
const IconCheck  = () => <span style={{fontSize:14,color:"var(--success)"}}>✓</span>;

// ─── Tela de conexão ──────────────────────────────────────────────────────────
function ConnectScreen({ drive, onClose, inline }) {
  return (
    <div style={{padding:"48px 32px",textAlign:"center",display:"flex",flexDirection:"column",alignItems:"center",gap:16}}>
      <div style={{fontSize:52}}>📂</div>
      <div style={{fontWeight:700,fontSize:17}}>Conectar Google Drive</div>
      <div style={{fontSize:13,color:"var(--muted)",maxWidth:340,lineHeight:1.6}}>
        Conecte sua conta Google para navegar pelos seus vídeos e agendá-los diretamente da Fila.
        O acesso é somente leitura.
      </div>

      {drive.errorMsg && drive.status!=="connecting" && (
        <div style={{padding:"10px 16px",borderRadius:8,background:"rgba(239,68,68,0.1)",border:"1px solid rgba(239,68,68,0.25)",color:"var(--danger)",fontSize:13,maxWidth:340}}>
          ⚠️ {drive.errorMsg}
        </div>
      )}

      <button onClick={drive.connect} disabled={drive.isConnecting} style={{display:"flex",alignItems:"center",gap:10,padding:"11px 24px",borderRadius:10,background:drive.isConnecting?"var(--bg3)":"#fff",color:"#3c4043",border:"1px solid #dadce0",fontWeight:600,fontSize:14,cursor:drive.isConnecting?"not-allowed":"pointer",boxShadow:"0 1px 3px rgba(0,0,0,0.2)",transition:"all 0.15s"}}>
        {drive.isConnecting ? (
          <><span className="spinner" style={{width:16,height:16,borderTopColor:"var(--accent)"}} /> Aguardando login...</>
        ) : (
          <>
            <svg width="18" height="18" viewBox="0 0 48 48">
              <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.2l6.7-6.7C35.8 2.2 30.3 0 24 0 14.6 0 6.6 5.4 2.6 13.3l7.8 6C12.2 13 17.7 9.5 24 9.5z"/>
              <path fill="#4285F4" d="M46.6 24.5c0-1.6-.1-3.1-.4-4.5H24v8.5h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8c4.4-4 6.9-10 6.9-17z"/>
              <path fill="#FBBC05" d="M10.4 28.7A14.6 14.6 0 0 1 9.5 24c0-1.6.3-3.2.9-4.7L2.6 13.3A23.9 23.9 0 0 0 0 24c0 3.8.9 7.4 2.6 10.6l7.8-5.9z"/>
              <path fill="#34A853" d="M24 48c6.3 0 11.6-2.1 15.5-5.6l-7.5-5.8c-2.1 1.4-4.8 2.3-8 2.3-6.3 0-11.7-4.2-13.6-10l-7.8 6C6.6 42.6 14.6 48 24 48z"/>
            </svg>
            Entrar com Google
          </>
        )}
      </button>

      {!inline && onClose && (
        <button onClick={onClose} style={{background:"none",border:"none",color:"var(--muted)",fontSize:13,cursor:"pointer",textDecoration:"underline"}}>Cancelar</button>
      )}
    </div>
  );
}

function ExpiredScreen({ drive, onClose, inline }) {
  return (
    <div style={{padding:"40px 32px",textAlign:"center",display:"flex",flexDirection:"column",alignItems:"center",gap:14}}>
      <div style={{fontSize:44}}>🔄</div>
      <div style={{fontWeight:700,fontSize:16}}>Sessão do Drive expirada</div>
      <div style={{fontSize:13,color:"var(--muted)"}}>Reconecte para continuar navegando.</div>
      <div style={{display:"flex",gap:10}}>
        <button onClick={drive.connect} className="btn btn-primary" style={{display:"flex",alignItems:"center",gap:8}}>
          {drive.isConnecting?<><span className="spinner" style={{width:12,height:12,borderTopColor:"#fff"}} /> Aguardando...</>:"🔑 Reconectar Drive"}
        </button>
        <button onClick={drive.disconnect} className="btn btn-ghost btn-sm" style={{color:"var(--danger)",borderColor:"rgba(239,68,68,0.3)"}}>Desconectar</button>
      </div>
      {!inline && onClose && <button onClick={onClose} style={{background:"none",border:"none",color:"var(--muted)",fontSize:12,cursor:"pointer",textDecoration:"underline"}}>Fechar</button>}
    </div>
  );
}

// ─── Componente principal ─────────────────────────────────────────────────────
// pickerMode=true: só seleção de arquivos/pasta — sem painel de agendamento
// onPick(videos): callback no modo picker
export default function DrivePicker({ accounts: allAccounts = [], onSchedule, onPick, onClose, inline = false, pickerMode = false }) {
  const drive = useDriveAuth();

  const [stack,    setStack]    = useState([{ id:"root", name:"Meu Drive" }]);
  const [folders,  setFolders]  = useState([]);
  const [videos,   setVideos]   = useState([]);
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [loadingFolder, setLoadingFolder] = useState(null); // id da pasta sendo carregada recursivamente

  // Configurações de agendamento
  const [postType,    setPostType]    = useState("REEL");
  const [caption,     setCaption]     = useState("");
  const [startTime,   setStartTime]   = useState(nowLocal(15));
  const [gapMinutes,  setGapMinutes]  = useState(60);
  const [jitterMin,   setJitterMin]   = useState(10);
  const [loop,        setLoop]        = useState(false);
  const [scheduling,  setScheduling]  = useState(false);

  // Seleção de contas — começa com todas selecionadas
  const [selectedAccIds, setSelectedAccIds] = useState(() => new Set((allAccounts||[]).map(a=>a.id)));

  // Sincroniza se allAccounts mudar
  useEffect(() => {
    setSelectedAccIds(prev => {
      const ids = new Set((allAccounts||[]).map(a=>a.id));
      // Remove contas que não existem mais
      const next = new Set([...prev].filter(id => ids.has(id)));
      // Se estava tudo selecionado antes e chegaram novas contas, seleciona as novas
      if (prev.size === 0 || prev.size >= ids.size - 1) return ids;
      return next;
    });
  }, [allAccounts]);

  const selectedAccounts = (allAccounts||[]).filter(a => selectedAccIds.has(a.id));

  const toggleAccount = (id) => {
    setSelectedAccIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };
  const selectAllAccounts  = () => setSelectedAccIds(new Set((allAccounts||[]).map(a=>a.id)));
  const selectNoneAccounts = () => setSelectedAccIds(new Set());

  const current = stack[stack.length - 1];

  const load = useCallback(async (folderId) => {
    setLoading(true); setError(null);
    try {
      const token = await drive.getValidToken();
      const res   = await fetch(`/api/drive-browse?folder=${encodeURIComponent(folderId)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (res.status === 401) { setError("Sessão expirada. Clique em Reconectar Drive."); return; }
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setFolders(data.folders || []);
      setVideos(data.videos   || []);
      setSelected(new Set());
    } catch (err) {
      if (err.message==="not_connected"||err.message==="token_expired") return;
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [drive.getValidToken]);

  useEffect(() => { if (drive.isConnected) load(current.id); }, [current.id, drive.isConnected]);

  function openFolder(folder) { setStack(s=>[...s,{id:folder.id,name:folder.name}]); }
  function goBack()           { if (stack.length>1) setStack(s=>s.slice(0,-1)); }

  // Seleciona todos os vídeos de uma pasta (recursivo)
  async function selectEntireFolder(folder) {
    setLoadingFolder(folder.id);
    try {
      const token = await drive.getValidToken();
      const allVideos = [];
      async function walk(folderId) {
        const res  = await fetch(`/api/drive-browse?folder=${encodeURIComponent(folderId)}`, { headers: { Authorization: `Bearer ${token}` } });
        const data = await res.json();
        if (!res.ok) return;
        for (const v of (data.videos || [])) allVideos.push(v);
        for (const f of (data.folders || [])) await walk(f.id);
      }
      await walk(folder.id);
      if (pickerMode && onPick && allVideos.length) {
        onPick(allVideos);
      } else {
        setSelected(prev => { const n = new Set(prev); allVideos.forEach(v => n.add(v.id)); return n; });
        // Adiciona os vídeos da pasta à lista local se não estiverem
        setVideos(prev => {
          const ids = new Set(prev.map(v => v.id));
          return [...prev, ...allVideos.filter(v => !ids.has(v.id))];
        });
      }
    } catch (err) {
      setError("Erro ao carregar pasta: " + err.message);
    } finally {
      setLoadingFolder(null);
    }
  }

  function toggleVideo(id) { setSelected(prev=>{const n=new Set(prev);n.has(id)?n.delete(id):n.add(id);return n;}); }
  function toggleAll()     { setSelected(selected.size===videos.length?new Set():new Set(videos.map(v=>v.id))); }

  async function handleSchedule() {
    if (!selected.size || !selectedAccounts.length) return;
    setScheduling(true); setError(null);
    try {
      const { refresh_token } = drive.tokenData || {};
      if (!refresh_token) { setError("Sessão do Drive sem refresh_token. Desconecte e reconecte o Drive."); return; }

      const chosenVideos = videos.filter(v=>selected.has(v.id));
      // startTime está em horário de Brasília — converter para UTC
      const startMs      = localInputToUTC(startTime);
      const gapMs        = gapMinutes * 60 * 1000;
      const jitterMs     = jitterMin * 60 * 1000;

      const items = chosenVideos.map((video, i) => {
        const jitter = i===0 ? 0 : Math.floor(Math.random()*(jitterMs*2+1))-jitterMs;
        return {
          id:                `drive-${video.id}-${Date.now()}-${i}`,
          status:            "pending",
          postType,
          mediaType:         "VIDEO",
          mediaUrl:          null,
          driveFileId:       video.id,
          driveName:         video.name,
          driveRefreshToken: refresh_token,
          caption,
          accounts:          selectedAccounts,
          scheduledAt:       startMs + i*gapMs + jitter,
          createdAt:         new Date().toISOString(),
          loop,
          source:            "google_drive",
        };
      });

      await onSchedule(items);
      if (!inline && onClose) onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setScheduling(false);
    }
  }

  // ─── Layout inline vs modal ───────────────────────────────────────────────
  const isModal = !inline;

  const content = (
    <>
      {/* Cabeçalho de navegação */}
      {drive.isConnected && (
        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:14,flexWrap:"wrap"}}>
          {stack.length>1 && <button onClick={goBack} className="btn btn-ghost btn-sm">← Voltar</button>}
          <div style={{display:"flex",alignItems:"center",gap:4,flex:1,fontSize:13,color:"var(--muted)",flexWrap:"wrap"}}>
            {stack.map((s,i) => (
              <span key={s.id}>
                {i>0 && <span style={{margin:"0 2px"}}>/</span>}
                <span style={{color:i===stack.length-1?"var(--text)":undefined,cursor:i<stack.length-1?"pointer":"default"}}
                  onClick={()=>i<stack.length-1&&setStack(stack.slice(0,i+1))}>
                  {s.name}
                </span>
              </span>
            ))}
          </div>
          <div style={{display:"flex",gap:6,alignItems:"center"}}>
            <span style={{fontSize:10,padding:"2px 8px",borderRadius:20,background:"rgba(34,197,94,0.12)",color:"var(--success)",border:"1px solid rgba(34,197,94,0.25)",whiteSpace:"nowrap"}}>✓ Drive conectado</span>
            <button onClick={()=>load(current.id)} className="btn btn-ghost btn-sm" style={{padding:"4px 8px"}} title="Recarregar">↻</button>
            <button onClick={drive.disconnect} className="btn btn-ghost btn-sm" style={{padding:"4px 8px",color:"var(--muted)",fontSize:11}} title="Desconectar Drive">✕</button>
          </div>
        </div>
      )}

      {/* Tela de conexão */}
      {!drive.isConnected && !drive.isExpired && <ConnectScreen drive={drive} onClose={onClose} inline={inline} />}
      {drive.isExpired && <ExpiredScreen drive={drive} onClose={onClose} inline={inline} />}

      {/* Conteúdo do Drive */}
      {drive.isConnected && (
        <>
          {loading && (
            <div style={{textAlign:"center",padding:40,color:"var(--muted)"}}>
              <span className="spinner" style={{width:20,height:20,display:"inline-block"}} />
              <div style={{marginTop:10,fontSize:13}}>Carregando...</div>
            </div>
          )}

          {error && (
            <div style={{padding:16,background:"rgba(239,68,68,0.1)",borderRadius:8,color:"var(--danger)",fontSize:13,marginBottom:8}}>
              <strong>Erro:</strong> {error}
              <button onClick={()=>load(current.id)} style={{marginLeft:12,fontSize:12,color:"var(--accent)",background:"none",border:"none",cursor:"pointer",textDecoration:"underline"}}>Tentar novamente</button>
            </div>
          )}

          {!loading && !error && (
            <>
              {folders.map(f => (
                <div key={f.id} style={{display:"flex",alignItems:"center",gap:10,padding:"9px 12px",borderRadius:8,cursor:"pointer",fontSize:14,transition:"background 0.1s"}}
                  onMouseEnter={e=>e.currentTarget.style.background="rgba(255,255,255,0.04)"}
                  onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                  <div style={{flex:1,display:"flex",alignItems:"center",gap:10}} onClick={()=>openFolder(f)}>
                    <IconFolder />
                    <span style={{flex:1}}>{f.name}</span>
                    <span style={{color:"var(--muted)",fontSize:12}}>▸</span>
                  </div>
                  {/* Botão de selecionar pasta inteira */}
                  <button
                    onClick={e=>{e.stopPropagation();selectEntireFolder(f);}}
                    disabled={loadingFolder===f.id}
                    title="Selecionar todos os vídeos desta pasta"
                    style={{fontSize:10,padding:"3px 8px",borderRadius:6,border:"1px solid rgba(124,92,252,0.3)",background:"rgba(124,92,252,0.08)",color:"var(--accent-light)",cursor:"pointer",whiteSpace:"nowrap",flexShrink:0}}
                  >
                    {loadingFolder===f.id ? "..." : pickerMode ? "📂 Usar pasta" : "+ pasta"}
                  </button>
                </div>
              ))}

              {folders.length>0 && videos.length>0 && <div style={{height:1,background:"var(--border)",margin:"8px 0"}} />}

              {videos.length>0 && (
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
                  <span style={{fontSize:12,color:"var(--muted)"}}>
                    {videos.length} vídeo{videos.length!==1?"s":""}
                    {selected.size>0&&` · ${selected.size} selecionado${selected.size!==1?"s":""}`}
                  </span>
                  <button onClick={toggleAll} className="btn btn-ghost btn-sm" style={{fontSize:12,padding:"3px 10px"}}>
                    {selected.size===videos.length?"Desmarcar todos":"Selecionar todos"}
                  </button>
                </div>
              )}

              {videos.map(v => {
                const isSel=selected.has(v.id);
                return (
                  <div key={v.id} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 10px",borderRadius:8,cursor:"pointer",fontSize:13,background:isSel?"rgba(124,58,237,0.12)":"transparent",border:isSel?"1px solid rgba(124,58,237,0.35)":"1px solid transparent"}}
                    onClick={()=>toggleVideo(v.id)}>
                    <div style={{width:20,height:20,borderRadius:5,border:`2px solid ${isSel?"var(--accent)":"var(--border)"}`,background:isSel?"var(--accent)":"transparent",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,transition:"all .15s"}}>
                      {isSel&&<IconCheck />}
                    </div>
                    {v.thumbnail
                      ? <img src={v.thumbnail} alt="" style={{width:52,height:36,objectFit:"cover",borderRadius:5,background:"var(--bg3)",flexShrink:0}} />
                      : <div style={{width:52,height:36,borderRadius:5,flexShrink:0,background:"var(--bg3)",display:"flex",alignItems:"center",justifyContent:"center"}}><IconVideo /></div>}
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontWeight:500,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{v.name}</div>
                      <div style={{fontSize:11,color:"var(--muted)",marginTop:2}}>{[fmtSize(v.size),fmtDuration(v.duration)].filter(Boolean).join(" · ")}</div>
                    </div>
                  </div>
                );
              })}

              {!loading&&folders.length===0&&videos.length===0 && (
                <div style={{textAlign:"center",padding:40,color:"var(--muted)",fontSize:13}}>Pasta vazia</div>
              )}

              {/* Botão confirmar seleção no modo picker */}
              {pickerMode && selected.size > 0 && (
                <div style={{padding:"12px 0 4px",borderTop:"1px solid var(--border)",marginTop:10}}>
                  <button
                    className="btn btn-primary"
                    style={{width:"100%"}}
                    onClick={() => {
                      const chosen = videos.filter(v => selected.has(v.id));
                      onPick?.(chosen);
                    }}
                  >
                    ✓ Usar {selected.size} vídeo{selected.size !== 1 ? "s" : ""} selecionado{selected.size !== 1 ? "s" : ""}
                  </button>
                </div>
              )}
            </>
          )}
        </>
      )}

      {/* ── Painel de configurações — aparece quando há vídeos selecionados e NÃO é pickerMode ── */}
      {drive.isConnected && selected.size>0 && !pickerMode && (
        <div style={{marginTop:20,padding:16,background:"var(--bg2)",borderRadius:12,border:"1px solid var(--border)",display:"flex",flexDirection:"column",gap:14}}>

          {/* Horário e intervalo */}
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(140px,1fr))",gap:10}}>
            <div>
              <div style={{fontSize:11,color:"var(--muted)",marginBottom:4}}>
                Início <span style={{color:"var(--accent-light)",fontWeight:600}}>(horário de Brasília)</span>
              </div>
              <input type="datetime-local" value={startTime} onChange={e=>setStartTime(e.target.value)}
                style={{background:"var(--bg)",color:"var(--fg)",border:"1px solid var(--border)",borderRadius:7,padding:"6px 10px",fontSize:13,width:"100%"}} />
              <div style={{fontSize:10,color:"var(--muted)",marginTop:3}}>
                🇧🇷 BRT (UTC-3) — padrão: agora + 15 min
              </div>
            </div>
            <div>
              <div style={{fontSize:11,color:"var(--muted)",marginBottom:4}}>Tipo de post</div>
              <select value={postType} onChange={e=>setPostType(e.target.value)} style={{background:"var(--bg)",color:"var(--fg)",border:"1px solid var(--border)",borderRadius:7,padding:"6px 10px",fontSize:13,width:"100%"}}>
                <option value="REEL">Reel</option>
                <option value="FEED">Feed (vídeo)</option>
                <option value="STORY">Story</option>
              </select>
            </div>
            <div>
              <div style={{fontSize:11,color:"var(--muted)",marginBottom:4}}>Intervalo entre posts</div>
              <select value={gapMinutes} onChange={e=>setGapMinutes(Number(e.target.value))} style={{background:"var(--bg)",color:"var(--fg)",border:"1px solid var(--border)",borderRadius:7,padding:"6px 10px",fontSize:13,width:"100%"}}>
                <option value={10}>10 min</option>
                <option value={30}>30 min</option>
                <option value={60}>1 hora</option>
                <option value={120}>2 horas</option>
                <option value={360}>6 horas</option>
                <option value={720}>12 horas</option>
                <option value={1440}>1 dia</option>
              </select>
            </div>
            <div>
              <div style={{fontSize:11,color:"var(--muted)",marginBottom:4}}>Variação (jitter)</div>
              <select value={jitterMin} onChange={e=>setJitterMin(Number(e.target.value))} style={{background:"var(--bg)",color:"var(--fg)",border:"1px solid var(--border)",borderRadius:7,padding:"6px 10px",fontSize:13,width:"100%"}}>
                <option value={0}>Sem variação</option>
                <option value={5}>± 5 min</option>
                <option value={10}>± 10 min</option>
                <option value={15}>± 15 min</option>
                <option value={20}>± 20 min</option>
                <option value={30}>± 30 min</option>
              </select>
            </div>
          </div>

          {/* Legenda */}
          <div>
            <div style={{fontSize:11,color:"var(--muted)",marginBottom:4}}>Legenda (opcional)</div>
            <textarea value={caption} onChange={e=>setCaption(e.target.value)} placeholder="Escreva a legenda dos posts..." rows={2}
              style={{background:"var(--bg)",color:"var(--fg)",border:"1px solid var(--border)",borderRadius:7,padding:"6px 10px",fontSize:13,width:"100%",resize:"vertical",fontFamily:"inherit"}} />
          </div>

          {/* ── Seleção de contas ── */}
          <div>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
              <div style={{fontWeight:600,fontSize:12}}>
                👥 Contas para postar
                <span style={{marginLeft:8,fontSize:11,color:"var(--accent-light)",fontWeight:400}}>
                  {selectedAccounts.length} de {(allAccounts||[]).length} selecionada{(allAccounts||[]).length!==1?"s":""}
                </span>
              </div>
              <div style={{display:"flex",gap:6}}>
                <button className="btn btn-ghost btn-xs" onClick={selectAllAccounts} style={{fontSize:11}}>✓ Todas</button>
                <button className="btn btn-ghost btn-xs" onClick={selectNoneAccounts} style={{fontSize:11}}>✕ Nenhuma</button>
              </div>
            </div>

            {(!allAccounts||allAccounts.length===0) ? (
              <div style={{padding:"10px 14px",borderRadius:8,background:"rgba(245,158,11,0.06)",border:"1px solid rgba(245,158,11,0.2)",fontSize:12,color:"var(--warning)"}}>
                ⚠️ Nenhuma conta conectada. Conecte contas primeiro em Contas.
              </div>
            ) : (
              <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(160px,1fr))",gap:7,maxHeight:220,overflowY:"auto",paddingRight:4}}>
                {(allAccounts||[]).map(acc => {
                  const isSel = selectedAccIds.has(acc.id);
                  return (
                    <div key={acc.id} onClick={()=>toggleAccount(acc.id)} style={{
                      padding:"7px 10px",borderRadius:8,cursor:"pointer",
                      background:isSel?"rgba(124,92,252,0.08)":"var(--bg3)",
                      border:`1px solid ${isSel?"var(--accent)":"var(--border)"}`,
                      display:"flex",alignItems:"center",gap:7,transition:"all 0.12s",
                      opacity:isSel?1:0.5,
                    }}>
                      {/* Checkbox */}
                      <div style={{width:15,height:15,borderRadius:4,flexShrink:0,border:`2px solid ${isSel?"var(--accent)":"var(--border2)"}`,background:isSel?"var(--accent)":"transparent",display:"flex",alignItems:"center",justifyContent:"center",transition:"all 0.12s"}}>
                        {isSel&&<span style={{color:"#fff",fontSize:9,fontWeight:900,lineHeight:1}}>✓</span>}
                      </div>
                      {/* Avatar */}
                      <div style={{width:22,height:22,borderRadius:"50%",flexShrink:0,overflow:"hidden",border:"1px solid var(--border2)"}}>
                        {acc.profile_picture
                          ? <img src={acc.profile_picture} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}} onError={e=>{e.target.style.display="none";}} />
                          : <div style={{width:"100%",height:"100%",background:"linear-gradient(135deg,var(--accent),#9b4dfc)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:9,fontWeight:700,color:"#fff"}}>
                              {(acc.nickname||acc.name||acc.username||"?")[0].toUpperCase()}
                            </div>}
                      </div>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{fontSize:11,fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                          {acc.nickname||acc.name||`@${acc.username}`}
                        </div>
                        <div style={{fontSize:9,color:"var(--muted)",marginTop:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>@{acc.username}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {selectedAccounts.length===0 && allAccounts?.length>0 && (
              <div style={{marginTop:8,padding:"6px 12px",borderRadius:7,background:"rgba(239,68,68,0.08)",border:"1px solid rgba(239,68,68,0.2)",fontSize:11,color:"var(--danger)"}}>
                ⚠️ Selecione pelo menos uma conta para agendar.
              </div>
            )}
          </div>

          {/* Resumo + ações */}
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,flexWrap:"wrap"}}>
            <div style={{display:"flex",alignItems:"center",gap:16,flexWrap:"wrap"}}>
              <div style={{fontSize:12,color:"var(--muted)"}}>
                <strong style={{color:"var(--fg)"}}>{selected.size}</strong> vídeo{selected.size!==1?"s":""} ·{" "}
                <strong style={{color:"var(--fg)"}}>{selectedAccounts.length}</strong> conta{selectedAccounts.length!==1?"s":""} ·{" "}
                início {new Date(localInputToUTC(startTime)).toLocaleString("pt-BR",{day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit",timeZone:"America/Sao_Paulo"})}
                {jitterMin>0&&<span style={{color:"var(--accent-light)"}}> · ±{jitterMin}min jitter</span>}
              </div>

              {/* Toggle loop */}
              <label style={{display:"flex",alignItems:"center",gap:7,cursor:"pointer",userSelect:"none",fontSize:12,color:loop?"var(--accent-light)":"var(--muted)",whiteSpace:"nowrap"}}>
                <div onClick={()=>setLoop(v=>!v)} style={{width:36,height:20,borderRadius:10,position:"relative",background:loop?"var(--accent)":"var(--bg3)",border:`1px solid ${loop?"var(--accent)":"var(--border)"}`,transition:"all 0.2s",cursor:"pointer",flexShrink:0}}>
                  <div style={{position:"absolute",top:2,left:loop?17:2,width:14,height:14,borderRadius:"50%",background:"#fff",transition:"left 0.2s"}} />
                </div>
                🔁 Loop diário
              </label>
            </div>

            <div style={{display:"flex",gap:8}}>
              {!inline && onClose && <button onClick={onClose} className="btn btn-ghost" disabled={scheduling}>Cancelar</button>}
              <button onClick={handleSchedule} className="btn btn-primary" disabled={scheduling||!selectedAccounts.length||!selected.size}>
                {scheduling ? "Agendando..." : `🚀 Agendar ${selected.size} vídeo${selected.size!==1?"s":""} → ${selectedAccounts.length} conta${selectedAccounts.length!==1?"s":""}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );

  // Modo inline: renderiza direto na página
  if (inline) {
    return <div style={{display:"flex",flexDirection:"column",gap:0}}>{content}</div>;
  }

  // Modo modal (legado — ainda usado em outros lugares)
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.65)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000,padding:16}} onClick={e=>e.target===e.currentTarget&&onClose?.()}>
      <div style={{background:"var(--bg2)",borderRadius:14,border:"1px solid var(--border2)",width:"100%",maxWidth:680,maxHeight:"90vh",display:"flex",flexDirection:"column",overflow:"hidden",boxShadow:"0 24px 64px rgba(0,0,0,0.6)"}}>
        <div style={{padding:"14px 18px",borderBottom:"1px solid var(--border)",display:"flex",alignItems:"center",gap:10}}>
          <span style={{fontWeight:600,color:"var(--fg)",fontSize:14}}>🗂 Google Drive</span>
          <div style={{flex:1}} />
          <button onClick={onClose} className="btn btn-ghost btn-sm" style={{padding:"4px 10px"}}>✕</button>
        </div>
        <div style={{flex:1,overflowY:"auto",padding:"12px 16px"}}>{content}</div>
      </div>
    </div>
  );
}
