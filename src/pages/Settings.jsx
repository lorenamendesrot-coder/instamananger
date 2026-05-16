// Settings.jsx — Configurações globais do Insta Manager
import { useState, useCallback } from "react";
import { useAccounts } from "../useAccounts.js";
import { dbGetAll, dbPut } from "../useDB.js";

// ─── Chaves de config no localStorage ────────────────────────────────────────
const CFG_KEY = "instamanager_settings";

function loadConfig() {
  try {
    return JSON.parse(localStorage.getItem(CFG_KEY) || "{}");
  } catch { return {}; }
}

function saveConfig(cfg) {
  localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
}

// ─── Componente Toggle ────────────────────────────────────────────────────────
function Toggle({ value, onChange }) {
  return (
    <div
      onClick={() => onChange(!value)}
      style={{
        width: 44, height: 24, borderRadius: 12, cursor: "pointer",
        background: value ? "var(--accent)" : "var(--border2)",
        position: "relative", transition: "background 0.2s", flexShrink: 0,
      }}
    >
      <div style={{
        position: "absolute", top: 3, left: value ? 22 : 2,
        width: 18, height: 18, borderRadius: "50%", background: "#fff",
        transition: "left 0.2s", boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
      }} />
    </div>
  );
}

// ─── Section card ─────────────────────────────────────────────────────────────
function Section({ icon, title, children }) {
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 16, display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 17 }}>{icon}</span>
        {title}
      </div>
      {children}
    </div>
  );
}

