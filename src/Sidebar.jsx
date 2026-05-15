import { useState } from "react";
import { NavLink } from "react-router-dom";
import { useScheduler } from "./App.jsx";

const NAV = [
  { to: "/",          label: "Contas",    icon: "👤" },
  { to: "/fila",      label: "Fila",      icon: "🗂️" },
  { to: "/historico", label: "Histórico", icon: "📊" },
];

export default function Sidebar({ accounts, oauthUrl, syncing, onConnectInstagram, oauthStatus }) {
  const { queue, cancelPending, resumeQueue } = useScheduler();
  const [busy,      setBusy]      = useState(false);
  const [actionMsg, setActionMsg] = useState(null);

  const pendingCount   = queue.filter((x) => x.status === "pending").length;
  const cancelledCount = queue.filter((x) => x.status === "cancelled").length;
  const loopCount      = queue.filter((x) => x.status === "pending" && x.loop).length;

  const handlePause = async () => {
    if (!pendingCount) return;
    if (!window.confirm(`Interromper ${pendingCount} post(s) pendente(s)? Podem ser retomados depois.`)) return;
    setBusy(true);
    const n = await cancelPending();
    setActionMsg(`⏸ ${n} post(s) pausado(s)`);
    setBusy(false);
    setTimeout(() => setActionMsg(null), 3000);
  };

  const handleResume = async () => {
    if (!cancelledCount) return;
    setBusy(true);
    const n = await resumeQueue();
    setActionMsg(`▶ ${n} post(s) retomado(s)`);
    setBusy(false);
    setTimeout(() => setActionMsg(null), 3000);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>

      {/* Logo */}
      <div style={{ padding: "20px 18px 16px", borderBottom: "1px solid var(--border)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 38, height: 38, borderRadius: 12, background: "linear-gradient(135deg, var(--accent), #9b4dfc)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, flexShrink: 0 }}>📱</div>
          <div>
            <div style={{ fontWeight: 800, fontSize: 15, color: "var(--fg)" }}>Insta Manager</div>
            <div style={{ fontSize: 10, color: "var(--muted)" }}>Meta Graph API v21</div>
          </div>
        </div>
      </div>

      {/* Resumo de contas */}
      {accounts.length > 0 && (
        <NavLink to="/" style={{ textDecoration: "none" }}>
          <div style={{ margin: "10px 10px 0", padding: "10px 12px", borderRadius: 10, background: "rgba(124,92,252,0.08)", border: "1px solid rgba(124,92,252,0.18)", display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 28, height: 28, borderRadius: 8, background: "linear-gradient(135deg, var(--accent), #9b4dfc)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, flexShrink: 0 }}>👥</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: "var(--accent-light)" }}>
                {accounts.length} conta{accounts.length > 1 ? "s" : ""} conectada{accounts.length > 1 ? "s" : ""}
              </div>
              {loopCount > 0 && (
                <div style={{ fontSize: 10, color: "var(--muted)" }}>🔁 {loopCount} em loop de 1h</div>
              )}
            </div>
          </div>
        </NavLink>
      )}

      {/* Nav */}
      <nav style={{ padding: "8px 10px", flex: 1, marginTop: 6 }}>
        {NAV.map((item) => (
          <NavLink key={item.to} to={item.to} end={item.to === "/"}
            style={({ isActive }) => ({
              display: "flex", alignItems: "center", gap: 10,
              padding: "9px 12px", borderRadius: 10, marginBottom: 2,
              color: isActive ? "var(--accent-light)" : "var(--muted)",
              background: isActive ? "rgba(124,92,252,0.13)" : "transparent",
              fontWeight: isActive ? 700 : 400, fontSize: 13,
              borderLeft: `2px solid ${isActive ? "var(--accent)" : "transparent"}`,
              textDecoration: "none",
            })}
          >
            <span style={{ fontSize: 17, lineHeight: 1, minWidth: 22, textAlign: "center" }}>{item.icon}</span>
            <span style={{ flex: 1 }}>{item.label}</span>
            {item.to === "/fila" && pendingCount > 0 && (
              <span style={{ fontSize: 10, fontWeight: 700, padding: "1px 6px", borderRadius: 10, background: "rgba(56,189,248,0.15)", color: "var(--info)", border: "1px solid rgba(56,189,248,0.3)" }}>{pendingCount}</span>
            )}
            {item.to === "/fila" && cancelledCount > 0 && pendingCount === 0 && (
              <span style={{ fontSize: 10, fontWeight: 700, padding: "1px 6px", borderRadius: 10, background: "rgba(245,158,11,0.15)", color: "var(--warning)", border: "1px solid rgba(245,158,11,0.3)" }}>⏸{cancelledCount}</span>
            )}
          </NavLink>
        ))}
      </nav>

      {/* Botão Pausar / Retomar */}
      {(pendingCount > 0 || cancelledCount > 0) && (
        <div style={{ padding: "0 10px 8px" }}>
          {actionMsg && (
            <div style={{ fontSize: 11, textAlign: "center", color: "var(--success)", padding: "4px 0 6px", fontWeight: 600 }}>{actionMsg}</div>
          )}
          {pendingCount > 0 && (
            <button onClick={handlePause} disabled={busy} className="btn btn-ghost btn-sm"
              style={{ width: "100%", fontSize: 12, marginBottom: cancelledCount > 0 ? 4 : 0, borderColor: "rgba(245,158,11,0.4)", color: "var(--warning)", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
              {busy ? <span className="spinner" style={{ width: 10, height: 10, borderTopColor: "var(--warning)" }} /> : "⏸"}
              Pausar fila ({pendingCount})
            </button>
          )}
          {cancelledCount > 0 && (
            <button onClick={handleResume} disabled={busy} className="btn btn-ghost btn-sm"
              style={{ width: "100%", fontSize: 12, borderColor: "rgba(34,197,94,0.4)", color: "var(--success)", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
              {busy ? <span className="spinner" style={{ width: 10, height: 10, borderTopColor: "var(--success)" }} /> : "▶"}
              Retomar ({cancelledCount})
            </button>
          )}
        </div>
      )}

      {/* Conectar Instagram */}
      <div style={{ padding: "12px 10px", borderTop: "1px solid var(--border)" }}>
        <button
          onClick={onConnectInstagram || (() => window.location.href = oauthUrl)}
          disabled={oauthStatus === "waiting" || oauthStatus === "saving"}
          className="btn btn-primary"
          style={{ width: "100%", fontSize: 13, display: "flex", alignItems: "center", justifyContent: "center", gap: 7, opacity: (oauthStatus === "waiting" || oauthStatus === "saving") ? 0.75 : 1 }}
        >
          {oauthStatus === "waiting" ? <><span className="spinner" style={{ width: 12, height: 12, borderTopColor: "#fff" }} /> Aguardando...</>
          : oauthStatus === "saving"  ? <><span className="spinner" style={{ width: 12, height: 12, borderTopColor: "#fff" }} /> Salvando...</>
          : <>📷 Conectar Instagram</>}
        </button>
      </div>

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        .spinner { display: inline-block; border: 2px solid rgba(255,255,255,0.15); border-radius: 50%; animation: spin 0.8s linear infinite; }
      `}</style>
    </div>
  );
}
