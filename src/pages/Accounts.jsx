import { useState, useCallback, useEffect, useRef } from "react";
import { useAccounts } from "../App.jsx";
import { useOAuthPopup } from "../useOAuthPopup.js";
import { dbPut } from "../useDB.js";
import Modal from "../Modal.jsx";
import AccountAvatar from "../components/accounts/AccountAvatar.jsx";
import StatBox from "../components/accounts/AccountStatBox.jsx";
import { RenameModal, AddViaPageModal, EditProfileModal, AddViaTokenModal } from "../components/accounts/AccountModals.jsx";
import { fmt } from "../components/accounts/AccountUtils.js";

// ── Modal de detalhes da conta ────────────────────────────────────────────────
function AccountDetailModal({ acc, ins, loadingInsights, onClose, onEdit, onRemove, onRefresh }) {
  const tokenExpired = acc.token_status === "expired";

  return (
    <div onClick={(e) => e.target === e.currentTarget && onClose()} style={{
      position: "fixed", inset: 0, zIndex: 2000,
      background: "rgba(0,0,0,0.75)", backdropFilter: "blur(5px)",
      display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
    }}>
      <div style={{
        background: "var(--bg2)", border: "1px solid var(--border2)",
        borderRadius: 18, width: "100%", maxWidth: 420,
        maxHeight: "90vh", display: "flex", flexDirection: "column",
        boxShadow: "0 24px 64px rgba(0,0,0,0.7)", overflow: "hidden",
      }}>
        <div style={{ height: 48, background: "linear-gradient(135deg, var(--bg3), var(--border))", position: "relative", borderBottom: "1px solid var(--border)" }}>
          <button onClick={onClose} style={{ position: "absolute", top: 10, right: 12, background: "none", color: "var(--muted)", fontSize: 20, padding: "0 4px", lineHeight: 1 }}>×</button>
        </div>

        <div style={{ padding: "0 16px", marginTop: -24, display: "flex", alignItems: "flex-end", justifyContent: "space-between" }}>
          <AccountAvatar acc={acc} ins={ins} size={52} />
          <div style={{ display: "flex", gap: 6, paddingBottom: 6 }}>
            <button className="btn btn-ghost btn-sm" onClick={onRefresh} disabled={loadingInsights}>
              {loadingInsights ? <span className="spinner" style={{ width: 12, height: 12 }} /> : "↻"}
            </button>
            <button className="btn btn-ghost btn-sm" onClick={onEdit}>✏️</button>
            <button className="btn btn-danger btn-sm" onClick={onRemove}>Desconectar</button>
          </div>
        </div>

        <div style={{ padding: "8px 16px 12px" }}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>{acc.nickname || acc.name || acc.username}</div>
          <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 6 }}>@{acc.username}</div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            <span className="badge badge-purple">{acc.account_type || "BUSINESS"}</span>
            {acc.added_via === "page_id" && <span className="badge" style={{ fontSize: 10, background: "rgba(245,158,11,0.12)", color: "var(--warning)", border: "1px solid rgba(245,158,11,0.3)" }}>🔑 via Page ID</span>}
          </div>
        </div>

        <div style={{ padding: "0 16px 16px", overflowY: "auto", flex: 1 }}>
          {loadingInsights ? (
            <div style={{ textAlign: "center", padding: "32px 0" }}>
              <div className="spinner" style={{ width: 24, height: 24, margin: "0 auto 10px" }} />
              <div style={{ fontSize: 12, color: "var(--muted)" }}>Buscando dados...</div>
            </div>
          ) : ins ? (
            <>
              <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
                <StatBox label="Seguidores" value={fmt(ins.followers_count)} icon="👥" />
                <StatBox label="Posts"      value={fmt(ins.media_count)}     icon="📸" />
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginBottom: 12 }}>
                {[
                  { icon: "🗂", label: "Tipo",         value: ins.account_type || acc.account_type || "BUSINESS" },
                  { icon: "🗓", label: "Conectada em", value: new Date(acc.connected_at || Date.now()).toLocaleDateString("pt-BR") },
                  { icon: "🔄", label: "Atualizado",   value: ins.fetched_at ? new Date(ins.fetched_at).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : "—" },
                  { icon: "🆔", label: "ID",           value: acc.id },
                ].map((item) => (
                  <div key={item.label} style={{ padding: "7px 9px", background: "var(--bg3)", borderRadius: 8, border: "1px solid var(--border)" }}>
                    <div style={{ fontSize: 10, color: "var(--muted)", marginBottom: 2 }}>{item.icon} {item.label}</div>
                    <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.value}</div>
                  </div>
                ))}
              </div>

              <div style={{ padding: "8px 11px", background: "var(--bg3)", borderRadius: 8, border: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 8 }}>
                <span>🔒</span>
                <div>
                  <div style={{ fontSize: 11, fontWeight: 600 }}>Token de acesso</div>
                  <div style={{ fontSize: 10, color: tokenExpired ? "var(--danger)" : "var(--success)" }}>
                    {tokenExpired ? "Expirado — reconecte a conta" : "Armazenado com segurança"}
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div style={{ textAlign: "center", padding: "20px 0", color: "var(--muted)", fontSize: 13 }}>
              Não foi possível carregar os dados da conta.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Página principal ──────────────────────────────────────────────────────────
