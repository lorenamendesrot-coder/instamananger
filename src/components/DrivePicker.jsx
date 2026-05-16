// DrivePicker.jsx
// Navegador de pastas/vídeos do Google Drive integrado ao agendador.
import { useState, useEffect, useCallback } from "react";

const API = "/api/drive-browse";

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

// ─── Ícones inline ────────────────────────────────────────────────────────────
const IconFolder  = () => <span style={{ fontSize: 20 }}>📁</span>;
const IconVideo   = () => <span style={{ fontSize: 18 }}>🎬</span>;
const IconBack    = () => <span style={{ fontSize: 16 }}>←</span>;
const IconCheck   = () => <span style={{ fontSize: 14, color: "var(--success)" }}>✓</span>;
const IconRefresh = () => <span style={{ fontSize: 15 }}>↻</span>;

// ─── Componente principal ─────────────────────────────────────────────────────
export default function DrivePicker({ accounts, onSchedule, onClose }) {
  const [stack,    setStack]    = useState([{ id: "root", name: "Meu Drive" }]);
  const [folders,  setFolders]  = useState([]);
  const [videos,   setVideos]   = useState([]);
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState(null);
  const [selected, setSelected] = useState(new Set()); // IDs de vídeos selecionados

  // Configurações de agendamento
  const [postType,    setPostType]    = useState("REEL");
  const [caption,     setCaption]     = useState("");
  const [startTime,   setStartTime]   = useState(() => {
    const d = new Date(); d.setMinutes(d.getMinutes() + 15, 0, 0);
    return d.toISOString().slice(0, 16);
  });
  const [gapMinutes,  setGapMinutes]  = useState(60);
  const [scheduling,  setScheduling]  = useState(false);

  const current = stack[stack.length - 1];

  const load = useCallback(async (folderId) => {
    setLoading(true); setError(null);
    try {
      const res  = await fetch(`${API}?folder=${encodeURIComponent(folderId)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setFolders(data.folders || []);
      setVideos(data.videos   || []);
      setSelected(new Set());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(current.id); }, [current.id]);

  function openFolder(folder) {
    setStack((s) => [...s, { id: folder.id, name: folder.name }]);
  }

  function goBack() {
    if (stack.length <= 1) return;
    setStack((s) => s.slice(0, -1));
  }

  function toggleVideo(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (selected.size === videos.length) setSelected(new Set());
    else setSelected(new Set(videos.map((v) => v.id)));
  }

  async function handleSchedule() {
    if (!selected.size)    return;
    if (!accounts?.length) return;
    setScheduling(true);

    const chosenVideos = videos.filter((v) => selected.has(v.id));
    const startMs      = new Date(startTime).getTime();
    const gapMs        = gapMinutes * 60 * 1000;

    // Cria um item de fila por vídeo, espaçados pelo gap definido
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

  // ─── Render ──────────────────────────────────────────────────────────────────
  const st = {
    overlay: {
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)",
      display: "flex", alignItems: "center", justifyContent: "center",
      zIndex: 1000, padding: 16,
    },
    modal: {
      background: "var(--bg-card, #1e1e2e)", borderRadius: 14,
      border: "1px solid var(--border, #333)",
      width: "100%", maxWidth: 680, maxHeight: "90vh",
      display: "flex", flexDirection: "column", overflow: "hidden",
    },
    header: {
      padding: "16px 20px", borderBottom: "1px solid var(--border, #333)",
      display: "flex", alignItems: "center", gap: 10,
    },
    breadcrumb: {
      display: "flex", alignItems: "center", gap: 6, flex: 1,
      fontSize: 13, color: "var(--text-muted, #888)", flexWrap: "wrap",
    },
    body: { flex: 1, overflowY: "auto", padding: "12px 16px" },
    footer: {
      padding: "14px 20px", borderTop: "1px solid var(--border, #333)",
      display: "flex", flexDirection: "column", gap: 12,
    },
    folderRow: {
      display: "flex", alignItems: "center", gap: 10, padding: "9px 12px",
      borderRadius: 8, cursor: "pointer", transition: "background .15s",
      fontSize: 14,
    },
    videoRow: {
      display: "flex", alignItems: "center", gap: 10, padding: "8px 10px",
      borderRadius: 8, cursor: "pointer", transition: "background .15s",
      fontSize: 13,
    },
    thumb: {
      width: 52, height: 36, objectFit: "cover", borderRadius: 5,
      background: "var(--bg, #111)", flexShrink: 0,
    },
    thumbPlaceholder: {
      width: 52, height: 36, borderRadius: 5, flexShrink: 0,
      background: "var(--bg, #111)", display: "flex",
      alignItems: "center", justifyContent: "center",
    },
    badge: {
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      width: 20, height: 20, borderRadius: 5, border: "2px solid var(--border, #555)",
      flexShrink: 0, background: "transparent", transition: "all .15s",
    },
    row2: { display: "flex", gap: 10, flexWrap: "wrap" },
    label: { fontSize: 12, color: "var(--text-muted, #888)", marginBottom: 4 },
    select: {
      background: "var(--bg, #111)", color: "var(--text, #eee)",
      border: "1px solid var(--border, #444)", borderRadius: 7,
      padding: "6px 10px", fontSize: 13, flex: 1,
    },
    input: {
      background: "var(--bg, #111)", color: "var(--text, #eee)",
      border: "1px solid var(--border, #444)", borderRadius: 7,
      padding: "6px 10px", fontSize: 13, width: "100%",
    },
    btnPrimary: {
      background: "var(--accent, #7c3aed)", color: "#fff",
      border: "none", borderRadius: 8, padding: "9px 20px",
      fontWeight: 600, fontSize: 14, cursor: "pointer",
    },
    btnGhost: {
      background: "transparent", color: "var(--text-muted, #888)",
      border: "1px solid var(--border, #444)", borderRadius: 8,
      padding: "8px 16px", fontSize: 13, cursor: "pointer",
    },
  };

  return (
    <div style={st.overlay} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div style={st.modal}>

        {/* Cabeçalho + breadcrumb */}
        <div style={st.header}>
          {stack.length > 1 && (
            <button onClick={goBack} style={{ ...st.btnGhost, padding: "5px 10px" }}>
              <IconBack /> Voltar
            </button>
          )}
          <div style={st.breadcrumb}>
            {stack.map((s, i) => (
              <span key={s.id}>
                {i > 0 && <span style={{ margin: "0 2px" }}>/</span>}
                <span
                  style={{ color: i === stack.length - 1 ? "var(--text, #eee)" : undefined, cursor: i < stack.length - 1 ? "pointer" : "default" }}
                  onClick={() => i < stack.length - 1 && setStack(stack.slice(0, i + 1))}
                >
                  {s.name}
                </span>
              </span>
            ))}
          </div>
          <button onClick={() => load(current.id)} style={{ ...st.btnGhost, padding: "5px 10px" }} title="Recarregar">
            <IconRefresh />
          </button>
          <button onClick={onClose} style={{ ...st.btnGhost, padding: "5px 12px" }}>✕</button>
        </div>

        {/* Conteúdo */}
        <div style={st.body}>
          {loading && (
            <div style={{ textAlign: "center", padding: 40, color: "var(--text-muted, #888)" }}>
              Carregando...
            </div>
          )}

          {error && (
            <div style={{ padding: 16, background: "rgba(239,68,68,0.1)", borderRadius: 8, color: "var(--danger, #f87171)", fontSize: 13 }}>
              <strong>Erro:</strong> {error}
              {error.includes("GOOGLE_SERVICE_ACCOUNT") && (
                <div style={{ marginTop: 8, fontSize: 12, opacity: .85 }}>
                  Configure a variável <code>GOOGLE_SERVICE_ACCOUNT</code> no Netlify com o JSON da sua Service Account.
                </div>
              )}
            </div>
          )}

          {!loading && !error && (
            <>
              {/* Pastas */}
              {folders.map((f) => (
                <div
                  key={f.id}
                  style={st.folderRow}
                  onMouseEnter={(e) => e.currentTarget.style.background = "var(--bg-hover, rgba(255,255,255,0.05)"}
                  onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}
                  onClick={() => openFolder(f)}
                >
                  <IconFolder />
                  <span style={{ flex: 1 }}>{f.name}</span>
                  <span style={{ color: "var(--text-muted, #888)", fontSize: 12 }}>▸</span>
                </div>
              ))}

              {/* Divisor se tem os dois */}
              {folders.length > 0 && videos.length > 0 && (
                <div style={{ height: 1, background: "var(--border, #333)", margin: "8px 0" }} />
              )}

              {/* Seleção de vídeos */}
              {videos.length > 0 && (
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                  <span style={{ fontSize: 12, color: "var(--text-muted, #888)" }}>
                    {videos.length} vídeo{videos.length !== 1 ? "s" : ""}
                    {selected.size > 0 && ` · ${selected.size} selecionado${selected.size !== 1 ? "s" : ""}`}
                  </span>
                  <button onClick={toggleAll} style={{ ...st.btnGhost, padding: "3px 10px", fontSize: 12 }}>
                    {selected.size === videos.length ? "Desmarcar todos" : "Selecionar todos"}
                  </button>
                </div>
              )}

              {videos.map((v) => {
                const isSelected = selected.has(v.id);
                return (
                  <div
                    key={v.id}
                    style={{
                      ...st.videoRow,
                      background: isSelected ? "rgba(124,58,237,0.12)" : "transparent",
                      border: isSelected ? "1px solid rgba(124,58,237,0.35)" : "1px solid transparent",
                    }}
                    onClick={() => toggleVideo(v.id)}
                  >
                    {/* Badge seleção */}
                    <div style={{
                      ...st.badge,
                      background: isSelected ? "var(--accent, #7c3aed)" : "transparent",
                      borderColor: isSelected ? "var(--accent, #7c3aed)" : "var(--border, #555)",
                    }}>
                      {isSelected && <IconCheck />}
                    </div>

                    {/* Thumbnail */}
                    {v.thumbnail
                      ? <img src={v.thumbnail} alt="" style={st.thumb} />
                      : <div style={st.thumbPlaceholder}><IconVideo /></div>
                    }

                    {/* Nome e infos */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {v.name}
                      </div>
                      <div style={{ fontSize: 11, color: "var(--text-muted, #888)", marginTop: 2 }}>
                        {[fmtSize(v.size), fmtDuration(v.duration)].filter(Boolean).join(" · ")}
                      </div>
                    </div>
                  </div>
                );
              })}

              {!loading && folders.length === 0 && videos.length === 0 && (
                <div style={{ textAlign: "center", padding: 40, color: "var(--text-muted, #888)", fontSize: 13 }}>
                  Pasta vazia
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer: opções de agendamento */}
        {selected.size > 0 && (
          <div style={st.footer}>
            <div style={st.row2}>
              {/* Tipo de post */}
              <div style={{ flex: 1, minWidth: 120 }}>
                <div style={st.label}>Tipo de post</div>
                <select value={postType} onChange={(e) => setPostType(e.target.value)} style={st.select}>
                  <option value="REEL">Reel</option>
                  <option value="FEED">Feed (vídeo)</option>
                  <option value="STORY">Story</option>
                </select>
              </div>

              {/* Gap entre posts */}
              <div style={{ flex: 1, minWidth: 120 }}>
                <div style={st.label}>Intervalo entre posts</div>
                <select value={gapMinutes} onChange={(e) => setGapMinutes(Number(e.target.value))} style={st.select}>
                  <option value={10}>10 minutos</option>
                  <option value={30}>30 minutos</option>
                  <option value={60}>1 hora</option>
                  <option value={120}>2 horas</option>
                  <option value={360}>6 horas</option>
                  <option value={720}>12 horas</option>
                  <option value={1440}>1 dia</option>
                </select>
              </div>

              {/* Horário inicial */}
              <div style={{ flex: 1, minWidth: 160 }}>
                <div style={st.label}>Início do agendamento</div>
                <input
                  type="datetime-local"
                  value={startTime}
                  onChange={(e) => setStartTime(e.target.value)}
                  style={st.input}
                />
              </div>
            </div>

            {/* Legenda */}
            <div>
              <div style={st.label}>Legenda (opcional)</div>
              <textarea
                value={caption}
                onChange={(e) => setCaption(e.target.value)}
                placeholder="Escreva a legenda dos posts..."
                rows={2}
                style={{ ...st.input, resize: "vertical", fontFamily: "inherit" }}
              />
            </div>

            {/* Resumo + botão */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
              <div style={{ fontSize: 12, color: "var(--text-muted, #888)" }}>
                <strong style={{ color: "var(--text, #eee)" }}>{selected.size}</strong> vídeo{selected.size !== 1 ? "s" : ""} ·{" "}
                <strong style={{ color: "var(--text, #eee)" }}>{accounts?.length || 0}</strong> conta{accounts?.length !== 1 ? "s" : ""} ·{" "}
                início {new Date(startTime).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={onClose} style={st.btnGhost} disabled={scheduling}>Cancelar</button>
                <button onClick={handleSchedule} style={st.btnPrimary} disabled={scheduling || !accounts?.length}>
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
