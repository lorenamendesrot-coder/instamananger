// ─── src/pages/Contingency.jsx ────────────────────────────────────────────────
// Aba de Contingência: estoque de contas preparadas manualmente antes de
// subir para as contas principais. Útil quando contas ativas caem por ban/shadowban.
//
// Funcionalidades:
//  • Importação de CSV  (username, senha, token2fa, email, nome)
//  • Tabela editável inline com revelar senha, copiar credenciais
//  • Status colorido + Qualidade selecionável
//  • Busca e filtro por Status
//  • Exportar CSV atualizado
//  • Excluir conta individual
//  • Botão "Mover para Contas Principais" (placeholder para integração futura)
//  • Persistência via useDB.js na store "contingency"
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useCallback, useRef } from "react";


// ─── DB local para garantir que a store "contingency" existe ──────────────────
// Isso evita erro caso o useDB.js ainda não tenha rodado o upgrade para v6
// (ex: browser com IndexedDB travado na versão antiga).
let _ctgDb = null;
async function openContingencyDB() {
  if (_ctgDb) return _ctgDb;
  return new Promise((resolve, reject) => {
    // Abre na versão atual do banco — se já existir em versão maior, usa ela
    const probe = indexedDB.open("insta_manager");
    probe.onsuccess = () => {
      const currentVersion = probe.result.version;
      probe.result.close();
      // Precisa criar a store? Faz upgrade
      const targetVersion = Math.max(currentVersion, 6);
      const req = indexedDB.open("insta_manager", targetVersion);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains("contingency")) {
          db.createObjectStore("contingency", { keyPath: "id" });
        }
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

const STORE = "contingency";

const STATUS_OPTIONS = [
  { value: "preparada",  label: "🟡 Preparada",   color: "#f59e0b", bg: "rgba(245,158,11,0.12)"  },
  { value: "em_edicao",  label: "✏️ Em Edição",   color: "#38bdf8", bg: "rgba(56,189,248,0.12)"  },
  { value: "pronta",     label: "✅ Pronta",       color: "#22c55e", bg: "rgba(34,197,94,0.12)"   },
  { value: "em_uso",     label: "🔄 Em Uso",       color: "#a78bfa", bg: "rgba(167,139,250,0.12)" },
  { value: "descartada", label: "⛔ Descartada",   color: "#ef4444", bg: "rgba(239,68,68,0.12)"   },
];

const QUALITY_OPTIONS = [
  { value: "premium", label: "⭐ Premium", color: "#f59e0b" },
  { value: "boa",     label: "🟢 Boa",     color: "#22c55e" },
  { value: "media",   label: "🟠 Média",   color: "#fb923c" },
  { value: "risco",   label: "🔴 Risco",   color: "#ef4444" },
];

// Ajudantes de lookup
const statusInfo  = (v) => STATUS_OPTIONS.find((s) => s.value === v)  || STATUS_OPTIONS[0];
const qualityInfo = (v) => QUALITY_OPTIONS.find((q) => q.value === v) || QUALITY_OPTIONS[1];

// ─── Utilitários ─────────────────────────────────────────────────────────────

/** Formata Date para exibição curta */
function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/** Gera ID único */
function uid() {
  return `ct-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Copia texto para clipboard e retorna Promise */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // fallback para browsers sem clipboard API
    const el = document.createElement("textarea");
    el.value = text;
    document.body.appendChild(el);
    el.select();
    document.execCommand("copy");
    document.body.removeChild(el);
    return true;
  }
}

/** Parseia CSV para array de objetos */
function parseCSV(text) {
  const lines  = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];

  // Detecta separador (vírgula ou ponto-e-vírgula)
  const sep = lines[0].includes(";") ? ";" : ",";

  const rawHeaders = lines[0].split(sep).map((h) => h.trim().toLowerCase().replace(/[^a-z0-9_]/g, ""));
  const COL_MAP    = { username: ["username", "user", "login", "usuario", "conta", "account", "perfil"],
                       senha:    ["senha", "password", "pass", "pw", "secret"],
                       token2fa: ["token2fa", "token", "2fa", "otp", "totp", "chave2fa"],
                       email:    ["email", "mail", "correo"],
                       nome:     ["nome", "name", "display", "apelido"] };

  // Mapeia coluna CSV → chave interna
  const colIndex = {};
  for (const [key, aliases] of Object.entries(COL_MAP)) {
    const idx = rawHeaders.findIndex((h) => aliases.includes(h));
    if (idx !== -1) colIndex[key] = idx;
  }

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(sep).map((c) => c.trim().replace(/^"|"$/g, ""));
    if (cells.every((c) => !c)) continue; // linha vazia

    const row = {};
    for (const [key, idx] of Object.entries(colIndex)) {
      row[key] = cells[idx] || "";
    }
    if (!row.username) continue; // sem username descarta
    rows.push(row);
  }
  return rows;
}

/** Exporta array de contas para CSV string */
function exportCSV(accounts) {
  const headers = ["username", "senha", "token2fa", "email", "nome", "status", "qualidade", "notas", "atualizado_em"];
  const escape  = (v) => `"${String(v || "").replace(/"/g, '""')}"`;
  const lines   = [
    headers.join(","),
    ...accounts.map((a) =>
      [a.username, a.senha, a.token2fa, a.email, a.nome,
       a.status, a.qualidade, a.notas, a.updated_at].map(escape).join(",")
    ),
  ];
  return lines.join("\n");
}

// ─── Sub-componentes ──────────────────────────────────────────────────────────

/** Badge de status com cor */
function StatusBadge({ status }) {
  const s = statusInfo(status);
  return (
    <span style={{
      fontSize: 11, fontWeight: 700, padding: "3px 9px", borderRadius: 20,
      background: s.bg, color: s.color, border: `1px solid ${s.color}40`,
      whiteSpace: "nowrap",
    }}>
      {s.label}
    </span>
  );
}

/** Célula de senha com botão revelar */
function PasswordCell({ value, onChange }) {
  const [revealed, setRevealed] = useState(false);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 5, minWidth: 150 }}>
      <input
        type={revealed ? "text" : "password"}
        value={value || ""}
        onChange={(e) => onChange(e.target.value)}
        placeholder="senha"
        style={{ fontSize: 12, padding: "4px 8px", flex: 1, minWidth: 0, fontFamily: revealed ? "inherit" : "monospace" }}
      />
      <button
        onClick={() => setRevealed((r) => !r)}
        title={revealed ? "Ocultar" : "Revelar"}
        style={{ background: "transparent", border: "1px solid var(--border2)", borderRadius: 6, padding: "4px 7px", fontSize: 13, color: "var(--muted)", cursor: "pointer", flexShrink: 0 }}
      >
        {revealed ? "🙈" : "👁️"}
      </button>
    </div>
  );
}

