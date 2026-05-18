/**
 * Profiles.jsx — Aba de Perfis do Insta Manager
 *
 * Funcionalidades:
 * - Grid responsivo de cards por conta
 * - Tabs de categorias com contadores
 * - Busca por username/nickname
 * - Edição inline de email, senha e token 2FA (persistido via addAccounts)
 * - Classificação automática + override manual (persistido via dbPut)
 * - Revelar senha, copiar 2FA, copiar credenciais completas (incl. 2FA)
 * - Filtro "Pronto para Subir"
 * - Health Score visual, Reach Drop, Shadowban Risk
 */

import { useState, useMemo, useCallback, useEffect } from "react";
import { useAccounts } from "../../useAccounts.js";
import { useHealthCheck } from "../../hooks/useHealthCheck.js";
import { dbGet, dbPut } from "../../useDB.js";

// ─── Constantes de Categoria ──────────────────────────────────────────────────

const CATEGORIES = [
  { id: "todas",       label: "Todas",       emoji: "🌐", color: "var(--muted)",   bg: "rgba(102,102,120,0.12)", border: "rgba(102,102,120,0.25)" },
  { id: "ativa",       label: "Ativas",      emoji: "✅", color: "var(--success)", bg: "rgba(34,197,94,0.10)",   border: "rgba(34,197,94,0.25)"   },
  { id: "advertencia", label: "Advertência", emoji: "⚠️", color: "var(--warning)", bg: "rgba(245,158,11,0.10)",  border: "rgba(245,158,11,0.25)"  },
  { id: "banida",      label: "Banidas",     emoji: "🚫", color: "var(--danger)",  bg: "rgba(239,68,68,0.10)",   border: "rgba(239,68,68,0.25)"   },
  { id: "premium",     label: "Premium",     emoji: "⭐", color: "#f59e0b",        bg: "rgba(245,158,11,0.08)",  border: "rgba(245,158,11,0.3)"   },
  { id: "warmup",      label: "Warmup",      emoji: "🔥", color: "var(--info)",    bg: "rgba(56,189,248,0.10)",  border: "rgba(56,189,248,0.25)"  },
];

const CAT_MAP = Object.fromEntries(CATEGORIES.map((c) => [c.id, c]));

// ─── Classificação Automática ─────────────────────────────────────────────────

function autoClassify(acc, healthResult) {
  if (acc.token_status === "expired" || healthResult?.status === "token_expired") return "banida";
  const score     = healthResult?.score ?? null;
  const drop      = healthResult?.reach_drop_pct ?? null;
  const shadowban = healthResult?.issues?.some((i) => typeof i === "string" && i.toLowerCase().includes("shadowban")) ?? false;
  if (acc.warmup_active) return "warmup";
  if ((score !== null && score < 50) || (drop !== null && drop > 40) || shadowban) return "advertencia";
  if (score !== null && score >= 80 && (acc.followers_count ?? 0) >= 10_000) return "premium";
  return "ativa";
}

// ─── Utilitários ──────────────────────────────────────────────────────────────

function fmt(n) {
  if (n == null) return "—";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 10_000)    return (n / 1_000).toFixed(0) + "k";
  if (n >= 1_000)     return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "k";
  return n.toLocaleString("pt-BR");
}

function fmtDate(iso) {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "short", year: "numeric" }); }
  catch { return "—"; }
}

function copyToClipboard(text, setCopied, key) {
  navigator.clipboard.writeText(text).then(() => {
    setCopied(key);
    setTimeout(() => setCopied(null), 1800);
  });
}

// ─── DB Keys ──────────────────────────────────────────────────────────────────

const DB_STORE    = "protection";
const DB_KEY_CAT  = "profile_category_overrides";
const DB_KEY_NOTE = "profile_notes";

// ─── Sub-componentes ──────────────────────────────────────────────────────────

