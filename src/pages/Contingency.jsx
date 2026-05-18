// ─── src/pages/Contingency.jsx ────────────────────────────────────────────────
// Aba de Contingência — badges de copiar + TOTP nativo + layout mobile
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useCallback, useRef } from "react";

// ─── TOTP nativo via Web Crypto API (RFC 6238) ────────────────────────────────

/** Decodifica base32 para Uint8Array */
function base32Decode(str) {
  const CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = str.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0, val = 0;
  const out = [];
  for (const ch of clean) {
    val = (val << 5) | CHARS.indexOf(ch);
    bits += 5;
    if (bits >= 8) { bits -= 8; out.push((val >> bits) & 0xff); }
  }
  return new Uint8Array(out);
}

/** Gera código TOTP de 6 dígitos para uma chave base32 */
async function generateTOTP(secret) {
  try {
    const key   = base32Decode(secret);
    const epoch = Math.floor(Date.now() / 1000);
    const T     = Math.floor(epoch / 30);
    // counter como 8 bytes big-endian
    const msg   = new Uint8Array(8);
    let tmp = T;
    for (let i = 7; i >= 0; i--) { msg[i] = tmp & 0xff; tmp >>= 8; }

    const cryptoKey = await crypto.subtle.importKey(
      "raw", key, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]
    );
    const sig    = await crypto.subtle.sign("HMAC", cryptoKey, msg);
    const hmac   = new Uint8Array(sig);
    const offset = hmac[19] & 0xf;
    const code   = (
      ((hmac[offset]     & 0x7f) << 24) |
      ((hmac[offset + 1] & 0xff) << 16) |
      ((hmac[offset + 2] & 0xff) <<  8) |
       (hmac[offset + 3] & 0xff)
    ) % 1_000_000;
    return String(code).padStart(6, "0");
  } catch {
    return null;
  }
}

/** Segundos restantes na janela TOTP atual */
function totpSecondsLeft() {
  return 30 - (Math.floor(Date.now() / 1000) % 30);
}

// ─── DB local ─────────────────────────────────────────────────────────────────
let _ctgDb = null;
async function openContingencyDB() {
  if (_ctgDb) return _ctgDb;
  return new Promise((resolve, reject) => {
    const probe = indexedDB.open("insta_manager");
    probe.onsuccess = () => {
      const currentVersion = probe.result.version;
      probe.result.close();
      const targetVersion = Math.max(currentVersion, 6);
      const req = indexedDB.open("insta_manager", targetVersion);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains("contingency"))
          db.createObjectStore("contingency", { keyPath: "id" });
      };
      req.onsuccess = () => { _ctgDb = req.result; resolve(_ctgDb); };
      req.onerror  = () => reject(req.error);
    };
    probe.onerror = () => reject(probe.error);
  });
}
async function ctgGetAll() {
  const db = await openContingencyDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction("contingency", "readonly");
    const req = tx.objectStore("contingency").getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror   = () => reject(req.error);
  });
}
async function ctgPut(item) {
  const db = await openContingencyDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("contingency", "readwrite");
    tx.objectStore("contingency").put(item);
    tx.oncomplete = resolve;
    tx.onerror    = reject;
  });
}
async function ctgDelete(id) {
  const db = await openContingencyDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("contingency", "readwrite");
    tx.objectStore("contingency").delete(id);
    tx.oncomplete = resolve;
    tx.onerror    = reject;
  });
}

// ─── Constantes ───────────────────────────────────────────────────────────────

const STATUS_OPTIONS = [
  { value: "preparada",  label: "🟡 Preparada",  color: "#f59e0b", bg: "rgba(245,158,11,0.12)"  },
  { value: "em_edicao",  label: "✏️ Em Edição",  color: "#38bdf8", bg: "rgba(56,189,248,0.12)"  },
  { value: "pronta",     label: "✅ Pronta",      color: "#22c55e", bg: "rgba(34,197,94,0.12)"   },
  { value: "em_uso",     label: "🔄 Em Uso",      color: "#a78bfa", bg: "rgba(167,139,250,0.12)" },
  { value: "descartada", label: "⛔ Descartada",  color: "#ef4444", bg: "rgba(239,68,68,0.12)"   },
];
const QUALITY_OPTIONS = [
  { value: "premium", label: "⭐ Premium", color: "#f59e0b" },
  { value: "boa",     label: "🟢 Boa",     color: "#22c55e" },
  { value: "media",   label: "🟠 Média",   color: "#fb923c" },
  { value: "risco",   label: "🔴 Risco",   color: "#ef4444" },
];
const statusInfo  = (v) => STATUS_OPTIONS.find((s) => s.value === v)  || STATUS_OPTIONS[0];
const qualityInfo = (v) => QUALITY_OPTIONS.find((q) => q.value === v) || QUALITY_OPTIONS[1];

