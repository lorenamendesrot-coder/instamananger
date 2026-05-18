/**
 * Profiles.jsx — Aba de Perfis do Insta Manager
 *
 * Funcionalidades:
 * - Grid responsivo de cards por conta
 * - Tabs de categorias com contadores
 * - Busca por username/nickname
 * - Classificação automática + override manual (persistido via dbPut)
 * - Revelar senha, copiar 2FA, copiar credenciais
 * - Filtro "Pronto para Subir"
 * - Health Score visual, Reach Drop, Shadowban Risk
 */

import { useState, useMemo, useCallback, useEffect } from "react";
import { useAccounts } from "../../useAccounts.js";
import { useHealthCheck } from "../../hooks/useHealthCheck.js";
import { dbGet, dbPut } from "../../useDB.js";

// ─── Constantes de Categoria ──────────────────────────────────────────────────

const CATEGORIES = [
  { id: "todas",      label: "Todas",       emoji: "🌐", color: "var(--muted)",   bg: "rgba(102,102,120,0.12)", border: "rgba(102,102,120,0.25)" },
  { id: "ativa",      label: "Ativas",      emoji: "✅", color: "var(--success)", bg: "rgba(34,197,94,0.10)",   border: "rgba(34,197,94,0.25)"   },
  { id: "advertencia",label: "Advertência", emoji: "⚠️", color: "var(--warning)", bg: "rgba(245,158,11,0.10)",  border: "rgba(245,158,11,0.25)"  },
  { id: "banida",     label: "Banidas",     emoji: "🚫", color: "var(--danger)",  bg: "rgba(239,68,68,0.10)",   border: "rgba(239,68,68,0.25)"   },
  { id: "premium",    label: "Premium",     emoji: "⭐", color: "#f59e0b",        bg: "rgba(245,158,11,0.08)",  border: "rgba(245,158,11,0.3)"   },
  { id: "warmup",     label: "Warmup",      emoji: "🔥", color: "var(--info)",    bg: "rgba(56,189,248,0.10)",  border: "rgba(56,189,248,0.25)"  },
];

const CAT_MAP = Object.fromEntries(CATEGORIES.map((c) => [c.id, c]));

// ─── Lógica de Classificação Automática ───────────────────────────────────────

function autoClassify(acc, healthResult) {
  // Token expirado → Banida
  if (acc.token_status === "expired" || healthResult?.status === "token_expired") return "banida";

  const score   = healthResult?.score ?? null;
  const drop    = healthResult?.reach_drop_pct ?? null;
  const shadowban = healthResult?.issues?.some((i) =>
    typeof i === "string" && i.toLowerCase().includes("shadowban")
  ) ?? false;

  // Warmup ativo
  if (acc.warmup_active) return "warmup";

  // Advertência: score baixo ou reach com queda acentuada
  if ((score !== null && score < 50) || (drop !== null && drop > 40) || shadowban) return "advertencia";

  // Premium: score alto + muitos seguidores
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
  try {
    return new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "short", year: "numeric" });
  } catch { return "—"; }
}

function copyToClipboard(text, setCopied, key) {
  navigator.clipboard.writeText(text).then(() => {
    setCopied(key);
    setTimeout(() => setCopied(null), 1800);
  });
}

// ─── DB Keys para sobrescritas manuais ───────────────────────────────────────

const DB_STORE    = "protection";
const DB_KEY_CAT  = "profile_category_overrides"; // { [accId]: categoryId }
const DB_KEY_NOTE = "profile_notes";              // { [accId]: string }

// ─── Sub-componentes ──────────────────────────────────────────────────────────

/** Barra de progresso colorida para o health score */
function ScoreBar({ score }) {
  if (score == null) return null;
  const color =
    score >= 75 ? "var(--success)" :
    score >= 45 ? "var(--warning)" :
                  "var(--danger)";
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--muted)", marginBottom: 3 }}>
        <span>Health Score</span>
        <span style={{ color, fontWeight: 700 }}>{score}/100</span>
      </div>
      <div style={{ height: 5, background: "var(--bg4)", borderRadius: 3, overflow: "hidden" }}>
        <div style={{
          height: "100%", width: `${score}%`, borderRadius: 3,
          background: `linear-gradient(90deg, ${color}99, ${color})`,
          transition: "width 0.5s ease",
          boxShadow: `0 0 6px ${color}66`,
        }} />
      </div>
    </div>
  );
}