function ScoreBar({ score }) {
  if (score == null) return null;
  const color = score >= 75 ? "var(--success)" : score >= 45 ? "var(--warning)" : "var(--danger)";
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--muted)", marginBottom: 3 }}>
        <span>Health Score</span>
        <span style={{ color, fontWeight: 700 }}>{score}/100</span>
      </div>
      <div style={{ height: 5, background: "var(--bg4)", borderRadius: 3, overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${score}%`, borderRadius: 3, background: `linear-gradient(90deg, ${color}99, ${color})`, transition: "width 0.5s ease", boxShadow: `0 0 6px ${color}66` }} />
      </div>
    </div>
  );
}

function CategoryBadge({ catId }) {
  const cat = CAT_MAP[catId] || CAT_MAP.ativa;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 7px", borderRadius: 20, fontSize: 10, fontWeight: 700, color: cat.color, background: cat.bg, border: `1px solid ${cat.border}`, whiteSpace: "nowrap" }}>
      {cat.emoji} {cat.label}
    </span>
  );
}

/**
 * Campo editável inline.
 * Clica no lápis (✏️) para editar, Enter ou blur salva, Escape cancela.
 */
function EditableField({ label, value, onSave, type = "text", copied, setCopied, copyKey }) {
  const [editing, setEditing] = useState(false);
  const [draft,   setDraft]   = useState(value || "");
  const [visible, setVisible] = useState(false);
  const [saving,  setSaving]  = useState(false);

  useEffect(() => { if (!editing) setDraft(value || ""); }, [value, editing]);

  const handleSave = async () => {
    if (draft.trim() === (value || "").trim()) { setEditing(false); return; }
    setSaving(true);
    await onSave(draft.trim());
    setSaving(false);
    setEditing(false);
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter")  { e.preventDefault(); handleSave(); }
    if (e.key === "Escape") { setDraft(value || ""); setEditing(false); }
  };

  const isSecret = type === "password" || type === "totp";
  const display  = isSecret && !visible && value ? "••••••••" : (value || "—");

  return (
    <div>
      {/* Label row */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
        <div style={{ fontSize: 9, color: "var(--muted)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" }}>{label}</div>
        <div style={{ display: "flex", gap: 3, alignItems: "center" }}>
          {/* Revelar / ocultar */}
          {isSecret && value && !editing && (
            <button onClick={() => setVisible((v) => !v)} title={visible ? "Ocultar" : "Revelar"}
              style={{ background: "none", color: "var(--muted)", fontSize: 12, padding: "0 2px", lineHeight: 1 }}>
              {visible ? "🙈" : "👁"}
            </button>
          )}
          {/* Copiar */}
          {value && !editing && (
            <button onClick={() => copyToClipboard(value, setCopied, copyKey)} title="Copiar"
              style={{ background: "none", color: copied === copyKey ? "var(--success)" : "var(--muted)", fontSize: 11, padding: "0 2px" }}>
              {copied === copyKey ? "✓" : "⧉"}
            </button>
          )}
          {/* Editar / confirmar */}
          {!editing ? (
            <button onClick={() => { setDraft(value || ""); setEditing(true); }} title="Editar"
              style={{ background: "none", color: "var(--accent2)", fontSize: 11, padding: "0 2px" }}>
              ✏️
            </button>
          ) : (
            <>
              <button onClick={handleSave} disabled={saving} title="Salvar"
                style={{ background: "none", color: "var(--success)", fontSize: 11, fontWeight: 700, padding: "0 2px" }}>
                {saving ? "…" : "✓"}
              </button>
              <button onClick={() => { setDraft(value || ""); setEditing(false); }} title="Cancelar"
                style={{ background: "none", color: "var(--danger)", fontSize: 11, padding: "0 2px" }}>
                ✕
              </button>
            </>
          )}
        </div>
      </div>

      {/* Valor ou input */}
      {editing ? (
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={handleSave}
          onKeyDown={handleKeyDown}
          placeholder={`Digite ${label.toLowerCase()}...`}
          autoFocus
          style={{ fontSize: 12, padding: "5px 8px", height: "auto" }}
        />
      ) : (
        <div style={{
          fontSize: 12,
          fontFamily: isSecret ? "monospace" : "inherit",
          color: value ? "var(--text2)" : "var(--muted)",
          letterSpacing: isSecret && !visible && value ? 2 : 0,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          cursor: "default",
        }}>
          {display}
        </div>
      )}
    </div>
  );
}

// ─── Card de Perfil ───────────────────────────────────────────────────────────

function ProfileCard({ acc, healthResult, categoryOverride, noteOverride, onCategoryChange, onNoteChange, onFieldSave }) {
  const [expanded,  setExpanded]  = useState(false);
  const [editNote,  setEditNote]  = useState(false);
  const [noteDraft, setNoteDraft] = useState(noteOverride || "");
  const [copied,    setCopied]    = useState(null);

  const effectiveCat = categoryOverride || autoClassify(acc, healthResult);
  const cat          = CAT_MAP[effectiveCat] || CAT_MAP.ativa;
  const isReady      = effectiveCat === "ativa" || effectiveCat === "premium";
  const drop         = healthResult?.reach_drop_pct ?? null;
  const shadowban    = healthResult?.issues?.some((i) => typeof i === "string" && i.toLowerCase().includes("shadowban"));

  useEffect(() => { setNoteDraft(noteOverride || ""); }, [noteOverride]);

  const handleNoteBlur = () => { setEditNote(false); onNoteChange(acc.id, noteDraft); };

  // Copia username + email + senha + 2FA secret
  const handleCopyCredentials = () => {
    const lines = [
      `Username: @${acc.username}`,
      `Email: ${acc.email || "—"}`,
      `Senha: ${acc.password || "—"}`,
      acc.totp_secret ? `2FA Secret: ${acc.totp_secret}` : null,
    ].filter(Boolean).join("\n");
    copyToClipboard(lines, setCopied, `cred-${acc.id}`);
  };

  return (
    <div style={{
      background: "var(--bg2)",
      border: `1px solid ${expanded ? cat.border : "var(--border)"}`,
      borderRadius: 14, overflow: "hidden",
      transition: "border-color 0.2s, box-shadow 0.2s",
      boxShadow: expanded ? `0 4px 24px rgba(0,0,0,0.35), 0 0 0 1px ${cat.border}` : "var(--shadow-sm)",
    }}>

      {/* ── Cabeçalho (clicável) ── */}
      <div style={{ padding: "14px 16px", cursor: "pointer", userSelect: "none" }} onClick={() => setExpanded((v) => !v)}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>

          {acc.profile_picture
            ? <img src={acc.profile_picture} alt="" style={{ width: 44, height: 44, borderRadius: "50%", objectFit: "cover", flexShrink: 0, border: `2px solid ${cat.border}` }} />
            : <div style={{ width: 44, height: 44, borderRadius: "50%", flexShrink: 0, background: `linear-gradient(135deg, ${cat.color}55, #9b4dfc55)`, border: `2px solid ${cat.border}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, fontWeight: 700, color: cat.color }}>
                {(acc.username || acc.name || "?")[0].toUpperCase()}
              </div>
          }

          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 140 }}>
                {acc.name || acc.username}
              </span>
              {isReady && (
                <span style={{ fontSize: 9, fontWeight: 700, padding: "1px 6px", borderRadius: 10, background: "rgba(34,197,94,0.15)", color: "var(--success)", border: "1px solid rgba(34,197,94,0.3)", whiteSpace: "nowrap" }}>✓ Pronta</span>
              )}
            </div>
            <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 1 }}>@{acc.username}</div>
            <div style={{ marginTop: 5, display: "flex", alignItems: "center", gap: 5 }}>
              <CategoryBadge catId={effectiveCat} />
              {categoryOverride && <span style={{ fontSize: 9, color: "var(--accent2)", fontStyle: "italic" }}>manual</span>}
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4, flexShrink: 0 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>
              {fmt(acc.followers_count ?? null)}
              <span style={{ fontSize: 9, color: "var(--muted)", fontWeight: 400, marginLeft: 2 }}>seg</span>
            </span>
            {drop !== null && (
              <span style={{ fontSize: 10, fontWeight: 700, color: drop >= 40 ? "var(--danger)" : drop >= 20 ? "var(--warning)" : "var(--success)" }}>
                {drop > 0 ? `↓${drop}%` : `↑${Math.abs(drop)}%`} reach
              </span>
            )}
          </div>

          <span style={{ color: "var(--muted)", fontSize: 12, marginLeft: 4, flexShrink: 0 }}>{expanded ? "▲" : "▼"}</span>
        </div>

        {healthResult?.score != null && (
          <div style={{ marginTop: 10 }}><ScoreBar score={healthResult.score} /></div>
        )}
      </div>

      {/* ── Conteúdo expandido ── */}
      {expanded && (
        <div style={{ borderTop: "1px solid var(--border)", padding: "16px 16px 14px" }}>

          {/* Campos editáveis */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px 20px", marginBottom: 16 }}>

            <EditableField
              label="Email"
              value={acc.email}
              onSave={(v) => onFieldSave(acc, { email: v })}
              type="text"
              copied={copied} setCopied={setCopied} copyKey={`email-${acc.id}`}
            />

            <EditableField
              label="Senha"
              value={acc.password}
              onSave={(v) => onFieldSave(acc, { password: v })}
              type="password"
              copied={copied} setCopied={setCopied} copyKey={`pwd-${acc.id}`}
            />

            {/* 2FA ocupa linha inteira */}
            <div style={{ gridColumn: "1 / -1" }}>
              <EditableField
                label="Token 2FA (TOTP Secret)"
                value={acc.totp_secret}
                onSave={(v) => onFieldSave(acc, { totp_secret: v })}
                type="totp"
                copied={copied} setCopied={setCopied} copyKey={`2fa-${acc.id}`}
              />
              {acc.totp_secret && (
                <a href={`https://2fa.live/tok/${acc.totp_secret}`} target="_blank" rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  style={{ fontSize: 10, color: "var(--info)", marginTop: 5, display: "inline-flex", alignItems: "center", gap: 4, textDecoration: "none" }}>
                  🔐 Abrir no 2FA.live ↗
                </a>
              )}
            </div>

            {/* Seguidores */}
            <StatField label="Seguidores">
              <span style={{ fontSize: 13, fontWeight: 700 }}>{fmt(acc.followers_count ?? null)}</span>
            </StatField>

            {/* Reach Drop */}
            <StatField label="Reach Drop (7d)">
              {drop !== null
                ? <span style={{ fontSize: 12, fontWeight: 700, color: drop >= 40 ? "var(--danger)" : drop >= 20 ? "var(--warning)" : "var(--success)" }}>
                    {drop > 0 ? `↓ ${drop}%` : `↑ ${Math.abs(drop)}%`}
                  </span>
                : <span style={{ color: "var(--muted)", fontSize: 12 }}>—</span>
              }
            </StatField>

            {/* Shadowban */}
            <StatField label="Shadowban Risk">
              <span style={{ fontSize: 11, fontWeight: 700, color: shadowban ? "var(--danger)" : "var(--success)" }}>
                {shadowban ? "⚠️ Detectado" : "✓ Limpo"}
              </span>
            </StatField>

            {/* Token */}
            <StatField label="Token">
              <span style={{ fontSize: 11, fontWeight: 700, color: acc.token_status === "expired" ? "var(--danger)" : "var(--success)" }}>
                {acc.token_status === "expired" ? "🔑 Expirado" : "✓ Ativo"}
              </span>
            </StatField>

            {/* Conectado em */}
            <StatField label="Conectado em">
              <span style={{ fontSize: 11, color: "var(--text2)" }}>{fmtDate(acc.connected_at)}</span>
            </StatField>

            {/* Último post */}
            {acc.last_post_at && (
              <StatField label="Último post">
                <span style={{ fontSize: 11, color: "var(--text2)" }}>{fmtDate(acc.last_post_at)}</span>
              </StatField>
            )}
          </div>

          {/* ── Categoria manual ── */}
          <div style={{ marginBottom: 14, padding: "10px 12px", borderRadius: 10, background: "var(--bg3)", border: "1px solid var(--border)" }}>
            <div style={{ fontSize: 10, color: "var(--muted)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 7 }}>
              Categoria manual
            </div>
            <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 6 }}>
              {CATEGORIES.filter((c) => c.id !== "todas").map((c) => {
                const isActive = categoryOverride === c.id;
                return (
                  <button key={c.id} onClick={() => onCategoryChange(acc.id, isActive ? null : c.id)}
                    style={{ fontSize: 10, fontWeight: 700, padding: "3px 9px", borderRadius: 20, cursor: "pointer", color: isActive ? c.color : "var(--muted)", background: isActive ? c.bg : "transparent", border: `1px solid ${isActive ? c.border : "var(--border)"}`, transition: "all 0.12s" }}>
                    {c.emoji} {c.label}
                  </button>
                );
              })}
              {categoryOverride && (
                <button onClick={() => onCategoryChange(acc.id, null)}
                  style={{ fontSize: 10, padding: "3px 8px", borderRadius: 20, cursor: "pointer", color: "var(--danger)", background: "transparent", border: "1px solid rgba(239,68,68,0.3)" }}>
                  ✕ Remover
                </button>
              )}
            </div>
            <div style={{ fontSize: 10, color: "var(--muted)", fontStyle: "italic" }}>
              {categoryOverride
                ? `Override manual ativo (automático: ${autoClassify(acc, healthResult)})`
                : "Classificação automática — clique para sobrescrever"}
            </div>
          </div>

          {/* ── Notas ── */}
          <div style={{ marginBottom: 14 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 5 }}>
              <div style={{ fontSize: 10, color: "var(--muted)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" }}>Notas / Observações</div>
              <button onClick={() => setEditNote((v) => !v)} style={{ fontSize: 10, color: "var(--accent2)", background: "none", padding: 0 }}>
                {editNote ? "✓ Salvar" : "✏️ Editar"}
              </button>
            </div>
            {editNote
              ? <textarea value={noteDraft} onChange={(e) => setNoteDraft(e.target.value)} onBlur={handleNoteBlur}
                  placeholder="Adicione observações..." style={{ minHeight: 64, fontSize: 12, resize: "vertical" }} autoFocus />
              : <div onClick={() => setEditNote(true)} style={{ fontSize: 12, color: noteDraft ? "var(--text2)" : "var(--muted)", padding: "8px 10px", borderRadius: 8, background: "var(--bg3)", border: "1px solid var(--border)", minHeight: 40, lineHeight: 1.5, whiteSpace: "pre-wrap", fontStyle: noteDraft ? "normal" : "italic", cursor: "text" }}>
                  {noteDraft || "Sem notas. Clique para adicionar..."}
                </div>
            }
          </div>

          {/* ── Ações rápidas ── */}
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button onClick={handleCopyCredentials} className="btn btn-ghost btn-xs"
              style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11 }}>
              {copied === `cred-${acc.id}` ? "✓ Copiado!" : "📋 Copiar credenciais + 2FA"}
            </button>
          </div>

        </div>
      )}
    </div>
  );
}

