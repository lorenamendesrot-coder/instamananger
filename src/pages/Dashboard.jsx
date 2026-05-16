import { useMemo } from "react";
import { useAccounts } from "../App.jsx";
import { useScheduler } from "../App.jsx";
import { useHistory }   from "../App.jsx";
import { NavLink }      from "react-router-dom";

// ── Helpers ────────────────────────────────────────────────────────────────────
function fmt(n) {
  if (n == null || isNaN(n)) return "—";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000)     return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
}

const TYPE_ICON  = { FEED: "🖼", REEL: "🎬", STORY: "⭕" };
const STATUS_CFG = {
  pending:   { label: "Agendado",  color: "var(--info)",    bg: "rgba(56,189,248,0.12)"  },
  running:   { label: "Rodando",   color: "var(--warning)", bg: "rgba(245,158,11,0.12)"  },
  done:      { label: "Publicado", color: "var(--success)", bg: "rgba(34,197,94,0.12)"   },
  posted:    { label: "Publicado", color: "var(--success)", bg: "rgba(34,197,94,0.12)"   },
  error:     { label: "Erro",      color: "var(--danger)",  bg: "rgba(239,68,68,0.12)"   },
  cancelled: { label: "Pausado",   color: "var(--muted)",   bg: "rgba(102,102,120,0.12)" },
};

// Gera os últimos 7 dias como labels pt-BR
function last7Days() {
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push({
      label: d.toLocaleDateString("pt-BR", { weekday: "short" }).replace(".", ""),
      date:  d.toDateString(),
    });
  }
  return days;
}

// ── Componentes internos ───────────────────────────────────────────────────────

function StatCard({ icon, label, value, sub, subColor, accent }) {
  return (
    <div style={{
      background: "var(--bg2)", border: "1px solid var(--border)",
      borderRadius: 14, padding: "18px 20px",
      borderTop: `3px solid ${accent || "var(--accent)"}`,
      display: "flex", flexDirection: "column", gap: 4,
    }}>
      <div style={{ fontSize: 11, color: "var(--muted)", fontWeight: 600, letterSpacing: "0.05em", textTransform: "uppercase", marginBottom: 4 }}>
        {icon} {label}
      </div>
      <div style={{ fontSize: 26, fontWeight: 800, letterSpacing: "-0.03em", color: "var(--text)" }}>
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: 11, color: subColor || "var(--muted)", fontWeight: 500 }}>
          {sub}
        </div>
      )}
    </div>
  );
}

function BarChart({ days, counts }) {
  const max = Math.max(...counts, 1);
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 6, height: 100 }}>
      {days.map((d, i) => {
        const pct = counts[i] / max;
        const isToday = i === days.length - 1;
        return (
          <div key={d.label} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 6, height: "100%" }}>
            <div style={{ flex: 1, width: "100%", display: "flex", alignItems: "flex-end" }}>
              <div
                title={`${counts[i]} post(s)`}
                style={{
                  width: "100%",
                  height: `${Math.max(pct * 100, counts[i] > 0 ? 8 : 2)}%`,
                  borderRadius: "6px 6px 3px 3px",
                  background: isToday
                    ? "linear-gradient(180deg, var(--accent), #9b4dfc)"
                    : counts[i] > 0
                      ? "linear-gradient(180deg, rgba(124,92,252,0.6), rgba(124,92,252,0.25))"
                      : "var(--bg4)",
                  transition: "height 0.4s ease",
                  cursor: counts[i] > 0 ? "default" : undefined,
                  minHeight: 3,
                }}
              />
            </div>
            <div style={{ fontSize: 9, color: isToday ? "var(--accent3)" : "var(--muted)", fontWeight: isToday ? 700 : 400, whiteSpace: "nowrap" }}>
              {d.label}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function RecentPostRow({ item }) {
  const icon   = TYPE_ICON[item.post_type] || "📌";
  const status = item.status || (item.from_scheduler ? "done" : "done");
  const cfg    = STATUS_CFG[status] || STATUS_CFG.done;
  const when   = item.created_at || item.scheduledAt;
  const label  = when ? (() => {
    const d    = new Date(when);
    const now  = new Date();
    const diff = now - d;
    if (diff < 0) {
      // futuro → agendado
      const dfuture = d - now;
      if (dfuture < 3600000) return `em ${Math.round(dfuture / 60000)}min`;
      if (dfuture < 86400000) return `hoje, ${d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`;
      return `amanhã, ${d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`;
    }
    if (diff < 3600000)  return `${Math.round(diff / 60000)}min atrás`;
    if (diff < 86400000) return `hoje, ${d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`;
    if (diff < 172800000) return "ontem";
    return `${Math.round(diff / 86400000)} dias atrás`;
  })() : "—";

  const caption = item.default_caption || item.caption || "Sem legenda";

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 12,
      padding: "11px 0", borderBottom: "1px solid var(--border)",
    }}>
      {/* Ícone tipo */}
      <div style={{
        width: 36, height: 36, borderRadius: 10, flexShrink: 0,
        background: "var(--bg3)", border: "1px solid var(--border)",
        display: "flex", alignItems: "center", justifyContent: "center", fontSize: 17,
      }}>{icon}</div>

      {/* Texto */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {caption.length > 60 ? caption.slice(0, 60) + "…" : caption}
        </div>
        <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>{label}</div>
      </div>

      {/* Badge status */}
      <div style={{
        fontSize: 10, fontWeight: 700, padding: "3px 9px", borderRadius: 20,
        background: cfg.bg, color: cfg.color, whiteSpace: "nowrap", flexShrink: 0,
      }}>
        {cfg.label}
      </div>
    </div>
  );
}

