// Accounts.jsx — Lista e gerencia contas conectadas
// Sem health check, sem insights automáticos, sem chamadas extras à API

import { useState, useCallback } from "react";
import { useAccounts } from "../App.jsx";
import { useOAuthPopup } from "../useOAuthPopup.js";
import Modal from "../Modal.jsx";
import AccountAvatar from "../components/accounts/AccountAvatar.jsx";
import { RenameModal, AddViaPageModal, AddViaTokenModal } from "../components/accounts/AccountModals.jsx";

// ─── Modal de detalhes simples ────────────────────────────────────────────────
function AccountDetailModal({ acc, onClose, onEdit, onRemove }) {
  return (
    <div onClick={(e) => e.target === e.currentTarget && onClose()} style={{
      position: "fixed", inset: 0, zIndex: 2000,
      background: "rgba(0,0,0,0.75)", backdropFilter: "blur(5px)",
      display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
    }}>
      <div style={{
        background: "var(--bg2)", border: "1px solid var(--border2)",
        borderRadius: 18, width: "100%", maxWidth: 380,
        boxShadow: "0 24px 64px rgba(0,0,0,0.7)", overflow: "hidden",
      }}>
        <div style={{ height: 44, background: "linear-gradient(135deg, var(--accent)22, #9b4dfc22)", position: "relative", borderBottom: "1px solid var(--border)" }}>
          <button onClick={onClose} style={{ position: "absolute", top: 10, right: 12, background: "none", color: "var(--muted)", fontSize: 20, padding: "0 4px", lineHeight: 1, border: "none", cursor: "pointer" }}>×</button>
        </div>

        <div style={{ padding: "0 16px", marginTop: -24, display: "flex", alignItems: "flex-end", justifyContent: "space-between" }}>
          <AccountAvatar acc={acc} size={52} />
          <div style={{ display: "flex", gap: 6, paddingBottom: 6 }}>
            <button className="btn btn-ghost btn-sm" onClick={onEdit}>✏️ Renomear</button>
            <button className="btn btn-danger btn-sm" onClick={onRemove}>Desconectar</button>
          </div>
        </div>

        <div style={{ padding: "8px 16px 20px" }}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>{acc.nickname || acc.name || acc.username}</div>
          <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 10 }}>@{acc.username}</div>

          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <span className="badge badge-purple">{acc.account_type || "BUSINESS"}</span>
            {acc.added_via === "page_id" && (
              <span className="badge" style={{ fontSize: 10, background: "rgba(245,158,11,0.12)", color: "var(--warning)", border: "1px solid rgba(245,158,11,0.3)" }}>🔑 via Page ID</span>
            )}
          </div>

          {acc.biography && (
            <div style={{ marginTop: 10, padding: "9px 12px", background: "var(--bg3)", borderRadius: 8, fontSize: 12, color: "var(--text)", lineHeight: 1.6 }}>
              {acc.biography}
            </div>
          )}

          <div style={{ marginTop: 10, fontSize: 11, color: "var(--muted)" }}>
            ID: {acc.id}
            {acc.connected_at && <> · conectado em {new Date(acc.connected_at).toLocaleDateString("pt-BR")}</>}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Componente principal ─────────────────────────────────────────────────────