// ─── Row de configuração ──────────────────────────────────────────────────────
function Row({ label, desc, children }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, marginBottom: 14, paddingBottom: 14, borderBottom: "1px solid var(--border)" }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{label}</div>
        {desc && <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2, lineHeight: 1.5 }}>{desc}</div>}
      </div>
      <div style={{ flexShrink: 0 }}>{children}</div>
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────
export default function Settings() {
  const { accounts, addAccounts } = useAccounts();
  const [cfg, setCfgRaw]   = useState(loadConfig);
  const [saved, setSaved]  = useState(false);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState(null);

  const update = useCallback((key, value) => {
    setCfgRaw((prev) => {
      const next = { ...prev, [key]: value };
      saveConfig(next);
      return next;
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 1800);
  }, []);

  // ── Exportar dados ────────────────────────────────────────────────────────
  const handleExport = async () => {
    setExporting(true);
    try {
      const history = await dbGetAll("history").catch(() => []);
      const queue   = await dbGetAll("queue").catch(() => []);
      const blob    = new Blob([JSON.stringify({ accounts, history, queue, settings: cfg, exportedAt: new Date().toISOString() }, null, 2)], { type: "application/json" });
      const url     = URL.createObjectURL(blob);
      const a       = document.createElement("a");
      a.href        = url;
      a.download    = `instamanager-backup-${new Date().toISOString().slice(0,10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } finally { setExporting(false); }
  };

  // ── Importar dados ────────────────────────────────────────────────────────
  const handleImport = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);
    setImportMsg(null);
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const data = JSON.parse(ev.target.result);
        if (data.accounts?.length) await addAccounts(data.accounts);
        if (data.history?.length) for (const h of data.history) await dbPut("history", h);
        if (data.queue?.length)   for (const q of data.queue)   await dbPut("queue", q);
        if (data.settings)        { saveConfig(data.settings); setCfgRaw(data.settings); }
        setImportMsg({ ok: true, msg: `✅ Importado: ${data.accounts?.length||0} contas, ${data.history?.length||0} histórico, ${data.queue?.length||0} fila.` });
      } catch (err) {
        setImportMsg({ ok: false, msg: "❌ Erro ao importar: " + err.message });
      } finally { setImporting(false); }
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const jitterOptions = [
    { v: 0,   label: "Desativado" },
    { v: 60,  label: "±1 min"     },
    { v: 180, label: "±3 min"     },
    { v: 300, label: "±5 min"     },
    { v: 600, label: "±10 min"    },
    { v: 900, label: "±15 min"    },
  ];

  const intervalOptions = [
    { v: 30,  label: "30s" },
    { v: 60,  label: "1 min" },
    { v: 120, label: "2 min" },
    { v: 300, label: "5 min" },
  ];

  return (
    <div className="page" style={{ maxWidth: 720 }}>

      <div className="page-header">
        <div>
          <h1 className="page-title">⚙️ Configurações</h1>
          <p className="page-subtitle">Ajuste o comportamento global do Insta Manager.</p>
        </div>
        {saved && (
          <div style={{ fontSize: 12, color: "var(--success)", fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}>
            ✓ Salvo automaticamente
          </div>
        )}
      </div>

      {/* ── Contas ─────────────────────────────────────────────── */}
      <Section icon="👤" title="Contas Conectadas">
        {accounts.length === 0 ? (
          <div style={{ fontSize: 12, color: "var(--muted)", textAlign: "center", padding: "14px 0" }}>
            Nenhuma conta conectada. Use o botão "Conectar Instagram" na barra lateral.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {accounts.map((acc) => (
              <div key={acc.id} style={{
                display: "flex", alignItems: "center", gap: 12,
                padding: "10px 14px", borderRadius: 10, background: "var(--bg3)",
                border: `1px solid ${acc.token_status === "expired" ? "rgba(239,68,68,0.3)" : "var(--border)"}`,
              }}>
                <div style={{ width: 36, height: 36, borderRadius: "50%", flexShrink: 0, overflow: "hidden", border: "1.5px solid var(--border2)" }}>
                  {acc.profile_picture
                    ? <img src={acc.profile_picture} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} onError={(e) => { e.target.style.display = "none"; }} />
                    : <div style={{ width: "100%", height: "100%", background: "linear-gradient(135deg, var(--accent), #9b4dfc)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, fontWeight: 700, color: "#fff" }}>
                        {(acc.nickname || acc.name || acc.username || "?")[0].toUpperCase()}
                      </div>}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 13 }}>@{acc.username}</div>
                  <div style={{ fontSize: 11, color: "var(--muted)" }}>
                    {acc.name || "—"} · ID: {acc.id}
                  </div>
                </div>
                <div style={{ flexShrink: 0 }}>
                  <span style={{
                    fontSize: 11, fontWeight: 600, padding: "3px 10px", borderRadius: 20,
                    background: acc.token_status === "expired" ? "rgba(239,68,68,0.1)" : "rgba(34,197,94,0.1)",
                    color: acc.token_status === "expired" ? "var(--danger)" : "var(--success)",
                    border: `1px solid ${acc.token_status === "expired" ? "rgba(239,68,68,0.3)" : "rgba(34,197,94,0.3)"}`,
                  }}>
                    {acc.token_status === "expired" ? "⚠️ Expirado" : "✓ Ativo"}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}

        <div style={{ marginTop: 14, padding: "10px 14px", borderRadius: 8, background: "rgba(56,189,248,0.06)", border: "1px solid rgba(56,189,248,0.2)", fontSize: 11, color: "var(--muted)" }}>
          💡 Tokens do Instagram expiram a cada 60 dias. O sistema renova automaticamente quando possível.
        </div>
      </Section>

      {/* ── Horários ───────────────────────────────────────────── */}
      <Section icon="🕐" title="Horários de Postagem">
        <Row label="Janela padrão — início" desc="Horário mínimo para agendar posts automaticamente.">
          <input
            type="time"
            value={cfg.defaultWindowStart || "09:00"}
            onChange={(e) => update("defaultWindowStart", e.target.value)}
            style={{ width: 110 }}
          />
        </Row>
        <Row label="Janela padrão — fim" desc="Horário máximo para agendar posts automaticamente.">
          <input
            type="time"
            value={cfg.defaultWindowEnd || "21:00"}
            onChange={(e) => update("defaultWindowEnd", e.target.value)}
            style={{ width: 110 }}
          />
        </Row>
        <Row label="Intervalo mínimo entre posts" desc="Tempo mínimo entre dois posts consecutivos de uma mesma conta.">
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
            {[
              { v: 30,  label: "30 min" },
              { v: 45,  label: "45 min" },
              { v: 60,  label: "1h"     },
              { v: 90,  label: "1h30"   },
              { v: 120, label: "2h"     },
            ].map(({ v, label }) => {
              const active = (cfg.minIntervalMin ?? 60) === v;
              return (
                <button key={v} onClick={() => update("minIntervalMin", v)} style={{
                  padding: "5px 12px", borderRadius: 20, fontSize: 12, cursor: "pointer",
                  fontWeight: active ? 700 : 400,
                  background: active ? "var(--accent)" : "var(--bg3)",
                  color: active ? "#fff" : "var(--muted)",
                  border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
                  transition: "all 0.12s",
                }}>{active ? `✓ ${label}` : label}</button>
              );
            })}
          </div>
        </Row>
        <Row label="Intervalo máximo entre posts" desc="Teto do intervalo aleatório entre posts.">
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              type="number"
              min={30} max={480} step={5}
              value={cfg.maxIntervalMin ?? 90}
              onChange={(e) => update("maxIntervalMin", parseInt(e.target.value) || 90)}
              style={{ width: 80 }}
            />
            <span style={{ fontSize: 12, color: "var(--muted)" }}>min</span>
          </div>
        </Row>
        <Row label="Verificar fila a cada" desc="Frequência com que o agendador verifica a fila no navegador.">
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
            {intervalOptions.map(({ v, label }) => {
              const active = (cfg.schedulerTickSec ?? 10) === v;
              return (
                <button key={v} onClick={() => update("schedulerTickSec", v)} style={{
                  padding: "5px 12px", borderRadius: 20, fontSize: 12, cursor: "pointer",
                  fontWeight: active ? 700 : 400,
                  background: active ? "var(--accent)" : "var(--bg3)",
                  color: active ? "#fff" : "var(--muted)",
                  border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
                }}>
                  {active ? `✓ ${label}` : label}
                </button>
              );
            })}
          </div>
        </Row>
      </Section>

      {/* ── Jitter / Anti-shadowban ───────────────────────────── */}
      <Section icon="🎲" title="Jitter & Anti-Shadowban">
        <div style={{ marginBottom: 14, padding: "10px 14px", borderRadius: 8, background: "rgba(124,92,252,0.06)", border: "1px solid rgba(124,92,252,0.2)", fontSize: 11, color: "var(--muted)", lineHeight: 1.6 }}>
          <b style={{ color: "var(--accent-light)" }}>O que é jitter?</b> É uma variação aleatória nos horários de postagem para evitar padrões previsíveis que o algoritmo do Instagram pode interpretar como comportamento automatizado.
        </div>

        <Row label="Jitter nos horários" desc="Adiciona ±X minutos aleatórios em cada horário agendado.">
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
            {jitterOptions.map(({ v, label }) => {
              const active = (cfg.jitterSec ?? 180) === v;
              return (
                <button key={v} onClick={() => update("jitterSec", v)} style={{
                  padding: "5px 12px", borderRadius: 20, fontSize: 12, cursor: "pointer",
                  fontWeight: active ? 700 : 400,
                  background: active ? "var(--accent)" : "var(--bg3)",
                  color: active ? "#fff" : "var(--muted)",
                  border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
                  transition: "all 0.12s",
                }}>{active ? `✓ ${label}` : label}</button>
              );
            })}
          </div>
        </Row>

        <Row label="Jitter de segundos" desc="Adiciona 0–59 segundos extras (mais natural).">
          <Toggle value={cfg.jitterSeconds !== false} onChange={(v) => update("jitterSeconds", v)} />
        </Row>

        <Row label="Modo loop anti-padrão" desc="Quando em loop, varia o horário base em ±15 min a cada ciclo.">
          <Toggle value={!!cfg.loopJitter} onChange={(v) => update("loopJitter", v)} />
        </Row>

        <Row label="Limite de posts por hora" desc="Protege contra rate-limit da Meta. 0 = sem limite.">
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
            {[
              { v: 0,  label: "Sem limite" },
              { v: 1,  label: "1/h"        },
              { v: 2,  label: "2/h"        },
              { v: 3,  label: "3/h"        },
              { v: 5,  label: "5/h"        },
            ].map(({ v, label }) => {
              const active = (cfg.maxPostsPerHour ?? 0) === v;
              return (
                <button key={v} onClick={() => update("maxPostsPerHour", v)} style={{
                  padding: "5px 12px", borderRadius: 20, fontSize: 12, cursor: "pointer",
                  fontWeight: active ? 700 : 400,
                  background: active ? "var(--accent)" : "var(--bg3)",
                  color: active ? "#fff" : "var(--muted)",
                  border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
                }}>{active ? `✓ ${label}` : label}</button>
              );
            })}
          </div>
        </Row>
      </Section>

      {/* ── Publicação ────────────────────────────────────────── */}
      <Section icon="📤" title="Publicação">
        <Row label="Legenda padrão" desc="Texto usado quando nenhuma legenda é definida para um post.">
          <textarea
            value={cfg.defaultCaption || ""}
            onChange={(e) => update("defaultCaption", e.target.value)}
            placeholder="Ex: #reels #viral #fyp"
            style={{ width: 260, minHeight: 60, fontSize: 12, resize: "vertical" }}
          />
        </Row>
        <Row label="Modo distribuição padrão" desc="Como as mídias são distribuídas entre contas no aquecimento.">
          <div style={{ display: "flex", gap: 6 }}>
            {[{ v: "roundrobin", label: "🔄 Round-robin" }, { v: "random", label: "🎲 Aleatório" }].map(({ v, label }) => {
              const active = (cfg.distribution ?? "roundrobin") === v;
              return (
                <button key={v} onClick={() => update("distribution", v)} style={{
                  padding: "6px 12px", borderRadius: 9, fontSize: 11, cursor: "pointer",
                  background: active ? "rgba(124,92,252,0.12)" : "var(--bg3)",
                  color: active ? "var(--accent-light)" : "var(--muted)",
                  border: `1px solid ${active ? "rgba(124,92,252,0.4)" : "var(--border)"}`,
                  fontWeight: active ? 700 : 400,
                }}>{label}</button>
              );
            })}
          </div>
        </Row>
        <Row label="Retentativas em erro" desc="Quantas vezes tentar novamente em caso de falha na publicação.">
          <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
            {[1, 2, 3, 5].map((v) => {
              const active = (cfg.maxRetries ?? 3) === v;
              return (
                <button key={v} onClick={() => update("maxRetries", v)} style={{
                  padding: "5px 12px", borderRadius: 20, fontSize: 12, cursor: "pointer",
                  fontWeight: active ? 700 : 400,
                  background: active ? "var(--accent)" : "var(--bg3)",
                  color: active ? "#fff" : "var(--muted)",
                  border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
                }}>{active ? `✓ ${v}x` : `${v}x`}</button>
              );
            })}
          </div>
        </Row>
        <Row label="Notificação de erros" desc="Exibe um toast no topo da tela quando um post falha.">
          <Toggle value={cfg.notifyErrors !== false} onChange={(v) => update("notifyErrors", v)} />
        </Row>
      </Section>

      {/* ── Interface ─────────────────────────────────────────── */}
      <Section icon="🎨" title="Interface">
        <Row label="Confirmar exclusões" desc="Pede confirmação antes de remover itens da fila ou histórico.">
          <Toggle value={cfg.confirmDeletes !== false} onChange={(v) => update("confirmDeletes", v)} />
        </Row>
        <Row label="Auto-avançar abas" desc="Muda automaticamente para a próxima aba após completar cada etapa.">
          <Toggle value={!!cfg.autoAdvanceTabs} onChange={(v) => update("autoAdvanceTabs", v)} />
        </Row>
        <Row label="Mostrar contagem na fila (sidebar)" desc="Exibe o número de posts pendentes no menu lateral.">
          <Toggle value={cfg.showQueueBadge !== false} onChange={(v) => update("showQueueBadge", v)} />
        </Row>
      </Section>

      {/* ── Backup ────────────────────────────────────────────── */}
      <Section icon="💾" title="Backup & Restauração">
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
          <button
            className="btn btn-ghost"
            style={{ flex: "1 1 auto" }}
            onClick={handleExport}
            disabled={exporting}
          >
            {exporting ? <><span className="spinner" style={{ width: 12, height: 12 }} /> Exportando...</> : "📦 Exportar backup"}
          </button>
          <label
            className="btn btn-ghost"
            style={{ flex: "1 1 auto", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}
          >
            {importing ? <><span className="spinner" style={{ width: 12, height: 12 }} /> Importando...</> : "📥 Importar backup"}
            <input type="file" accept=".json" style={{ display: "none" }} onChange={handleImport} />
          </label>
        </div>

        {importMsg && (
          <div style={{
            padding: "10px 14px", borderRadius: 8, fontSize: 12,
            background: importMsg.ok ? "rgba(34,197,94,0.08)" : "rgba(239,68,68,0.08)",
            border: `1px solid ${importMsg.ok ? "rgba(34,197,94,0.25)" : "rgba(239,68,68,0.25)"}`,
            color: importMsg.ok ? "var(--success)" : "var(--danger)",
          }}>
            {importMsg.msg}
          </div>
        )}

        <div style={{ marginTop: 14, padding: "10px 14px", borderRadius: 8, background: "rgba(245,158,11,0.06)", border: "1px solid rgba(245,158,11,0.2)", fontSize: 11, color: "var(--muted)", lineHeight: 1.5 }}>
          ⚠️ O backup inclui contas, histórico, fila e configurações. Faça backups periódicos para não perder dados.
        </div>
      </Section>

      <style>{`
        .spinner { display: inline-block; border: 2px solid rgba(255,255,255,0.15); border-radius: 50%; animation: spin 0.8s linear infinite; }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}
