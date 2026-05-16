// Settings.jsx — Configurações globais do Insta Manager
import { useState, useCallback } from "react";
import { useAccounts } from "../useAccounts.js";
import { dbGetAll, dbPut } from "../useDB.js";
import { useDriveAuth } from "../useDriveAuth.js";

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

// ─── Google Drive SVG Logo ────────────────────────────────────────────────────
function GoogleDriveLogo({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 87.3 78" xmlns="http://www.w3.org/2000/svg">
      <path d="m6.6 66.85 3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3l13.75-23.8h-27.5c0 1.55.4 3.1 1.2 4.5z" fill="#0066da"/>
      <path d="m43.65 25-13.75-23.8c-1.35.8-2.5 1.9-3.3 3.3l-25.4 44a9.06 9.06 0 0 0 -1.2 4.5h27.5z" fill="#00ac47"/>
      <path d="m73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 7.65-13.25c.8-1.4 1.2-2.95 1.2-4.5h-27.502l5.852 11.5z" fill="#ea4335"/>
      <path d="m43.65 25 13.75-23.8c-1.35-.8-2.9-1.2-4.5-1.2h-18.5c-1.6 0-3.15.45-4.5 1.2z" fill="#00832d"/>
      <path d="m59.8 53h-32.3l-13.75 23.8c1.35.8 2.9 1.2 4.5 1.2h50.8c1.6 0 3.15-.45 4.5-1.2z" fill="#2684fc"/>
      <path d="m73.4 26.5-12.7-22c-.8-1.4-1.95-2.5-3.3-3.3l-13.75 23.8 16.15 27h27.45c0-1.55-.4-3.1-1.2-4.5z" fill="#ffba00"/>
    </svg>
  );
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
function Row({ label, desc, children, last }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "space-between",
      gap: 16, marginBottom: last ? 0 : 14, paddingBottom: last ? 0 : 14,
      borderBottom: last ? "none" : "1px solid var(--border)",
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{label}</div>
        {desc && <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2, lineHeight: 1.5 }}>{desc}</div>}
      </div>
      <div style={{ flexShrink: 0 }}>{children}</div>
    </div>
  );
}