/** Campo de estatística simples (somente leitura) */
function StatField({ label, children }) {
  return (
    <div>
      <div style={{ fontSize: 9, color: "var(--muted)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 3 }}>{label}</div>
      {children}
    </div>
  );
}

// ─── Componente Principal ─────────────────────────────────────────────────────

// ─── Opções de Ordenação ──────────────────────────────────────────────────────

const SORT_OPTIONS = [
  { id: "none",       label: "Padrão",       icon: "↕️" },
  { id: "score_desc", label: "Qualidade ↓",  icon: "⭐" },
  { id: "score_asc",  label: "Qualidade ↑",  icon: "⭐" },
  { id: "followers_desc", label: "Seguidores ↓", icon: "👥" },
  { id: "followers_asc",  label: "Seguidores ↑", icon: "👥" },
  { id: "reach_desc", label: "Reach Drop ↓", icon: "📉" },
  { id: "reach_asc",  label: "Reach Drop ↑", icon: "📉" },
  { id: "cat",        label: "Categoria",    icon: "🏷️" },
  { id: "name",       label: "Nome A–Z",     icon: "🔤" },
];

function sortEnriched(list, sortId) {
  if (sortId === "none") return list;
  const copy = [...list];
  copy.sort((a, b) => {
    const aScore = a.healthResult?.score ?? -1;
    const bScore = b.healthResult?.score ?? -1;
    const aFol   = a.acc.followers_count ?? -1;
    const bFol   = b.acc.followers_count ?? -1;
    const aDrop  = a.healthResult?.reach_drop_pct ?? 0;
    const bDrop  = b.healthResult?.reach_drop_pct ?? 0;
    switch (sortId) {
      case "score_desc":    return bScore - aScore;
      case "score_asc":     return aScore - bScore;
      case "followers_desc": return bFol - aFol;
      case "followers_asc":  return aFol - bFol;
      case "reach_desc":    return bDrop - aDrop;
      case "reach_asc":     return aDrop - bDrop;
      case "cat": {
        const CAT_ORDER = ["premium", "ativa", "warmup", "advertencia", "banida"];
        return CAT_ORDER.indexOf(a.effectiveCat) - CAT_ORDER.indexOf(b.effectiveCat);
      }
      case "name": return (a.acc.name || a.acc.username || "").localeCompare(b.acc.name || b.acc.username || "", "pt-BR");
      default: return 0;
    }
  });
  return copy;
}

export default function Profiles() {
  const { accounts, loading, addAccounts } = useAccounts();
  const { getAccountResult, runCheck }     = useHealthCheck(accounts, {});

  const [activeTab,     setActiveTab]     = useState("todas");
  const [search,        setSearch]        = useState("");
  const [readyOnly,     setReadyOnly]     = useState(false);
  const [overrides,     setOverrides]     = useState({});
  const [notes,         setNotes]         = useState({});
  const [dbLoaded,      setDbLoaded]      = useState(false);
  const [sortBy,        setSortBy]        = useState("none");
  const [sortOpen,      setSortOpen]      = useState(false);
  const [refreshing,    setRefreshing]    = useState(false);
  const [refreshMsg,    setRefreshMsg]    = useState(null);

  // Fechar dropdown ao clicar fora
  useEffect(() => {
    if (!sortOpen) return;
    const handler = () => setSortOpen(false);
    document.addEventListener("click", handler, true);
    return () => document.removeEventListener("click", handler, true);
  }, [sortOpen]);

  useEffect(() => {
    Promise.all([
      dbGet(DB_STORE, DB_KEY_CAT).catch(() => null),
      dbGet(DB_STORE, DB_KEY_NOTE).catch(() => null),
    ]).then(([catRow, noteRow]) => {
      if (catRow?.data)  setOverrides(catRow.data);
      if (noteRow?.data) setNotes(noteRow.data);
      setDbLoaded(true);
    });
  }, []);

  const handleCategoryChange = useCallback(async (accId, catId) => {
    const updated = { ...overrides };
    if (catId === null) delete updated[accId]; else updated[accId] = catId;
    setOverrides(updated);
    await dbPut(DB_STORE, { id: DB_KEY_CAT, data: updated, updatedAt: new Date().toISOString() });
  }, [overrides]);

  const handleNoteChange = useCallback(async (accId, text) => {
    const updated = { ...notes };
    if (!text) delete updated[accId]; else updated[accId] = text;
    setNotes(updated);
    await dbPut(DB_STORE, { id: DB_KEY_NOTE, data: updated, updatedAt: new Date().toISOString() });
  }, [notes]);

  // Salva email, senha ou totp_secret na nuvem via addAccounts
  const handleFieldSave = useCallback(async (acc, patch) => {
    try { await addAccounts([{ ...acc, ...patch }]); }
    catch (err) { console.error("[Profiles] Erro ao salvar campo:", err); }
  }, [addAccounts]);

  // Atualizar dados: re-sincroniza todas as contas + refaz health check
  const handleRefresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshMsg(null);
    try {
      await addAccounts(accounts);
      await runCheck(true);
      setRefreshMsg({ ok: true, text: "Dados atualizados!" });
    } catch (err) {
      console.error("[Profiles] Erro ao atualizar:", err);
      setRefreshMsg({ ok: false, text: "Erro ao atualizar." });
    } finally {
      setRefreshing(false);
      setTimeout(() => setRefreshMsg(null), 3000);
    }
  }, [refreshing, accounts, addAccounts, runCheck]);

  const enriched = useMemo(() => accounts.map((acc) => {
    const healthResult = getAccountResult(acc.id);
    const effectiveCat = overrides[acc.id] || autoClassify(acc, healthResult);
    return { acc, healthResult, effectiveCat };
  }), [accounts, getAccountResult, overrides]);

  const counts = useMemo(() => {
    const c = { todas: enriched.length };
    for (const { effectiveCat } of enriched) c[effectiveCat] = (c[effectiveCat] || 0) + 1;
    return c;
  }, [enriched]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const base = enriched.filter(({ acc, effectiveCat }) => {
      if (activeTab !== "todas" && effectiveCat !== activeTab) return false;
      if (readyOnly && effectiveCat !== "ativa" && effectiveCat !== "premium") return false;
      if (q) {
        const hay = [acc.username, acc.name, acc.email, acc.nickname].filter(Boolean).join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    return sortEnriched(base, sortBy);
  }, [enriched, activeTab, search, readyOnly, sortBy]);

  if (loading) return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: 80 }}>
      <span className="spinner" style={{ width: 28, height: 28, borderTopColor: "var(--accent)", borderWidth: 3 }} />
      <span style={{ marginLeft: 14, color: "var(--muted)", fontSize: 14 }}>Carregando perfis...</span>
    </div>
  );

  if (!accounts.length) return (
    <div style={{ padding: 40, textAlign: "center" }}>
      <div style={{ fontSize: 48, marginBottom: 12 }}>👤</div>
      <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>Nenhuma conta conectada</div>
      <div style={{ fontSize: 13, color: "var(--muted)" }}>Conecte uma conta do Instagram para gerenciar os perfis aqui.</div>
    </div>
  );

  return (
    <div style={{ padding: "24px 20px", maxWidth: 1100, margin: "0 auto" }}>

      {/* Header */}
      <div style={{ marginBottom: 20, display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 800, color: "var(--text)", lineHeight: 1.2 }}>
            Perfis <span style={{ fontSize: 14, fontWeight: 500, color: "var(--muted)", marginLeft: 6 }}>{accounts.length} conta{accounts.length !== 1 ? "s" : ""}</span>
          </h1>
          <p style={{ fontSize: 13, color: "var(--muted)", marginTop: 3 }}>Gerencie, classifique e monitore todos os perfis Instagram</p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {/* Mensagem de feedback */}
          {refreshMsg && (
            <span style={{ fontSize: 12, fontWeight: 600, color: refreshMsg.ok ? "var(--success)" : "var(--danger)", padding: "6px 10px", background: refreshMsg.ok ? "rgba(34,197,94,0.1)" : "rgba(239,68,68,0.1)", borderRadius: 8, border: `1px solid ${refreshMsg.ok ? "rgba(34,197,94,0.3)" : "rgba(239,68,68,0.3)"}`, whiteSpace: "nowrap" }}>
              {refreshMsg.ok ? "✓" : "✕"} {refreshMsg.text}
            </span>
          )}
          {/* Botão Atualizar Dados */}
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="btn btn-ghost btn-sm"
            style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, opacity: refreshing ? 0.7 : 1, minWidth: 140, justifyContent: "center" }}
          >
            {refreshing
              ? <><span className="spinner" style={{ width: 12, height: 12, borderTopColor: "var(--accent)", borderWidth: 2 }} /> Atualizando...</>
              : <><span style={{ fontSize: 14 }}>🔄</span> Atualizar Dados</>
            }
          </button>
          {/* Health Check */}
          <button onClick={() => runCheck(true)} className="btn btn-ghost btn-sm" style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
            🩺 Health Check
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 16, padding: "4px", background: "var(--bg2)", borderRadius: 12, border: "1px solid var(--border)" }}>
        {CATEGORIES.map((cat) => {
          const isActive = activeTab === cat.id;
          const count    = counts[cat.id] || 0;
          return (
            <button key={cat.id} onClick={() => setActiveTab(cat.id)} style={{ display: "flex", alignItems: "center", gap: 5, padding: "6px 13px", borderRadius: 9, fontSize: 12, fontWeight: isActive ? 700 : 500, color: isActive ? cat.color : "var(--muted)", background: isActive ? cat.bg : "transparent", border: isActive ? `1px solid ${cat.border}` : "1px solid transparent", transition: "all 0.15s", cursor: "pointer" }}>
              <span style={{ lineHeight: 1 }}>{cat.emoji}</span>
              <span>{cat.label}</span>
              {count > 0 && <span style={{ fontSize: 10, fontWeight: 700, padding: "1px 6px", borderRadius: 10, background: isActive ? `${cat.color}22` : "var(--bg3)", color: isActive ? cat.color : "var(--muted)", border: `1px solid ${isActive ? cat.border : "var(--border)"}` }}>{count}</span>}
            </button>
          );
        })}
      </div>

      {/* Busca + filtros */}
      <div style={{ display: "flex", gap: 10, marginBottom: 20, flexWrap: "wrap", alignItems: "center" }}>
        <div style={{ position: "relative", flex: 1, minWidth: 200 }}>
          <span style={{ position: "absolute", left: 11, top: "50%", transform: "translateY(-50%)", color: "var(--muted)", fontSize: 14, pointerEvents: "none" }}>🔍</span>
          <input type="text" placeholder="Buscar por username, nome ou email..." value={search} onChange={(e) => setSearch(e.target.value)} style={{ paddingLeft: 34, paddingRight: search ? 32 : 13 }} />
          {search && <button onClick={() => setSearch("")} style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", background: "none", color: "var(--muted)", fontSize: 14 }}>✕</button>}
        </div>

        {/* Ordenar por — dropdown */}
        <div style={{ position: "relative" }}>
          <button
            onClick={() => setSortOpen((v) => !v)}
            style={{ display: "flex", alignItems: "center", gap: 6, padding: "9px 14px", borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer", color: sortBy !== "none" ? "var(--accent2)" : "var(--muted)", background: sortBy !== "none" ? "rgba(139,92,246,0.1)" : "var(--bg3)", border: sortBy !== "none" ? "1px solid rgba(139,92,246,0.35)" : "1px solid var(--border)", transition: "all 0.15s", whiteSpace: "nowrap" }}
          >
            {SORT_OPTIONS.find((s) => s.id === sortBy)?.icon || "↕️"} Ordenar{sortBy !== "none" ? `: ${SORT_OPTIONS.find((s) => s.id === sortBy)?.label}` : ""} ▾
          </button>
          {sortOpen && (
            <div style={{ position: "absolute", top: "calc(100% + 6px)", right: 0, zIndex: 100, background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 12, padding: "6px", minWidth: 180, boxShadow: "0 8px 32px rgba(0,0,0,0.4)" }}>
              {SORT_OPTIONS.map((opt) => (
                <button key={opt.id} onClick={() => { setSortBy(opt.id); setSortOpen(false); }}
                  style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "8px 12px", borderRadius: 8, fontSize: 12, fontWeight: sortBy === opt.id ? 700 : 500, color: sortBy === opt.id ? "var(--accent2)" : "var(--text2)", background: sortBy === opt.id ? "rgba(139,92,246,0.12)" : "transparent", border: "none", cursor: "pointer", textAlign: "left", transition: "background 0.1s" }}>
                  <span>{opt.icon}</span> {opt.label}
                  {sortBy === opt.id && <span style={{ marginLeft: "auto", color: "var(--accent2)" }}>✓</span>}
                </button>
              ))}
            </div>
          )}
        </div>

        <button onClick={() => setReadyOnly((v) => !v)} style={{ display: "flex", alignItems: "center", gap: 6, padding: "9px 14px", borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer", color: readyOnly ? "var(--success)" : "var(--muted)", background: readyOnly ? "rgba(34,197,94,0.1)" : "var(--bg3)", border: readyOnly ? "1px solid rgba(34,197,94,0.3)" : "1px solid var(--border)", transition: "all 0.15s" }}>
          {readyOnly ? "✅" : "📋"} Prontas para subir
        </button>
      </div>

      {search && <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 14 }}>{filtered.length} resultado{filtered.length !== 1 ? "s" : ""} para <strong style={{ color: "var(--accent2)" }}>"{search}"</strong></div>}

      {/* Grid */}
      {filtered.length === 0 ? (
        <div style={{ textAlign: "center", padding: 48, color: "var(--muted)" }}>
          <div style={{ fontSize: 36, marginBottom: 10 }}>🔎</div>
          <div style={{ fontSize: 14, fontWeight: 600 }}>Nenhum perfil encontrado</div>
          <div style={{ fontSize: 12, marginTop: 4 }}>Tente outra busca ou mude a aba.</div>
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 14 }}>
          {filtered.map(({ acc, healthResult }) => (
            <ProfileCard
              key={acc.id}
              acc={acc}
              healthResult={healthResult}
              categoryOverride={overrides[acc.id] || null}
              noteOverride={notes[acc.id] || ""}
              onCategoryChange={handleCategoryChange}
              onNoteChange={handleNoteChange}
              onFieldSave={handleFieldSave}
            />
          ))}
        </div>
      )}

      {!dbLoaded && (
        <div style={{ position: "fixed", bottom: 20, right: 20, padding: "8px 14px", background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 10, fontSize: 12, color: "var(--muted)", display: "flex", alignItems: "center", gap: 8 }}>
          <span className="spinner" style={{ width: 12, height: 12, borderTopColor: "var(--accent)" }} />
          Carregando dados salvos...
        </div>
      )}

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        .spinner { display: inline-block; border: 2px solid rgba(255,255,255,0.1); border-radius: 50%; animation: spin 0.8s linear infinite; }
      `}</style>
    </div>
  );
}
