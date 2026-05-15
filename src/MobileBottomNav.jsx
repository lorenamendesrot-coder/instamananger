import { NavLink } from "react-router-dom";

const NAV = [
  { to: "/",          label: "Contas",    icon: "👤" },
  { to: "/fila",      label: "Fila",      icon: "🗂️" },
  { to: "/historico", label: "Histórico", icon: "📊" },
];

export default function MobileBottomNav() {
  return (
    <nav style={{
      display: "none", position: "fixed", bottom: 0, left: 0, right: 0,
      background: "var(--bg2)", borderTop: "1px solid var(--border)",
      zIndex: 100, padding: "6px 0",
    }} className="mobile-bottom-nav">
      {NAV.map((item) => (
        <NavLink key={item.to} to={item.to} end={item.to === "/"}
          style={({ isActive }) => ({
            flex: 1, display: "flex", flexDirection: "column", alignItems: "center",
            gap: 3, padding: "6px 0", textDecoration: "none",
            color: isActive ? "var(--accent-light)" : "var(--muted)", fontSize: 10, fontWeight: isActive ? 700 : 400,
          })}>
          <span style={{ fontSize: 20 }}>{item.icon}</span>
          {item.label}
        </NavLink>
      ))}
      <style>{`
        @media (max-width: 768px) { .mobile-bottom-nav { display: flex !important; } }
      `}</style>
    </nav>
  );
}
