// WarmupMediaUploadZone.jsx — adicionar mídias por URL
import { useState } from "react";

export default function MediaUploadZone({ typeConfig, files, onRemoveFile, onRemoveAll, urlInput, onUrlInputChange, onAddUrl }) {
  const [showBulkUrl, setShowBulkUrl] = useState(false);

  const myFiles = files[typeConfig.id] || [];
  const done    = myFiles.filter((f) => f.status === "done");
  const errors  = myFiles.filter((f) => f.status === "error");
  const total   = myFiles.length;

  const handleAddUrl = () => {
    const urls = (urlInput || "").split(/[\n,]/).map((u) => u.trim()).filter((u) => u.startsWith("http"));
    if (!urls.length) return;
    onAddUrl(typeConfig.id, urls);
    onUrlInputChange(typeConfig.id, "");
    setShowBulkUrl(false);
  };

  const urlCount = (urlInput || "").split(/[\n,]/).filter((u) => u.trim().startsWith("http")).length;

  return (
    <div style={{ marginBottom: 4 }}>
      {/* Header com contador */}
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

      {/* Botão para abrir campo de URL */}
      {!showBulkUrl ? (
        <button
          className="btn btn-ghost btn-sm"
          style={{ width: "100%", marginBottom: myFiles.length ? 8 : 0 }}
          onClick={() => setShowBulkUrl(true)}
        >
          🔗 Adicionar URLs
        </button>
      ) : (
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

      {/* Lista de arquivos */}
      {myFiles.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 200, overflowY: "auto" }}>
          {myFiles.map((f) => (
            <div key={f.id} style={{
              display: "flex", alignItems: "center", gap: 8,
              padding: "6px 10px", borderRadius: 7, fontSize: 11,
              background: f.status === "error" ? "rgba(239,68,68,0.06)" : "rgba(34,197,94,0.06)",
              border: `1px solid ${f.status === "error" ? "rgba(239,68,68,0.2)" : "rgba(34,197,94,0.2)"}`,
            }}>
              <span style={{ fontSize: 13 }}>{typeConfig.icon}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 500 }}>
                  {f.name || f.url || "URL adicionada"}
                </div>
                {f.url && (
                  <div style={{ fontSize: 10, color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {f.url}
                  </div>
                )}
                {f.status === "error" && (
                  <div style={{ fontSize: 10, color: "var(--danger)", marginTop: 2 }}>✗ {f.error}</div>
                )}
              </div>
              <span className="badge badge-success" style={{ fontSize: 10, flexShrink: 0 }}>✓</span>
              <button
                onClick={() => onRemoveFile(typeConfig.id, f.id)}
                style={{ background: "none", color: "var(--muted)", fontSize: 14, padding: 0, flexShrink: 0 }}
              >×</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