export default function Accounts() {
  const { accounts, addAccounts, removeAccount } = useAccounts();

  const [detailAcc,  setDetailAcc]  = useState(null);
  const [renameAcc,  setRenameAcc]  = useState(null);
  const [showAddPage, setShowAddPage] = useState(false);
  const [showAddToken, setShowAddToken] = useState(false);

  // OAuth popup inline na página
  const { status: oauthStatus, openPopup, reset: resetOauth } = useOAuthPopup({
    onAccounts: async (accs) => {
      await addAccounts(accs);
      resetOauth();
    },
    onError: () => resetOauth(),
  });

  const handleRemove = useCallback((acc) => {
    if (!window.confirm(`Desconectar @${acc.username}?`)) return;
    removeAccount(acc.id);
    setDetailAcc(null);
  }, [removeAccount]);

  const handleRename = useCallback(async (acc, nickname) => {
    await addAccounts([{ ...acc, nickname }]);
    setRenameAcc(null);
    setDetailAcc(null);
  }, [addAccounts]);

  return (
    <div style={{ padding: "24px 28px", maxWidth: 900, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 800, margin: 0 }}>Contas</h1>
          <p style={{ fontSize: 13, color: "var(--muted)", margin: "4px 0 0" }}>
            {accounts.length} conta{accounts.length !== 1 ? "s" : ""} conectada{accounts.length !== 1 ? "s" : ""}
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn btn-ghost btn-sm" onClick={() => setShowAddToken(true)}>🔑 Token direto</button>
          <button className="btn btn-ghost btn-sm" onClick={() => setShowAddPage(true)}>📄 Via Page ID</button>
          <button
            className="btn btn-primary btn-sm"
            onClick={openPopup}
            disabled={oauthStatus === "waiting" || oauthStatus === "saving"}
            style={{ display: "flex", alignItems: "center", gap: 6 }}
          >
            {oauthStatus === "waiting" ? <><span className="spinner" style={{ width: 11, height: 11, borderTopColor: "#fff" }} /> Aguardando...</>
            : oauthStatus === "saving"  ? <><span className="spinner" style={{ width: 11, height: 11, borderTopColor: "#fff" }} /> Salvando...</>
            : <>📷 Conectar Instagram</>}
          </button>
        </div>
      </div>

      {accounts.length === 0 ? (
        <div style={{ textAlign: "center", padding: "60px 0", color: "var(--muted)" }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>📱</div>
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>Nenhuma conta conectada</div>
          <div style={{ fontSize: 13 }}>Clique em "Conectar Instagram" para adicionar sua primeira conta.</div>
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 12 }}>
          {accounts.map((acc) => (
            <div
              key={acc.id}
              onClick={() => setDetailAcc(acc)}
              style={{
                background: "var(--bg2)", border: "1px solid var(--border)",
                borderRadius: 14, padding: "16px 14px",
                cursor: "pointer", transition: "border-color 0.15s",
                display: "flex", flexDirection: "column", alignItems: "center", gap: 10,
              }}
              onMouseEnter={(e) => e.currentTarget.style.borderColor = "var(--accent)"}
              onMouseLeave={(e) => e.currentTarget.style.borderColor = "var(--border)"}
            >
              <AccountAvatar acc={acc} size={52} />
              <div style={{ textAlign: "center", minWidth: 0, width: "100%" }}>
                <div style={{ fontWeight: 700, fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {acc.nickname || acc.name || acc.username}
                </div>
                <div style={{ fontSize: 11, color: "var(--muted)" }}>@{acc.username}</div>
              </div>
              <span className="badge badge-purple" style={{ fontSize: 10 }}>{acc.account_type || "BUSINESS"}</span>
            </div>
          ))}
        </div>
      )}

      {/* Modais */}
      {detailAcc && (
        <AccountDetailModal
          acc={detailAcc}
          onClose={() => setDetailAcc(null)}
          onEdit={() => { setRenameAcc(detailAcc); setDetailAcc(null); }}
          onRemove={() => handleRemove(detailAcc)}
        />
      )}
      {renameAcc && (
        <RenameModal acc={renameAcc} onClose={() => setRenameAcc(null)} onSave={handleRename} />
      )}
      {showAddPage && (
        <AddViaPageModal onClose={() => setShowAddPage(false)} onSave={async (accs) => { await addAccounts(accs); setShowAddPage(false); }} />
      )}
      {showAddToken && (
        <AddViaTokenModal onClose={() => setShowAddToken(false)} onSave={async (accs) => { await addAccounts(accs); setShowAddToken(false); }} />
      )}

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        .spinner { display: inline-block; border: 2px solid rgba(255,255,255,0.15); border-radius: 50%; animation: spin 0.8s linear infinite; }
      `}</style>
    </div>
  );
}
