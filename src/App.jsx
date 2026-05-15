import { Routes, Route, useLocation } from "react-router-dom";
import { useEffect, useState, useCallback, useRef, createContext, useContext } from "react";

import Accounts from "./pages/Accounts.jsx";
import Queue    from "./pages/Queue.jsx";
import History  from "./pages/History.jsx";

import { useAccounts }  from "./useAccounts.js";
import { useToast }     from "./useToast.js";
import { useOAuthUrl }  from "./useOAuthUrl.js";
import { useOAuthPopup } from "./useOAuthPopup.js";
import { dbGetAll, dbGet, dbPut, dbPutMany, dbDelete, dbClear } from "./useDB.js";
import Sidebar from "./Sidebar.jsx";
import Toast   from "./Toast.jsx";
import MobileBottomNav from "./MobileBottomNav.jsx";

export { useAccounts };

// ─── History Context ──────────────────────────────────────────────────────────
const HistoryContext = createContext(null);
export const useHistory = () => useContext(HistoryContext);

function HistoryProvider({ children }) {
  const [history, setHistory]     = useState([]);
  const [totalCount, setTotalCount] = useState(0);

  const reload = useCallback(async () => {
    const all = await dbGetAll("history");
    all.sort((a, b) => {
      const ta = a.created_at ? new Date(a.created_at).getTime() : parseInt((a.id || "0").split("-")[1] || "0", 10);
      const tb = b.created_at ? new Date(b.created_at).getTime() : parseInt((b.id || "0").split("-")[1] || "0", 10);
      return tb - ta;
    });
    setTotalCount(all.length);
    setHistory(all.slice(0, 500));
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const addEntry    = useCallback(async (entry) => { await dbPut("history", entry); reload(); }, [reload]);
  const clearHistory = useCallback(async () => { await dbClear("history"); setHistory([]); setTotalCount(0); }, []);

  return (
    <HistoryContext.Provider value={{ history, totalCount, addEntry, clearHistory, reloadHistory: reload }}>
      {children}
    </HistoryContext.Provider>
  );
}

// ─── Scheduler Context ────────────────────────────────────────────────────────
const SchedulerContext = createContext(null);
export const useScheduler = () => useContext(SchedulerContext);

const qApi = {
  getAll: ()      => fetch("/api/queue").then((r) => r.json()).catch(() => []),
  save:   (items) => fetch("/api/queue", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Array.isArray(items) ? items : [items]) }).catch(() => {}),
  update: (item)  => fetch("/api/queue", { method: "PUT",  headers: { "Content-Type": "application/json" }, body: JSON.stringify(item) }).then((r) => r.json()).catch(() => item),
  remove: (id)    => fetch(`/api/queue?id=${id}`, { method: "DELETE" }).catch(() => {}),
  clear:  ()      => fetch("/api/queue", { method: "DELETE" }).catch(() => {}),
};