// ── Página principal ───────────────────────────────────────────────────────────
export default function Dashboard() {
  const { accounts } = useAccounts();
  const { queue }    = useScheduler();
  const { history }  = useHistory();

  // ── Métricas de contas ────────────────────────────────────────────────────
  const totalFollowers = accounts.reduce((s, a) => s + (a.followers_count || 0), 0);
  const totalPosts     = accounts.reduce((s, a) => s + (a.media_count     || 0), 0);
  const expiredTokens  = accounts.filter((a) => a.token_status === "expired").length;

  // ── Fila ─────────────────────────────────────────────────────────────────
  const pendingCount = queue.filter((x) => !x.type && x.status === "pending").length;

  // ── Publicações recentes (fila + histórico misturados, últimas 6) ─────────
  const recentItems = useMemo(() => {
    // Histórico (já publicados)
    const histItems = (history || []).slice(0, 20).map((h) => ({
      id:               h.id,
      post_type:        h.post_type,
      default_caption:  h.default_caption || h.caption || "",
      status:           "done",
      created_at:       h.created_at,
      from_history:     true,
    }));

    // Fila pendente (agendados)
    const queueItems = queue
      .filter((x) => !x.type && (x.status === "pending" || x.status === "running"))
      .slice(0, 10)
      .map((q) => ({
        id:              q.id,
        post_type:       q.postType,
        default_caption: q.caption || "",
        status:          q.status,
        scheduledAt:     q.scheduledAt,
        created_at:      null,
      }));

    // Mistura e ordena: agendados futuros primeiro (desc scheduledAt), depois histórico (desc created_at)
    const all = [
      ...queueItems.sort((a, b) => (a.scheduledAt || 0) - (b.scheduledAt || 0)),
      ...histItems,
    ];

    return all.slice(0, 6);
  }, [history, queue]);

  // ── Gráfico: posts publicados por dia nos últimos 7 dias ──────────────────
  const days7 = last7Days();
  const chartCounts = useMemo(() => {
    return days7.map(({ date }) =>
      (history || []).filter((h) => {
        if (!h.created_at) return false;
        return new Date(h.created_at).toDateString() === date;
      }).length
    );
  }, [history, days7]);

  const postsThisWeek = chartCounts.reduce((a, b) => a + b, 0);

  return (
    <div className="page">
      <style>{`
        @keyframes fadeUp { from { opacity:0; transform:translateY(10px); } to { opacity:1; transform:none; } }
        .dash-card { animation: fadeUp 0.3s ease both; }
        .dash-card:nth-child(1) { animation-delay: 0.00s; }
        .dash-card:nth-child(2) { animation-delay: 0.05s; }
        .dash-card:nth-child(3) { animation-delay: 0.10s; }
        .dash-card:nth-child(4) { animation-delay: 0.15s; }
      `}</style>

      {/* ── Header ────────────────────────────────────────────────────────── */}
      <div className="page-header" style={{ marginBottom: 24 }}>
        <div>
          <div className="page-title">Dashboard</div>
          <div className="page-subtitle">Visão geral das suas contas e publicações</div>
        </div>
        <NavLink to="/fila" className="btn btn-primary btn-sm" style={{ textDecoration: "none", display: "flex", alignItems: "center", gap: 6 }}>
          + Nova publicação
        </NavLink>
      </div>

      {/* ── Stat cards ────────────────────────────────────────────────────── */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 12, marginBottom: 24 }}>
        <div className="dash-card">
          <StatCard icon="👥" label="Seguidores" value={fmt(totalFollowers)} sub={`${accounts.length} conta(s)`} accent="var(--accent)" />
        </div>
        <div className="dash-card">
          <StatCard icon="📸" label="Posts totais" value={fmt(totalPosts)} sub="combinado" accent="#38bdf8" />
        </div>
        <div className="dash-card">
          <StatCard icon="🗂️" label="Na fila" value={pendingCount} sub="agendados" accent="#f59e0b" subColor="var(--warning)" />
        </div>
        <div className="dash-card">
          <StatCard
            icon={expiredTokens > 0 ? "⚠️" : "✅"}
            label="Tokens"
            value={expiredTokens > 0 ? expiredTokens : accounts.length}
            sub={expiredTokens > 0 ? "expirado(s)" : "todos ativos"}
            accent={expiredTokens > 0 ? "var(--danger)" : "var(--success)"}
            subColor={expiredTokens > 0 ? "var(--danger)" : "var(--success)"}
          />
        </div>
      </div>

      {/* ── Gráfico + Publicações recentes ────────────────────────────────── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 0 }}>

        {/* Gráfico */}
        <div style={{ background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 14, padding: "20px 22px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 14 }}>Publicações — últimos 7 dias</div>
              <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
                {postsThisWeek > 0 ? `${postsThisWeek} post(s) publicados esta semana` : "Nenhum post esta semana"}
              </div>
            </div>
            <NavLink to="/historico" style={{ fontSize: 11, color: "var(--accent3)", textDecoration: "none" }}>Ver histórico →</NavLink>
          </div>
          <BarChart days={days7} counts={chartCounts} />
        </div>

        {/* Publicações recentes */}
        <div style={{ background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 14, padding: "20px 22px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
            <div style={{ fontWeight: 700, fontSize: 14 }}>Publicações recentes</div>
            <NavLink to="/fila" style={{ fontSize: 11, color: "var(--accent3)", textDecoration: "none" }}>Ver fila →</NavLink>
          </div>

          {recentItems.length === 0 ? (
            <div style={{ textAlign: "center", padding: "40px 0", color: "var(--muted)", fontSize: 13 }}>
              <div style={{ fontSize: 28, marginBottom: 10 }}>📭</div>
              Nenhuma publicação ainda.<br />
              <NavLink to="/fila" style={{ color: "var(--accent3)", fontSize: 12 }}>Agendar agora →</NavLink>
            </div>
          ) : (
            <div>
              {recentItems.map((item) => (
                <RecentPostRow key={item.id} item={item} />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── Contas rápidas ────────────────────────────────────────────────── */}
      {accounts.length > 0 && (
        <div style={{ marginTop: 16, background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 14, padding: "18px 22px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
            <div style={{ fontWeight: 700, fontSize: 14 }}>Contas conectadas</div>
            <NavLink to="/" style={{ fontSize: 11, color: "var(--accent3)", textDecoration: "none" }}>Gerenciar →</NavLink>
          </div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            {accounts.slice(0, 8).map((acc) => (
              <div key={acc.id} style={{
                display: "flex", alignItems: "center", gap: 8,
                padding: "7px 12px", borderRadius: 10,
                background: "var(--bg3)", border: "1px solid var(--border)",
              }}>
                {acc.profile_picture ? (
                  <img src={acc.profile_picture} alt="" style={{ width: 24, height: 24, borderRadius: "50%", objectFit: "cover" }} />
                ) : (
                  <div style={{ width: 24, height: 24, borderRadius: "50%", background: "linear-gradient(135deg, var(--accent), #9b4dfc)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: "#fff", fontWeight: 700 }}>
                    {(acc.nickname || acc.name || acc.username || "?")[0].toUpperCase()}
                  </div>
                )}
                <div>
                  <div style={{ fontSize: 12, fontWeight: 600 }}>{acc.nickname || acc.name || acc.username}</div>
                  <div style={{ fontSize: 10, color: "var(--muted)" }}>
                    {acc.followers_count ? fmt(acc.followers_count) + " seguidores" : "@" + (acc.username || acc.id)}
                  </div>
                </div>
                {acc.token_status === "expired" && (
                  <span style={{ fontSize: 9, color: "var(--danger)" }}>⚠️</span>
                )}
              </div>
            ))}
            {accounts.length > 8 && (
              <div style={{ display: "flex", alignItems: "center", padding: "7px 12px", borderRadius: 10, background: "var(--bg3)", border: "1px solid var(--border)", fontSize: 12, color: "var(--muted)" }}>
                +{accounts.length - 8} mais
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Estado vazio geral ────────────────────────────────────────────── */}
      {accounts.length === 0 && (
        <div style={{ marginTop: 16, textAlign: "center", padding: "48px 20px", background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 14 }}>
          <div style={{ fontSize: 36, marginBottom: 12 }}>📱</div>
          <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>Nenhuma conta conectada</div>
          <div style={{ fontSize: 13, color: "var(--muted)", marginBottom: 20 }}>Conecte uma conta para ver os dados aqui.</div>
          <NavLink to="/" className="btn btn-primary" style={{ textDecoration: "none", display: "inline-flex" }}>
            Conectar conta
          </NavLink>
        </div>
      )}
    </div>
  );
}