export default function Accounts() {
  const { accounts, removeAccount, clearAllAccounts, loading, reloadAccounts, addAccounts } = useAccounts();
  const [confirmModal,    setConfirmModal]    = useState(null);
  const [editingAcc,      setEditingAcc]      = useState(null);
  const [detailAcc,       setDetailAcc]       = useState(null);
  const [profileData,     setProfileData]     = useState({});
  const [loadingIns,      setLoadingIns]      = useState({});
  const [showPageIdModal,  setShowPageIdModal]  = useState(false);
  const [showTokenModal,   setShowTokenModal]   = useState(false);
  const [renamingAcc,     setRenamingAcc]     = useState(null);
  const [selectMode,      setSelectMode]      = useState(false);
  const [selected,        setSelected]        = useState(new Set());

  const APP_ID   = import.meta.env.VITE_META_FB_APP_ID || import.meta.env.VITE_META_APP_ID;
  const REDIRECT = encodeURIComponent(window.location.origin + "/api/auth-callback");
  const SCOPE    = "instagram_basic,instagram_content_publish,pages_read_engagement,pages_show_list,pages_manage_posts,business_management,pages_manage_metadata";

  const { status: oauthStatus, errorMsg: oauthError, openPopup, reset: resetOauth } = useOAuthPopup({
    flow: "facebook",
    onAccounts: async (accs) => {
      try { await addAccounts(accs); await reloadAccounts(); resetOauth(); }
      catch (err) { alert("Erro ao salvar contas: " + err.message); resetOauth(); }
    },
  });

  const { status: igStatus, errorMsg: igError, openPopup: openIgPopup, reset: resetIg } = useOAuthPopup({
    flow: "instagram",
    onAccounts: async (accs) => {
      try { await addAccounts(accs); await reloadAccounts(); resetIg(); }
      catch (err) { alert("Erro ao salvar contas: " + err.message); resetIg(); }
    },
  });

  const profileRef    = useRef(profileData);
  const loadingInsRef = useRef(loadingIns);
  useEffect(() => { profileRef.current    = profileData; }, [profileData]);
  useEffect(() => { loadingInsRef.current = loadingIns;  }, [loadingIns]);

  // Busca apenas perfil básico (username, foto, seguidores) — sem métricas
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
    setTimeout(() => fetchProfile(account, true), 600);
  };

  const handleAddViaPage = async (account) => {
    await addAccounts([account]);
    setTimeout(() => fetchProfile(account, true), 600);
  };

  if (loading) return (
    <div className="page" style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: 300 }}>
      <div className="spinner" style={{ width: 28, height: 28 }} />
    </div>
  );

  return (
    <div className="page">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="page-header">
        <div>
          <div className="page-title">Contas conectadas</div>
          <div className="page-subtitle">{accounts.length} conta(s) vinculada(s) via Meta API</div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {accounts.length > 0 && !selectMode && (
            <button className="btn btn-danger btn-sm" onClick={() => setConfirmModal({ type: "clear" })}>
              Remover todas
            </button>
          )}
          {accounts.length > 0 && selectMode && selected.size > 0 && (
            <button className="btn btn-danger btn-sm" onClick={() => setConfirmModal({ type: "remove-selected", count: selected.size })}>
              🗑 Remover ({selected.size})
            </button>
          )}
          {accounts.length > 0 && (
            <button className="btn btn-ghost btn-sm" onClick={() => { setSelectMode((v) => !v); setSelected(new Set()); }}
              style={selectMode ? { borderColor: "var(--accent)", color: "var(--accent)" } : {}}>
              {selectMode ? "✕ Cancelar" : "☑ Selecionar"}
            </button>
          )}
          <button className="btn btn-ghost btn-sm" onClick={() => setShowPageIdModal(true)}>
            🔑 Adicionar via Page ID
          </button>
          <button className="btn btn-ghost btn-sm" onClick={() => setShowTokenModal(true)}>
            🔐 Adicionar via Token
          </button>
          <button
            onClick={openPopup}
            disabled={oauthStatus === "waiting" || oauthStatus === "saving"}
            className="btn btn-ghost btn-sm"
            style={{ display: "flex", alignItems: "center", gap: 6 }}
          >
            {oauthStatus === "waiting"
              ? <><span className="spinner" style={{ width: 12, height: 12 }} /> Aguardando...</>
              : oauthStatus === "saving"
                ? <><span className="spinner" style={{ width: 12, height: 12 }} /> Salvando...</>
                : "📘 + Conta via Facebook"}
          </button>
          <button
            onClick={openIgPopup}
            disabled={igStatus === "waiting" || igStatus === "saving"}
            className="btn btn-primary btn-sm"
            style={{ display: "flex", alignItems: "center", gap: 6 }}
          >
            {igStatus === "waiting"
              ? <><span className="spinner" style={{ width: 12, height: 12 }} /> Aguardando...</>
              : igStatus === "saving"
                ? <><span className="spinner" style={{ width: 12, height: 12 }} /> Salvando...</>
                : "📷 + Conta via Instagram"}
          </button>
        </div>
      </div>

      {/* ── Erros OAuth ───────────────────────────────────────────────────── */}
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

      {/* ── Modais ─────────────────────────────────────────────────────────── */}
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
          onSaved={async (updated) => { await addAccounts([updated]); }}
        />
      )}

      {/* ── Vazio ──────────────────────────────────────────────────────────── */}
      {accounts.length === 0 ? (
        <div className="empty">
          <div className="empty-icon">📱</div>
          <div className="empty-title">Nenhuma conta conectada</div>
          <div style={{ fontSize: 13, marginBottom: 20, color: "var(--muted)" }}>Conecte contas Instagram Business ou Creator.</div>
          <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
            <button onClick={openPopup} disabled={oauthStatus === "waiting" || oauthStatus === "saving"} className="btn btn-ghost" style={{ display: "flex", alignItems: "center", gap: 6 }}>
              {oauthStatus === "waiting" ? <><span className="spinner" style={{ width: 12, height: 12 }} /> Aguardando...</>
              : oauthStatus === "saving"  ? <><span className="spinner" style={{ width: 12, height: 12 }} /> Salvando...</>
              : "📘 Conectar via Facebook"}
            </button>
            <button onClick={openIgPopup} disabled={igStatus === "waiting" || igStatus === "saving"} className="btn btn-primary" style={{ display: "flex", alignItems: "center", gap: 6 }}>
              {igStatus === "waiting" ? <><span className="spinner" style={{ width: 12, height: 12 }} /> Aguardando...</>
              : igStatus === "saving"  ? <><span className="spinner" style={{ width: 12, height: 12 }} /> Salvando...</>
              : "📷 Conectar via Instagram"}
            </button>
            <button className="btn btn-ghost" onClick={() => setShowTokenModal(true)}>🔐 Adicionar via Token</button>
            <button className="btn btn-ghost" onClick={() => setShowPageIdModal(true)}>🔑 Adicionar via Page ID</button>
          </div>
        </div>
      ) : (
        <>
          {/* ── Grid de cards ──────────────────────────────────────────────── */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(250px, 1fr))", gap: 12 }}>
            {accounts.map((acc) => {
              const ins          = profileData[acc.id];
              const isLoading    = !!loadingIns[acc.id];
              const tokenExpired = acc.token_status === "expired";

              return (
                <div
                  key={acc.id}
                  className="card card-hover"
                  style={{
                    display: "flex", flexDirection: "column", gap: 10, cursor: "pointer", position: "relative",
                    outline: selectMode && selected.has(acc.id) ? "2px solid var(--accent)" : "none",
                    outlineOffset: 2,
                  }}
                  onClick={() => {
                    if (selectMode) {
                      setSelected((prev) => {
                        const next = new Set(prev);
                        if (next.has(acc.id)) next.delete(acc.id); else next.add(acc.id);
                        return next;
                      });
                    } else {
                      openDetail(acc);
                    }
                  }}
                >
                  {/* Checkbox de seleção */}
                  {selectMode && (
                    <div style={{ position: "absolute", top: 8, left: 8, width: 18, height: 18, borderRadius: 5, border: "2px solid var(--accent)", background: selected.has(acc.id) ? "var(--accent)" : "transparent", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 10, fontSize: 11, color: "#fff", pointerEvents: "none" }}>
                      {selected.has(acc.id) && "✓"}
                    </div>
                  )}

                  {/* Botões de ação rápida */}
                  <div style={{ position: "absolute", top: 8, right: 8, display: "flex", gap: 4 }} onClick={(e) => e.stopPropagation()}>
                    <button onClick={() => setRenamingAcc(acc)} title="Renomear" style={{ background: "var(--bg3)", border: "1px solid var(--border)", borderRadius: 6, padding: "3px 7px", fontSize: 10, color: "var(--muted)", cursor: "pointer", lineHeight: 1 }}>✏️</button>
                    <button onClick={() => fetchProfile(acc, true)} disabled={isLoading} title="Atualizar" style={{ background: "var(--bg3)", border: "1px solid var(--border)", borderRadius: 6, padding: "3px 7px", fontSize: 10, color: "var(--muted)", cursor: isLoading ? "default" : "pointer", opacity: isLoading ? 0.5 : 1, lineHeight: 1 }}>↻</button>
                  </div>

                  {/* Avatar + nome */}
                  <div style={{ display: "flex", alignItems: "center", gap: 11, paddingRight: 52 }}>
                    <AccountAvatar acc={acc} ins={ins} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 700, fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {acc.nickname || ins?.name || acc.name || acc.username || "—"}
                      </div>
                      <div style={{ fontSize: 11, color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        @{ins?.username || acc.username || "—"}
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 4, flexWrap: "wrap" }}>
                        <span className="badge badge-purple" style={{ fontSize: 9 }}>{acc.account_type || "BUSINESS"}</span>
                        {acc.added_via === "page_id" && <span style={{ fontSize: 10, color: "var(--warning)" }} title="via Page ID">🔑</span>}
                        {tokenExpired && <span style={{ fontSize: 9, padding: "1px 5px", borderRadius: 4, background: "rgba(239,68,68,0.12)", color: "var(--danger)", border: "1px solid rgba(239,68,68,0.3)" }}>Token expirado</span>}
                      </div>
                    </div>
                  </div>

                  {/* Stats: seguidores / posts */}
                  {isLoading ? (
                    <div style={{ display: "flex", gap: 5 }}>
                      {["Seguidores", "Posts"].map((l) => (
                        <div key={l} style={{ flex: 1, textAlign: "center", padding: "7px 4px", background: "var(--bg3)", borderRadius: 7, border: "1px solid var(--border)" }}>
                          <div style={{ height: 14, width: "55%", background: "var(--border)", borderRadius: 4, margin: "0 auto 4px", animation: "pulse 1.2s ease infinite" }} />
                          <div style={{ fontSize: 9, color: "var(--muted)" }}>{l}</div>
                        </div>
                      ))}
                    </div>
                  ) : ins ? (
                    <div style={{ display: "flex", gap: 5 }}>
                      {[
                        { v: fmt(ins.followers_count ?? acc.followers_count), l: "Seguidores" },
                        { v: fmt(ins.media_count     ?? acc.media_count),     l: "Posts" },
                      ].map((s) => (
                        <div key={s.l} style={{ flex: 1, textAlign: "center", padding: "7px 4px", background: "var(--bg3)", borderRadius: 7, border: "1px solid var(--border)" }}>
                          <div style={{ fontSize: 13, fontWeight: 700 }}>{s.v}</div>
                          <div style={{ fontSize: 9, color: "var(--muted)", marginTop: 1 }}>{s.l}</div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div style={{ fontSize: 11, color: "var(--muted)", textAlign: "center", padding: "4px 0" }}>
                      Clique ↻ para carregar dados
                    </div>
                  )}

                  <div style={{ fontSize: 10, color: "var(--muted)", marginTop: "auto" }}>
                    🗓 Conectada em {new Date(acc.connected_at || Date.now()).toLocaleDateString("pt-BR")}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* ── Confirm Modal ──────────────────────────────────────────────────── */}
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