function SchedulerProvider({ addEntry, children }) {
  const [queue, setQueue] = useState([]);
  const runningRef = useRef(new Set());

  const reload = useCallback(async () => {
    const all = await qApi.getAll();
    if (!Array.isArray(all)) return;
    all.sort((a, b) => (a.scheduledAt || 0) - (b.scheduledAt || 0));
    setQueue(all);
    try { await dbClear("queue"); await dbPutMany("queue", all); } catch {}

    // Sincroniza histórico de itens "done" pelo servidor
    try {
      const done = all.filter((x) => !x.type && x.status === "done" && !x._historySynced);
      for (const item of done) {
        const historyId = `h-srv-${item.id}`;
        const exists = await dbGet("history", historyId).catch(() => null);
        if (!exists) {
          await dbPut("history", {
            id:              historyId,
            post_type:       item.postType,
            media_url:       item.mediaUrl || "",
            media_type:      item.mediaType,
            default_caption: item.caption  || "",
            results:         item.results  || [],
            created_at:      item.completedAt || new Date().toISOString(),
            from_scheduler:  true,
          });
        }
        await qApi.update({ ...item, _historySynced: true }).catch(() => {});
      }
      if (done.length > 0) window.dispatchEvent(new CustomEvent("sw:queue-update"));
    } catch {}
  }, []);

  useEffect(() => {
    reload();
    const h = () => reload();
    window.addEventListener("sw:queue-update", h);
    return () => window.removeEventListener("sw:queue-update", h);
  }, [reload]);

  // Tick do scheduler no browser (fallback quando o cron não está ativo)
  useEffect(() => {
    let cronAvailable = false;

    const detectCron = async () => {
      try {
        const res = await fetch("/api/scheduler", { method: "GET" });
        cronAvailable = res.ok;
      } catch { cronAvailable = false; }
    };
    detectCron();
    const cronCheck = setInterval(detectCron, 5 * 60_000);

    const tick = async () => {
      const all = await qApi.getAll();
      if (!Array.isArray(all)) return;
      const now = Date.now();

      // Reseta travados
      for (const item of all.filter((x) => x.status === "running")) {
        await qApi.update({ ...item, status: "pending", scheduledAt: now + 5000 });
      }

      // Se o cron serverless está ativo, não processa aqui (evita duplicar)
      if (cronAvailable) return;

      const due = all.filter((x) => x.status === "pending" && x.scheduledAt <= now);
      for (const item of due) {
        if (runningRef.current.has(item.id)) continue;
        runningRef.current.add(item.id);
        await qApi.update({ ...item, status: "running" });
        reload();

        try {
          const res = await fetch("/.netlify/functions/publish", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              accounts:        item.accounts,
              media_url:       item.mediaUrl,
              media_type:      item.mediaType,
              post_type:       item.postType,
              captions:        item.captions || {},
              default_caption: item.caption  || "",
              skip_rate_limit: true,
            }),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data    = await res.json();
          const results = data.results || [];

          await addEntry({
            id:              `h-${Date.now()}`,
            post_type:       item.postType,
            media_url:       item.mediaUrl,
            media_type:      item.mediaType,
            default_caption: item.caption,
            results,
            created_at:      new Date().toISOString(),
            from_scheduler:  true,
          });

          if (item.loop) {
            await qApi.update({
              ...item,
              status:      "pending",
              scheduledAt: item.scheduledAt + 60 * 60_000,
              runCount:    (item.runCount || 0) + 1,
            });
          } else {
            await qApi.update({ ...item, status: "done" });
          }
        } catch (err) {
          await qApi.update({ ...item, status: "error", error: err.message });
        }
        runningRef.current.delete(item.id);
        reload();
      }
    };

    const iv = setInterval(tick, 15_000);
    tick();
    return () => { clearInterval(iv); clearInterval(cronCheck); };
  }, [addEntry, reload]);

  const addBatch = async (items) => {
    const BATCH = 100;
    for (let i = 0; i < items.length; i += BATCH) {
      await qApi.save(items.slice(i, i + BATCH));
    }
    reload();
  };

  const updateItem  = async (item) => { await qApi.update(item); reload(); };
  const removeItem  = async (id)   => { await qApi.remove(id); setQueue((p) => p.filter((x) => x.id !== id)); };
  const clearQueue  = async ()     => { await qApi.clear(); setQueue([]); };

  const cancelPending = async () => {
    const all = await qApi.getAll();
    const pending = all.filter((x) => x.status === "pending");
    for (const item of pending) await qApi.update({ ...item, status: "cancelled" });
    reload();
    return pending.length;
  };

  const resumeQueue = async () => {
    const all = await qApi.getAll();
    const cancelled = all.filter((x) => x.status === "cancelled");
    for (const item of cancelled) await qApi.update({ ...item, status: "pending" });
    reload();
    return cancelled.length;
  };

  return (
    <SchedulerContext.Provider value={{ queue, addBatch, updateItem, removeItem, clearQueue, cancelPending, resumeQueue, reload }}>
      {children}
    </SchedulerContext.Provider>
  );
}