// ─── Chips de opção ───────────────────────────────────────────────────────────
function Chips({ options, value, onChange }) {
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
      {options.map(({ v, label }) => {
        const active = value === v;
        return (
          <button key={v} onClick={() => onChange(v)} style={{
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
  );
}

// ─── Google Drive Section ─────────────────────────────────────────────────────
function DriveSection({ cfg, update }) {
  const drive = useDriveAuth();

  const statusColor = drive.isConnected
    ? "var(--success)"
    : drive.isExpired
    ? "#f59e0b"
    : "var(--muted)";

  const statusLabel = drive.isConnected
    ? "Conectado"
    : drive.isExpired
    ? "Sessão expirada"
    : drive.isConnecting
    ? "Conectando…"
    : "Não conectado";

  const statusDot = drive.isConnected ? "✓" : drive.isExpired ? "⚠" : drive.isConnecting ? "⟳" : "○";

  return (
    <div className="card" style={{
      marginBottom: 14,
      border: "1px solid rgba(66,133,244,0.25)",
      background: "linear-gradient(135deg, rgba(66,133,244,0.04) 0%, rgba(52,168,83,0.03) 50%, rgba(251,188,5,0.03) 100%)",
    }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{
            width: 38, height: 38, borderRadius: 10,
            background: "rgba(255,255,255,0.08)",
            border: "1px solid rgba(66,133,244,0.2)",
            display: "flex", alignItems: "center", justifyContent: "center",
            flexShrink: 0,
          }}>
            <GoogleDriveLogo size={22} />
          </div>
          <div>
            <div style={{ fontWeight: 700, fontSize: 14, lineHeight: 1.2 }}>Google Drive</div>
            <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 1 }}>
              Importe mídias diretamente da nuvem
            </div>
          </div>
        </div>

        {/* Status badge */}
        <div style={{
          display: "flex", alignItems: "center", gap: 6,
          padding: "5px 12px", borderRadius: 20, fontSize: 11, fontWeight: 700,
          background: drive.isConnected
            ? "rgba(34,197,94,0.1)"
            : drive.isExpired
            ? "rgba(245,158,11,0.1)"
            : "var(--bg3)",
          color: statusColor,
          border: `1px solid ${drive.isConnected ? "rgba(34,197,94,0.3)" : drive.isExpired ? "rgba(245,158,11,0.3)" : "var(--border)"}`,
        }}>
          <span style={{ fontSize: 10 }}>{statusDot}</span>
          {statusLabel}
        </div>
      </div>

      {/* Error */}
      {drive.errorMsg && (
        <div style={{
          padding: "8px 12px", borderRadius: 8, fontSize: 11, marginBottom: 14,
          background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)",
          color: "var(--danger)",
        }}>
          ⚠️ {drive.errorMsg}
        </div>
      )}

      {/* Conta conectada */}
      {drive.isConnected && (
        <div style={{
          display: "flex", alignItems: "center", gap: 10,
          padding: "10px 14px", borderRadius: 10,
          background: "rgba(34,197,94,0.06)",
          border: "1px solid rgba(34,197,94,0.15)",
          marginBottom: 14,
        }}>
          <div style={{
            width: 32, height: 32, borderRadius: "50%",
            background: "linear-gradient(135deg, #4285f4, #34a853)",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 14, fontWeight: 700, color: "#fff", flexShrink: 0,
          }}>G</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text)" }}>
              {drive.tokenData?.email || "Conta Google"}
            </div>
            <div style={{ fontSize: 10, color: "var(--muted)" }}>
              Acesso ao Google Drive autorizado
            </div>
          </div>
        </div>
      )}

      {/* Sessão expirada */}
      {drive.isExpired && (
        <div style={{
          padding: "10px 14px", borderRadius: 8, fontSize: 11, marginBottom: 14,
          background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.25)",
          color: "#f59e0b",
        }}>
          Sua sessão do Google Drive expirou. Reconecte para continuar importando mídias.
        </div>
      )}

      {/* Botões de ação */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {!drive.isConnected ? (
          <button
            onClick={drive.connect}
            disabled={drive.isConnecting}
            style={{
              display: "flex", alignItems: "center", gap: 10,
              padding: "10px 20px", borderRadius: 10,
              background: drive.isConnecting ? "var(--bg3)" : "#fff",
              color: "#3c4043",
              border: "1px solid #dadce0",
              fontWeight: 600, fontSize: 13,
              cursor: drive.isConnecting ? "not-allowed" : "pointer",
              boxShadow: "0 1px 4px rgba(0,0,0,0.18)",
              transition: "all 0.15s",
            }}
          >
            {drive.isConnecting ? (
              <><span className="spinner" style={{ width: 14, height: 14, borderColor: "rgba(0,0,0,0.12)", borderTopColor: "#4285f4" }} /> Conectando…</>
            ) : (
              <><GoogleDriveLogo size={18} /> Entrar com Google</>
            )}
          </button>
        ) : (
          <>
            <button
              onClick={drive.connect}
              style={{
                display: "flex", alignItems: "center", gap: 8,
                padding: "8px 16px", borderRadius: 9,
                background: "rgba(66,133,244,0.1)", color: "#4285f4",
                border: "1px solid rgba(66,133,244,0.3)",
                fontWeight: 600, fontSize: 12, cursor: "pointer",
              }}
            >
              🔄 Reconectar
            </button>
            <button
              onClick={drive.disconnect}
              style={{
                display: "flex", alignItems: "center", gap: 8,
                padding: "8px 16px", borderRadius: 9,
                background: "rgba(239,68,68,0.08)", color: "var(--danger)",
                border: "1px solid rgba(239,68,68,0.2)",
                fontWeight: 600, fontSize: 12, cursor: "pointer",
              }}
            >
              ✕ Desconectar
            </button>
          </>
        )}
      </div>

      {/* Configurações do Drive (só quando conectado) */}
      {drive.isConnected && (
        <div style={{ marginTop: 18, paddingTop: 18, borderTop: "1px solid var(--border)" }}>
          <div style={{
            fontSize: 11, fontWeight: 700, color: "var(--muted)",
            textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 14,
          }}>
            Preferências de importação
          </div>

          <Row label="Pasta padrão" desc="Pasta do Drive aberta por padrão no seletor de mídias.">
            <input
              type="text"
              value={cfg.driveDefaultFolder || ""}
              onChange={(e) => update("driveDefaultFolder", e.target.value)}
              placeholder="ID da pasta (opcional)"
              style={{ width: 200, fontSize: 12 }}
            />
          </Row>

          <Row label="Tipos aceitos" desc="Formatos de arquivo exibidos no seletor do Drive.">
            <Chips
              options={[
                { v: "video", label: "🎬 Só vídeos" },
                { v: "all",   label: "🗂 Tudo"      },
              ]}
              value={cfg.driveFileTypes || "video"}
              onChange={(v) => update("driveFileTypes", v)}
            />
          </Row>

          <Row label="Proxy para importação" desc="Usa o servidor Netlify como proxy para baixar arquivos do Drive." last>
            <Toggle value={cfg.driveUseProxy !== false} onChange={(v) => update("driveUseProxy", v)} />
          </Row>
        </div>
      )}

      {/* Nota informativa */}
      <div style={{
        marginTop: 18, padding: "9px 12px", borderRadius: 8,
        background: "rgba(66,133,244,0.06)",
        border: "1px solid rgba(66,133,244,0.15)",
        fontSize: 11, color: "var(--muted)", lineHeight: 1.6,
      }}>
        <span style={{ color: "#4285f4", fontWeight: 700 }}>Como funciona:</span> conecte sua conta Google para navegar pelas suas pastas e importar vídeos direto no Aquecimento e na Fila, sem precisar baixar os arquivos manualmente.
      </div>
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
                  <div style={{ fontSize: 11, color: "var(--muted)" }}>{acc.name || "—"} · ID: {acc.id}</div>
                </div>
                <span style={{
                  fontSize: 11, fontWeight: 600, padding: "3px 10px", borderRadius: 20, flexShrink: 0,
                  background: acc.token_status === "expired" ? "rgba(239,68,68,0.1)" : "rgba(34,197,94,0.1)",
                  color: acc.token_status === "expired" ? "var(--danger)" : "var(--success)",
                  border: `1px solid ${acc.token_status === "expired" ? "rgba(239,68,68,0.3)" : "rgba(34,197,94,0.3)"}`,
                }}>
                  {acc.token_status === "expired" ? "⚠️ Expirado" : "✓ Ativo"}
                </span>
              </div>
            ))}
          </div>
        )}
        <div style={{ marginTop: 14, padding: "10px 14px", borderRadius: 8, background: "rgba(56,189,248,0.06)", border: "1px solid rgba(56,189,248,0.2)", fontSize: 11, color: "var(--muted)" }}>
          💡 Tokens do Instagram expiram a cada 60 dias. O sistema renova automaticamente quando possível.
        </div>
      </Section>

      {/* ── Google Drive ─────────────────────────────────────────── */}
      <DriveSection cfg={cfg} update={update} />

      {/* ── Horários ───────────────────────────────────────────── */}
      <Section icon="🕐" title="Horários de Postagem">
        <Row label="Janela padrão — início" desc="Horário mínimo para agendar posts automaticamente.">
          <input type="time" value={cfg.defaultWindowStart || "09:00"} onChange={(e) => update("defaultWindowStart", e.target.value)} style={{ width: 110 }} />
        </Row>
        <Row label="Janela padrão — fim" desc="Horário máximo para agendar posts automaticamente.">
          <input type="time" value={cfg.defaultWindowEnd || "21:00"} onChange={(e) => update("defaultWindowEnd", e.target.value)} style={{ width: 110 }} />
        </Row>
        <Row label="Intervalo mínimo entre posts" desc="Tempo mínimo entre dois posts consecutivos de uma mesma conta.">
          <Chips
            options={[{ v:30,label:"30 min" },{ v:45,label:"45 min" },{ v:60,label:"1h" },{ v:90,label:"1h30" },{ v:120,label:"2h" }]}
            value={cfg.minIntervalMin ?? 60}
            onChange={(v) => update("minIntervalMin", v)}
          />
        </Row>
        <Row label="Intervalo máximo entre posts" desc="Teto do intervalo aleatório entre posts.">
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input type="number" min={30} max={480} step={5} value={cfg.maxIntervalMin ?? 90} onChange={(e) => update("maxIntervalMin", parseInt(e.target.value) || 90)} style={{ width: 80 }} />
            <span style={{ fontSize: 12, color: "var(--muted)" }}>min</span>
          </div>
        </Row>
        <Row label="Verificar fila a cada" desc="Frequência com que o agendador verifica a fila no navegador." last>
          <Chips
            options={[{ v:30,label:"30s" },{ v:60,label:"1 min" },{ v:120,label:"2 min" },{ v:300,label:"5 min" }]}
            value={cfg.schedulerTickSec ?? 10}
            onChange={(v) => update("schedulerTickSec", v)}
          />
        </Row>
      </Section>

      {/* ── Jitter / Anti-shadowban ───────────────────────────── */}
      <Section icon="🎲" title="Jitter & Anti-Shadowban">
        <div style={{ marginBottom: 14, padding: "10px 14px", borderRadius: 8, background: "rgba(124,92,252,0.06)", border: "1px solid rgba(124,92,252,0.2)", fontSize: 11, color: "var(--muted)", lineHeight: 1.6 }}>
          <b style={{ color: "var(--accent-light)" }}>O que é jitter?</b> É uma variação aleatória nos horários de postagem para evitar padrões previsíveis que o algoritmo do Instagram pode interpretar como comportamento automatizado.
        </div>
        <Row label="Jitter nos horários" desc="Adiciona ±X minutos aleatórios em cada horário agendado.">
          <Chips
            options={[{ v:0,label:"Desativado" },{ v:60,label:"±1 min" },{ v:180,label:"±3 min" },{ v:300,label:"±5 min" },{ v:600,label:"±10 min" },{ v:900,label:"±15 min" }]}
            value={cfg.jitterSec ?? 180}
            onChange={(v) => update("jitterSec", v)}
          />
        </Row>
        <Row label="Jitter de segundos" desc="Adiciona 0–59 segundos extras (mais natural).">
          <Toggle value={cfg.jitterSeconds !== false} onChange={(v) => update("jitterSeconds", v)} />
        </Row>
        <Row label="Modo loop anti-padrão" desc="Quando em loop, varia o horário base em ±15 min a cada ciclo.">
          <Toggle value={!!cfg.loopJitter} onChange={(v) => update("loopJitter", v)} />
        </Row>
        <Row label="Limite de posts por hora" desc="Protege contra rate-limit da Meta. 0 = sem limite." last>
          <Chips
            options={[{ v:0,label:"Sem limite" },{ v:1,label:"1/h" },{ v:2,label:"2/h" },{ v:3,label:"3/h" },{ v:5,label:"5/h" }]}
            value={cfg.maxPostsPerHour ?? 0}
            onChange={(v) => update("maxPostsPerHour", v)}
          />
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
            {[{ v:"roundrobin",label:"🔄 Round-robin" },{ v:"random",label:"🎲 Aleatório" }].map(({ v, label }) => {
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
          <Chips
            options={[{ v:1,label:"1x" },{ v:2,label:"2x" },{ v:3,label:"3x" },{ v:5,label:"5x" }]}
            value={cfg.maxRetries ?? 3}
            onChange={(v) => update("maxRetries", v)}
          />
        </Row>
        <Row label="Notificação de erros" desc="Exibe um toast no topo da tela quando um post falha." last>
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
        <Row label="Mostrar contagem na fila (sidebar)" desc="Exibe o número de posts pendentes no menu lateral." last>
          <Toggle value={cfg.showQueueBadge !== false} onChange={(v) => update("showQueueBadge", v)} />
        </Row>
      </Section>

      {/* ── Backup ────────────────────────────────────────────── */}
      <Section icon="💾" title="Backup & Restauração">
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
          <button className="btn btn-ghost" style={{ flex: "1 1 auto" }} onClick={handleExport} disabled={exporting}>
            {exporting ? <><span className="spinner" style={{ width: 12, height: 12 }} /> Exportando...</> : "📦 Exportar backup"}
          </button>
          <label className="btn btn-ghost" style={{ flex: "1 1 auto", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
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
        .spinner { display: inline-block; border: 2px solid rgba(255,255,255,0.15); border-top-color: currentColor; border-radius: 50%; animation: spin 0.8s linear infinite; }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}