/** Badge de categoria */
function CategoryBadge({ catId, size = "sm" }) {
  const cat = CAT_MAP[catId] || CAT_MAP.ativa;
  const pad = size === "xs" ? "2px 7px" : "3px 10px";
  const fs  = size === "xs" ? 10 : 11;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 4,
      padding: pad, borderRadius: 20, fontSize: fs, fontWeight: 700,
      color: cat.color, background: cat.bg, border: `1px solid ${cat.border}`,
      whiteSpace: "nowrap",
    }}>
      {cat.emoji} {cat.label}
    </span>
  );
}

/** Campo de senha com toggle de visibilidade */
function PasswordField({ password, copied, setCopied, accId }) {
  const [visible, setVisible] = useState(false);
  if (!password) return <span style={{ color: "var(--muted)", fontSize: 12 }}>—</span>;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
      <span style={{ fontFamily: "monospace", fontSize: 12, color: "var(--text2)", letterSpacing: visible ? 0 : 2 }}>
        {visible ? password : "••••••••"}
      </span>
      <button
        onClick={() => setVisible((v) => !v)}
        title={visible ? "Ocultar" : "Revelar"}
        style={{ background: "none", color: "var(--muted)", fontSize: 13, padding: "0 2px", lineHeight: 1 }}
      >
        {visible ? "🙈" : "👁"}
      </button>
      <button
        onClick={() => copyToClipboard(password, setCopied, `pwd-${accId}`)}
        title="Copiar senha"
        style={{ background: "none", color: copied === `pwd-${accId}` ? "var(--success)" : "var(--muted)", fontSize: 11, padding: "0 2px" }}
      >
        {copied === `pwd-${accId}` ? "✓" : "⧉"}
      </button>
    </div>
  );
}

