import { useState, useCallback, useEffect, useRef } from "react";
import { useAccounts } from "../App.jsx";
import { useOAuthPopup } from "../useOAuthPopup.js";
import { dbPut } from "../useDB.js";
import Modal from "../Modal.jsx";
import AccountAvatar from "../components/accounts/AccountAvatar.jsx";
import StatBox from "../components/accounts/AccountStatBox.jsx";
import { RenameModal, AddViaPageModal, EditProfileModal, AddViaTokenModal } from "../components/accounts/AccountModals.jsx";
import { fmt } from "../components/accounts/AccountUtils.js";

// ── Modal de detalhes da conta ─────────────────────────────────────────────────
function AccountDetailModal({ acc, ins, loadingInsights, onClose, onEdit, onRemove, onRefresh }) {
  const tokenExpired = acc.token_status === "expired";

  return (
    <div
      onClick={(e) => e.target === e.currentTarget && onClose()}
      style={{
        position: "fixed", inset: 0, zIndex: 2000,
        background: "rgba(0,0,0,0.8)", backdropFilter: "blur(8px)",
        display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
      }}
    >
      <div style={{
        background: "var(--bg2)", border: "1px solid var(--border2)",
        borderRadius: 20, width: "100%", maxWidth: 420,
        maxHeight: "90vh", display: "flex", flexDirection: "column",
        boxShadow: "0 32px 80px rgba(0,0,0,0.8)", overflow: "hidden",
      }}>
        {/* Header faixa gradiente */}
        <div style={{
          height: 56, position: "relative",
          background: "linear-gradient(135deg, #2d1f6e 0%, #1a1a2e 50%, #0f0f1a 100%)",
          borderBottom: "1px solid var(--border)",
        }}>
          <div style={{
            position: "absolute", inset: 0, opacity: 0.4,
            backgroundImage: "radial-gradient(ellipse at 30% 50%, rgba(124,92,252,0.4) 0%, transparent 60%)",
          }} />
          <button
            onClick={onClose}
            style={{
              position: "absolute", top: 10, right: 12, background: "rgba(255,255,255,0.08)",
              color: "var(--text2)", fontSize: 16, width: 28, height: 28, borderRadius: 8,
              display: "flex", alignItems: "center", justifyContent: "center",
              border: "1px solid rgba(255,255,255,0.1)", lineHeight: 1,
            }}
          >×</button>
        </div>

        {/* Avatar sobreposição */}
        <div style={{ padding: "0 20px", marginTop: -28, display: "flex", alignItems: "flex-end", justifyContent: "space-between" }}>
          <AccountAvatar acc={acc} ins={ins} size={56} />
          <div style={{ display: "flex", gap: 6, paddingBottom: 6 }}>
            <button className="btn btn-ghost btn-sm" onClick={onRefresh} disabled={loadingInsights}>
              {loadingInsights ? <span className="spinner" style={{ width: 12, height: 12 }} /> : "↻"}
            </button>
            <button className="btn btn-ghost btn-sm" onClick={onEdit}>✏️</button>
            <button className="btn btn-danger btn-sm" onClick={onRemove}>Desconectar</button>
          </div>
        </div>

        {/* Nome e badges */}
        <div style={{ padding: "8px 20px 14px" }}>
          <div style={{ fontWeight: 700, fontSize: 16, letterSpacing: "-0.01em" }}>
            {acc.nickname || acc.name || acc.username}
          </div>
          <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 8 }}>@{acc.username}</div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            <span className="badge badge-purple">{acc.account_type || "BUSINESS"}</span>
            {acc.added_via === "page_id" && (
              <span className="badge" style={{ fontSize: 10, background: "rgba(245,158,11,0.12)", color: "var(--warning)", border: "1px solid rgba(245,158,11,0.3)" }}>🔑 via Page ID</span>
            )}
          </div>
        </div>

        {/* Conteúdo insights */}
        <div style={{ padding: "0 20px 20px", overflowY: "auto", flex: 1 }}>
          {loadingInsights ? (
            <div style={{ textAlign: "center", padding: "40px 0" }}>
              <div className="spinner" style={{ width: 28, height: 28, margin: "0 auto 12px" }} />
              <div style={{ fontSize: 12, color: "var(--muted)" }}>Buscando dados...</div>
            </div>
          ) : ins ? (
            <>
              <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
                <StatBox label="Seguidores" value={fmt(ins.followers_count)} icon="👥" />
                <StatBox label="Posts" value={fmt(ins.media_count)} icon="📸" />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 12 }}>
                {[
                  { icon: "🗂", label: "Tipo", value: ins.account_type || acc.account_type || "BUSINESS" },
                  { icon: "🗓", label: "Conectada em", value: new Date(acc.connected_at || Date.now()).toLocaleDateString("pt-BR") },
                  { icon: "🔄", label: "Atualizado", value: ins.fetched_at ? new Date(ins.fetched_at).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : "—" },
                  { icon: "🆔", label: "ID", value: acc.id },
                ].map((item) => (
                  <div key={item.label} style={{ padding: "8px 10px", background: "var(--bg3)", borderRadius: 10, border: "1px solid var(--border)" }}>
                    <div style={{ fontSize: 10, color: "var(--muted)", marginBottom: 2 }}>{item.icon} {item.label}</div>
                    <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.value}</div>
                  </div>
                ))}
              </div>
              <div style={{ padding: "10px 13px", background: "var(--bg3)", borderRadius: 10, border: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 10 }}>
                <span>🔒</span>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 600 }}>Token de acesso</div>
                  <div style={{ fontSize: 11, color: tokenExpired ? "var(--danger)" : "var(--success)" }}>
                    {tokenExpired ? "Expirado — reconecte a conta" : "Armazenado com segurança"}
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div style={{ textAlign: "center", padding: "24px 0", color: "var(--muted)", fontSize: 13 }}>
              Não foi possível carregar os dados da conta.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Card de conta ──────────────────────────────────────────────────────────────