/** Botão de copiar com feedback visual */
function CopyButton({ text, title = "Copiar" }) {
  const [copied, setCopied] = useState(false);
  const handle = async () => {
    await copyText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button
      onClick={handle}
      title={title}
      style={{
        background: copied ? "rgba(34,197,94,0.12)" : "transparent",
        border: `1px solid ${copied ? "rgba(34,197,94,0.4)" : "var(--border2)"}`,
        borderRadius: 6, padding: "4px 8px", fontSize: 11,
        color: copied ? "var(--success)" : "var(--muted)",
        cursor: "pointer", transition: "all 0.15s", whiteSpace: "nowrap",
      }}
    >
      {copied ? "✓ Copiado" : "📋 Copiar"}
    </button>
  );
}

/** Select estilizado para Status */
function StatusSelect({ value, onChange }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{
        fontSize: 11, padding: "4px 8px", borderRadius: 8,
        background: statusInfo(value).bg,
        color: statusInfo(value).color,
        border: `1px solid ${statusInfo(value).color}50`,
        fontWeight: 700, cursor: "pointer", minWidth: 130,
      }}
    >
      {STATUS_OPTIONS.map((s) => (
        <option key={s.value} value={s.value} style={{ background: "var(--bg3)", color: "var(--text)" }}>
          {s.label}
        </option>
      ))}
    </select>
  );
}

