// WarmupMediaUploadZone.jsx — mídias por arquivo, pasta ou URL
import { useState, useRef, useCallback } from "react";

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
  const [dragging, setDragging]       = useState(false);
  const [uploading, setUploading]     = useState({}); // fileId → progress
  const fileInputRef   = useRef(null);
  const folderInputRef = useRef(null);

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

  const handleFileInput = (e) => {
    handleFilesSelected(e.target.files);
    e.target.value = "";
  };

  const handleFolderPick = async () => {
    if (window.showDirectoryPicker) {
      try {
        const dirHandle = await window.showDirectoryPicker({ mode: "read" });
        const collected = [];
        async function walk(handle) {
          for await (const [, entry] of handle.entries()) {
            if (entry.kind === "file") {
              const f = await entry.getFile();
              if (isMediaFile(f)) collected.push(f);
            } else if (entry.kind === "directory") {
              await walk(entry);
            }
          }
        }
        await walk(dirHandle);
        if (collected.length) onAddFiles(typeConfig.id, collected);
        else alert("Nenhuma mídia encontrada na pasta selecionada.");
      } catch (err) {
        if (err.name !== "AbortError") console.error(err);
      }
    } else {
      folderInputRef.current?.click();
    }
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
      <input ref={fileInputRef} type="file" accept={MEDIA_ACCEPT} multiple style={{ display: "none" }} onChange={handleFileInput} />
      <input ref={folderInputRef} type="file" accept={MEDIA_ACCEPT} multiple webkitdirectory="true" style={{ display: "none" }} onChange={handleFileInput} />

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
        <button className="btn btn-ghost btn-sm" style={{ flex: "1 1 auto" }} onClick={() => fileInputRef.current?.click()}>
          📁 Arquivos
        </button>
        <button className="btn btn-ghost btn-sm" style={{ flex: "1 1 auto" }} onClick={handleFolderPick}>
          📂 Pasta
        </button>
        <button
          className="btn btn-ghost btn-sm"
          style={{ flex: "0 0 auto", color: showBulkUrl ? "var(--accent-light)" : undefined }}
          onClick={() => setShowBulkUrl((p) => !p)}
          title="Adicionar por URL pública"
        >
          🔗 URL
        </button>
      </div>

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
          onClick={() => fileInputRef.current?.click()}
        >
          <div style={{ fontSize: 24, marginBottom: 4 }}>⬆</div>
          Arraste mídias aqui ou clique para selecionar<br />
          <span style={{ fontSize: 10, opacity: 0.65 }}>Aceita vídeos e imagens • MP4, MOV, JPG, PNG...</span>
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
