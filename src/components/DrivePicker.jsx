// DrivePicker.jsx
// Navegador de pastas/vídeos do Google Drive com autenticação OAuth.
// Usa useDriveAuth para gerenciar o token — sem Service Account.

import { useState, useEffect, useCallback } from "react";
import { useDriveAuth } from "../useDriveAuth.js";

function fmtSize(bytes) {
  if (!bytes) return "";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtDuration(sec) {
  if (!sec) return "";
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

const IconFolder = () => <span style={{ fontSize: 20 }}>📁</span>;
const IconVideo  = () => <span style={{ fontSize: 18 }}>🎬</span>;
const IconCheck  = () => <span style={{ fontSize: 14, color: "var(--success)" }}>✓</span>;

// ─── Tela de conexão ──────────────────────────────────────────────────────────
function ConnectScreen({ drive, onClose }) {
  return (
    <div style={{ padding: "48px 32px", textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: 16 }}>
      <div style={{ fontSize: 52 }}>📂</div>
      <div style={{ fontWeight: 700, fontSize: 17 }}>Conectar Google Drive</div>
      <div style={{ fontSize: 13, color: "var(--muted)", maxWidth: 340, lineHeight: 1.6 }}>
        Conecte sua conta Google para navegar pelos seus vídeos e agendá-los diretamente da Fila.
        O acesso é somente leitura.
      </div>

      {drive.errorMsg && drive.status !== "connecting" && (
        <div style={{ padding: "10px 16px", borderRadius: 8, background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.25)", color: "var(--danger)", fontSize: 13, maxWidth: 340 }}>
          ⚠️ {drive.errorMsg}
        </div>
      )}

      <button
        onClick={drive.connect}
        disabled={drive.isConnecting}
        style={{
          display: "flex", alignItems: "center", gap: 10,
          padding: "11px 24px", borderRadius: 10,
          background: drive.isConnecting ? "var(--bg3)" : "#fff",
          color: "#3c4043", border: "1px solid #dadce0",
          fontWeight: 600, fontSize: 14, cursor: drive.isConnecting ? "not-allowed" : "pointer",
          boxShadow: "0 1px 3px rgba(0,0,0,0.2)", transition: "all 0.15s",
        }}
      >
        {drive.isConnecting ? (
          <><span className="spinner" style={{ width: 16, height: 16, borderTopColor: "var(--accent)" }} /> Aguardando login...</>
        ) : (
          <>
            {/* Logo do Google */}
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

      <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--muted)", fontSize: 13, cursor: "pointer", textDecoration: "underline" }}>
        Cancelar
      </button>
    </div>
  );
}

// ─── Tela de token expirado ───────────────────────────────────────────────────
function ExpiredScreen({ drive, onClose }) {
  return (
    <div style={{ padding: "40px 32px", textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: 14 }}>
      <div style={{ fontSize: 44 }}>🔄</div>
      <div style={{ fontWeight: 700, fontSize: 16 }}>Sessão do Drive expirada</div>
      <div style={{ fontSize: 13, color: "var(--muted)" }}>Reconecte para continuar navegando.</div>
      <div style={{ display: "flex", gap: 10 }}>
        <button onClick={drive.connect} className="btn btn-primary" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {drive.isConnecting ? <><span className="spinner" style={{ width: 12, height: 12, borderTopColor: "#fff" }} /> Aguardando...</> : "🔑 Reconectar Drive"}
        </button>
        <button onClick={drive.disconnect} className="btn btn-ghost btn-sm" style={{ color: "var(--danger)", borderColor: "rgba(239,68,68,0.3)" }}>
          Desconectar
        </button>
      </div>
      <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--muted)", fontSize: 12, cursor: "pointer", textDecoration: "underline" }}>Fechar</button>
    </div>
  );
}

// ─── Componente principal ─────────────────────────────────────────────────────
export default function DrivePicker({ accounts, onSchedule, onClose }) {
  const drive = useDriveAuth();

  const [stack,    setStack]    = useState([{ id: "root", name: "Meu Drive" }]);
  const [folders,  setFolders]  = useState([]);
  const [videos,   setVideos]   = useState([]);
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState(null);
  const [selected, setSelected] = useState(new Set());

  // Configurações de agendamento
  const [postType,   setPostType]   = useState("REEL");
  const [caption,    setCaption]    = useState("");
  const [startTime,  setStartTime]  = useState(() => {
    const d = new Date(); d.setMinutes(d.getMinutes() + 15, 0, 0);
    return d.toISOString().slice(0, 16);
  });
  const [gapMinutes, setGapMinutes] = useState(60);
  const [scheduling, setScheduling] = useState(false);

  const current = stack[stack.length - 1];

  const load = useCallback(async (folderId) => {
    setLoading(true); setError(null);
    try {
      const token = await drive.getValidToken();
      const res   = await fetch(`/api/drive-browse?folder=${encodeURIComponent(folderId)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (res.status === 401) {
        // Token rejeitado pela API (edge case — getValidToken já devia ter renovado)
        setError("Sessão expirada. Clique em Reconectar Drive.");
        return;
      }
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setFolders(data.folders || []);
      setVideos(data.videos   || []);
      setSelected(new Set());
    } catch (err) {
      if (err.message === "not_connected" || err.message === "token_expired") return; // mostra tela de conexão
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [drive.getValidToken]);

  // Carrega pasta quando conectado
  useEffect(() => {
    if (drive.isConnected) load(current.id);
  }, [current.id, drive.isConnected]);

  function openFolder(folder) { setStack((s) => [...s, { id: folder.id, name: folder.name }]); }
  function goBack()           { if (stack.length > 1) setStack((s) => s.slice(0, -1)); }

  function toggleVideo(id) {
    setSelected((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }
  function toggleAll() {
    setSelected(selected.size === videos.length ? new Set() : new Set(videos.map((v) => v.id)));
  }

  async function handleSchedule() {
    if (!selected.size || !accounts?.length) return;
    setScheduling(true);
    const chosenVideos = videos.filter((v) => selected.has(v.id));
    const startMs      = new Date(startTime).getTime();
    const gapMs        = gapMinutes * 60 * 1000;
    const items = chosenVideos.map((video, i) => ({
      id:          `drive-${video.id}-${Date.now()}-${i}`,
      status:      "pending",
      postType,
      mediaType:   "VIDEO",
      mediaUrl:    video.url,
      caption,
      accounts,
      scheduledAt: startMs + i * gapMs,
      createdAt:   new Date().toISOString(),
      loop:        false,
      source:      "google_drive",
      driveFileId: video.id,
      driveName:   video.name,
    }));
    await onSchedule(items);
    setScheduling(false);
    onClose();
  }

  // ─── Estilos compartilhados ───────────────────────────────────────────────
  const st = {
    overlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 16 },
    modal:   { background: "var(--bg2)", borderRadius: 14, border: "1px solid var(--border2)", width: "100%", maxWidth: 680, maxHeight: "90vh", display: "flex", flexDirection: "column", overflow: "hidden", boxShadow: "0 24px 64px rgba(0,0,0,0.6)" },
    header:  { padding: "14px 18px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 10 },
    body:    { flex: 1, overflowY: "auto", padding: "12px 16px" },
    footer:  { padding: "14px 20px", borderTop: "1px solid var(--border)", display: "flex", flexDirection: "column", gap: 12 },
    badge:   { display: "inline-flex", alignItems: "center", justifyContent: "center", width: 20, height: 20, borderRadius: 5, border: "2px solid var(--border)", flexShrink: 0, background: "transparent", transition: "all .15s" },
    thumb:   { width: 52, height: 36, objectFit: "cover", borderRadius: 5, background: "var(--bg3)", flexShrink: 0 },
    thumbPh: { width: 52, height: 36, borderRadius: 5, flexShrink: 0, background: "var(--bg3)", display: "flex", alignItems: "center", justifyContent: "center" },
    label:   { fontSize: 12, color: "var(--muted)", marginBottom: 4 },
    select:  { background: "var(--bg)", color: "var(--fg)", border: "1px solid var(--border)", borderRadius: 7, padding: "6px 10px", fontSize: 13, flex: 1 },
    input:   { background: "var(--bg)", color: "var(--fg)", border: "1px solid var(--border)", borderRadius: 7, padding: "6px 10px", fontSize: 13, width: "100%" },
  };

  return (
    <div style={st.overlay} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div style={st.modal}>

        {/* Cabeçalho */}
        <div style={st.header}>
          {drive.isConnected && stack.length > 1 && (
            <button onClick={goBack} className="btn btn-ghost btn-sm">← Voltar</button>
          )}
          <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, fontSize: 13, color: "var(--muted)", flexWrap: "wrap" }}>
            {drive.isConnected ? (
              stack.map((s, i) => (
                <span key={s.id}>
                  {i > 0 && <span style={{ margin: "0 2px" }}>/</span>}
                  <span
                    style={{ color: i === stack.length - 1 ? "var(--fg)" : undefined, cursor: i < stack.length - 1 ? "pointer" : "default" }}
                    onClick={() => i < stack.length - 1 && setStack(stack.slice(0, i + 1))}
                  >{s.name}</span>
                </span>
              ))
            ) : (
              <span style={{ fontWeight: 600, color: "var(--fg)", fontSize: 14 }}>🗂 Google Drive</span>
            )}
          </div>

          {/* Status de conexão + botão de reconectar/desconectar */}
          {drive.isConnected && (
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 20, background: "rgba(34,197,94,0.12)", color: "var(--success)", border: "1px solid rgba(34,197,94,0.25)", whiteSpace: "nowrap" }}>
                ✓ Drive conectado
              </span>
              <button onClick={() => load(current.id)} className="btn btn-ghost btn-sm" style={{ padding: "4px 8px" }} title="Recarregar">↻</button>
              <button onClick={drive.disconnect} className="btn btn-ghost btn-sm" style={{ padding: "4px 8px", color: "var(--muted)", fontSize: 11 }} title="Desconectar Drive">✕</button>
            </div>
          )}

          <button onClick={onClose} className="btn btn-ghost btn-sm" style={{ padding: "4px 10px" }}>✕</button>
        </div>

        {/* Conteúdo */}
        <div style={st.body}>
          {/* Tela de conexão */}
          {!drive.isConnected && !drive.isExpired && (
            <ConnectScreen drive={drive} onClose={onClose} />
          )}

          {/* Tela de token expirado */}
          {drive.isExpired && (
            <ExpiredScreen drive={drive} onClose={onClose} />
          )}

          {/* Conteúdo do Drive */}
          {drive.isConnected && (
            <>
              {loading && (
                <div style={{ textAlign: "center", padding: 40, color: "var(--muted)" }}>
                  <span className="spinner" style={{ width: 20, height: 20, display: "inline-block" }} />
                  <div style={{ marginTop: 10, fontSize: 13 }}>Carregando...</div>
                </div>
              )}

              {error && (
                <div style={{ padding: 16, background: "rgba(239,68,68,0.1)", borderRadius: 8, color: "var(--danger)", fontSize: 13, marginBottom: 8 }}>
                  <strong>Erro:</strong> {error}
                  <button onClick={() => load(current.id)} style={{ marginLeft: 12, fontSize: 12, color: "var(--accent)", background: "none", border: "none", cursor: "pointer", textDecoration: "underline" }}>
                    Tentar novamente
                  </button>
                </div>
              )}

              {!loading && !error && (
                <>
                  {/* Pastas */}
                  {folders.map((f) => (
                    <div key={f.id}
                      style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", borderRadius: 8, cursor: "pointer", fontSize: 14 }}
                      onMouseEnter={(e) => e.currentTarget.style.background = "rgba(255,255,255,0.04)"}
                      onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}
                      onClick={() => openFolder(f)}
                    >
                      <IconFolder />
                      <span style={{ flex: 1 }}>{f.name}</span>
                      <span style={{ color: "var(--muted)", fontSize: 12 }}>▸</span>
                    </div>
                  ))}

                  {folders.length > 0 && videos.length > 0 && (
                    <div style={{ height: 1, background: "var(--border)", margin: "8px 0" }} />
                  )}

                  {videos.length > 0 && (
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                      <span style={{ fontSize: 12, color: "var(--muted)" }}>
                        {videos.length} vídeo{videos.length !== 1 ? "s" : ""}
                        {selected.size > 0 && ` · ${selected.size} selecionado${selected.size !== 1 ? "s" : ""}`}
                      </span>
                      <button onClick={toggleAll} className="btn btn-ghost btn-sm" style={{ fontSize: 12, padding: "3px 10px" }}>
                        {selected.size === videos.length ? "Desmarcar todos" : "Selecionar todos"}
                      </button>
                    </div>
                  )}

                  {videos.map((v) => {
                    const isSel = selected.has(v.id);
                    return (
                      <div key={v.id}
                        style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", borderRadius: 8, cursor: "pointer", fontSize: 13,
                          background: isSel ? "rgba(124,58,237,0.12)" : "transparent",
                          border: isSel ? "1px solid rgba(124,58,237,0.35)" : "1px solid transparent" }}
                        onClick={() => toggleVideo(v.id)}
                      >
                        <div style={{ ...st.badge, background: isSel ? "var(--accent)" : "transparent", borderColor: isSel ? "var(--accent)" : "var(--border)" }}>
                          {isSel && <IconCheck />}
                        </div>
                        {v.thumbnail
                          ? <img src={v.thumbnail} alt="" style={st.thumb} />
                          : <div style={st.thumbPh}><IconVideo /></div>
                        }
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{v.name}</div>
                          <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
                            {[fmtSize(v.size), fmtDuration(v.duration)].filter(Boolean).join(" · ")}
                          </div>
                        </div>
                      </div>
                    );
                  })}

                  {!loading && folders.length === 0 && videos.length === 0 && (
                    <div style={{ textAlign: "center", padding: 40, color: "var(--muted)", fontSize: 13 }}>Pasta vazia</div>
                  )}
                </>
              )}
            </>
          )}
        </div>

        {/* Footer de agendamento — só aparece quando há vídeos selecionados */}
        {drive.isConnected && selected.size > 0 && (
          <div style={st.footer}>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <div style={{ flex: 1, minWidth: 120 }}>
                <div style={st.label}>Tipo de post</div>
                <select value={postType} onChange={(e) => setPostType(e.target.value)} style={st.select}>
                  <option value="REEL">Reel</option>
                  <option value="FEED">Feed (vídeo)</option>
                  <option value="STORY">Story</option>
                </select>
              </div>
              <div style={{ flex: 1, minWidth: 120 }}>
                <div style={st.label}>Intervalo entre posts</div>
                <select value={gapMinutes} onChange={(e) => setGapMinutes(Number(e.target.value))} style={st.select}>
                  <option value={10}>10 min</option>
                  <option value={30}>30 min</option>
                  <option value={60}>1 hora</option>
                  <option value={120}>2 horas</option>
                  <option value={360}>6 horas</option>
                  <option value={720}>12 horas</option>
                  <option value={1440}>1 dia</option>
                </select>
              </div>
              <div style={{ flex: 1, minWidth: 160 }}>
                <div style={st.label}>Início do agendamento</div>
                <input type="datetime-local" value={startTime} onChange={(e) => setStartTime(e.target.value)} style={st.input} />
              </div>
            </div>

            <div>
              <div style={st.label}>Legenda (opcional)</div>
              <textarea value={caption} onChange={(e) => setCaption(e.target.value)}
                placeholder="Escreva a legenda dos posts..." rows={2}
                style={{ ...st.input, resize: "vertical", fontFamily: "inherit" }} />
            </div>

            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
              <div style={{ fontSize: 12, color: "var(--muted)" }}>
                <strong style={{ color: "var(--fg)" }}>{selected.size}</strong> vídeo{selected.size !== 1 ? "s" : ""} ·{" "}
                <strong style={{ color: "var(--fg)" }}>{accounts?.length || 0}</strong> conta{accounts?.length !== 1 ? "s" : ""} ·{" "}
                início {new Date(startTime).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={onClose} className="btn btn-ghost" disabled={scheduling}>Cancelar</button>
                <button onClick={handleSchedule} className="btn btn-primary" disabled={scheduling || !accounts?.length}>
                  {scheduling ? "Agendando..." : `Agendar ${selected.size} vídeo${selected.size !== 1 ? "s" : ""}`}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
