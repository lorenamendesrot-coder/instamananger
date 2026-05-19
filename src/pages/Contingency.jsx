// ─── src/pages/Contingency.jsx ────────────────────────────────────────────────
// Aba de Contingência — badges de copiar + TOTP nativo + layout mobile
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useCallback, useRef } from "react";
import DrivePicker from "../components/DrivePicker.jsx";
import { useDriveAuth } from "../useDriveAuth.js";

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
    username:   ["username","user","login","usuario","conta","account","perfil"],
    senha:      ["senha","password","pass","pw","secret"],
    token2fa:   ["token2fa","token","2fa","otp","totp","chave2fa"],
    nome:       ["nome","name","display","apelido"],
    status:     ["status","estado","situacao"],
    qualidade:  ["qualidade","quality","tier"],
    notas:      ["notas","notes","obs","observacoes","observacao"],
    updated_at: ["atualizadoem","updatedat","atualizado"],
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

/** Parseia XLSX usando a lib SheetJS carregada dinamicamente */
async function parseXLSX(arrayBuffer) {
  // Carrega SheetJS via CDN se ainda não estiver disponível
  if (!window.XLSX) {
    await new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
      s.onload = resolve;
      s.onerror = () => reject(new Error("Falha ao carregar parser XLSX"));
      document.head.appendChild(s);
    });
  }
  const XLSX = window.XLSX;
  const wb   = XLSX.read(arrayBuffer, { type: "array" });
  const ws   = wb.Sheets[wb.SheetNames[0]];
  const raw  = XLSX.utils.sheet_to_json(ws, { defval: "" });
  if (!raw.length) return [];

  // Normaliza cabeçalhos
  const COL_ALIASES = {
    username:   ["username","user","login","usuario","conta","account","perfil"],
    senha:      ["senha","password","pass","pw","secret"],
    token2fa:   ["token2fa","token","2fa","otp","totp","chave2fa"],
    nome:       ["nome","name","display","apelido"],
    status:     ["status","estado","situacao"],
    qualidade:  ["qualidade","quality","tier"],
    notas:      ["notas","notes","obs","observacoes","observacao"],
    updated_at: ["atualizadoem","updatedat","atualizado"],
  };
  const firstRow   = raw[0];
  const headerKeys = Object.keys(firstRow);
  const colMap     = {};
  for (const [field, aliases] of Object.entries(COL_ALIASES)) {
    const found = headerKeys.find((k) => aliases.includes(k.toLowerCase().replace(/[^a-z0-9_]/g, "")));
    if (found) colMap[field] = found;
  }

  return raw
    .map((row) => {
      const r = {};
      for (const [field, key] of Object.entries(colMap)) r[field] = String(row[key] || "").trim();
      return r;
    })
    .filter((r) => r.username);
}

/** Detecta se é xlsx pelo nome do arquivo e chama o parser certo */
async function parseSpreadsheet(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
    const buf = await file.arrayBuffer();
    return parseXLSX(buf);
  }
  return parseCSV(await file.text());
}

/** Parseia xlsx vindo do Drive (já em ArrayBuffer) */
async function parseDriveFile(arrayBuffer, filename) {
  const name = (filename || "").toLowerCase();
  if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
    return parseXLSX(arrayBuffer);
  }
  const text = new TextDecoder("utf-8").decode(arrayBuffer);
  return parseCSV(text);
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