/** Card completo de uma conta */
function ProfileCard({ acc, healthResult, categoryOverride, noteOverride, onCategoryChange, onNoteChange }) {
  const [expanded,  setExpanded]  = useState(false);
  const [editNote,  setEditNote]  = useState(false);
  const [noteDraft, setNoteDraft] = useState(noteOverride || "");
  const [copied,    setCopied]    = useState(null);

  const effectiveCat = categoryOverride || autoClassify(acc, healthResult);
  const cat          = CAT_MAP[effectiveCat] || CAT_MAP.ativa;

  const isReady = effectiveCat === "ativa" || effectiveCat === "premium";
  const drop    = healthResult?.reach_drop_pct ?? null;
  const shadowban = healthResult?.issues?.some((i) =>
    typeof i === "string" && i.toLowerCase().includes("shadowban")
  );

  const handleNoteBlur = () => {
    setEditNote(false);
    onNoteChange(acc.id, noteDraft);
  };

  const handleCopyCredentials = () => {
    const text = `Username: @${acc.username}\nSenha: ${acc.password || "—"}\nEmail: ${acc.email || "—"}`;
    copyToClipboard(text, setCopied, `cred-${acc.id}`);
  };

  const handle2FA = () => {
    if (acc.totp_secret) copyToClipboard(acc.totp_secret, setCopied, `2fa-${acc.id}`);
  };

  return (
    <div style={{
      background: "var(--bg2)",
      border: `1px solid ${expanded ? cat.border : "var(--border)"}`,
      borderRadius: 14,
      overflow: "hidden",
      transition: "border-color 0.2s, box-shadow 0.2s",
      boxShadow: expanded ? `0 4px 24px rgba(0,0,0,0.35), 0 0 0 1px ${cat.border}` : "var(--shadow-sm)",
    }}>

      {/* ── Cabeçalho do card ── */}
      <div
        style={{ padding: "14px 16px", cursor: "pointer", userSelect: "none" }}
        onClick={() => setExpanded((v) => !v)}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>

          {/* Avatar */}
          {acc.profile_picture
            ? <img
                src={acc.profile_picture} alt=""
                style={{ width: 44, height: 44, borderRadius: "50%", objectFit: "cover", flexShrink: 0, border: `2px solid ${cat.border}` }}
              />
            : <div style={{
                width: 44, height: 44, borderRadius: "50%", flexShrink: 0,
                background: `linear-gradient(135deg, ${cat.color}55, #9b4dfc55)`,
                border: `2px solid ${cat.border}`,
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 18, fontWeight: 700, color: cat.color,
              }}>
                {(acc.username || acc.name || "?")[0].toUpperCase()}
              </div>
          }

          {/* Info principal */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 140 }}>
                {acc.name || acc.username}
              </span>
              {isReady && (
                <span style={{ fontSize: 9, fontWeight: 700, padding: "1px 6px", borderRadius: 10, background: "rgba(34,197,94,0.15)", color: "var(--success)", border: "1px solid rgba(34,197,94,0.3)", whiteSpace: "nowrap" }}>
                  ✓ Pronta
                </span>
              )}
            </div>
            <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 1 }}>@{acc.username}</div>
            <div style={{ marginTop: 5 }}>
              <CategoryBadge catId={effectiveCat} size="xs" />
              {categoryOverride && (
                <span style={{ marginLeft: 5, fontSize: 9, color: "var(--accent2)", fontStyle: "italic" }}>manual</span>
              )}
            </div>
          </div>

          {/* Stats rápidos */}
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4, flexShrink: 0 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>
              {fmt(acc.followers_count ?? null)}
              <span style={{ fontSize: 9, color: "var(--muted)", fontWeight: 400, marginLeft: 2 }}>seg</span>
            </span>
            {drop !== null && (
              <span style={{
                fontSize: 10, fontWeight: 700,
                color: drop >= 40 ? "var(--danger)" : drop >= 20 ? "var(--warning)" : "var(--success)",
              }}>
                {drop > 0 ? `↓${drop}%` : `↑${Math.abs(drop)}%`} reach
              </span>
            )}
          </div>

          <span style={{ color: "var(--muted)", fontSize: 12, marginLeft: 4, flexShrink: 0 }}>
            {expanded ? "▲" : "▼"}
          </span>
        </div>

        {/* Health score bar sempre visível */}
        {healthResult?.score != null && (
          <div style={{ marginTop: 10 }}>
            <ScoreBar score={healthResult.score} />
          </div>
        )}
      </div>

      {/* ── Conteúdo expandido ── */}
      {expanded && (
        <div style={{ borderTop: "1px solid var(--border)", padding: "14px 16px" }}>

          {/* Grid de campos */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px 16px", marginBottom: 14 }}>

            {/* Email */}
            <InfoField label="Email">
              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <span style={{ fontSize: 12, color: "var(--text2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 130 }}>
                  {acc.email || "—"}
                </span>
                {acc.email && (
                  <button
                    onClick={() => copyToClipboard(acc.email, setCopied, `email-${acc.id}`)}
                    style={{ background: "none", color: copied === `email-${acc.id}` ? "var(--success)" : "var(--muted)", fontSize: 11, padding: "0 2px", flexShrink: 0 }}
                  >
                    {copied === `email-${acc.id}` ? "✓" : "⧉"}
                  </button>
                )}
              </div>
            </InfoField>

            {/* Senha */}
            <InfoField label="Senha">
              <PasswordField password={acc.password} copied={copied} setCopied={setCopied} accId={acc.id} />
            </InfoField>

            {/* Token 2FA */}
            <InfoField label="Token 2FA">
              {acc.totp_secret ? (
                <button
                  onClick={handle2FA}
                  style={{
                    display: "inline-flex", alignItems: "center", gap: 5,
                    fontSize: 11, fontWeight: 600, padding: "3px 9px", borderRadius: 6,
                    background: copied === `2fa-${acc.id}` ? "rgba(34,197,94,0.15)" : "rgba(56,189,248,0.1)",
                    color: copied === `2fa-${acc.id}` ? "var(--success)" : "var(--info)",
                    border: `1px solid ${copied === `2fa-${acc.id}` ? "rgba(34,197,94,0.3)" : "rgba(56,189,248,0.25)"}`,
                    cursor: "pointer",
                  }}
                >
                  {copied === `2fa-${acc.id}` ? "✓ Copiado!" : "🔐 Copiar 2FA"}
                </button>
              ) : <span style={{ color: "var(--muted)", fontSize: 12 }}>—</span>}
            </InfoField>

            {/* Followers */}
            <InfoField label="Seguidores">
              <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>
                {fmt(acc.followers_count ?? null)}
              </span>
            </InfoField>

            {/* Reach Drop */}
            <InfoField label="Reach Drop (7d)">
              {drop !== null ? (
                <span style={{
                  fontSize: 12, fontWeight: 700,
                  color: drop >= 40 ? "var(--danger)" : drop >= 20 ? "var(--warning)" : "var(--success)",
                }}>
                  {drop > 0 ? `↓ ${drop}%` : `↑ ${Math.abs(drop)}%`}
                </span>
              ) : <span style={{ color: "var(--muted)", fontSize: 12 }}>—</span>}
            </InfoField>

            {/* Shadowban Risk */}
            <InfoField label="Shadowban Risk">
              <span style={{
                fontSize: 11, fontWeight: 700,
                color: shadowban ? "var(--danger)" : "var(--success)",
              }}>
                {shadowban ? "⚠️ Detectado" : "✓ Limpo"}
              </span>
            </InfoField>

            {/* Status do token */}
            <InfoField label="Token">
              <span style={{
                fontSize: 11, fontWeight: 700,
                color: acc.token_status === "expired" ? "var(--danger)" : "var(--success)",
              }}>
                {acc.token_status === "expired" ? "🔑 Expirado" : "✓ Ativo"}
              </span>
            </InfoField>

            {/* Data de conexão */}
            <InfoField label="Conectado em">
              <span style={{ fontSize: 11, color: "var(--text2)" }}>{fmtDate(acc.connected_at)}</span>
            </InfoField>

            {/* Último post */}
            {acc.last_post_at && (
              <InfoField label="Último post">
                <span style={{ fontSize: 11, color: "var(--text2)" }}>{fmtDate(acc.last_post_at)}</span>
              </InfoField>
            )}

          </div>

          {/* Categoria manual */}
          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 10, color: "var(--muted)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", display: "block", marginBottom: 5 }}>
              Categoria manual
            </label>
            <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
              {CATEGORIES.filter((c) => c.id !== "todas").map((c) => {
                const isActive = (categoryOverride || effectiveCat) === c.id && categoryOverride;
                return (
                  <button
                    key={c.id}
                    onClick={() => onCategoryChange(acc.id, categoryOverride === c.id ? null : c.id)}
                    style={{
                      fontSize: 10, fontWeight: 700, padding: "3px 9px", borderRadius: 20, cursor: "pointer",
                      color: isActive ? c.color : "var(--muted)",
                      background: isActive ? c.bg : "transparent",
                      border: `1px solid ${isActive ? c.border : "var(--border)"}`,
                      transition: "all 0.12s",
                    }}
                    title={isActive ? "Clique para remover override" : `Definir como ${c.label}`}
                  >
                    {c.emoji} {c.label}
                  </button>
                );
              })}
              {categoryOverride && (
                <button
                  onClick={() => onCategoryChange(acc.id, null)}
                  style={{ fontSize: 10, padding: "3px 8px", borderRadius: 20, cursor: "pointer", color: "var(--danger)", background: "transparent", border: "1px solid rgba(239,68,68,0.3)" }}
                >
                  ✕ Remover
                </button>
              )}
            </div>
            {!categoryOverride && (
              <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 4, fontStyle: "italic" }}>
                Classificação automática ativa — clique em uma categoria para sobrescrever
              </div>
            )}
          </div>

          {/* Notas */}
          <div style={{ marginBottom: 14 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 5 }}>
              <label style={{ fontSize: 10, color: "var(--muted)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", margin: 0 }}>
                Notas / Observações
              </label>
              <button
                onClick={() => setEditNote((v) => !v)}
                style={{ fontSize: 10, color: "var(--accent2)", background: "none", padding: 0 }}
              >
                {editNote ? "✓ Salvar" : "✏️ Editar"}
              </button>
            </div>
            {editNote ? (
              <textarea
                value={noteDraft}
                onChange={(e) => setNoteDraft(e.target.value)}
                onBlur={handleNoteBlur}
                placeholder="Adicione observações sobre esta conta..."
                style={{ minHeight: 64, fontSize: 12, resize: "vertical" }}
                autoFocus
              />
            ) : (
              <div style={{
                fontSize: 12, color: noteDraft ? "var(--text2)" : "var(--muted)",
                padding: "8px 10px", borderRadius: 8, background: "var(--bg3)",
                border: "1px solid var(--border)", minHeight: 40, lineHeight: 1.5,
                whiteSpace: "pre-wrap", fontStyle: noteDraft ? "normal" : "italic",
                cursor: "text",
              }}
                onClick={() => setEditNote(true)}
              >
                {noteDraft || "Sem notas. Clique para adicionar..."}
              </div>
            )}
          </div>

          {/* Ações rápidas */}
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button
              onClick={handleCopyCredentials}
              className="btn btn-ghost btn-xs"
              style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11 }}
            >
              {copied === `cred-${acc.id}` ? "✓ Copiado!" : "📋 Copiar credenciais"}
            </button>
            {acc.totp_secret && (
              <a
                href={`https://2fa.live/tok/${acc.totp_secret}`}
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn-ghost btn-xs"
                style={{ fontSize: 11, display: "flex", alignItems: "center", gap: 5 }}
              >
                🔐 Abrir 2FA.live
              </a>
            )}
          </div>

        </div>
      )}
    </div>
  );
}