/** Select estilizado para Qualidade */
function QualitySelect({ value, onChange }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{
        fontSize: 11, padding: "4px 8px", borderRadius: 8,
        background: "var(--bg3)", color: qualityInfo(value).color,
        border: "1px solid var(--border2)", fontWeight: 600,
        cursor: "pointer", minWidth: 110,
      }}
    >
      {QUALITY_OPTIONS.map((q) => (
        <option key={q.value} value={q.value} style={{ background: "var(--bg3)", color: "var(--text)" }}>
          {q.label}
        </option>
      ))}
    </select>
  );
}

// ─── Componente Principal ─────────────────────────────────────────────────────

export default function Contingency() {
  // ── Estado ────────────────────────────────────────────────────────────────
  const [accounts,    setAccounts]   = useState([]);    // todas as contas do DB
  const [loading,     setLoading]    = useState(true);
  const [search,      setSearch]     = useState("");
  const [filterStatus, setFilterStatus] = useState("todas");
  const [toastMsg,    setToastMsg]   = useState(null);  // { type: "success"|"error", text }
  const [importing,   setImporting]  = useState(false);
  const fileInputRef = useRef(null);

  // ── Persistência ──────────────────────────────────────────────────────────

  /** Carrega todas as contas do IndexedDB na store "contingency" */
  const loadAccounts = useCallback(async () => {
    try {
      const all = await ctgGetAll();
      // Ordena por data de criação (mais recente primeiro)
      all.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
      setAccounts(all);
    } catch (err) {
      showToast("error", "Erro ao carregar contas: " + err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadAccounts(); }, [loadAccounts]);

  /** Persiste uma conta no DB e atualiza o estado local */
  const saveAccount = useCallback(async (account) => {
    const updated = { ...account, updated_at: new Date().toISOString() };
    await ctgPut(updated);
    setAccounts((prev) => {
      const idx = prev.findIndex((a) => a.id === updated.id);
      if (idx === -1) return [updated, ...prev];
      const copy = [...prev];
      copy[idx] = updated;
      return copy;
    });
    return updated;
  }, []);

  /** Remove uma conta do DB e do estado local */
  const deleteAccount = useCallback(async (id) => {
    await ctgDelete(id);
    setAccounts((prev) => prev.filter((a) => a.id !== id));
  }, []);

  // ── Toast ─────────────────────────────────────────────────────────────────
  const showToast = useCallback((type, text) => {
    setToastMsg({ type, text });
    setTimeout(() => setToastMsg(null), 3200);
  }, []);

  // ── Importação de CSV ─────────────────────────────────────────────────────

  const handleFileChange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = ""; // permite re-selecionar o mesmo arquivo

    setImporting(true);
    try {
      const text = await file.text();
      const rows = parseCSV(text);

      if (rows.length === 0) {
        showToast("error", "Nenhuma conta encontrada. Verifique as colunas do CSV.");
        return;
      }

      // Cria registro para cada linha
      const now = new Date().toISOString();
      const created = await Promise.all(
        rows.map((row) =>
          saveAccount({
            id:        uid(),
            username:  row.username  || "",
            senha:     row.senha     || "",
            token2fa:  row.token2fa  || "",
            email:     row.email     || "",
            nome:      row.nome      || "",
            status:    "preparada",
            qualidade: "boa",
            notas:     "",
            created_at: now,
            updated_at: now,
          })
        )
      );

      showToast("success", `✅ ${created.length} conta(s) importada(s) com sucesso!`);
    } catch (err) {
      showToast("error", "Erro ao importar: " + err.message);
    } finally {
      setImporting(false);
    }
  };

  // ── Exportação de CSV ─────────────────────────────────────────────────────

  const handleExport = () => {
    const csv  = exportCSV(filtered);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = `contingencia_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    showToast("success", `CSV exportado com ${filtered.length} conta(s).`);
  };

  // ── Edição inline ─────────────────────────────────────────────────────────

  /** Atualiza um campo de uma conta e persiste */
  const handleFieldChange = useCallback(async (id, field, value) => {
    const account = accounts.find((a) => a.id === id);
    if (!account) return;
    await saveAccount({ ...account, [field]: value });
  }, [accounts, saveAccount]);

  // ── Excluir conta ─────────────────────────────────────────────────────────

  const handleDelete = useCallback(async (id, username) => {
    if (!window.confirm(`Excluir a conta @${username || id}? Esta ação não pode ser desfeita.`)) return;
    await deleteAccount(id);
    showToast("success", `🗑️ Conta @${username} excluída.`);
  }, [deleteAccount, showToast]);

  // ── Copiar credenciais completas ──────────────────────────────────────────

  const handleCopyAll = useCallback(async (acc) => {
    const text = [
      `👤 Username: @${acc.username}`,
      `🔑 Senha: ${acc.senha}`,
      acc.token2fa ? `🔐 Token 2FA: ${acc.token2fa}` : null,
      acc.email    ? `📧 Email: ${acc.email}`         : null,
    ].filter(Boolean).join("\n");
    await copyText(text);
    showToast("success", `📋 Credenciais de @${acc.username} copiadas!`);
  }, [showToast]);

  // ── Mover para Contas Principais (placeholder) ────────────────────────────

  const handleMoveToMain = useCallback(async (acc) => {
    // TODO: integrar com useAccounts quando houver endpoint de adição manual
    showToast("error",
      "⚠️ Função futura: integração com useAccounts via token manual. " +
      "Por enquanto copie as credenciais e conecte manualmente."
    );
  }, [showToast]);

  // ── Adicionar conta manualmente ───────────────────────────────────────────

  const handleAddEmpty = useCallback(async () => {
    const now = new Date().toISOString();
    await saveAccount({
      id: uid(), username: "", senha: "", token2fa: "", email: "",
      nome: "", status: "preparada", qualidade: "boa", notas: "",
      created_at: now, updated_at: now,
    });
    showToast("success", "✏️ Nova conta adicionada. Preencha os campos.");
  }, [saveAccount, showToast]);

  // ── Filtragem ─────────────────────────────────────────────────────────────

  const filtered = accounts.filter((a) => {
    const q = search.toLowerCase();
    const matchSearch = !q
      || (a.username || "").toLowerCase().includes(q)
      || (a.email    || "").toLowerCase().includes(q)
      || (a.nome     || "").toLowerCase().includes(q);
    const matchStatus = filterStatus === "todas" || a.status === filterStatus;
    return matchSearch && matchStatus;
  });

  // ── Contadores por status ─────────────────────────────────────────────────

  const counts = STATUS_OPTIONS.reduce((acc, s) => {
    acc[s.value] = accounts.filter((a) => a.status === s.value).length;
    return acc;
  }, {});

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div style={{ padding: "24px 28px", maxWidth: 1400, margin: "0 auto" }}>

      {/* ── Toast inline ─────────────────────────────────────────────────── */}
      {toastMsg && (
        <div style={{
          position: "fixed", top: 20, right: 20, zIndex: 9999,
          background: toastMsg.type === "success" ? "rgba(34,197,94,0.15)" : "rgba(239,68,68,0.15)",
          border: `1px solid ${toastMsg.type === "success" ? "rgba(34,197,94,0.4)" : "rgba(239,68,68,0.4)"}`,
          color: toastMsg.type === "success" ? "var(--success)" : "var(--danger)",
          padding: "12px 20px", borderRadius: 10, fontWeight: 600, fontSize: 13,
          maxWidth: 400, boxShadow: "var(--shadow)",
          animation: "slideIn 0.2s ease",
        }}>
          {toastMsg.text}
        </div>
      )}

      {/* ── Header ───────────────────────────────────────────────────────── */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap", gap: 14 }}>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 800, color: "var(--text)", marginBottom: 4, display: "flex", alignItems: "center", gap: 10 }}>
              🛡️ Contingência
            </h1>
            <p style={{ color: "var(--muted)", fontSize: 13 }}>
              Estoque de contas preparadas manualmente — prontas para substituir contas principais em caso de ban ou shadowban.
            </p>
          </div>

          {/* Ações rápidas */}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <button className="btn btn-ghost btn-sm" onClick={handleAddEmpty} title="Adicionar conta vazia">
              ➕ Adicionar
            </button>

            <button
              className="btn btn-primary btn-sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={importing}
              title="Importar contas via CSV"
            >
              {importing
                ? <><span className="spinner" style={{ width: 11, height: 11, borderTopColor: "#fff" }} /> Importando...</>
                : "📥 Importar CSV"}
            </button>

            <button
              className="btn btn-ghost btn-sm"
              onClick={handleExport}
              disabled={filtered.length === 0}
              title="Exportar tabela filtrada como CSV"
            >
              📤 Exportar CSV
            </button>

            {/* Input de arquivo oculto */}
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              style={{ display: "none" }}
              onChange={handleFileChange}
            />
          </div>
        </div>
      </div>

      {/* ── Cards de resumo ──────────────────────────────────────────────── */}
      <div style={{ display: "flex", gap: 10, marginBottom: 20, flexWrap: "wrap" }}>
        {/* Total */}
        <div className="card card-sm" style={{ minWidth: 110, flex: "0 0 auto", textAlign: "center" }}>
          <div style={{ fontSize: 22, fontWeight: 800, color: "var(--accent-light)" }}>{accounts.length}</div>
          <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>Total</div>
        </div>
        {/* Por status */}
        {STATUS_OPTIONS.map((s) => (
          <button
            key={s.value}
            onClick={() => setFilterStatus((f) => f === s.value ? "todas" : s.value)}
            style={{
              background: filterStatus === s.value ? s.bg : "var(--bg2)",
              border: `1px solid ${filterStatus === s.value ? s.color + "80" : "var(--border)"}`,
              borderRadius: "var(--radius)", padding: "10px 16px",
              cursor: "pointer", textAlign: "center", minWidth: 110, flex: "0 0 auto",
              transition: "all 0.15s",
            }}
          >
            <div style={{ fontSize: 18, fontWeight: 800, color: s.color }}>{counts[s.value] || 0}</div>
            <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 2 }}>{s.label}</div>
          </button>
        ))}
      </div>

      {/* ── Barra de busca + filtro ───────────────────────────────────────── */}
      <div style={{ display: "flex", gap: 10, marginBottom: 18, flexWrap: "wrap", alignItems: "center" }}>
        <div style={{ position: "relative", flex: 1, minWidth: 220 }}>
          <input
            type="text"
            placeholder="Buscar por username, email ou nome…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ paddingLeft: 36 }}
          />
          <span style={{ position: "absolute", left: 11, top: "50%", transform: "translateY(-50%)", fontSize: 15, color: "var(--muted)", pointerEvents: "none" }}>🔍</span>
        </div>

        <select
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
          style={{ minWidth: 160, padding: "10px 13px" }}
        >
          <option value="todas">🔘 Todos os status</option>
          {STATUS_OPTIONS.map((s) => (
            <option key={s.value} value={s.value}>{s.label} ({counts[s.value] || 0})</option>
          ))}
        </select>

        {(search || filterStatus !== "todas") && (
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => { setSearch(""); setFilterStatus("todas"); }}
          >
            ✕ Limpar filtros
          </button>
        )}

        <span style={{ fontSize: 12, color: "var(--muted)", marginLeft: "auto" }}>
          {filtered.length} de {accounts.length} conta{accounts.length !== 1 ? "s" : ""}
        </span>
      </div>

      {/* ── Dica de importação ───────────────────────────────────────────── */}
      {accounts.length === 0 && !loading && (
        <div style={{
          background: "rgba(124,92,252,0.06)", border: "1px dashed var(--border2)",
          borderRadius: "var(--radius)", padding: "36px 24px", textAlign: "center",
          marginBottom: 20,
        }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>🛡️</div>
          <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text)", marginBottom: 8 }}>
            Nenhuma conta de contingência ainda
          </div>
          <div style={{ fontSize: 13, color: "var(--muted)", marginBottom: 20, lineHeight: 1.7 }}>
            Importe um CSV com as colunas: <code style={{ color: "var(--accent3)", background: "var(--bg3)", padding: "2px 6px", borderRadius: 4 }}>username, senha, token2fa, email, nome</code>
            <br />ou adicione contas manualmente clicando em <strong>➕ Adicionar</strong>.
          </div>
          <button className="btn btn-primary" onClick={() => fileInputRef.current?.click()} disabled={importing}>
            📥 Importar CSV agora
          </button>
        </div>
      )}

      {/* ── Tabela ───────────────────────────────────────────────────────── */}
      {filtered.length > 0 && (
        <div style={{ overflowX: "auto", borderRadius: "var(--radius)", border: "1px solid var(--border)" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ background: "var(--bg2)", borderBottom: "1px solid var(--border2)" }}>
                {[
                  "Username (@)",
                  "Senha",
                  "Token 2FA",
                  "Email",
                  "Status",
                  "Qualidade",
                  "Notas",
                  "Atualizado em",
                  "Ações",
                ].map((h) => (
                  <th key={h} style={{
                    padding: "12px 14px", textAlign: "left", fontSize: 10,
                    fontWeight: 700, color: "var(--muted)", letterSpacing: "0.06em",
                    textTransform: "uppercase", whiteSpace: "nowrap",
                  }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((acc, idx) => (
                <AccountRow
                  key={acc.id}
                  acc={acc}
                  idx={idx}
                  onFieldChange={handleFieldChange}
                  onDelete={handleDelete}
                  onCopyAll={handleCopyAll}
                  onMoveToMain={handleMoveToMain}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Estado de carregamento ────────────────────────────────────────── */}
      {loading && (
        <div style={{ textAlign: "center", padding: 40, color: "var(--muted)" }}>
          <span className="spinner" style={{ width: 20, height: 20, borderTopColor: "var(--accent)", display: "inline-block" }} />
          <div style={{ marginTop: 12, fontSize: 13 }}>Carregando contas…</div>
        </div>
      )}

      {/* ── Nota de rodapé ───────────────────────────────────────────────── */}
      {accounts.length > 0 && (
        <div style={{ marginTop: 16, fontSize: 11, color: "var(--muted)", textAlign: "right" }}>
          💾 Dados salvos localmente no navegador (IndexedDB). Exportar CSV para backup externo.
        </div>
      )}

      <style>{`
        @keyframes slideIn { from { opacity: 0; transform: translateX(20px); } to { opacity: 1; transform: translateX(0); } }
        @keyframes spin    { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        .spinner { display: inline-block; border: 2px solid rgba(255,255,255,0.1); border-radius: 50%; animation: spin 0.8s linear infinite; }
        tr:hover td { background: rgba(124,92,252,0.04); }
      `}</style>
    </div>
  );
}

// ─── Linha da Tabela (memorizada para não re-renderizar tudo ao digitar) ───────

function AccountRow({ acc, idx, onFieldChange, onDelete, onCopyAll, onMoveToMain }) {
  // Debounce de campos de texto para evitar dbPut a cada tecla
  const debounceRef = useRef({});

  const handleDebounced = (field, value) => {
    clearTimeout(debounceRef.current[field]);
    debounceRef.current[field] = setTimeout(() => {
      onFieldChange(acc.id, field, value);
    }, 600);
  };

  // Campos que salvam imediatamente (selects)
  const handleImmediate = (field, value) => {
    onFieldChange(acc.id, field, value);
  };

  // Cor de fundo da linha levemente variada por status
  const si = statusInfo(acc.status);
  const rowBg = idx % 2 === 0 ? "transparent" : "rgba(255,255,255,0.015)";

  return (
    <tr style={{ borderBottom: "1px solid var(--border)", transition: "background 0.1s" }}>

      {/* Username */}
      <td style={{ padding: "10px 14px", background: rowBg }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <div style={{ width: 6, height: 6, borderRadius: "50%", background: si.color, flexShrink: 0 }} />
          <input
            type="text"
            defaultValue={acc.username}
            onChange={(e) => handleDebounced("username", e.target.value)}
            placeholder="@username"
            style={{ fontSize: 12, padding: "4px 8px", fontWeight: 600, minWidth: 120 }}
          />
        </div>
      </td>

      {/* Senha */}
      <td style={{ padding: "10px 14px", background: rowBg }}>
        <PasswordCell
          value={acc.senha}
          onChange={(v) => handleDebounced("senha", v)}
        />
      </td>

      {/* Token 2FA */}
      <td style={{ padding: "10px 14px", background: rowBg }}>
        <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
          <input
            type="text"
            defaultValue={acc.token2fa}
            onChange={(e) => handleDebounced("token2fa", e.target.value)}
            placeholder="token2fa"
            style={{ fontSize: 11, padding: "4px 8px", fontFamily: "monospace", minWidth: 140 }}
          />
          {acc.token2fa && (
            <CopyButton text={acc.token2fa} title="Copiar token 2FA para usar em 2fa.live" />
          )}
        </div>
      </td>

      {/* Email */}
      <td style={{ padding: "10px 14px", background: rowBg }}>
        <input
          type="text"
          defaultValue={acc.email}
          onChange={(e) => handleDebounced("email", e.target.value)}
          placeholder="email"
          style={{ fontSize: 12, padding: "4px 8px", minWidth: 160 }}
        />
      </td>

      {/* Status */}
      <td style={{ padding: "10px 14px", background: rowBg }}>
        <StatusSelect
          value={acc.status}
          onChange={(v) => handleImmediate("status", v)}
        />
      </td>

      {/* Qualidade */}
      <td style={{ padding: "10px 14px", background: rowBg }}>
        <QualitySelect
          value={acc.qualidade}
          onChange={(v) => handleImmediate("qualidade", v)}
        />
      </td>

      {/* Notas */}
      <td style={{ padding: "10px 14px", background: rowBg }}>
        <textarea
          defaultValue={acc.notas}
          onChange={(e) => handleDebounced("notas", e.target.value)}
          placeholder="Observações…"
          rows={2}
          style={{ fontSize: 11, padding: "4px 8px", minWidth: 180, minHeight: "unset", resize: "vertical" }}
        />
      </td>

      {/* Atualizado em */}
      <td style={{ padding: "10px 14px", background: rowBg, whiteSpace: "nowrap", color: "var(--muted)", fontSize: 11 }}>
        {fmtDate(acc.updated_at)}
      </td>

      {/* Ações */}
      <td style={{ padding: "10px 14px", background: rowBg }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 5, alignItems: "flex-start" }}>
          {/* Copiar tudo */}
          <button
            className="btn btn-ghost btn-xs"
            onClick={() => onCopyAll(acc)}
            title="Copiar username + senha + 2FA"
            style={{ fontSize: 11 }}
          >
            📋 Copiar tudo
          </button>

          {/* Mover para Principais */}
          <button
            className="btn btn-xs"
            onClick={() => onMoveToMain(acc)}
            title="Mover para Contas Principais"
            style={{
              fontSize: 11, background: "rgba(124,92,252,0.1)",
              color: "var(--accent3)", border: "1px solid rgba(124,92,252,0.3)",
              borderRadius: 6, padding: "4px 10px",
            }}
          >
            🚀 → Principais
          </button>

          {/* Excluir */}
          <button
            className="btn btn-danger btn-xs"
            onClick={() => onDelete(acc.id, acc.username)}
            title="Excluir conta"
          >
            🗑️ Excluir
          </button>
        </div>
      </td>
    </tr>
  );
}
