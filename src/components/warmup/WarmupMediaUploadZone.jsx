// WarmupMediaUploadZone.jsx — mídias por URL ou Google Drive
import { useState, useCallback, useRef } from "react";
import DrivePicker from "../DrivePicker.jsx";
import { useDriveAuth } from "../../useDriveAuth.js";

// ── Transcodagem para padrão Instagram (H.264/AAC/faststart) ──────────────────
let _ffmpegInstance = null;
async function getFFmpeg() {
  if (_ffmpegInstance) return _ffmpegInstance;
  const { FFmpeg } = await import("@ffmpeg/ffmpeg");
  const ff = new FFmpeg();
  await ff.load({
    coreURL:   "/ffmpeg/ffmpeg-core.js",
    wasmURL:   "/ffmpeg/ffmpeg-core.wasm",
    workerURL: "/ffmpeg/ffmpeg-core.worker.js",
  });
  _ffmpegInstance = ff;
  return ff;
}

async function transcodeForInstagram(arrayBuffer, fileName, onProgress) {
  // Só transcoda vídeos — imagens passam direto
  if (!/\.(mp4|mov|avi|mkv|webm|m4v)$/i.test(fileName)) return arrayBuffer;

  onProgress?.("transcoding");
  const ff   = await getFFmpeg();
  const ext  = fileName.split(".").pop();
  const inF  = `in_${Date.now()}.${ext}`;
  const outF = `out_${Date.now()}.mp4`;

  ff.on("progress", ({ progress }) => onProgress?.("transcoding", Math.round(progress * 100)));

  await ff.writeFile(inF, new Uint8Array(arrayBuffer));
  await ff.exec([
    "-i", inF,
    "-vcodec", "libx264", "-profile:v", "main", "-level", "4.0",
    "-acodec", "aac", "-ar", "48000", "-b:a", "128k",
    "-movflags", "+faststart",
    "-crf", "23",
    "-preset", "fast",
    "-y", outF,
  ]);

  const data = await ff.readFile(outF);
  await ff.deleteFile(inF).catch(() => {});
  await ff.deleteFile(outF).catch(() => {});

  return data.buffer;
}
// ─────────────────────────────────────────────────────────────────────────────

const MEDIA_ACCEPT = "video/*,image/*";
const MEDIA_EXTS   = /\.(mp4|mov|avi|mkv|webm|m4v|jpg|jpeg|png|webp|gif|heic|heif)$/i;

function isMediaFile(file) {
  return file.type.startsWith("video/") || file.type.startsWith("image/") || MEDIA_EXTS.test(file.name);
}

// Upload para catbox.moe (sem autenticação, gratuito)
async function uploadToCatbox(file, onProgress) {
  const form = new FormData();
  form.append("reqtype", "fileupload");
  form.append("userhash", "");
  form.append("fileToUpload", file);

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "https://catbox.moe/user.php");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 95));
    };
    xhr.onload = () => {
      if (xhr.status === 200 && xhr.responseText.startsWith("https://")) {
        onProgress(100);
        resolve(xhr.responseText.trim());
      } else {
        reject(new Error("Falha no upload: " + xhr.responseText.slice(0, 80)));
      }
    };
    xhr.onerror = () => reject(new Error("Erro de rede ao fazer upload"));
    xhr.send(form);
  });
}