// ─── AppShell ─────────────────────────────────────────────────────────────────
function AppShell() {
  const { addAccounts, accounts, syncing, loading: accountsLoading } = useAccounts();
  const { toast, showToast } = useToast();
  const { oauthUrl }         = useOAuthUrl();
  const location = useLocation();
  const { addEntry } = useHistory();

  const { status: oauthStatus, errorMsg: oauthError, openPopup, reset: resetOauth } = useOAuthPopup({
    onAccounts: async (accs) => {
      try {
        showToast("success", `✅ ${accs.length} conta(s) conectada(s)! Salvando...`);
        await addAccounts(accs);
        showToast("success", `✅ ${accs.length} conta(s) salvas!`);
        resetOauth();
      } catch (err) {
        showToast("error", "Erro ao salvar contas: " + err.message);
        resetOauth();
      }
    },
    onError: (err) => {
      if (err !== "popup_blocked" && err !== "Login cancelado.") {
        showToast("error", "Erro no login: " + (err || "Tente novamente."));
      }
    },
  });

  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  useEffect(() => { setMobileMenuOpen(false); }, [location.pathname]);

  // Lê contas da URL (callback OAuth)
  useEffect(() => {
    const params  = new URLSearchParams(window.location.search);
    const encoded = params.get("accounts");
    const error   = params.get("error");
    window.history.replaceState({}, "", window.location.pathname);
    if (encoded) {
      (async () => {
        try {
          const accs = JSON.parse(atob(encoded.replace(/-/g, "+").replace(/_/g, "/")));
          showToast("success", `Salvando ${accs.length} conta(s)...`);
          await addAccounts(accs);
          showToast("success", `✅ ${accs.length} conta(s) conectada(s)!`);
        } catch (err) {
          showToast("error", "Erro ao salvar contas: " + err.message);
        }
      })();
    }
    if (error) showToast("error", decodeURIComponent(error));
  }, []);

  return (
    <SchedulerProvider addEntry={addEntry}>
      <div style={{ display: "flex", minHeight: "100vh" }}>
        <aside style={{ width: 230, background: "var(--bg2)", borderRight: "1px solid var(--border)", display: "flex", flexDirection: "column", flexShrink: 0, position: "sticky", top: 0, height: "100vh" }} className="sidebar-desktop">
          <Sidebar accounts={accounts} oauthUrl={oauthUrl} syncing={syncing} loading={accountsLoading} onConnectInstagram={openPopup} oauthStatus={oauthStatus} />
        </aside>

        <div className="mobile-header">
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 30, height: 30, borderRadius: 8, background: "linear-gradient(135deg, var(--accent), #9b4dfc)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15 }}>📱</div>
            <span style={{ fontWeight: 700, fontSize: 14 }}>Insta Manager</span>
            {syncing && <span style={{ color: "var(--accent-light)", animation: "spin 1s linear infinite", display: "inline-block", fontSize: 14 }}>⟳</span>}
          </div>
          <button
            onClick={oauthStatus === "waiting" ? undefined : openPopup}
            disabled={oauthStatus === "waiting" || oauthStatus === "saving"}
            style={{ fontSize: 12, fontWeight: 600, padding: "6px 12px", borderRadius: 8, background: "linear-gradient(135deg, var(--accent), #9b4dfc)", color: "#fff", border: "none", cursor: oauthStatus === "waiting" ? "not-allowed" : "pointer", display: "flex", alignItems: "center", gap: 6, opacity: oauthStatus === "waiting" || oauthStatus === "saving" ? 0.7 : 1 }}
          >
            {oauthStatus === "waiting" ? <><span className="spinner" style={{ width: 11, height: 11, borderTopColor: "#fff" }} /> Aguardando...</>
            : oauthStatus === "saving"  ? <><span className="spinner" style={{ width: 11, height: 11, borderTopColor: "#fff" }} /> Salvando...</>
            : "+ Conta"}
          </button>
        </div>

        <MobileBottomNav />

        <main style={{ flex: 1, overflow: "auto", minWidth: 0, background: "var(--bg)" }}>
          <Toast toast={toast} />
          <Routes>
            <Route path="/"          element={<Accounts />} />
            <Route path="/fila"      element={<Queue />} />
            <Route path="/historico" element={<History />} />
          </Routes>
        </main>

        <style>{`
          @keyframes slideIn     { from { opacity: 0; transform: translateX(20px);  } to { opacity: 1; transform: translateX(0); } }
          @keyframes slideInLeft { from { opacity: 0; transform: translateX(-100%); } to { opacity: 1; transform: translateX(0); } }
          @keyframes spin        { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
          .sidebar-desktop { display: flex; }
          .mobile-header   { display: none; }
          @media (max-width: 768px) {
            .sidebar-desktop { display: none !important; }
            .mobile-header { display: flex; align-items: center; justify-content: space-between; position: fixed; top: 0; left: 0; right: 0; z-index: 100; padding: 10px 16px; background: var(--bg2); border-bottom: 1px solid var(--border); height: 52px; }
            main { padding-top: 52px; padding-bottom: 70px; }
          }
        `}</style>
      </div>
    </SchedulerProvider>
  );
}

export default function App() {
  return (
    <HistoryProvider>
      <AppShell />
    </HistoryProvider>
  );
}