// ─── Utilitários ──────────────────────────────────────────────────────────────

function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
}
function uid() { return `ct-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; }
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    const el = document.createElement("textarea");
    el.value = text; document.body.appendChild(el); el.select();
    document.execCommand("copy"); document.body.removeChild(el); return true;
  }
}
function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const sep = lines[0].includes(";") ? ";" : ",";
  const rawHeaders = lines[0].split(sep).map((h) => h.trim().toLowerCase().replace(/[^a-z0-9_]/g, ""));
  const COL_MAP = {
    username: ["username","user","login","usuario","conta","account","perfil"],
    senha:    ["senha","password","pass","pw","secret"],
    token2fa: ["token2fa","token","2fa","otp","totp","chave2fa"],
    nome:     ["nome","name","display","apelido"],
  };
  const colIndex = {};
  for (const [key, aliases] of Object.entries(COL_MAP)) {
    const idx = rawHeaders.findIndex((h) => aliases.includes(h));
    if (idx !== -1) colIndex[key] = idx;
  }
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(sep).map((c) => c.trim().replace(/^"|"$/g, ""));
    if (cells.every((c) => !c)) continue;
    const row = {};
    for (const [key, idx] of Object.entries(colIndex)) row[key] = cells[idx] || "";
    if (!row.username) continue;
    rows.push(row);
  }
  return rows;
}
function exportCSV(accounts) {
  const headers = ["username","senha","token2fa","nome","status","qualidade","notas","atualizado_em"];
  const escape  = (v) => `"${String(v||"").replace(/"/g,'""')}"`;
  return [
    headers.join(","),
    ...accounts.map((a) =>
      [a.username,a.senha,a.token2fa,a.nome,a.status,a.qualidade,a.notas,a.updated_at].map(escape).join(",")
    ),
  ].join("\n");
}

// ─── Sub-componentes ──────────────────────────────────────────────────────────

function CopyBadge({ text, title = "Copiar" }) {
  const [copied, setCopied] = useState(false);
  if (!text) return null;
  const handle = async (e) => {
    e.stopPropagation();
    await copyText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button onClick={handle} title={title} style={{
      display: "inline-flex", alignItems: "center", gap: 3,
      background: copied ? "rgba(34,197,94,0.15)" : "rgba(255,255,255,0.06)",
      border: `1px solid ${copied ? "rgba(34,197,94,0.5)" : "rgba(255,255,255,0.12)"}`,
      borderRadius: 5, padding: "2px 7px", fontSize: 10, fontWeight: 600,
      color: copied ? "#22c55e" : "var(--muted)",
      cursor: "pointer", transition: "all 0.15s", whiteSpace: "nowrap", flexShrink: 0,
    }}>
      {copied ? "✓ Copiado" : "⎘ Copiar"}
    </button>
  );
}

function FieldWithCopy({ value, onChange, placeholder, monospace = false, copyTitle }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 5, width: "100%" }}>
      <input
        type="text" defaultValue={value || ""}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={{ flex: 1, minWidth: 0, fontSize: 12, padding: "5px 8px", fontFamily: monospace ? "monospace" : "inherit" }}
      />
      <CopyBadge text={value} title={copyTitle || `Copiar ${placeholder}`} />
    </div>
  );
}

function PasswordCell({ value, onChange }) {
  const [revealed, setRevealed] = useState(false);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 5, width: "100%" }}>
      <input
        type={revealed ? "text" : "password"} defaultValue={value || ""}
        onChange={(e) => onChange(e.target.value)} placeholder="senha"
        style={{ flex: 1, minWidth: 0, fontSize: 12, padding: "5px 8px", fontFamily: revealed ? "inherit" : "monospace" }}
      />
      <button onClick={() => setRevealed((r) => !r)} title={revealed ? "Ocultar" : "Revelar"}
        style={{ background: "transparent", border: "1px solid var(--border2)", borderRadius: 5, padding: "4px 6px", fontSize: 12, color: "var(--muted)", cursor: "pointer", flexShrink: 0 }}>
        {revealed ? "🙈" : "👁️"}
      </button>
      <CopyBadge text={value} title="Copiar senha" />
    </div>
  );
}