function AccountCard({ acc, ins, isLoading, selectMode, isSelected, onToggleSelect, onOpenDetail, onRename, onRefresh }) {
  const tokenExpired = acc.token_status === "expired";
  const followers = ins?.followers_count ?? acc.followers_count;
  const posts = ins?.media_count ?? acc.media_count;
  const name = acc.nickname || ins?.name || acc.name || acc.username || "—";
  const username = ins?.username || acc.username || "—";

  return (
    <div
      className="card card-hover"
      style={{
        display: "flex", flexDirection: "column", gap: 0,
        cursor: "pointer", position: "relative", overflow: "hidden",
        padding: 0,
        outline: selectMode && isSelected ? "2px solid var(--accent)" : "none",
        outlineOffset: 2,
        transition: "border-color 0.15s, box-shadow 0.15s",
      }}
      onClick={() => {
        if (selectMode) onToggleSelect();
        else onOpenDetail();
      }}
    >
      {/* Faixa superior colorida */}
      <div style={{
        height: 4,
        background: tokenExpired
          ? "linear-gradient(90deg, var(--danger), rgba(239,68,68,0.3))"
          : "linear-gradient(90deg, var(--accent), #9b4dfc, #e879f9)",
      }} />

      {/* Corpo */}
      <div style={{ padding: "16px 16px 14px" }}>
        {/* Checkbox seleção */}
        {selectMode && (
          <div style={{
            position: "absolute", top: 16, left: 14, width: 18, height: 18,
            borderRadius: 5, border: "2px solid var(--accent)",
            background: isSelected ? "var(--accent)" : "transparent",
            display: "flex", alignItems: "center", justifyContent: "center",
            zIndex: 10, fontSize: 11, color: "#fff", pointerEvents: "none",
          }}>
            {isSelected && "✓"}
          </div>
        )}

        {/* Botões de ação */}
        <div
          style={{ position: "absolute", top: 12, right: 12, display: "flex", gap: 4, opacity: 0 }}
          className="account-card-actions"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={() => onRename()}
            title="Renomear"
            style={{
              background: "var(--bg3)", border: "1px solid var(--border2)",
              borderRadius: 7, padding: "4px 8px", fontSize: 10,
              color: "var(--muted)", cursor: "pointer", lineHeight: 1,
            }}
          >✏️</button>
          <button
            onClick={() => onRefresh()}
            disabled={isLoading}
            title="Atualizar"
            style={{
              background: "var(--bg3)", border: "1px solid var(--border2)",
              borderRadius: 7, padding: "4px 8px", fontSize: 10,
              color: "var(--muted)", cursor: isLoading ? "default" : "pointer",
              opacity: isLoading ? 0.5 : 1, lineHeight: 1,
            }}
          >↻</button>
        </div>

        {/* Avatar + info */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
          <AccountAvatar acc={acc} ins={ins} size={46} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", letterSpacing: "-0.01em" }}>
              {name}
            </div>
            <div style={{ fontSize: 11, color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginBottom: 5 }}>
              @{username}
            </div>
            <div style={{ display: "flex", gap: 5, flexWrap: "wrap", alignItems: "center" }}>
              <span className="badge badge-purple" style={{ fontSize: 9, padding: "2px 7px" }}>
                {acc.account_type || "BUSINESS"}
              </span>
              {acc.added_via === "page_id" && (
                <span style={{ fontSize: 10, color: "var(--warning)" }} title="via Page ID">🔑</span>
              )}
              {tokenExpired && (
                <span style={{ fontSize: 9, padding: "2px 6px", borderRadius: 4, background: "rgba(239,68,68,0.12)", color: "var(--danger)", border: "1px solid rgba(239,68,68,0.3)" }}>
                  Token expirado
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Stats */}
        {isLoading ? (
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            {["Seguidores", "Posts"].map((l) => (
              <div key={l} style={{ flex: 1, textAlign: "center", padding: "10px 8px", background: "var(--bg3)", borderRadius: 10, border: "1px solid var(--border)" }}>
                <div style={{ height: 16, width: "50%", background: "var(--border)", borderRadius: 4, margin: "0 auto 6px", animation: "pulse 1.2s ease infinite" }} />
                <div style={{ fontSize: 10, color: "var(--muted)" }}>{l}</div>
              </div>
            ))}
          </div>
        ) : ins || followers != null ? (
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            {[
              { v: followers != null ? fmt(followers) : "—", l: "Seguidores", icon: "👥" },
              { v: posts != null ? fmt(posts) : "—", l: "Posts", icon: "📸" },
            ].map((s) => (
              <div key={s.l} style={{ flex: 1, textAlign: "center", padding: "10px 8px", background: "var(--bg3)", borderRadius: 10, border: "1px solid var(--border)", transition: "border-color 0.15s" }}>
                <div style={{ fontSize: 14, fontWeight: 700, letterSpacing: "-0.02em", marginBottom: 2 }}>{s.v}</div>
                <div style={{ fontSize: 10, color: "var(--muted)" }}>{s.l}</div>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ fontSize: 11, color: "var(--muted)", textAlign: "center", padding: "10px 0 12px", background: "var(--bg3)", borderRadius: 10, border: "1px solid var(--border)", marginBottom: 12 }}>
            Clique ↻ para carregar dados
          </div>
        )}

        {/* Rodapé data + badge App2 */}
        <div style={{ fontSize: 10, color: "var(--muted)", display: "flex", alignItems: "center", gap: 4, justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{ opacity: 0.6 }}>🗓</span>
            Conectada em {new Date(acc.connected_at || Date.now()).toLocaleDateString("pt-BR")}
          </div>
          {acc.token_app2 && (
            <span style={{
              fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 4,
              background: "rgba(124,92,252,0.15)", color: "var(--accent-light)",
              border: "1px solid rgba(124,92,252,0.3)", letterSpacing: "0.03em",
            }}>⚡ APP2</span>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Página principal ───────────────────────────────────────────────────────────
export default function Accounts() {
  const { accounts, removeAccount, clearAllAccounts, loading, reloadAccounts, addAccounts } = useAccounts();
  const [confirmModal,    setConfirmModal]    = useState(null);
  const [editingAcc,      setEditingAcc]      = useState(null);
  const [detailAcc,       setDetailAcc]       = useState(null);
  const [profileData,     setProfileData]     = useState({});
  const [loadingIns,      setLoadingIns]      = useState({});
  const [showPageIdModal, setShowPageIdModal] = useState(false);
  const [showTokenModal,  setShowTokenModal]  = useState(false);
  const [renamingAcc,     setRenamingAcc]     = useState(null);
  const [selectMode,      setSelectMode]      = useState(false);
  const [selected,        setSelected]        = useState(new Set());
  const [refreshingAll,   setRefreshingAll]   = useState(false);
  const [addMenuOpen,     setAddMenuOpen]     = useState(false);
  const addMenuRef = useRef(null);

  const APP_ID   = import.meta.env.VITE_META_FB_APP_ID || import.meta.env.VITE_META_APP_ID;
  const REDIRECT = encodeURIComponent(window.location.origin + "/api/auth-callback");
  const SCOPE    = "instagram_basic,instagram_content_publish,pages_read_engagement,pages_show_list,pages_manage_posts,business_management,pages_manage_metadata";

  const { status: oauthStatus, errorMsg: oauthError, openPopup, reset: resetOauth } = useOAuthPopup({
    flow: "facebook",
    onAccounts: async (accs) => {
      try { await addAccounts(accs); await reloadAccounts(); resetOauth(); setAddMenuOpen(false); }
      catch (err) { alert("Erro ao salvar contas: " + err.message); resetOauth(); }
    },
  });

  const { status: igStatus, errorMsg: igError, openPopup: openIgPopup, reset: resetIg } = useOAuthPopup({
    flow: "instagram",
    onAccounts: async (accs) => {
      try { await addAccounts(accs); await reloadAccounts(); resetIg(); setAddMenuOpen(false); }
      catch (err) { alert("Erro ao salvar contas: " + err.message); resetIg(); }
    },
  });

  // App 2 — fluxo Instagram Login
  const { status: app2IgStatus, openPopupApp2: openIgPopupApp2, reset: resetApp2Ig } = useOAuthPopup({
    flow: "instagram",
    onAccounts: async (accs) => {
      try { await addAccounts(accs); await reloadAccounts(); resetApp2Ig(); setAddMenuOpen(false); }
      catch (err) { alert("Erro ao vincular App 2: " + err.message); resetApp2Ig(); }
    },
    onApp2Accounts: async (accs) => {
      try { await addAccounts(accs); await reloadAccounts(); resetApp2Ig(); setAddMenuOpen(false); }
      catch (err) { alert("Erro ao vincular App 2: " + err.message); resetApp2Ig(); }
    },
    onError: (err) => {
      if (err === "app2_not_configured") alert("App 2 não configurado. Adicione VITE_META_APP_ID_2 nas variáveis de ambiente do Netlify.");
    },
  });

  // App 2 — fluxo Facebook/Página
  const { status: app2FbStatus, openPopupApp2: openFbPopupApp2, reset: resetApp2Fb } = useOAuthPopup({
    flow: "facebook",
    onAccounts: async (accs) => {
      try { await addAccounts(accs); await reloadAccounts(); resetApp2Fb(); setAddMenuOpen(false); }
      catch (err) { alert("Erro ao vincular App 2 (FB): " + err.message); resetApp2Fb(); }
    },
    onApp2Accounts: async (accs) => {
      try { await addAccounts(accs); await reloadAccounts(); resetApp2Fb(); setAddMenuOpen(false); }
      catch (err) { alert("Erro ao vincular App 2 (FB): " + err.message); resetApp2Fb(); }
    },
    onError: (err) => {
      if (err === "app2_not_configured") alert("App 2 não configurado. Adicione VITE_META_APP_ID_2 nas variáveis de ambiente do Netlify.");
    },
  });

  // Fecha o menu ao clicar fora
  useEffect(() => {
    if (!addMenuOpen) return;
    const handler = (e) => {
      if (addMenuRef.current && !addMenuRef.current.contains(e.target)) setAddMenuOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [addMenuOpen]);

  const profileRef    = useRef(profileData);
  const loadingInsRef = useRef(loadingIns);
  useEffect(() => { profileRef.current    = profileData; }, [profileData]);
  useEffect(() => { loadingInsRef.current = loadingIns;  }, [loadingIns]);

  const fetchProfile = useCallback(async (acc, force = false) => {
    if (!force && (loadingInsRef.current[acc.id] || profileRef.current[acc.id])) return;
    if (!acc.access_token) return;
    setLoadingIns((p) => ({ ...p, [acc.id]: true }));
    try {
      const res  = await fetch("/api/account-insights", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instagram_id: acc.id, access_token: acc.access_token }),
      });
      const json = await res.json();
      if (res.ok && !json.error) {
        const updatedAcc = {
          ...acc,
          username:        json.username        || acc.username,
          name:            json.name            || acc.name,
          profile_picture: json.profile_picture || acc.profile_picture,
          followers_count: json.followers_count ?? acc.followers_count,
          media_count:     json.media_count     ?? acc.media_count,
        };
        await dbPut("sessions", updatedAcc);
        setProfileData((p) => ({ ...p, [acc.id]: json }));
        return { id: acc.id, data: json };
      }
      return { id: acc.id, data: null };
    } catch {
      return { id: acc.id, data: null };
    } finally {
      setLoadingIns((p) => ({ ...p, [acc.id]: false }));
    }
  }, []);

  // Atualizar todas as contas de uma vez
  const handleRefreshAll = async () => {
    if (refreshingAll) return;
    setRefreshingAll(true);
    await Promise.all(accounts.map((acc) => fetchProfile(acc, true)));
    setRefreshingAll(false);
  };

  const openDetail = (acc) => {
    setDetailAcc(acc);
    if (!profileData[acc.id] && !loadingIns[acc.id]) fetchProfile(acc);
  };

  const handleConfirm = async () => {
    if (!confirmModal) return;
    if (confirmModal.type === "remove") await removeAccount(confirmModal.id);
    if (confirmModal.type === "clear")  await clearAllAccounts();
    if (confirmModal.type === "remove-selected") {
      await Promise.all([...selected].map((id) => removeAccount(id)));
      setSelected(new Set()); setSelectMode(false);
    }
    setConfirmModal(null); setDetailAcc(null);
  };

  const handleSaved = async (updated) => {
    await dbPut("sessions", updated); reloadAccounts(); setEditingAcc(null);
  };

  const handleAddViaToken = async (account) => {
    await addAccounts([account]);
    setShowTokenModal(false);
    setTimeout(() => fetchProfile(account, true), 600);
  };

  const handleAddViaPage = async (account) => {
    await addAccounts([account]);
    setShowPageIdModal(false);
    setTimeout(() => fetchProfile(account, true), 600);
  };

  // Totais agregados
  const totalFollowers = accounts.reduce((sum, acc) => {
    const ins = profileData[acc.id];
    const v = ins?.followers_count ?? acc.followers_count;
    return sum + (v || 0);
  }, 0);
  const totalPosts = accounts.reduce((sum, acc) => {
    const ins = profileData[acc.id];
    const v = ins?.media_count ?? acc.media_count;
    return sum + (v || 0);
  }, 0);
  const expiredTokens = accounts.filter((a) => a.token_status === "expired").length;

  if (loading) return (
    <div className="page" style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: 300 }}>
      <div className="spinner" style={{ width: 28, height: 28 }} />
    </div>
  );

  return (
    <div className="page">
      {/* ── Estilos internos ────────────────────────────────────────────────── */}
      <style>{`
        .account-card-actions { opacity: 0; transition: opacity 0.15s; }
        .card:hover .account-card-actions { opacity: 1 !important; }
        .stat-summary-card { transition: border-color 0.15s; }
        .stat-summary-card:hover { border-color: var(--border2) !important; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
        .account-card-grid > * { animation: fadeIn 0.25s ease both; }
        ${accounts.map((_, i) => `.account-card-grid > *:nth-child(${i + 1}) { animation-delay: ${i * 0.04}s; }`).join("\n")}
      `}</style>

      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div className="page-header" style={{ marginBottom: 20 }}>
        <div>
          <div className="page-title">Contas conectadas</div>
          <div className="page-subtitle">{accounts.length} conta(s) vinculada(s) via Meta API</div>
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          {/* Botão Atualizar todas — destaque */}
          {accounts.length > 0 && (
            <button
              className="btn btn-ghost btn-sm"
              onClick={handleRefreshAll}
              disabled={refreshingAll}
              style={{
                display: "flex", alignItems: "center", gap: 6,
                borderColor: refreshingAll ? "var(--accent)" : undefined,
                color: refreshingAll ? "var(--accent)" : undefined,
              }}
            >
              {refreshingAll
                ? <><span className="spinner" style={{ width: 12, height: 12 }} /> Atualizando...</>
                : <>↻ Atualizar todas</>}
            </button>
          )}

          {/* Selecionar */}
          {accounts.length > 0 && (
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => { setSelectMode((v) => !v); setSelected(new Set()); }}
              style={selectMode ? { borderColor: "var(--accent)", color: "var(--accent)" } : {}}
            >
              {selectMode ? "✕ Cancelar" : "☑ Selecionar"}
            </button>
          )}

          {/* Remover selecionados */}
          {selectMode && selected.size > 0 && (
            <button className="btn btn-danger btn-sm" onClick={() => setConfirmModal({ type: "remove-selected", count: selected.size })}>
              🗑 Remover ({selected.size})
            </button>
          )}

          {/* Remover todas */}
          {accounts.length > 0 && !selectMode && (
            <button className="btn btn-danger btn-sm" onClick={() => setConfirmModal({ type: "clear" })}>
              Remover todas
            </button>
          )}

          {/* Menu "Adicionar conta" */}
          <div style={{ position: "relative" }} ref={addMenuRef}>
            <button
              className="btn btn-primary btn-sm"
              onClick={() => setAddMenuOpen((v) => !v)}
              style={{ display: "flex", alignItems: "center", gap: 6 }}
            >
              + Nova conta
              <span style={{ fontSize: 10, opacity: 0.8 }}>▾</span>
            </button>

            {addMenuOpen && (
              <div style={{
                position: "absolute", top: "calc(100% + 8px)", right: 0, zIndex: 500,
                background: "var(--bg2)", border: "1px solid var(--border2)",
                borderRadius: 12, padding: 6, minWidth: 220,
                boxShadow: "0 16px 48px rgba(0,0,0,0.6)",
                animation: "fadeIn 0.15s ease",
              }}>
                {[
                  { label: "📷 Via Instagram", action: () => { openIgPopup(); }, loading: igStatus === "waiting" || igStatus === "saving", loadingLabel: igStatus === "waiting" ? "Aguardando..." : "Salvando..." },
                  { label: "📘 Via Facebook", action: () => { openPopup(); }, loading: oauthStatus === "waiting" || oauthStatus === "saving", loadingLabel: oauthStatus === "waiting" ? "Aguardando..." : "Salvando..." },
                  { label: "🔑 Via Page ID", action: () => { setShowPageIdModal(true); setAddMenuOpen(false); }, loading: false },
                  { label: "🔐 Via Token direto", action: () => { setShowTokenModal(true); setAddMenuOpen(false); }, loading: false },
                  null, // separador
                  { label: "⚡ App 2 via Instagram", action: () => { openIgPopupApp2(); setAddMenuOpen(false); }, loading: app2IgStatus === "waiting" || app2IgStatus === "saving", loadingLabel: app2IgStatus === "waiting" ? "Aguardando..." : "Salvando...", isApp2: true },
                  { label: "⚡ App 2 via Facebook", action: () => { openFbPopupApp2(); setAddMenuOpen(false); }, loading: app2FbStatus === "waiting" || app2FbStatus === "saving", loadingLabel: app2FbStatus === "waiting" ? "Aguardando..." : "Salvando...", isApp2: true },
                ].map((item, i) => {
                  if (item === null) return (
                    <div key={i} style={{ height: 1, background: "var(--border)", margin: "4px 8px" }} />
                  );
                  return (
                  <button
                    key={i}
                    onClick={item.action}
                    disabled={item.loading}
                    style={{
                      display: "flex", alignItems: "center", gap: 8, width: "100%",
                      padding: "9px 12px", borderRadius: 8,
                      background: item.isApp2 ? "rgba(124,92,252,0.08)" : "none",
                      border: item.isApp2 ? "1px solid rgba(124,92,252,0.2)" : "none",
                      color: item.isApp2 ? "var(--accent-light)" : "var(--text)",
                      fontSize: 13, fontWeight: item.isApp2 ? 600 : 500,
                      cursor: item.loading ? "default" : "pointer", opacity: item.loading ? 0.6 : 1,
                      transition: "background 0.12s",
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = item.isApp2 ? "rgba(124,92,252,0.15)" : "var(--bg3)"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = item.isApp2 ? "rgba(124,92,252,0.08)" : "none"; }}
                  >
                    {item.loading
                      ? <><span className="spinner" style={{ width: 12, height: 12 }} /> {item.loadingLabel}</>
                      : item.label}
                  </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Erros OAuth ─────────────────────────────────────────────────────── */}
      {igError && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", borderRadius: 10, marginBottom: 14, background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)", fontSize: 13, color: "var(--danger)" }}>
          ⚠️ {igError}
          <button onClick={resetIg} style={{ marginLeft: 10, background: "none", color: "inherit", fontSize: 12, textDecoration: "underline", padding: 0, cursor: "pointer" }}>Fechar</button>
        </div>
      )}
      {oauthError && (
        <div style={{ position: "fixed", bottom: 80, left: "50%", transform: "translateX(-50%)", padding: "10px 18px", borderRadius: 10, zIndex: 9999, background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.3)", color: "var(--danger)", fontSize: 13, maxWidth: 420, textAlign: "center", backdropFilter: "blur(8px)", boxShadow: "0 8px 32px rgba(0,0,0,0.4)" }}>
          ⚠️ {oauthError}
          <button onClick={resetOauth} style={{ marginLeft: 10, background: "none", color: "inherit", fontSize: 12, textDecoration: "underline", padding: 0, cursor: "pointer" }}>Fechar</button>
        </div>
      )}

      {/* ── Modais ──────────────────────────────────────────────────────────── */}
      {showTokenModal  && <AddViaTokenModal onClose={() => setShowTokenModal(false)}  onAdded={handleAddViaToken} />}
      {showPageIdModal && <AddViaPageModal  onClose={() => setShowPageIdModal(false)} onAdded={handleAddViaPage} />}

      {detailAcc && (
        <AccountDetailModal
          acc={detailAcc}
          ins={profileData[detailAcc.id]}
          loadingInsights={!!loadingIns[detailAcc.id]}
          onClose={() => setDetailAcc(null)}
          onEdit={() => { setEditingAcc(detailAcc); setDetailAcc(null); }}
          onRemove={() => { setConfirmModal({ type: "remove", id: detailAcc.id, username: detailAcc.username }); setDetailAcc(null); }}
          onRefresh={() => fetchProfile(detailAcc, true)}
        />
      )}

      {editingAcc && <EditProfileModal acc={editingAcc} onClose={() => setEditingAcc(null)} onSaved={handleSaved} />}

      {renamingAcc && (
        <RenameModal
          acc={renamingAcc}
          onClose={() => setRenamingAcc(null)}
          onSaved={async (updated) => { await addAccounts([updated]); setRenamingAcc(null); }}
        />
      )}

      {/* ── Vazio ───────────────────────────────────────────────────────────── */}
      {accounts.length === 0 ? (
        <div style={{
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
          padding: "80px 20px", textAlign: "center",
        }}>
          <div style={{
            width: 80, height: 80, borderRadius: 24, marginBottom: 20,
            background: "linear-gradient(135deg, var(--bg3), var(--bg4))",
            border: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 36,
          }}>📱</div>
          <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 8, letterSpacing: "-0.02em" }}>Nenhuma conta conectada</div>
          <div style={{ fontSize: 13, marginBottom: 28, color: "var(--muted)", maxWidth: 320 }}>
            Conecte contas Instagram Business ou Creator para gerenciar publicações e visualizar métricas.
          </div>
          <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
            <button onClick={openIgPopup} disabled={igStatus === "waiting" || igStatus === "saving"} className="btn btn-primary" style={{ display: "flex", alignItems: "center", gap: 6 }}>
              {igStatus === "waiting" ? <><span className="spinner" style={{ width: 12, height: 12 }} /> Aguardando...</>
              : igStatus === "saving"  ? <><span className="spinner" style={{ width: 12, height: 12 }} /> Salvando...</>
              : "📷 Conectar via Instagram"}
            </button>
            <button onClick={openPopup} disabled={oauthStatus === "waiting" || oauthStatus === "saving"} className="btn btn-ghost" style={{ display: "flex", alignItems: "center", gap: 6 }}>
              {oauthStatus === "waiting" ? <><span className="spinner" style={{ width: 12, height: 12 }} /> Aguardando...</>
              : oauthStatus === "saving"  ? <><span className="spinner" style={{ width: 12, height: 12 }} /> Salvando...</>
              : "📘 Conectar via Facebook"}
            </button>
            <button className="btn btn-ghost" onClick={() => setShowTokenModal(true)}>🔐 Via Token</button>
            <button className="btn btn-ghost" onClick={() => setShowPageIdModal(true)}>🔑 Via Page ID</button>
          </div>
        </div>
      ) : (
        <>
          {/* ── Cards de resumo ──────────────────────────────────────────────── */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 12, marginBottom: 24 }}>
            {[
              { icon: "📱", label: "Contas", value: accounts.length, sub: "conectadas", color: "var(--accent)" },
              { icon: "👥", label: "Seguidores", value: fmt(totalFollowers), sub: "total combinado", color: "#22c55e" },
              { icon: "📸", label: "Posts", value: fmt(totalPosts), sub: "total combinado", color: "#38bdf8" },
              ...(expiredTokens > 0 ? [{ icon: "⚠️", label: "Tokens", value: expiredTokens, sub: "expirado(s)", color: "var(--danger)" }] : []),
            ].map((s) => (
              <div
                key={s.label}
                className="stat-summary-card"
                style={{
                  background: "var(--bg2)", border: "1px solid var(--border)",
                  borderRadius: 14, padding: "16px 18px",
                  borderTop: `3px solid ${s.color}`,
                }}
              >
                <div style={{ fontSize: 20, marginBottom: 8 }}>{s.icon}</div>
                <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-0.03em", color: s.color }}>{s.value}</div>
                <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text2)", marginTop: 2 }}>{s.label}</div>
                <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 1 }}>{s.sub}</div>
              </div>
            ))}
          </div>

          {/* ── Grid de cards ───────────────────────────────────────────────── */}
          <div
            className="account-card-grid"
            style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 14 }}
          >
            {accounts.map((acc) => (
              <AccountCard
                key={acc.id}
                acc={acc}
                ins={profileData[acc.id]}
                isLoading={!!loadingIns[acc.id]}
                selectMode={selectMode}
                isSelected={selected.has(acc.id)}
                onToggleSelect={() => setSelected((prev) => {
                  const next = new Set(prev);
                  if (next.has(acc.id)) next.delete(acc.id); else next.add(acc.id);
                  return next;
                })}
                onOpenDetail={() => openDetail(acc)}
                onRename={() => setRenamingAcc(acc)}
                onRefresh={() => fetchProfile(acc, true)}
              />
            ))}
          </div>
        </>
      )}

      {/* ── Confirm Modal ────────────────────────────────────────────────────── */}
      <Modal
        open={!!confirmModal}
        title={
          confirmModal?.type === "clear" ? "Remover todas as contas?"
          : confirmModal?.type === "remove-selected" ? `Remover ${confirmModal?.count} conta(s)?`
          : `Desconectar @${confirmModal?.username}?`
        }
        message={
          confirmModal?.type === "clear" ? "Todas as contas e tokens serão removidos do dispositivo."
          : confirmModal?.type === "remove-selected" ? `As ${confirmModal?.count} contas selecionadas serão desconectadas.`
          : "A conta será removida do Insta Manager. Você poderá reconectá-la quando quiser."
        }
        confirmLabel={confirmModal?.type === "clear" || confirmModal?.type === "remove-selected" ? "Remover" : "Desconectar"}
        confirmDanger
        onConfirm={handleConfirm}
        onCancel={() => setConfirmModal(null)}
      />
    </div>
  );
}