/** Célula TOTP: chave editável + código ao vivo compacto */
function TOTPCell({ secret, onChange }) {
  const [code,     setCode]     = useState(null);
  const [secsLeft, setSecsLeft] = useState(totpSecondsLeft());
  const [copied,   setCopied]   = useState(false);
  const [expanded, setExpanded] = useState(false);
  const intervalRef = useRef(null);

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

  const urgency = secsLeft <= 7 ? "#ef4444" : secsLeft <= 15 ? "#f59e0b" : "#22c55e";
  const pct     = (secsLeft / 30) * 100;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, width: "100%" }}>
      {/* Linha 1: input da chave + revelar + copiar chave */}
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

      {/* Linha 2: código + barra + contador + botão copiar — tudo inline e compacto */}
      {secret && (
        <div style={{
          display: "flex", alignItems: "center", gap: 6,
          background: "rgba(0,0,0,0.2)", borderRadius: 6,
          padding: "4px 8px", border: "1px solid rgba(255,255,255,0.06)",
        }}>
          {code ? (
            <>
              {/* Código XXX XXX */}
              <span style={{
                fontFamily: "monospace", fontSize: 14, fontWeight: 800,
                letterSpacing: 2, color: urgency, userSelect: "all", flexShrink: 0,
              }}>
                {code.slice(0, 3)} {code.slice(3)}
              </span>

              {/* Barra de progresso fina */}
              <div style={{ flex: 1, height: 3, background: "rgba(255,255,255,0.1)", borderRadius: 2, overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${pct}%`, background: urgency, borderRadius: 2, transition: "width 1s linear, background 0.3s" }} />
              </div>

              {/* Contador colorido */}
              <span style={{ fontSize: 11, fontWeight: 700, color: urgency, flexShrink: 0, minWidth: 22, textAlign: "right" }}>
                {secsLeft}s
              </span>

              {/* Botão copiar — só ícone */}
              <button onClick={handleCopyCode} title="Copiar código TOTP" style={{
                display: "inline-flex", alignItems: "center", justifyContent: "center",
                background: copied ? "rgba(34,197,94,0.2)" : "rgba(255,255,255,0.07)",
                border: `1px solid ${copied ? "rgba(34,197,94,0.5)" : "rgba(255,255,255,0.12)"}`,
                borderRadius: 5, width: 24, height: 24, fontSize: 13,
                cursor: "pointer", transition: "all 0.15s", flexShrink: 0,
              }}>
                {copied ? "✓" : "📋"}
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

function AccountCard({ acc, onFieldChange, onDelete, onCopyAll, onMoveToMain, selectMode, isSelected, onToggleSelect }) {
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
      <div onClick={() => selectMode ? onToggleSelect(acc.id) : setExpanded((e) => !e)} style={{
        display: "flex", alignItems: "center", gap: 10,
        padding: "12px 14px", cursor: "pointer",
        background: isSelected ? "rgba(239,68,68,0.07)" : expanded ? si.color + "08" : "transparent",
      }}>
        {selectMode && (
          <div style={{
            width: 17, height: 17, borderRadius: 5, flexShrink: 0,
            border: `2px solid ${isSelected ? "var(--danger)" : "var(--border2)"}`,
            background: isSelected ? "var(--danger)" : "transparent",
            display: "flex", alignItems: "center", justifyContent: "center", transition: "all 0.15s",
          }}>
            {isSelected && <span style={{ color: "#fff", fontSize: 10, fontWeight: 900 }}>✓</span>}
          </div>
        )}
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

function AccountRow({ acc, idx, onFieldChange, onDelete, onCopyAll, onMoveToMain, selectMode, isSelected, onToggleSelect }) {
  const debounceRef = useRef({});
  const [localToken, setLocalToken] = useState(acc.token2fa || "");

  const handleDebounced = (field, value) => {
    clearTimeout(debounceRef.current[field]);
    debounceRef.current[field] = setTimeout(() => onFieldChange(acc.id, field, value), 600);
  };
  const handleImmediate = (field, value) => onFieldChange(acc.id, field, value);

  const si    = statusInfo(acc.status);
  const rowBg = isSelected ? "rgba(239,68,68,0.06)" : idx % 2 === 0 ? "transparent" : "rgba(255,255,255,0.015)";

  return (
    <tr style={{ borderBottom: "1px solid var(--border)", transition: "background 0.1s" }}>
      {/* Username */}
      <td style={{ padding: "10px 12px", background: rowBg }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {selectMode ? (
            <div
              onClick={() => onToggleSelect(acc.id)}
              style={{
                width: 17, height: 17, borderRadius: 5, flexShrink: 0,
                border: `2px solid ${isSelected ? "var(--danger)" : "var(--border2)"}`,
                background: isSelected ? "var(--danger)" : "transparent",
                display: "flex", alignItems: "center", justifyContent: "center",
                cursor: "pointer", transition: "all 0.15s",
              }}
            >
              {isSelected && <span style={{ color: "#fff", fontSize: 10, fontWeight: 900 }}>✓</span>}
            </div>
          ) : (
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: si.color, flexShrink: 0 }} />
          )}
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
  const drive = useDriveAuth();
  const [accounts,     setAccounts]    = useState([]);
  const [loading,      setLoading]     = useState(true);
  const [search,       setSearch]      = useState("");
  const [filterStatus, setFilterStatus]= useState("todas");
  const [toastMsg,     setToastMsg]    = useState(null);
  const [importing,    setImporting]   = useState(false);
  const [syncing,      setSyncing]     = useState(false);
  const [driveFileId,  setDriveFileId] = useState(() => localStorage.getItem("ctg_drive_file_id") || null);
  const [isMobile,     setIsMobile]    = useState(false);
  const [drivePickerOpen, setDrivePickerOpen] = useState(false);
  const [selected,     setSelected]    = useState(new Set()); // ids selecionados para exclusão em lote
  const [selectMode,   setSelectMode]  = useState(false);     // modo seleção ativo
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

  // Callback quando o DrivePicker entrega um arquivo selecionado
  const handlePickFromDrive = useCallback(async (files, accessToken) => {
    const file = files?.[0]; if (!file) return;
    setDrivePickerOpen(false);
    setImporting(true);
    try {
      if (!accessToken) throw new Error("Sessão do Drive expirada. Reconecte o Drive.");
      const res = await fetch(
        `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      if (res.status === 401) throw new Error("Token do Drive expirado. Reconecte o Drive.");
      if (res.status === 403) throw new Error("Sem permissão para acessar este arquivo.");
      if (res.status === 404) throw new Error("Arquivo não encontrado no Drive.");
      if (!res.ok) throw new Error(`Erro ao baixar arquivo: HTTP ${res.status}`);
      const arrayBuffer = await res.arrayBuffer();
      const rows = await parseDriveFile(arrayBuffer, file.name);
      if (!rows.length) { showToast("error", "Nenhuma conta encontrada no CSV."); return; }

      // ── Merge inteligente: usa updated_at para resolver conflitos ──────────
      const now = new Date().toISOString();
      const existing = await ctgGetAll();
      const byUsername = Object.fromEntries(existing.map((a) => [a.username?.toLowerCase(), a]));

      const VALID_STATUS = ["em_edicao","pronta","em_uso","descartada"];
      const VALID_QUALITY = ["premium","boa","media","risco"];

      let created = 0, updated = 0, skipped = 0;

      for (const row of rows) {
        const key = row.username?.toLowerCase();
        if (!key) continue;

        // Normaliza campos vindos do CSV
        const csvStatus   = VALID_STATUS.includes(row.status)   ? row.status   : null;
        const csvQuality  = VALID_QUALITY.includes(row.qualidade)? row.qualidade: null;
        const csvUpdated  = row.updated_at || null;

        if (byUsername[key]) {
          // Conta já existe — compara timestamps para decidir se atualiza
          const local = byUsername[key];
          const localTs = local.updated_at ? new Date(local.updated_at).getTime() : 0;
          const driveTs = csvUpdated        ? new Date(csvUpdated).getTime()       : 0;

          if (driveTs > localTs) {
            // Drive é mais recente — atualiza campos que o CSV tem
            const merged = {
              ...local,
              senha:    row.senha    || local.senha,
              token2fa: row.token2fa || local.token2fa,
              nome:     row.nome     || local.nome,
              status:   csvStatus    || local.status,
              qualidade:csvQuality   || local.qualidade,
              notas:    row.notas    !== undefined ? row.notas : local.notas,
              updated_at: csvUpdated || local.updated_at,
            };
            await ctgPut(merged);
            byUsername[key] = merged;
            updated++;
          } else {
            skipped++; // local é mais recente ou igual — não sobrescreve
          }
        } else {
          // Conta nova — cria com dados do CSV
          const novaConta = {
            id:        uid(),
            username:  row.username || "",
            senha:     row.senha    || "",
            token2fa:  row.token2fa || "",
            nome:      row.nome     || "",
            status:    csvStatus    || "em_edicao",
            qualidade: csvQuality   || "boa",
            notas:     row.notas    || "",
            created_at: now,
            updated_at: csvUpdated  || now,
          };
          await ctgPut(novaConta);
          byUsername[key] = novaConta;
          created++;
        }
      }

      await loadAccounts(); // recarrega tudo do IDB
      const parts = [];
      if (created)  parts.push(`${created} nova${created!==1?"s":""}`);
      if (updated)  parts.push(`${updated} atualizada${updated!==1?"s":""}`);
      if (skipped)  parts.push(`${skipped} já atualizada${skipped!==1?"s":""} localmente`);
      showToast("success", `✅ Sync Drive: ${parts.join(", ")}.`);
    } catch (err) {
      showToast("error", "Erro ao importar do Drive: " + err.message);
    } finally {
      setImporting(false);
    }
  }, [showToast, loadAccounts]);

  const handleFileChange = async (e) => {
    const file = e.target.files?.[0]; if (!file) return;
    e.target.value = ""; setImporting(true);
    try {
      const rows = await parseSpreadsheet(file);
      if (!rows.length) { showToast("error", "Nenhuma conta encontrada."); return; }

      const now = new Date().toISOString();
      const existing = await ctgGetAll();
      const byUsername = Object.fromEntries(existing.map((a) => [a.username?.toLowerCase(), a]));

      const VALID_STATUS  = ["em_edicao","pronta","em_uso","descartada"];
      const VALID_QUALITY = ["premium","boa","media","risco"];
      let created = 0, updated = 0, skipped = 0;

      for (const row of rows) {
        const key = row.username?.toLowerCase();
        if (!key) continue;
        const csvStatus   = VALID_STATUS.includes(row.status)    ? row.status    : null;
        const csvQuality  = VALID_QUALITY.includes(row.qualidade) ? row.qualidade : null;
        const csvUpdated  = row.updated_at || null;

        if (byUsername[key]) {
          const local   = byUsername[key];
          const localTs = local.updated_at ? new Date(local.updated_at).getTime() : 0;
          const fileTs  = csvUpdated        ? new Date(csvUpdated).getTime()       : 0;
          if (fileTs > localTs) {
            const merged = {
              ...local,
              senha:    row.senha    || local.senha,
              token2fa: row.token2fa || local.token2fa,
              nome:     row.nome     || local.nome,
              status:   csvStatus    || local.status,
              qualidade:csvQuality   || local.qualidade,
              notas:    row.notas    !== undefined ? row.notas : local.notas,
              updated_at: csvUpdated || local.updated_at,
            };
            await ctgPut(merged);
            byUsername[key] = merged;
            updated++;
          } else { skipped++; }
        } else {
          const novaConta = {
            id: uid(), username: row.username||"", senha: row.senha||"",
            token2fa: row.token2fa||"", nome: row.nome||"",
            status: csvStatus||"em_edicao", qualidade: csvQuality||"boa",
            notas: row.notas||"", created_at: now, updated_at: csvUpdated||now,
          };
          await ctgPut(novaConta);
          byUsername[key] = novaConta;
          created++;
        }
      }

      await loadAccounts();
      const parts = [];
      if (created) parts.push(`${created} nova${created!==1?"s":""}`);
      if (updated) parts.push(`${updated} atualizada${updated!==1?"s":""}`);
      if (skipped) parts.push(`${skipped} já atualizada${skipped!==1?"s":""} localmente`);
      showToast("success", `✅ ${parts.join(", ")}.`);
    } catch (err) { showToast("error", "Erro ao importar: " + err.message); }
    finally { setImporting(false); }
  };

  // Normaliza status antigos ("preparada") para o equivalente atual
  const normalizeStatus = (s) => s === "preparada" ? "em_edicao" : s;

  const filtered = accounts.filter((a) => {
    const q = search.toLowerCase();
    const status = normalizeStatus(a.status);
    return (!q || (a.username||"").toLowerCase().includes(q) || (a.nome||"").toLowerCase().includes(q))
      && (filterStatus === "todas" || status === filterStatus);
  });

  const counts = STATUS_OPTIONS.reduce((acc, s) => {
    acc[s.value] = accounts.filter((a) => normalizeStatus(a.status) === s.value).length; return acc;
  }, {});

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

  // ── Seleção em lote ──────────────────────────────────────────────────────────
  const toggleSelectMode = useCallback(() => {
    setSelectMode((v) => { if (v) setSelected(new Set()); return !v; });
  }, []);

  const toggleSelectOne = useCallback((id) => {
    setSelected((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }, []);

  const selectAllFiltered = useCallback(() => {
    setSelected(new Set(filtered.map((a) => a.id)));
  }, [filtered]);

  const deselectAll = useCallback(() => setSelected(new Set()), []);

  const handleDeleteSelected = useCallback(async () => {
    if (!selected.size) return;
    const names = accounts.filter((a) => selected.has(a.id)).map((a) => `@${a.username||a.id}`);
    const preview = names.slice(0, 5).join(", ") + (names.length > 5 ? ` e mais ${names.length - 5}` : "");
    if (!window.confirm(`Excluir ${selected.size} conta(s)?\n\n${preview}`)) return;
    const ids = [...selected];
    await Promise.all(ids.map((id) => ctgDelete(id)));
    setAccounts((prev) => prev.filter((a) => !selected.has(a.id)));
    setSelected(new Set());
    showToast("success", `🗑️ ${ids.length} conta(s) excluída(s).`);
  }, [selected, accounts, showToast]);

  const handleAddEmpty = useCallback(async () => {
    const now = new Date().toISOString();
    await saveAccount({ id: uid(), username:"", senha:"", token2fa:"", nome:"", status:"em_edicao", qualidade:"boa", notas:"", created_at:now, updated_at:now });
    showToast("success", "✏️ Nova conta adicionada.");
  }, [saveAccount, showToast]);

  // ── Salvar CSV no Drive ──────────────────────────────────────────────────────
  const handleSaveToDrive = useCallback(async () => {
    if (!drive.isConnected) {
      showToast("error", "⚠️ Conecte o Drive primeiro clicando no botão Drive.");
      return;
    }
    if (!accounts.length) { showToast("error", "Nenhuma conta para salvar."); return; }
    setSyncing(true);
    try {
      const token = await drive.getValidToken();
      const csv   = exportCSV(accounts);
      const blob  = new Blob([csv], { type: "text/csv;charset=utf-8;" });
      const filename = "contingencia.csv";

      if (driveFileId) {
        // Atualiza o arquivo existente (PATCH)
        const res = await fetch(
          `https://www.googleapis.com/upload/drive/v3/files/${driveFileId}?uploadType=media`,
          { method: "PATCH", headers: { Authorization: `Bearer ${token}`, "Content-Type": "text/csv" }, body: blob }
        );
        if (res.status === 404) {
          // Arquivo foi deletado do Drive — recria
          localStorage.removeItem("ctg_drive_file_id");
          setDriveFileId(null);
          showToast("error", "Arquivo não encontrado no Drive. Tente salvar novamente.");
          return;
        }
        if (!res.ok) throw new Error(`Erro HTTP ${res.status}`);
        showToast("success", "☁️ Salvo no Drive! Use 'Drive → importar' em outro dispositivo para sincronizar.");
      } else {
        // Cria novo arquivo
        const meta = JSON.stringify({ name: filename, mimeType: "text/csv" });
        const form = new FormData();
        form.append("metadata", new Blob([meta], { type: "application/json" }));
        form.append("file", blob);
        const res = await fetch(
          "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name",
          { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form }
        );
        if (!res.ok) throw new Error(`Erro HTTP ${res.status}`);
        const data = await res.json();
        localStorage.setItem("ctg_drive_file_id", data.id);
        setDriveFileId(data.id);
        showToast("success", `☁️ Arquivo "${filename}" criado no Drive! Use 'Drive → importar' em outro dispositivo para sincronizar.`);
      }
    } catch (err) {
      showToast("error", "Erro ao salvar no Drive: " + err.message);
    } finally {
      setSyncing(false);
    }
  }, [drive, accounts, driveFileId, showToast]);

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
            {accounts.length > 0 && (
              <button
                className="btn btn-ghost btn-sm"
                onClick={toggleSelectMode}
                style={{ color: selectMode ? "var(--danger)" : "var(--muted)", borderColor: selectMode ? "rgba(239,68,68,0.4)" : undefined }}
              >
                {selectMode ? "✕ Cancelar" : (isMobile ? "☑️" : "☑️ Selecionar")}
              </button>
            )}
            <button className="btn btn-primary btn-sm" onClick={() => fileInputRef.current?.click()} disabled={importing}>
              {importing ? <><span className="spinner" style={{ width:11,height:11,borderTopColor:"#fff" }} /> Importando...</> : isMobile ? "📥 Arquivo" : "📥 Importar CSV/XLSX"}
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => setDrivePickerOpen(true)} disabled={importing || syncing}
              style={{ display:"inline-flex", alignItems:"center", gap:6 }}>
              <svg width="16" height="14" viewBox="0 0 87.3 78" xmlns="http://www.w3.org/2000/svg">
                <path d="m6.6 66.85 3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3l13.75-23.8h-27.5c0 1.55.4 3.1 1.2 4.5z" fill="#0066da"/>
                <path d="m43.65 25-13.75-23.8c-1.35.8-2.5 1.9-3.3 3.3l-25.4 44a9.06 9.06 0 0 0 -1.2 4.5h27.5z" fill="#00ac47"/>
                <path d="m73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 7.65-13.25c.8-1.4 1.2-2.95 1.2-4.5h-27.502l5.852 11.5z" fill="#ea4335"/>
                <path d="m43.65 25 13.75-23.8c-1.35-.8-2.9-1.2-4.5-1.2h-18.5c-1.6 0-3.15.45-4.5 1.2z" fill="#00832d"/>
                <path d="m59.8 53h-32.3l-13.75 23.8c1.35.8 2.9 1.2 4.5 1.2h50.8c1.6 0 3.15-.45 4.5-1.2z" fill="#2684fc"/>
                <path d="m73.4 26.5-12.7-22c-.8-1.4-1.95-2.5-3.3-3.3l-13.75 23.8 16.15 28h27.45c0-1.55-.4-3.1-1.2-4.5z" fill="#ffba00"/>
              </svg>
              {!isMobile && "Drive"}
            </button>
            <button
              className="btn btn-ghost btn-sm"
              onClick={handleSaveToDrive}
              disabled={syncing || !accounts.length}
              title={drive.isConnected ? "Salvar CSV no Drive para sincronizar com outros dispositivos" : "Conecte o Drive primeiro"}
              style={{ display:"inline-flex", alignItems:"center", gap:6, color: drive.isConnected ? "var(--success)" : "var(--muted)", borderColor: drive.isConnected ? "rgba(34,197,94,0.35)" : undefined }}
            >
              {syncing
                ? <><span className="spinner" style={{ width:11, height:11, borderTopColor:"var(--success)" }} /> {!isMobile && "Salvando..."}</>
                : <>{!isMobile && "☁️ Salvar no Drive"}{isMobile && "☁️"}</>
              }
            </button>
            <button className="btn btn-ghost btn-sm" onClick={handleExport} disabled={!filtered.length}>{isMobile ? "📤" : "📤 Exportar CSV"}</button>
            <input ref={fileInputRef} type="file" accept=".csv,.txt,.tsv,.xlsx,.xls" style={{ display:"none" }} onChange={handleFileChange} />
          </div>
        </div>
      </div>

      {/* Barra de seleção em lote */}
      {selectMode && (
        <div style={{
          display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
          marginBottom: 14, padding: "10px 14px",
          background: selected.size > 0 ? "rgba(239,68,68,0.08)" : "rgba(255,255,255,0.04)",
          border: `1px solid ${selected.size > 0 ? "rgba(239,68,68,0.3)" : "var(--border)"}`,
          borderRadius: 10, transition: "all 0.2s",
        }}>
          {/* Checkbox selecionar tudo */}
          <label style={{ display: "flex", alignItems: "center", gap: 7, cursor: "pointer", userSelect: "none", fontSize: 13, fontWeight: 600 }}>
            <div
              onClick={selected.size === filtered.length ? deselectAll : selectAllFiltered}
              style={{
                width: 18, height: 18, borderRadius: 5, flexShrink: 0,
                border: `2px solid ${selected.size === filtered.length ? "var(--danger)" : "var(--border2)"}`,
                background: selected.size === filtered.length ? "var(--danger)" : selected.size > 0 ? "rgba(239,68,68,0.3)" : "transparent",
                display: "flex", alignItems: "center", justifyContent: "center",
                cursor: "pointer", transition: "all 0.15s",
              }}
            >
              {selected.size === filtered.length && <span style={{ color: "#fff", fontSize: 11, fontWeight: 900 }}>✓</span>}
              {selected.size > 0 && selected.size < filtered.length && <span style={{ color: "#fff", fontSize: 14, lineHeight: 1, marginTop: -1 }}>—</span>}
            </div>
            <span style={{ color: selected.size > 0 ? "var(--text)" : "var(--muted)" }}>
              {selected.size > 0 ? `${selected.size} selecionada${selected.size !== 1 ? "s" : ""}` : "Nenhuma selecionada"}
            </span>
          </label>

          <div style={{ display: "flex", gap: 6, marginLeft: "auto", flexWrap: "wrap" }}>
            <button className="btn btn-ghost btn-sm" onClick={selectAllFiltered} style={{ fontSize: 11 }}>
              ✓ Todas ({filtered.length})
            </button>
            {selected.size > 0 && (
              <button className="btn btn-ghost btn-sm" onClick={deselectAll} style={{ fontSize: 11 }}>
                ✕ Limpar
              </button>
            )}
            <button
              className="btn btn-danger btn-sm"
              onClick={handleDeleteSelected}
              disabled={selected.size === 0}
              style={{ fontSize: 11, opacity: selected.size === 0 ? 0.4 : 1 }}
            >
              🗑️ Excluir {selected.size > 0 ? `(${selected.size})` : "selecionadas"}
            </button>
          </div>
        </div>
      )}

      {/* Resumo */}
      <div style={{ display:"flex", gap:8, marginBottom:16, overflowX: isMobile?"auto":"visible", flexWrap: isMobile?"nowrap":"wrap", paddingBottom: isMobile?4:0 }}>
        <button onClick={() => { setFilterStatus("todas"); setSearch(""); }} style={{
          background: filterStatus==="todas" && !search ? "rgba(124,92,252,0.12)" : "var(--bg2)",
          border:`1px solid ${filterStatus==="todas" && !search ? "rgba(124,92,252,0.5)" : "var(--border)"}`,
          borderRadius:"var(--radius)", padding:"8px 12px", cursor:"pointer",
          textAlign:"center", minWidth:80, flex:"0 0 auto", transition:"all 0.15s",
        }}>
          <div style={{ fontSize:20, fontWeight:800, color:"var(--accent-light)" }}>{accounts.length}</div>
          <div style={{ fontSize:10, color:"var(--text)", marginTop:2 }}>Total</div>
        </button>
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
            Importe um CSV ou XLSX com: <code style={{ color:"var(--accent3)", background:"var(--bg3)", padding:"2px 6px", borderRadius:4 }}>username, senha, token2fa, nome</code>
          </div>
          <button className="btn btn-primary" onClick={() => fileInputRef.current?.click()} disabled={importing}>📥 Importar CSV/XLSX agora</button>
        </div>
      )}

      {/* Conteúdo */}
      {filtered.length > 0 && (
        isMobile ? (
          <div>
            {filtered.map((acc) => (
              <AccountCard key={acc.id} acc={acc} onFieldChange={handleFieldChange} onDelete={handleDelete} onCopyAll={handleCopyAll} onMoveToMain={handleMoveToMain} selectMode={selectMode} isSelected={selected.has(acc.id)} onToggleSelect={toggleSelectOne} />
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
                  <AccountRow key={acc.id} acc={acc} idx={idx} onFieldChange={handleFieldChange} onDelete={handleDelete} onCopyAll={handleCopyAll} onMoveToMain={handleMoveToMain} selectMode={selectMode} isSelected={selected.has(acc.id)} onToggleSelect={toggleSelectOne} />
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
        <div style={{ marginTop:14, fontSize:10, color:"var(--muted)", textAlign:"right", lineHeight:1.6 }}>
          💾 Dados salvos localmente (IndexedDB).<br/>
          🔄 <strong>Para sincronizar entre dispositivos:</strong> exporte CSV → salve no Drive → em outro dispositivo clique em Drive e importe o mesmo arquivo. O sync faz merge inteligente pelo <code>updated_at</code>.
        </div>
      )}


      {/* ─── Drive CSV Picker — usa o mesmo componente do Aquecimento ────────── */}
      {drivePickerOpen && (
        <DrivePicker
          pickerMode={true}
          fileMode="csv"
          onPick={handlePickFromDrive}
          onClose={() => setDrivePickerOpen(false)}
        />
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