export default function MediaUploadZone({ typeConfig, files, onAddFiles, onRemoveFile, onRemoveAll, urlInput, onUrlInputChange, onAddUrl, onUpdateFile }) {
  const [showBulkUrl, setShowBulkUrl] = useState(false);
  const [showDrive, setShowDrive]     = useState(false);
  const [dragging, setDragging]       = useState(false);
  const [uploading, setUploading]     = useState({}); // fileId → progress
  const abortRef  = useRef(false);
  const IMPORT_KEY = `driveImport_${typeConfig.id}`;
  const [driveImportState, setDriveImportState] = useState(() => {
    try { return JSON.parse(localStorage.getItem(IMPORT_KEY) || "null"); } catch { return null; }
  });
  const driveImporting = driveImportState?.active === true;
  const driveImportError = driveImportState?.error || null;

  // Helpers para atualizar estado e persistir no localStorage
  function setImportProgress(current, total, currentName, stage) {
    const s = { active: true, current, total, currentName, stage: stage || null };
    setDriveImportState(s);
    try { localStorage.setItem(IMPORT_KEY, JSON.stringify(s)); } catch {}
  }
  function setImportDone() {
    try { localStorage.removeItem(IMPORT_KEY); } catch {}
    setDriveImportState(null);
  }
  function setImportError(msg) {
    const s = { active: false, error: msg };
    setDriveImportState(s);
    try { localStorage.setItem(IMPORT_KEY, JSON.stringify(s)); } catch {}
  }
  function clearImportError() {
    setDriveImportState(null);
    try { localStorage.removeItem(IMPORT_KEY); } catch {}
  }
  function cancelImport() {
    abortRef.current = true;
    try { localStorage.removeItem(IMPORT_KEY); } catch {}
    setDriveImportState(null);
  }
  const drive = useDriveAuth();

  const myFiles = files[typeConfig.id] || [];
  const done    = myFiles.filter((f) => f.status === "done");
  const idle    = myFiles.filter((f) => f.status === "idle");
  const total   = myFiles.length;

  const handleAddUrl = () => {
    const urls = (urlInput || "").split(/[\n,]/).map((u) => u.trim()).filter((u) => u.startsWith("http"));
    if (!urls.length) return;
    onAddUrl(typeConfig.id, urls);
    onUrlInputChange(typeConfig.id, "");
    setShowBulkUrl(false);
  };

  const handleFilesSelected = (rawFiles) => {
    const mediaOnly = Array.from(rawFiles).filter(isMediaFile);
    if (!mediaOnly.length) return;
    onAddFiles(typeConfig.id, mediaOnly);
  };

  const uploadAll = useCallback(async () => {
    const idleFiles = (files[typeConfig.id] || []).filter((f) => f.status === "idle" && f.file);
    if (!idleFiles.length) return;
    setUploading((p) => Object.fromEntries(idleFiles.map((f) => [f.id, 0])));

    for (const entry of idleFiles) {
      try {
        onUpdateFile?.(typeConfig.id, entry.id, { status: "uploading", progress: 0 });
        const url = await uploadToCatbox(entry.file, (pct) => {
          setUploading((p) => ({ ...p, [entry.id]: pct }));
          onUpdateFile?.(typeConfig.id, entry.id, { progress: pct });
        });
        onUpdateFile?.(typeConfig.id, entry.id, { status: "done", url, progress: 100 });
      } catch (err) {
        onUpdateFile?.(typeConfig.id, entry.id, { status: "error", error: err.message, progress: 0 });
      }
      setUploading((p) => { const n = { ...p }; delete n[entry.id]; return n; });
    }
  }, [files, typeConfig.id, onUpdateFile]);

  const urlCount = (urlInput || "").split(/[\n,]/).filter((u) => u.trim().startsWith("http")).length;
  const isUploading = Object.keys(uploading).length > 0;

  return (
    <div style={{ marginBottom: 4 }}>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <span style={{ fontSize: 18 }}>{typeConfig.icon}</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 700, fontSize: 13 }}>{typeConfig.label}</div>
          <div style={{ fontSize: 11, color: "var(--muted)" }}>{typeConfig.hint}</div>
        </div>
        <span style={{
          fontSize: 12, fontWeight: 700, padding: "2px 8px", borderRadius: 20,
          background: done.length > 0 && done.length === total && total > 0
            ? "rgba(34,197,94,0.15)" : "var(--bg4)",
          color: done.length > 0 && done.length === total && total > 0
            ? "var(--success)" : "var(--muted)",
          border: `1px solid ${done.length === total && total > 0 ? "rgba(34,197,94,0.3)" : "var(--border)"}`,
          minWidth: 36, textAlign: "center",
        }}>
          {done.length}/{total || 0}
        </span>
      </div>

      {/* Botões de seleção */}
      <div style={{ display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
        <button
          className="btn btn-ghost btn-sm"
          style={{ flex: "1 1 auto", color: showDrive ? "var(--accent-light)" : undefined }}
          onClick={() => { setShowDrive((p) => !p); setShowBulkUrl(false); }}
          title="Selecionar do Google Drive"
        >
          <svg width="13" height="13" viewBox="0 0 48 48" style={{ display: "inline", verticalAlign: "middle", marginRight: 5 }}>
            <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.2l6.7-6.7C35.8 2.2 30.3 0 24 0 14.6 0 6.6 5.4 2.6 13.3l7.8 6C12.2 13 17.7 9.5 24 9.5z"/>
            <path fill="#4285F4" d="M46.6 24.5c0-1.6-.1-3.1-.4-4.5H24v8.5h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8c4.4-4 6.9-10 6.9-17z"/>
            <path fill="#FBBC05" d="M10.4 28.7A14.6 14.6 0 0 1 9.5 24c0-1.6.3-3.2.9-4.7L2.6 13.3A23.9 23.9 0 0 0 0 24c0 3.8.9 7.4 2.6 10.6l7.8-5.9z"/>
            <path fill="#34A853" d="M24 48c6.3 0 11.6-2.1 15.5-5.6l-7.5-5.8c-2.1 1.4-4.8 2.3-8 2.3-6.3 0-11.7-4.2-13.6-10l-7.8 6C6.6 42.6 14.6 48 24 48z"/>
          </svg>
          Google Drive
        </button>
        <button
          className="btn btn-ghost btn-sm"
          style={{ flex: "0 0 auto", color: showBulkUrl ? "var(--accent-light)" : undefined }}
          onClick={() => { setShowBulkUrl((p) => !p); setShowDrive(false); }}
          title="Adicionar por URL pública"
        >
          🔗 URL
        </button>
      </div>

      {/* Google Drive — modal grande */}
      {showDrive && (
        <div
          style={{ position:"fixed",inset:0,background:"rgba(0,0,0,0.7)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:2000,padding:16 }}
          onClick={(e) => { if (e.target === e.currentTarget) setShowDrive(false); }}
        >
          <div style={{ background:"var(--bg2)",borderRadius:16,border:"1px solid var(--border2)",width:"100%",maxWidth:700,maxHeight:"88vh",display:"flex",flexDirection:"column",overflow:"hidden",boxShadow:"0 32px 80px rgba(0,0,0,0.7)" }}>
            {/* Cabeçalho do modal */}
            <div style={{ padding:"14px 18px",borderBottom:"1px solid var(--border)",display:"flex",alignItems:"center",gap:10,flexShrink:0 }}>
              <svg width="16" height="16" viewBox="0 0 48 48">
                <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.2l6.7-6.7C35.8 2.2 30.3 0 24 0 14.6 0 6.6 5.4 2.6 13.3l7.8 6C12.2 13 17.7 9.5 24 9.5z"/>
                <path fill="#4285F4" d="M46.6 24.5c0-1.6-.1-3.1-.4-4.5H24v8.5h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8c4.4-4 6.9-10 6.9-17z"/>
                <path fill="#FBBC05" d="M10.4 28.7A14.6 14.6 0 0 1 9.5 24c0-1.6.3-3.2.9-4.7L2.6 13.3A23.9 23.9 0 0 0 0 24c0 3.8.9 7.4 2.6 10.6l7.8-5.9z"/>
                <path fill="#34A853" d="M24 48c6.3 0 11.6-2.1 15.5-5.6l-7.5-5.8c-2.1 1.4-4.8 2.3-8 2.3-6.3 0-11.7-4.2-13.6-10l-7.8 6C6.6 42.6 14.6 48 24 48z"/>
              </svg>
              <span style={{ fontWeight:700,fontSize:14 }}>Google Drive — Selecionar Mídias</span>
              <div style={{ flex:1 }} />
              <span style={{ fontSize:11,color:"var(--muted)" }}>Selecione arquivos ou use "📂 Usar pasta" para importar uma pasta inteira</span>
              <button onClick={() => setShowDrive(false)} className="btn btn-ghost btn-sm" style={{ padding:"4px 10px",marginLeft:8 }}>✕</button>
            </div>
            {/* Conteúdo do picker */}
            <div style={{ flex:1,overflowY:"auto",padding:"12px 16px" }}>
              <DrivePicker
                pickerMode
                accounts={[]}
                onClose={() => setShowDrive(false)}
                onPick={async (pickedVideos) => {
                  setShowDrive(false);
                  abortRef.current = false;
                  setImportProgress(0, pickedVideos.length, null);
                  try {
                    const { refresh_token } = drive.tokenData || {};
                    if (!refresh_token) throw new Error("Sessão do Drive sem refresh_token. Desconecte e reconecte.");

                    const CONCURRENCY = 3;
                    const urls = new Array(pickedVideos.length).fill(null);
                    let completed = 0;
                    

                    // Fila de tarefas — cada worker pega um arquivo, processa e atualiza progresso
                    const queue = pickedVideos.map((v, idx) => ({ v, idx }));
                    let queuePos = 0;

                    async function worker() {
                      while (true) {
                        if (abortRef.current) break;
                        const task = queue[queuePos++];
                        if (!task) break;
                        const { v, idx } = task;
                        const isVideo = /\.(mp4|mov|avi|mkv|webm|m4v)$/i.test(v.name);

                        // 1. Baixar do Drive como blob binário
                        setImportProgress(completed, pickedVideos.length, v.name, "⬇️ baixando");
                        const dlRes = await fetch("/api/drive-proxy", {
                          method:  "POST",
                          headers: { "Content-Type": "application/json" },
                          body:    JSON.stringify({ file_id: v.id, file_name: v.name, refresh_token, return_blob: true }),
                        });
                        if (!dlRes.ok) {
                          const d = await dlRes.json().catch(() => ({}));
                          throw new Error(d.error || `Erro ao baixar "${v.name}"`);
                        }

                        // 2. Transcodar para H.264/AAC no browser (só vídeos)
                        let finalBlob;
                        if (isVideo) {
                          setImportProgress(completed, pickedVideos.length, v.name, "⚙️ convertendo...");
                          const rawBuffer = await dlRes.arrayBuffer();
                          const converted = await transcodeForInstagram(rawBuffer, v.name,
                            (_stage, pct) => pct != null && setImportProgress(completed, pickedVideos.length, v.name, `⚙️ convertendo ${pct}%`)
                          );
                          finalBlob = new Blob([converted], { type: "video/mp4" });
                        } else {
                          finalBlob = await dlRes.blob();
                        }

                        // 3. Salvar o arquivo convertido nos Netlify Blobs via drive-proxy PUT
                        setImportProgress(completed, pickedVideos.length, v.name, "☁️ salvando");
                        const outName = isVideo ? v.name.replace(/\.[^.]+$/, ".mp4") : v.name;
                        const form    = new FormData();
                        form.append("file",          finalBlob, outName);
                        form.append("file_id",       v.id);
                        form.append("refresh_token", refresh_token);
                        const upRes  = await fetch("/api/drive-proxy", { method: "PUT", body: form });
                        const upData = await upRes.json();
                        if (!upRes.ok) throw new Error(upData.error || `Erro ao salvar "${v.name}"`);

                        urls[idx] = upData.url;
                        completed++;
                        if (completed >= pickedVideos.length) {
                          const validUrls = urls.filter(Boolean);
                          if (validUrls.length) onAddUrl(typeConfig.id, validUrls);
                          setImportDone();
                        } else {
                          setImportProgress(completed, pickedVideos.length, v.name, "✅");
                        }
                      }
                    }

                    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
                  } catch (err) {
                    setImportError(err.message);
                  }
                }}
                onSchedule={() => {}}
              />
            </div>
          </div>
        </div>
      )}

      {/* Status de importação do Drive */}
      {driveImporting && driveImportState && (
        <div style={{ marginBottom: 8, padding: "12px 14px", borderRadius: 9, background: "rgba(124,92,252,0.07)", border: "1px solid rgba(124,92,252,0.25)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
            <span className="spinner" style={{ width: 13, height: 13, borderTopColor: "var(--accent)", display: "inline-block", flexShrink: 0 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "var(--accent-light)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span>Importando do Google Drive...</span>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontWeight: 700, color: "var(--text)" }}>{driveImportState.current}/{driveImportState.total}</span>
                  <button
                    onClick={cancelImport}
                    title="Cancelar importação e limpar"
                    style={{ background: "rgba(239,68,68,0.12)", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 6, color: "var(--danger)", fontSize: 10, fontWeight: 700, padding: "2px 8px", cursor: "pointer", lineHeight: 1.4 }}
                  >✕ Parar</button>
                </div>
              </div>
              {driveImportState.currentName && (
                <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  📄 {driveImportState.currentName}
                </div>
              )}
            </div>
          </div>
          {/* Barra de progresso */}
          <div style={{ height: 4, borderRadius: 99, background: "rgba(124,92,252,0.15)", overflow: "hidden" }}>
            <div style={{
              height: "100%",
              borderRadius: 99,
              background: "linear-gradient(90deg, var(--accent), #9b4dfc)",
              width: `${driveImportState.total > 0 ? Math.round((driveImportState.current / driveImportState.total) * 100) : 0}%`,
              transition: "width 0.4s ease",
            }} />
          </div>
          <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 5 }}>
            {driveImportState.stage && driveImportState.stage !== "✅"
              ? driveImportState.stage
              : "🛡 Convertendo para padrão Instagram (H.264/AAC)... Pode mudar de aba."}
          </div>
        </div>
      )}
      {driveImportError && (
        <div style={{ marginBottom: 8, padding: "10px 14px", borderRadius: 9, background: "rgba(239,68,68,0.07)", border: "1px solid rgba(239,68,68,0.25)", fontSize: 12, color: "var(--danger)", display: "flex", alignItems: "center", gap: 8 }}>
          <span>⚠️ {driveImportError}</span>
          <button style={{ marginLeft: "auto", background: "none", border: "none", color: "var(--muted)", cursor: "pointer", fontSize: 14 }} onClick={clearImportError}>✕</button>
        </div>
      )}

      {/* Campo URL */}
      {showBulkUrl && (
        <div style={{ marginBottom: 8 }}>
          <textarea
            value={urlInput || ""}
            onChange={(e) => onUrlInputChange(typeConfig.id, e.target.value)}
            placeholder={"Cole uma ou várias URLs (uma por linha):\nhttps://exemplo.com/video.mp4\nhttps://..."}
            style={{ width: "100%", minHeight: 80, fontFamily: "monospace", fontSize: 11, resize: "vertical", boxSizing: "border-box", marginBottom: 6 }}
            autoFocus
          />
          <div style={{ display: "flex", gap: 6 }}>
            <button className="btn btn-primary btn-sm" style={{ flex: 1 }} onClick={handleAddUrl} disabled={urlCount === 0}>
              ✓ Adicionar {urlCount > 0 ? urlCount : ""} URL{urlCount !== 1 ? "s" : ""}
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => setShowBulkUrl(false)}>Cancelar</button>
          </div>
        </div>
      )}

      {/* Drop zone (só quando vazio) */}
      {myFiles.length === 0 && (
        <div
          style={{
            border: `2px dashed ${dragging ? "var(--accent)" : "var(--border2)"}`,
            borderRadius: 10, padding: "20px 12px", textAlign: "center",
            fontSize: 11, color: dragging ? "var(--accent-light)" : "var(--muted)",
            cursor: "pointer", transition: "all 0.15s", marginBottom: 4,
            background: dragging ? "rgba(124,92,252,0.05)" : "transparent",
          }}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => { e.preventDefault(); setDragging(false); handleFilesSelected(e.dataTransfer.files); }}
          onClick={() => setShowDrive(true)}
        >
          <div style={{ fontSize: 24, marginBottom: 4 }}>⬆</div>
          Arraste mídias aqui ou clique para abrir o Drive<br />
          <span style={{ fontSize: 10, opacity: 0.65 }}>Ou use os botões acima para Drive / URL</span>
        </div>
      )}

      {/* Botão de upload em lote */}
      {idle.length > 0 && (
        <div style={{ marginBottom: 8, padding: "10px 12px", borderRadius: 9, background: "rgba(245,158,11,0.07)", border: "1px solid rgba(245,158,11,0.25)" }}>
          <div style={{ fontSize: 11, color: "var(--warning)", fontWeight: 600, marginBottom: 6 }}>
            ⏳ {idle.length} arquivo{idle.length > 1 ? "s" : ""} aguardando upload
          </div>
          <div style={{ fontSize: 10, color: "var(--muted)", marginBottom: 8, lineHeight: 1.5 }}>
            O Instagram exige URLs públicas. Clique para fazer upload automático via Catbox.moe (grátis, sem cadastro).
          </div>
          <button
            className="btn btn-primary btn-sm"
            style={{ width: "100%", background: "rgba(245,158,11,0.85)", borderColor: "transparent" }}
            onClick={uploadAll}
            disabled={isUploading}
          >
            {isUploading
              ? <><span className="spinner" style={{ width: 11, height: 11, borderTopColor: "#fff", display: "inline-block" }} /> Enviando...</>
              : `⬆ Fazer upload de ${idle.length} arquivo${idle.length > 1 ? "s" : ""}`}
          </button>
        </div>
      )}

      {/* Lista */}
      {myFiles.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 220, overflowY: "auto" }}>
          {myFiles.map((f) => {
            const pct = uploading[f.id] ?? f.progress ?? 0;
            const isUp = f.status === "uploading" || uploading[f.id] !== undefined;
            return (
              <div key={f.id} style={{
                display: "flex", alignItems: "center", gap: 8,
                padding: "6px 10px", borderRadius: 7, fontSize: 11,
                background: f.status === "error"
                  ? "rgba(239,68,68,0.06)"
                  : f.status === "done"
                    ? "rgba(34,197,94,0.06)"
                    : "rgba(245,158,11,0.05)",
                border: `1px solid ${
                  f.status === "error" ? "rgba(239,68,68,0.2)"
                  : f.status === "done" ? "rgba(34,197,94,0.2)"
                  : "rgba(245,158,11,0.18)"}`,
              }}>
                <span style={{ fontSize: 13 }}>
                  {f.file ? (f.file.type?.startsWith("video") ? "🎬" : "🖼") : typeConfig.icon}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 500 }}>
                    {f.name || f.url || "Arquivo adicionado"}
                  </div>
                  {f.size > 0 && (
                    <div style={{ fontSize: 10, color: "var(--muted)" }}>{(f.size / 1024 / 1024).toFixed(1)} MB</div>
                  )}
                  {isUp && (
                    <div style={{ marginTop: 4, height: 3, borderRadius: 2, background: "var(--border2)", overflow: "hidden" }}>
                      <div style={{ height: "100%", borderRadius: 2, width: `${pct}%`, background: "var(--accent)", transition: "width 0.3s" }} />
                    </div>
                  )}
                  {f.url && !f.file && (
                    <div style={{ fontSize: 10, color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.url}</div>
                  )}
                  {f.status === "error" && <div style={{ fontSize: 10, color: "var(--danger)", marginTop: 2 }}>✗ {f.error}</div>}
                </div>
                {f.status === "done"     && <span className="badge badge-success" style={{ fontSize: 10, flexShrink: 0 }}>✓</span>}
                {f.status === "idle"     && <span style={{ fontSize: 10, color: "var(--warning)", flexShrink: 0 }}>⏳</span>}
                {f.status === "uploading"&& <span style={{ fontSize: 10, color: "var(--accent-light)", flexShrink: 0 }}>{pct}%</span>}
                {f.status === "error"    && <span style={{ fontSize: 10, color: "var(--danger)", flexShrink: 0 }}>✗</span>}
                <button
                  onClick={() => onRemoveFile(typeConfig.id, f.id)}
                  disabled={isUp}
                  style={{ background: "none", color: "var(--muted)", fontSize: 14, padding: 0, flexShrink: 0, cursor: "pointer", opacity: isUp ? 0.4 : 1 }}
                >×</button>
              </div>
            );
          })}
        </div>
      )}

      {myFiles.length > 1 && (
        <button
          className="btn btn-ghost btn-xs"
          style={{ marginTop: 6, fontSize: 10, color: "var(--danger)", borderColor: "rgba(239,68,68,0.25)" }}
          onClick={() => onRemoveAll(typeConfig.id)}
        >
          🗑 Limpar todos ({myFiles.length})
        </button>
      )}
    </div>
  );
}