/** Célula TOTP: chave editável + código ao vivo + copiar + barra de tempo */
function TOTPCell({ secret, onChange }) {
  const [code,     setCode]     = useState(null);
  const [secsLeft, setSecsLeft] = useState(totpSecondsLeft());
  const [copied,   setCopied]   = useState(false);
  const [expanded, setExpanded] = useState(false);
  const intervalRef = useRef(null);

  // Gera código e agenda próxima atualização
  const refresh = useCallback(async (currentSecret) => {
    if (!currentSecret) { setCode(null); return; }
    const c = await generateTOTP(currentSecret);
    setCode(c);
  }, []);

  useEffect(() => {
    if (!secret) { setCode(null); return; }
    refresh(secret);
    intervalRef.current = setInterval(() => {
      setSecsLeft(totpSecondsLeft());
      refresh(secret);
    }, 1000);
    return () => clearInterval(intervalRef.current);
  }, [secret, refresh]);

  const handleCopyCode = async (e) => {
    e.stopPropagation();
    if (!code) return;
    await copyText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const urgency = secsLeft <= 5 ? "#ef4444" : secsLeft <= 10 ? "#f59e0b" : "#22c55e";
  const pct     = (secsLeft / 30) * 100;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5, width: "100%" }}>
      {/* Linha do input + badge copiar chave */}
      <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
        <input
          type={expanded ? "text" : "password"}
          defaultValue={secret || ""}
          onChange={(e) => onChange(e.target.value)}
          placeholder="chave 2FA (base32)"
          style={{ flex: 1, minWidth: 0, fontSize: 11, padding: "5px 8px", fontFamily: "monospace" }}
        />
        <button onClick={() => setExpanded((v) => !v)} title={expanded ? "Ocultar chave" : "Revelar chave"}
          style={{ background: "transparent", border: "1px solid var(--border2)", borderRadius: 5, padding: "4px 6px", fontSize: 11, color: "var(--muted)", cursor: "pointer", flexShrink: 0 }}>
          {expanded ? "🙈" : "👁️"}
        </button>
        <CopyBadge text={secret} title="Copiar chave 2FA" />
      </div>

      {/* Código TOTP ao vivo */}
      {secret && (
        <div style={{
          display: "flex", alignItems: "center", gap: 8,
          background: "rgba(0,0,0,0.25)", borderRadius: 8,
          padding: "6px 10px", border: "1px solid rgba(255,255,255,0.07)",
        }}>
          {code ? (
            <>
              {/* Código formatado XXX XXX */}
              <span style={{
                fontFamily: "monospace", fontSize: 18, fontWeight: 800,
                letterSpacing: 3, color: urgency, userSelect: "all",
              }}>
                {code.slice(0, 3)} {code.slice(3)}
              </span>

              {/* Contador + barra */}
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, flexShrink: 0 }}>
                <span style={{ fontSize: 10, fontWeight: 700, color: urgency, lineHeight: 1 }}>{secsLeft}s</span>
                <div style={{ width: 28, height: 4, background: "rgba(255,255,255,0.1)", borderRadius: 2, overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${pct}%`, background: urgency, borderRadius: 2, transition: "width 1s linear, background 0.3s" }} />
                </div>
              </div>

              {/* Botão copiar código */}
              <button onClick={handleCopyCode} title="Copiar código TOTP" style={{
                marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 4,
                background: copied ? "rgba(34,197,94,0.2)" : "rgba(255,255,255,0.08)",
                border: `1px solid ${copied ? "rgba(34,197,94,0.5)" : "rgba(255,255,255,0.15)"}`,
                borderRadius: 6, padding: "4px 10px", fontSize: 11, fontWeight: 700,
                color: copied ? "#22c55e" : "var(--text)",
                cursor: "pointer", transition: "all 0.15s", whiteSpace: "nowrap",
              }}>
                {copied ? "✓ Copiado!" : "📋 Copiar código"}
              </button>
            </>
          ) : (
            <span style={{ fontSize: 11, color: "var(--muted)" }}>⚠️ Chave inválida</span>
          )}
        </div>
      )}
    </div>
  );
}

function StatusSelect({ value, onChange }) {
  const si = statusInfo(value);
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} style={{
      fontSize: 11, padding: "5px 8px", borderRadius: 8, width: "100%",
      background: si.bg, color: si.color, border: `1px solid ${si.color}50`,
      fontWeight: 700, cursor: "pointer",
    }}>
      {STATUS_OPTIONS.map((s) => (
        <option key={s.value} value={s.value} style={{ background: "var(--bg3)", color: "var(--text)" }}>{s.label}</option>
      ))}
    </select>
  );
}
function QualitySelect({ value, onChange }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} style={{
      fontSize: 11, padding: "5px 8px", borderRadius: 8, width: "100%",
      background: "var(--bg3)", color: qualityInfo(value).color,
      border: "1px solid var(--border2)", fontWeight: 600, cursor: "pointer",
    }}>
      {QUALITY_OPTIONS.map((q) => (
        <option key={q.value} value={q.value} style={{ background: "var(--bg3)", color: "var(--text)" }}>{q.label}</option>
      ))}
    </select>
  );
}

// ─── Card Mobile ──────────────────────────────────────────────────────────────

function AccountCard({ acc, onFieldChange, onDelete, onCopyAll, onMoveToMain }) {
  const debounceRef = useRef({});
  const [expanded, setExpanded] = useState(false);
  const si = statusInfo(acc.status);
  const [localToken, setLocalToken] = useState(acc.token2fa || "");

  const handleDebounced = (field, value) => {
    clearTimeout(debounceRef.current[field]);
    debounceRef.current[field] = setTimeout(() => onFieldChange(acc.id, field, value), 600);
  };
  const handleImmediate = (field, value) => onFieldChange(acc.id, field, value);

  return (
    <div style={{
      background: "var(--bg2)",
      border: `1px solid ${expanded ? si.color + "40" : "var(--border)"}`,
      borderRadius: 12, marginBottom: 10, overflow: "hidden", transition: "border-color 0.2s",
    }}>
      <div onClick={() => setExpanded((e) => !e)} style={{
        display: "flex", alignItems: "center", gap: 10,
        padding: "12px 14px", cursor: "pointer",
        background: expanded ? si.color + "08" : "transparent",
      }}>
        <div style={{ width: 8, height: 8, borderRadius: "50%", background: si.color, flexShrink: 0 }} />
        <span style={{ fontWeight: 700, fontSize: 13, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {acc.username ? `@${acc.username}` : <span style={{ color: "var(--muted)" }}>sem username</span>}
        </span>
        <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 20, background: si.bg, color: si.color, border: `1px solid ${si.color}40`, whiteSpace: "nowrap" }}>
          {si.label}
        </span>
        <span style={{ color: "var(--muted)", fontSize: 13 }}>{expanded ? "▲" : "▼"}</span>
      </div>

      {expanded && (
        <div style={{ padding: "0 14px 14px", borderTop: "1px solid var(--border)" }}>
          <div style={{ marginTop: 12 }}>
            <label style={{ fontSize: 10, color: "var(--muted)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: 4 }}>Username (@)</label>
            <FieldWithCopy value={acc.username} onChange={(v) => handleDebounced("username", v)} placeholder="@username" copyTitle="Copiar username" />
          </div>
          <div style={{ marginTop: 10 }}>
            <label style={{ fontSize: 10, color: "var(--muted)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: 4 }}>Senha</label>
            <PasswordCell value={acc.senha} onChange={(v) => handleDebounced("senha", v)} />
          </div>
          <div style={{ marginTop: 10 }}>
            <label style={{ fontSize: 10, color: "var(--muted)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: 4 }}>Token 2FA</label>
            <TOTPCell
              secret={localToken}
              onChange={(v) => { setLocalToken(v); handleDebounced("token2fa", v); }}
            />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 10 }}>
            <div>
              <label style={{ fontSize: 10, color: "var(--muted)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: 4 }}>Status</label>
              <StatusSelect value={acc.status} onChange={(v) => handleImmediate("status", v)} />
            </div>
            <div>
              <label style={{ fontSize: 10, color: "var(--muted)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: 4 }}>Qualidade</label>
              <QualitySelect value={acc.qualidade} onChange={(v) => handleImmediate("qualidade", v)} />
            </div>
          </div>
          <div style={{ marginTop: 10 }}>
            <label style={{ fontSize: 10, color: "var(--muted)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: 4 }}>Notas</label>
            <textarea defaultValue={acc.notas} onChange={(e) => handleDebounced("notas", e.target.value)} placeholder="Observações…" rows={2}
              style={{ width: "100%", fontSize: 12, padding: "6px 8px", boxSizing: "border-box", resize: "vertical" }} />
          </div>
          <div style={{ marginTop: 12, display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 6 }}>
            <span style={{ fontSize: 10, color: "var(--muted)" }}>⏱ {fmtDate(acc.updated_at)}</span>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <button className="btn btn-ghost btn-xs" onClick={() => onCopyAll(acc)} style={{ fontSize: 11 }}>📋 Copiar tudo</button>
              <button className="btn btn-xs" onClick={() => onMoveToMain(acc)} style={{ fontSize: 11, background: "rgba(124,92,252,0.1)", color: "var(--accent3)", border: "1px solid rgba(124,92,252,0.3)", borderRadius: 6, padding: "4px 10px" }}>🚀 → Principais</button>
              <button className="btn btn-danger btn-xs" onClick={() => onDelete(acc.id, acc.username)} style={{ fontSize: 11 }}>🗑️</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Linha Desktop ────────────────────────────────────────────────────────────

function AccountRow({ acc, idx, onFieldChange, onDelete, onCopyAll, onMoveToMain }) {
  const debounceRef = useRef({});
  const [localToken, setLocalToken] = useState(acc.token2fa || "");

  const handleDebounced = (field, value) => {
    clearTimeout(debounceRef.current[field]);
    debounceRef.current[field] = setTimeout(() => onFieldChange(acc.id, field, value), 600);
  };
  const handleImmediate = (field, value) => onFieldChange(acc.id, field, value);

  const si    = statusInfo(acc.status);
  const rowBg = idx % 2 === 0 ? "transparent" : "rgba(255,255,255,0.015)";

  return (
    <tr style={{ borderBottom: "1px solid var(--border)", transition: "background 0.1s" }}>
      {/* Username */}
      <td style={{ padding: "10px 12px", background: rowBg }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <div style={{ width: 6, height: 6, borderRadius: "50%", background: si.color, flexShrink: 0 }} />
          <div style={{ display: "flex", alignItems: "center", gap: 5, flex: 1, minWidth: 0 }}>
            <input type="text" defaultValue={acc.username} onChange={(e) => handleDebounced("username", e.target.value)}
              placeholder="@username" style={{ fontSize: 12, padding: "4px 8px", fontWeight: 600, flex: 1, minWidth: 80 }} />
            <CopyBadge text={acc.username} title="Copiar username" />
          </div>
        </div>
      </td>
      {/* Senha */}
      <td style={{ padding: "10px 12px", background: rowBg }}>
        <PasswordCell value={acc.senha} onChange={(v) => handleDebounced("senha", v)} />
      </td>
      {/* Token 2FA */}
      <td style={{ padding: "10px 12px", background: rowBg, minWidth: 240 }}>
        <TOTPCell
          secret={localToken}
          onChange={(v) => { setLocalToken(v); handleDebounced("token2fa", v); }}
        />
      </td>
      {/* Status */}
      <td style={{ padding: "10px 12px", background: rowBg }}>
        <StatusSelect value={acc.status} onChange={(v) => handleImmediate("status", v)} />
      </td>
      {/* Qualidade */}
      <td style={{ padding: "10px 12px", background: rowBg }}>
        <QualitySelect value={acc.qualidade} onChange={(v) => handleImmediate("qualidade", v)} />
      </td>
      {/* Notas */}
      <td style={{ padding: "10px 12px", background: rowBg }}>
        <textarea defaultValue={acc.notas} onChange={(e) => handleDebounced("notas", e.target.value)}
          placeholder="Observações…" rows={2}
          style={{ fontSize: 11, padding: "4px 8px", width: "100%", minWidth: 140, minHeight: "unset", resize: "vertical", boxSizing: "border-box" }} />
      </td>
      {/* Data */}
      <td style={{ padding: "10px 12px", background: rowBg, whiteSpace: "nowrap", color: "var(--muted)", fontSize: 11 }}>
        {fmtDate(acc.updated_at)}
      </td>
      {/* Ações */}
      <td style={{ padding: "10px 12px", background: rowBg }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          <button className="btn btn-ghost btn-xs" onClick={() => onCopyAll(acc)} style={{ fontSize: 11 }}>📋 Copiar tudo</button>
          <button className="btn btn-xs" onClick={() => onMoveToMain(acc)} style={{ fontSize: 11, background: "rgba(124,92,252,0.1)", color: "var(--accent3)", border: "1px solid rgba(124,92,252,0.3)", borderRadius: 6, padding: "4px 10px" }}>🚀 → Principais</button>
          <button className="btn btn-danger btn-xs" onClick={() => onDelete(acc.id, acc.username)}>🗑️ Excluir</button>
        </div>
      </td>
    </tr>
  );
}

// ─── Componente Principal ─────────────────────────────────────────────────────

export default function Contingency() {
  const [accounts,     setAccounts]    = useState([]);
  const [loading,      setLoading]     = useState(true);
  const [search,       setSearch]      = useState("");
  const [filterStatus, setFilterStatus]= useState("todas");
  const [toastMsg,     setToastMsg]    = useState(null);
  const [importing,    setImporting]   = useState(false);
  const [isMobile,     setIsMobile]    = useState(false);
  const fileInputRef = useRef(null);

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  const loadAccounts = useCallback(async () => {
    try {
      const all = await ctgGetAll();
      all.sort((a, b) => new Date(b.created_at||0) - new Date(a.created_at||0));
      setAccounts(all);
    } catch (err) { showToast("error", "Erro ao carregar: " + err.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { loadAccounts(); }, [loadAccounts]);

  const saveAccount = useCallback(async (account) => {
    const updated = { ...account, updated_at: new Date().toISOString() };
    await ctgPut(updated);
    setAccounts((prev) => {
      const idx = prev.findIndex((a) => a.id === updated.id);
      if (idx === -1) return [updated, ...prev];
      const copy = [...prev]; copy[idx] = updated; return copy;
    });
    return updated;
  }, []);

  const deleteAccount = useCallback(async (id) => {
    await ctgDelete(id);
    setAccounts((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const showToast = useCallback((type, text) => {
    setToastMsg({ type, text });
    setTimeout(() => setToastMsg(null), 3200);
  }, []);

  const handleFileChange = async (e) => {
    const file = e.target.files?.[0]; if (!file) return;
    e.target.value = ""; setImporting(true);
    try {
      const rows = parseCSV(await file.text());
      if (!rows.length) { showToast("error", "Nenhuma conta encontrada."); return; }
      const now = new Date().toISOString();
      const created = await Promise.all(rows.map((row) => saveAccount({
        id: uid(), username: row.username||"", senha: row.senha||"",
        token2fa: row.token2fa||"", nome: row.nome||"",
        status: "preparada", qualidade: "boa", notas: "", created_at: now, updated_at: now,
      })));
      showToast("success", `✅ ${created.length} conta(s) importada(s)!`);
    } catch (err) { showToast("error", "Erro ao importar: " + err.message); }
    finally { setImporting(false); }
  };

  const handleExport = () => {
    const csv  = exportCSV(filtered);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href = url; a.download = `contingencia_${new Date().toISOString().slice(0,10)}.csv`;
    a.click(); URL.revokeObjectURL(url);
    showToast("success", `CSV exportado com ${filtered.length} conta(s).`);
  };

  const handleFieldChange = useCallback(async (id, field, value) => {
    const account = accounts.find((a) => a.id === id); if (!account) return;
    await saveAccount({ ...account, [field]: value });
  }, [accounts, saveAccount]);

  const handleDelete = useCallback(async (id, username) => {
    if (!window.confirm(`Excluir @${username||id}?`)) return;
    await deleteAccount(id);
    showToast("success", `🗑️ @${username} excluída.`);
  }, [deleteAccount, showToast]);

  const handleCopyAll = useCallback(async (acc) => {
    const code = acc.token2fa ? await generateTOTP(acc.token2fa) : null;
    const text = [
      `👤 @${acc.username}`,
      `🔑 ${acc.senha}`,
      acc.token2fa ? `🔐 Chave 2FA: ${acc.token2fa}` : null,
      code         ? `🔢 Código TOTP: ${code}`        : null,
    ].filter(Boolean).join("\n");
    await copyText(text);
    showToast("success", `📋 Credenciais de @${acc.username} copiadas!`);
  }, [showToast]);

  const handleMoveToMain = useCallback(() => {
    showToast("error", "⚠️ Função futura. Por enquanto copie as credenciais e conecte manualmente.");
  }, [showToast]);

  const handleAddEmpty = useCallback(async () => {
    const now = new Date().toISOString();
    await saveAccount({ id: uid(), username:"", senha:"", token2fa:"", nome:"", status:"preparada", qualidade:"boa", notas:"", created_at:now, updated_at:now });
    showToast("success", "✏️ Nova conta adicionada.");
  }, [saveAccount, showToast]);

  const filtered = accounts.filter((a) => {
    const q = search.toLowerCase();
    return (!q || (a.username||"").toLowerCase().includes(q) || (a.nome||"").toLowerCase().includes(q))
      && (filterStatus === "todas" || a.status === filterStatus);
  });

  const counts = STATUS_OPTIONS.reduce((acc, s) => {
    acc[s.value] = accounts.filter((a) => a.status === s.value).length; return acc;
  }, {});

  return (
    <div style={{ padding: isMobile ? "16px 12px" : "24px 28px", maxWidth: 1400, margin: "0 auto" }}>

      {/* Toast */}
      {toastMsg && (
        <div style={{
          position:"fixed", top: isMobile?"auto":20, bottom: isMobile?80:"auto",
          right: isMobile?10:20, left: isMobile?10:"auto", zIndex:9999,
          background: toastMsg.type==="success" ? "rgba(34,197,94,0.15)" : "rgba(239,68,68,0.15)",
          border:`1px solid ${toastMsg.type==="success" ? "rgba(34,197,94,0.4)" : "rgba(239,68,68,0.4)"}`,
          color: toastMsg.type==="success" ? "var(--success)" : "var(--danger)",
          padding:"12px 16px", borderRadius:10, fontWeight:600, fontSize:13,
          boxShadow:"var(--shadow)", animation:"slideIn 0.2s ease",
        }}>
          {toastMsg.text}
        </div>
      )}

      {/* Header */}
      <div style={{ marginBottom:20 }}>
        <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", flexWrap:"wrap", gap:12 }}>
          <div>
            <h1 style={{ fontSize: isMobile?18:22, fontWeight:800, color:"var(--text)", marginBottom:4 }}>🛡️ Contingência</h1>
            {!isMobile && <p style={{ color:"var(--muted)", fontSize:13 }}>Estoque de contas preparadas manualmente — prontas para substituir em caso de ban ou shadowban.</p>}
          </div>
          <div style={{ display:"flex", gap:8, flexWrap:"wrap", alignItems:"center" }}>
            <button className="btn btn-ghost btn-sm" onClick={handleAddEmpty}>{isMobile ? "➕" : "➕ Adicionar"}</button>
            <button className="btn btn-primary btn-sm" onClick={() => fileInputRef.current?.click()} disabled={importing}>
              {importing ? <><span className="spinner" style={{ width:11,height:11,borderTopColor:"#fff" }} /> Importando...</> : isMobile ? "📥 CSV" : "📥 Importar CSV"}
            </button>
            <button className="btn btn-ghost btn-sm" onClick={handleExport} disabled={!filtered.length}>{isMobile ? "📤" : "📤 Exportar CSV"}</button>
            <input ref={fileInputRef} type="file" accept=".csv,text/csv" style={{ display:"none" }} onChange={handleFileChange} />
          </div>
        </div>
      </div>

      {/* Resumo */}
      <div style={{ display:"flex", gap:8, marginBottom:16, overflowX: isMobile?"auto":"visible", flexWrap: isMobile?"nowrap":"wrap", paddingBottom: isMobile?4:0 }}>
        <div className="card card-sm" style={{ minWidth:80, flex:"0 0 auto", textAlign:"center" }}>
          <div style={{ fontSize:20, fontWeight:800, color:"var(--accent-light)" }}>{accounts.length}</div>
          <div style={{ fontSize:10, color:"var(--muted)", marginTop:2 }}>Total</div>
        </div>
        {STATUS_OPTIONS.map((s) => (
          <button key={s.value} onClick={() => setFilterStatus((f) => f===s.value ? "todas" : s.value)} style={{
            background: filterStatus===s.value ? s.bg : "var(--bg2)",
            border:`1px solid ${filterStatus===s.value ? s.color+"80" : "var(--border)"}`,
            borderRadius:"var(--radius)", padding:"8px 12px", cursor:"pointer",
            textAlign:"center", minWidth:80, flex:"0 0 auto", transition:"all 0.15s",
          }}>
            <div style={{ fontSize:16, fontWeight:800, color:s.color }}>{counts[s.value]||0}</div>
            <div style={{ fontSize:10, color:"var(--muted)", marginTop:2 }}>{s.label}</div>
          </button>
        ))}
      </div>

      {/* Busca */}
      <div style={{ display:"flex", gap:8, marginBottom:14, flexWrap:"wrap", alignItems:"center" }}>
        <div style={{ position:"relative", flex:1, minWidth:180 }}>
          <input type="text" placeholder="Buscar por username ou nome…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ paddingLeft:34 }} />
          <span style={{ position:"absolute", left:10, top:"50%", transform:"translateY(-50%)", fontSize:14, color:"var(--muted)", pointerEvents:"none" }}>🔍</span>
        </div>
        {!isMobile && (
          <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)} style={{ minWidth:150, padding:"10px 12px" }}>
            <option value="todas">🔘 Todos os status</option>
            {STATUS_OPTIONS.map((s) => <option key={s.value} value={s.value}>{s.label} ({counts[s.value]||0})</option>)}
          </select>
        )}
        {(search || filterStatus !== "todas") && (
          <button className="btn btn-ghost btn-sm" onClick={() => { setSearch(""); setFilterStatus("todas"); }}>✕ {!isMobile && "Limpar"}</button>
        )}
        <span style={{ fontSize:11, color:"var(--muted)", marginLeft:"auto" }}>{filtered.length}/{accounts.length}</span>
      </div>

      {/* Vazio */}
      {accounts.length===0 && !loading && (
        <div style={{ background:"rgba(124,92,252,0.06)", border:"1px dashed var(--border2)", borderRadius:"var(--radius)", padding:"36px 24px", textAlign:"center", marginBottom:20 }}>
          <div style={{ fontSize:36, marginBottom:10 }}>🛡️</div>
          <div style={{ fontSize:15, fontWeight:700, color:"var(--text)", marginBottom:8 }}>Nenhuma conta de contingência ainda</div>
          <div style={{ fontSize:12, color:"var(--muted)", marginBottom:18, lineHeight:1.7 }}>
            Importe um CSV com: <code style={{ color:"var(--accent3)", background:"var(--bg3)", padding:"2px 6px", borderRadius:4 }}>username, senha, token2fa, nome</code>
          </div>
          <button className="btn btn-primary" onClick={() => fileInputRef.current?.click()} disabled={importing}>📥 Importar CSV agora</button>
        </div>
      )}

      {/* Conteúdo */}
      {filtered.length > 0 && (
        isMobile ? (
          <div>
            {filtered.map((acc) => (
              <AccountCard key={acc.id} acc={acc} onFieldChange={handleFieldChange} onDelete={handleDelete} onCopyAll={handleCopyAll} onMoveToMain={handleMoveToMain} />
            ))}
          </div>
        ) : (
          <div style={{ overflowX:"auto", borderRadius:"var(--radius)", border:"1px solid var(--border)" }}>
            <table style={{ width:"100%", borderCollapse:"collapse", fontSize:12 }}>
              <thead>
                <tr style={{ background:"var(--bg2)", borderBottom:"1px solid var(--border2)" }}>
                  {["Username (@)","Senha","Token 2FA / Código TOTP","Status","Qualidade","Notas","Atualizado em","Ações"].map((h) => (
                    <th key={h} style={{ padding:"12px 12px", textAlign:"left", fontSize:10, fontWeight:700, color:"var(--muted)", letterSpacing:"0.06em", textTransform:"uppercase", whiteSpace:"nowrap" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((acc, idx) => (
                  <AccountRow key={acc.id} acc={acc} idx={idx} onFieldChange={handleFieldChange} onDelete={handleDelete} onCopyAll={handleCopyAll} onMoveToMain={handleMoveToMain} />
                ))}
              </tbody>
            </table>
          </div>
        )
      )}

      {loading && (
        <div style={{ textAlign:"center", padding:40, color:"var(--muted)" }}>
          <span className="spinner" style={{ width:20, height:20, borderTopColor:"var(--accent)", display:"inline-block" }} />
          <div style={{ marginTop:12, fontSize:13 }}>Carregando contas…</div>
        </div>
      )}

      {accounts.length > 0 && (
        <div style={{ marginTop:14, fontSize:10, color:"var(--muted)", textAlign:"right" }}>
          💾 Dados salvos localmente (IndexedDB). Exporte CSV para backup.
        </div>
      )}

      <style>{`
        @keyframes slideIn { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:translateY(0); } }
        @keyframes spin { from { transform:rotate(0deg); } to { transform:rotate(360deg); } }
        .spinner { display:inline-block; border:2px solid rgba(255,255,255,0.1); border-radius:50%; animation:spin 0.8s linear infinite; }
        tr:hover td { background:rgba(124,92,252,0.04); }
      `}</style>
    </div>
  );
}