/** Campo de info padronizado */
function InfoField({ label, children }) {
  return (
    <div>
      <div style={{ fontSize: 9, color: "var(--muted)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 3 }}>
        {label}
      </div>
      {children}
    </div>
  );
}

// ─── Componente Principal ─────────────────────────────────────────────────────

export default function Profiles() {
  const { accounts, loading }          = useAccounts();
  const { getAccountResult, runCheck } = useHealthCheck(accounts, {});

  const [activeTab,   setActiveTab]   = useState("todas");
  const [search,      setSearch]      = useState("");
  const [readyOnly,   setReadyOnly]   = useState(false);
  const [overrides,   setOverrides]   = useState({});    // { [accId]: catId | null }
  const [notes,       setNotes]       = useState({});    // { [accId]: string }
  const [dbLoaded,    setDbLoaded]    = useState(false);

  // Carrega overrides e notas do IndexedDB na montagem
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

  // Persiste override de categoria
  const handleCategoryChange = useCallback(async (accId, catId) => {
    const updated = { ...overrides, [accId]: catId };
    if (catId === null) delete updated[accId];
    setOverrides(updated);
    await dbPut(DB_STORE, { id: DB_KEY_CAT, data: updated, updatedAt: new Date().toISOString() });
  }, [overrides]);

  // Persiste nota
  const handleNoteChange = useCallback(async (accId, text) => {
    const updated = { ...notes, [accId]: text };
    if (!text) delete updated[accId];
    setNotes(updated);
    await dbPut(DB_STORE, { id: DB_KEY_NOTE, data: updated, updatedAt: new Date().toISOString() });
  }, [notes]);

  // Contas enriquecidas com categoria efetiva
  const enriched = useMemo(() => {
    return accounts.map((acc) => {
      const healthResult = getAccountResult(acc.id);
      const effectiveCat = overrides[acc.id] || autoClassify(acc, healthResult);
      return { acc, healthResult, effectiveCat };
    });
  }, [accounts, getAccountResult, overrides]);

  // Contadores por categoria
  const counts = useMemo(() => {
    const c = { todas: enriched.length };
    for (const { effectiveCat } of enriched) {
      c[effectiveCat] = (c[effectiveCat] || 0) + 1;
    }
    return c;
  }, [enriched]);

  // Filtragem final
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return enriched.filter(({ acc, effectiveCat }) => {
      if (activeTab !== "todas" && effectiveCat !== activeTab) return false;
      if (readyOnly && effectiveCat !== "ativa" && effectiveCat !== "premium") return false;
      if (q) {
        const hay = [acc.username, acc.name, acc.email, acc.nickname].filter(Boolean).join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [enriched, activeTab, search, readyOnly]);

  // ── Render ──────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: 80 }}>
        <span className="spinner" style={{ width: 28, height: 28, borderTopColor: "var(--accent)", borderWidth: 3 }} />
        <span style={{ marginLeft: 14, color: "var(--muted)", fontSize: 14 }}>Carregando perfis...</span>
      </div>
    );
  }

  if (!accounts.length) {
    return (
      <div style={{ padding: 40, textAlign: "center" }}>
        <div style={{ fontSize: 48, marginBottom: 12 }}>👤</div>
        <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text)", marginBottom: 6 }}>Nenhuma conta conectada</div>
        <div style={{ fontSize: 13, color: "var(--muted)" }}>Conecte uma conta do Instagram para gerenciar os perfis aqui.</div>
      </div>
    );
  }

  return (
    <div style={{ padding: "24px 20px", maxWidth: 1100, margin: "0 auto" }}>

      {/* ── Header ── */}
      <div style={{ marginBottom: 20, display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 800, color: "var(--text)", lineHeight: 1.2 }}>
            Perfis <span style={{ fontSize: 14, fontWeight: 500, color: "var(--muted)", marginLeft: 6 }}>{accounts.length} conta{accounts.length !== 1 ? "s" : ""}</span>
          </h1>
          <p style={{ fontSize: 13, color: "var(--muted)", marginTop: 3 }}>
            Gerencie, classifique e monitore todos os perfis Instagram
          </p>
        </div>
        <button
          onClick={() => runCheck(true)}
          className="btn btn-ghost btn-sm"
          style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}
        >
          🔄 Atualizar Health Check
        </button>
      </div>

      {/* ── Tabs de categoria ── */}
      <div style={{
        display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 16,
        padding: "4px", background: "var(--bg2)", borderRadius: 12, border: "1px solid var(--border)",
      }}>
        {CATEGORIES.map((cat) => {
          const isActive = activeTab === cat.id;
          const count    = counts[cat.id] || 0;
          return (
            <button
              key={cat.id}
              onClick={() => setActiveTab(cat.id)}
              style={{
                display: "flex", alignItems: "center", gap: 5,
                padding: "6px 13px", borderRadius: 9, fontSize: 12, fontWeight: isActive ? 700 : 500,
                color: isActive ? cat.color : "var(--muted)",
                background: isActive ? cat.bg : "transparent",
                border: isActive ? `1px solid ${cat.border}` : "1px solid transparent",
                transition: "all 0.15s", cursor: "pointer",
              }}
            >
              <span style={{ lineHeight: 1 }}>{cat.emoji}</span>
              <span>{cat.label}</span>
              {count > 0 && (
                <span style={{
                  fontSize: 10, fontWeight: 700, padding: "1px 6px", borderRadius: 10,
                  background: isActive ? `${cat.color}22` : "var(--bg3)",
                  color: isActive ? cat.color : "var(--muted)",
                  border: `1px solid ${isActive ? cat.border : "var(--border)"}`,
                }}>
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* ── Barra de busca e filtros ── */}
      <div style={{ display: "flex", gap: 10, marginBottom: 20, flexWrap: "wrap", alignItems: "center" }}>
        <div style={{ position: "relative", flex: 1, minWidth: 200 }}>
          <span style={{ position: "absolute", left: 11, top: "50%", transform: "translateY(-50%)", color: "var(--muted)", fontSize: 14, pointerEvents: "none" }}>🔍</span>
          <input
            type="text"
            placeholder="Buscar por username, nome ou email..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ paddingLeft: 34, paddingRight: search ? 32 : 13 }}
          />
          {search && (
            <button
              onClick={() => setSearch("")}
              style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", background: "none", color: "var(--muted)", fontSize: 14 }}
            >
              ✕
            </button>
          )}
        </div>

        {/* Toggle "Pronto para subir" */}
        <button
          onClick={() => setReadyOnly((v) => !v)}
          style={{
            display: "flex", alignItems: "center", gap: 6, padding: "9px 14px",
            borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer",
            color: readyOnly ? "var(--success)" : "var(--muted)",
            background: readyOnly ? "rgba(34,197,94,0.1)" : "var(--bg3)",
            border: readyOnly ? "1px solid rgba(34,197,94,0.3)" : "1px solid var(--border)",
            transition: "all 0.15s",
          }}
        >
          {readyOnly ? "✅" : "📋"} Prontas para subir
        </button>
      </div>

      {/* ── Resultado da busca ── */}
      {search && (
        <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 14 }}>
          {filtered.length} resultado{filtered.length !== 1 ? "s" : ""} para <strong style={{ color: "var(--accent2)" }}>"{search}"</strong>
        </div>
      )}

      {/* ── Grid de cards ── */}
      {filtered.length === 0 ? (
        <div style={{ textAlign: "center", padding: 48, color: "var(--muted)" }}>
          <div style={{ fontSize: 36, marginBottom: 10 }}>🔎</div>
          <div style={{ fontSize: 14, fontWeight: 600 }}>Nenhum perfil encontrado</div>
          <div style={{ fontSize: 12, marginTop: 4 }}>Tente outra busca ou mude a aba.</div>
        </div>
      ) : (
        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
          gap: 14,
        }}>
          {filtered.map(({ acc, healthResult }) => (
            <ProfileCard
              key={acc.id}
              acc={acc}
              healthResult={healthResult}
              categoryOverride={overrides[acc.id] || null}
              noteOverride={notes[acc.id] || ""}
              onCategoryChange={handleCategoryChange}
              onNoteChange={handleNoteChange}
            />
          ))}
        </div>
      )}

      {/* ── Spinner do DB ── */}
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
