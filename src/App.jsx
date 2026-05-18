import { Routes, Route, useLocation } from "react-router-dom";
import { useEffect, useState, useCallback, useRef, createContext, useContext } from "react";

import Dashboard from "./pages/Dashboard.jsx";
import Accounts  from "./pages/Accounts.jsx";
import Queue    from "./pages/Queue.jsx";
import History  from "./pages/History.jsx";
import Warmup   from "./pages/Warmup.jsx";
import Settings  from "./pages/Settings.jsx";
import Profiles  from "./components/Profiles/Profiles.jsx";
import Contingency from "./pages/Contingency.jsx";

import { useAccounts }   from "./useAccounts.js";
import { useToast }      from "./useToast.js";
import { useOAuthUrl }   from "./useOAuthUrl.js";
import { useOAuthPopup } from "./useOAuthPopup.js";
import { useTokenCheck } from "./useTokenCheck.js";
import { dbGetAll, dbGet, dbPut, dbPutMany, dbClear } from "./useDB.js";
import Sidebar         from "./Sidebar.jsx";
import Toast           from "./Toast.jsx";
import MobileBottomNav from "./MobileBottomNav.jsx";

export { useAccounts };

// ─── History Context ──────────────────────────────────────────────────────────
const HistoryContext = createContext(null);
export const useHistory = () => useContext(HistoryContext);

function HistoryProvider({ children }) {
  const [history, setHistory]       = useState([]);
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
  useEffect(() => {
    const h = () => reload();
    window.addEventListener("sw:queue-update", h);
    return () => window.removeEventListener("sw:queue-update", h);
  }, [reload]);

  const addEntry     = useCallback(async (entry) => { await dbPut("history", entry); reload(); }, [reload]);
  const clearHistory = useCallback(async () => { await dbClear("history"); setHistory([]); setTotalCount(0); }, []);

  return (
    <HistoryContext.Provider value={{ history, totalCount, addEntry, clearHistory, reloadHistory: reload }}>
      {children}
    </HistoryContext.Provider>
  );
}

// ─── Warmup Context ───────────────────────────────────────────────────────────
const WarmupContext = createContext(null);
export const useWarmupFiles = () => useContext(WarmupContext);

function WarmupProvider({ children }) {
  const [files, setFiles] = useState({ reels: [], feed: [], stories: [] });

  const addFiles = useCallback((typeId, newFiles) => {
    const entries = Array.from(newFiles).map((file) => ({
      id: `${typeId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      file, name: file.name, size: file.size,
      status: "idle", progress: 0, url: "", error: "", typeId,
    }));
    setFiles((prev) => ({ ...prev, [typeId]: [...(prev[typeId] || []), ...entries] }));
  }, []);

  const removeFile = useCallback((typeId, fileId) => {
    setFiles((prev) => ({ ...prev, [typeId]: prev[typeId].filter((f) => f.id !== fileId) }));
  }, []);

  const updateFile = useCallback((typeId, fileId, patch) => {
    setFiles((prev) => ({ ...prev, [typeId]: prev[typeId].map((f) => f.id === fileId ? { ...f, ...patch } : f) }));
  }, []);

  const clearFiles = useCallback((typeId) => {
    if (typeId) setFiles((prev) => ({ ...prev, [typeId]: [] }));
    else setFiles({ reels: [], feed: [], stories: [] });
  }, []);

  return (
    <WarmupContext.Provider value={{ files, setFiles, addFiles, removeFile, updateFile, clearFiles }}>
      {children}
    </WarmupContext.Provider>
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
  const runningRef        = useRef(new Set());

  const reload = useCallback(async () => {
    const all = await qApi.getAll();
    if (!Array.isArray(all)) return;
    all.sort((a, b) => (a.scheduledAt || 0) - (b.scheduledAt || 0));
    setQueue(all);
    try { await dbClear("queue"); await dbPutMany("queue", all); } catch {}

    // Sincroniza histórico de itens done pelo scheduler serverless
    try {
      const doneSemHistoria = all.filter((x) => (x.status === "done" || x.status === "posted") && !x._historySynced && (x.type === "group" || !x.type));
      for (const item of doneSemHistoria) {
        const historyId = item.historyId || `h-srv-${item.id}`;
        const jaExiste  = await dbGet("history", historyId).catch(() => null);

        // Busca video_finish pendentes vinculados a este item para mostrar contas aguardando
        const videoFinishPendentes = all.filter(
          (x) => x.type === "video_finish" && x.status === "pending" && x.historyId === historyId
        );
        const pendingAccounts = videoFinishPendentes.map((vf) => ({
          account_id: vf.account_id,
          username:   vf.username || vf.account_id,
        }));

        if (!jaExiste) {
          await dbPut("history", {
            id:               historyId,
            post_type:        item.postType,
            media_url:        item.mediaUrl || (item.mediaUrls?.[0] ?? ""),
            media_type:       item.mediaType,
            default_caption:  item.caption || "",
            results:          item.results  || [],
            pending_accounts: pendingAccounts,
            created_at:       item.completedAt || new Date().toISOString(),
            from_scheduler:   true,
            source:           item.warmup ? "warmup" : "schedule",
          });
        } else if (pendingAccounts.length !== (jaExiste.pending_accounts || []).length) {
          // Atualiza pending_accounts se a lista mudou (contas finalizando aos poucos)
          await dbPut("history", { ...jaExiste, pending_accounts: pendingAccounts });
        }
        await qApi.update({ ...item, _historySynced: true }).catch(() => {});
      }
      // REMOVIDO: não disparar sw:queue-update de dentro do reload()
      // Isso causava loop infinito: reload → dispatch → throttle bypass → reload
      // O SW já emite sw:queue-update no próprio tick dele (a cada 20s)
    } catch (e) { console.warn("[sync-history]", e); }
  }, []);

  useEffect(() => {
    reload();
    // Throttle: ignora eventos sw:queue-update repetidos em menos de 30s
    // O SW emite este evento a cada tick (20s) + a cada video_finish — sem throttle
    // isso causa 3-5 requests/min desnecessários ao Netlify Blob
    let lastReload = 0;
    const h = () => {
      const now = Date.now();
      if (now - lastReload < 30000) return;
      lastReload = now;
      reload();
    };
    window.addEventListener("sw:queue-update", h);

    // Atualização cirúrgica: recebe item já com status "posted" direto do SW
    // sem precisar de um GET ao Blob (evita race condition de consistency do Netlify)
    const onSwMessage = (e) => {
      if (e.data?.type === "ITEM_POSTED" && e.data?.item) {
        const updated = e.data.item;
        setQueue((prev) => prev.map((q) => q.id === updated.id ? { ...q, ...updated } : q));
      }
    };
    navigator.serviceWorker?.addEventListener("message", onSwMessage);

    return () => {
      window.removeEventListener("sw:queue-update", h);
      navigator.serviceWorker?.removeEventListener("message", onSwMessage);
    };
  }, [reload]);

  useEffect(() => {
    let cronAvailable = false;

    const detectCron = async () => {
      try {
        const res = await fetch("/api/scheduler", { method: "GET" });
        cronAvailable = res.ok || res.status === 405;
      } catch { cronAvailable = false; }
    };

    detectCron().catch(() => {});
    const cronCheck = setInterval(() => detectCron().catch(() => {}), 5 * 60 * 1000);

    // Recarrega fila imediatamente ao voltar para a aba (cron serverless pode ter atualizado)
    const onVisible = () => { if (document.visibilityState === "visible") reload(); };
    document.addEventListener("visibilitychange", onVisible);

    // Reseta itens running travados
    const resetStuck = async () => {
      const all = await qApi.getAll();
      if (!Array.isArray(all)) return;
      for (const item of all.filter((x) => x.status === "running")) {
        await qApi.update({ ...item, status: "pending", scheduledAt: Date.now() + 5000 });
      }
    };
    resetStuck().catch(() => {});

    const tick = async () => {
      const all    = await qApi.getAll();
      if (!Array.isArray(all)) return;
      const now    = Date.now();
      const dueFin = all.filter((x) => x.type === "video_finish" && x.status === "pending" && x.scheduledAt <= now);
      const due    = all.filter((x) => !x.type && x.scheduledAt <= now && x.status === "pending");

      // video_finish: sempre processa no browser para atualizar UI
      for (const vf of dueFin) {
        if (runningRef.current.has(vf.id)) continue;
        runningRef.current.add(vf.id);
        try {
          await qApi.update({ ...vf, status: "running" });
          const res = await fetch("/.netlify/functions/publish-finish", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              pending:  [{ account_id: vf.account_id, creation_id: vf.creation_id, username: vf.username }],
              accounts: vf.accounts,
            }),
          });
          if (!res.ok) throw new Error(`publish-finish HTTP ${res.status}`);
          const data   = await res.json();
          const result = (data.results || [])[0];
          if (result?.success) {
            const all2      = await dbGetAll("history");
            const histEntry = all2.find((h) => h.id === vf.historyId) || null;
            if (histEntry) {
              const prevResults    = (histEntry.results || []).filter((r) => r.account_id !== vf.account_id);
              const updatedPending = (histEntry.pending_accounts || []).filter((a) => a.account_id !== vf.account_id);
              await dbPut("history", { ...histEntry, results: [...prevResults, result], pending_accounts: updatedPending });
            }
            await qApi.update({ ...vf, status: "done", result, finishedAt: new Date().toISOString() });
          } else if (result && !result.success) {
            const all2      = await dbGetAll("history");
            const histEntry = all2.find((h) => h.id === vf.historyId) || null;
            if (histEntry) {
              const updatedPending = (histEntry.pending_accounts || []).filter((a) => a.account_id !== vf.account_id);
              await dbPut("history", { ...histEntry, results: [...(histEntry.results || []), { account_id: vf.account_id, username: vf.username, success: false, error: result.error }], pending_accounts: updatedPending });
            }
            await qApi.update({ ...vf, status: "error", error: result.error });
          } else {
            const attempts = (vf.attempts || 0) + 1;
            if (attempts >= (vf.maxAttempts || 20)) {
              await qApi.update({ ...vf, status: "error", error: "Timeout: vídeo não processou" });
            } else {
              await qApi.update({ ...vf, status: "pending", attempts, scheduledAt: Date.now() + 20000 });
            }
          }
        } catch (err) {
          const attempts = (vf.attempts || 0) + 1;
          if (attempts >= (vf.maxAttempts || 20)) {
            await qApi.update({ ...vf, status: "error", error: err.message }).catch(() => {});
          } else {
            await qApi.update({ ...vf, status: "pending", attempts, scheduledAt: Date.now() + 20000 }).catch(() => {});
          }
        } finally { runningRef.current.delete(vf.id); }
        reload();
      }

      // Posts normais: só no browser se cron não estiver ativo
      if (cronAvailable || !due.length) return;

      for (const item of due) {
        if (runningRef.current.has(item.id)) continue;
        runningRef.current.add(item.id);
        await qApi.update({ ...item, status: "running" });
        reload();

        try {
          const urlsToPost = item.mediaUrls || [item.mediaUrl];
          for (let mi = 0; mi < urlsToPost.length; mi++) {
            const mediaUrl = urlsToPost[mi];
            if (mi > 0) await new Promise(r => setTimeout(r, 3000));

            let res, lastErr;
            for (let attempt = 0; attempt < 3; attempt++) {
              if (attempt > 0) await new Promise(r => setTimeout(r, 5000 * Math.pow(3, attempt - 1)));
              try {
                res = await fetch("/.netlify/functions/publish", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    accounts:        item.accounts,
                    media_url:       mediaUrl,
                    media_type:      item.mediaType,
                    post_type:       item.postType,
                    captions:        item.captions || {},
                    default_caption: item.caption  || "",
                    delay_seconds:   0,
                    skip_rate_limit: !!item.warmup,
                  }),
                });
                if (res.ok || (res.status >= 400 && res.status < 500)) break;
                lastErr = new Error(`HTTP ${res.status}`);
              } catch (fetchErr) { lastErr = fetchErr; res = null; }
            }
            if (!res || !res.ok) throw lastErr || new Error(`HTTP ${res?.status}`);

            const data            = await res.json();
            const results         = data.results || [];
            const pendingResults  = results.filter((r) => r.pending && r.creation_id);
            const finishedResults = results.filter((r) => !r.pending);
            const historyId       = `h-${Date.now()}-${mi}`;

            for (const pr of pendingResults) {
              await qApi.save({
                id: `vf-${historyId}-${pr.account_id}`, type: "video_finish", status: "pending",
                creation_id: pr.creation_id, account_id: pr.account_id, username: pr.username || pr.account_id,
                accounts: item.accounts, scheduledAt: Date.now() + 30000, historyId,
                parentId: item.id,
                mediaUrl, postType: item.postType, mediaType: item.mediaType, caption: item.caption || "",
                createdAt: new Date().toISOString(), attempts: 0, maxAttempts: 20,
              });
            }

            await addEntry({
              id: historyId, post_type: item.postType, media_url: mediaUrl, media_type: item.mediaType,
              default_caption: item.caption, results: finishedResults,
              pending_accounts: pendingResults.map((r) => ({ account_id: r.account_id, username: r.username || r.account_id })),
              accounts: item.accounts || [],
              created_at: new Date().toISOString(), from_scheduler: true,
              source: item.warmup ? "warmup" : "schedule",
            });
          }

          // Loop horário: reagenda com aleatoriedade ±3 min para anti-shadowban
          if (item.loop) {
            const jitter = (Math.floor(Math.random() * 360) - 180) * 1000; // ±3 min em ms
            await qApi.update({ ...item, status: "pending", scheduledAt: item.scheduledAt + 3600000 + jitter, runCount: (item.runCount || 0) + 1 });
          } else {
            await qApi.update({ ...item, status: "done" });
          }
        } catch (err) {
          await qApi.update({ ...item, status: "error", error: err.message, failedAt: new Date().toISOString(), retryCount: (item.retryCount || 0) + 1 });
        }
        runningRef.current.delete(item.id);
        reload();
      }
    };

    // Poll adaptativo: 4s quando há itens rodando/done, 12s caso contrário
    let ivTimeout;
    const scheduleTick = async () => {
      const all = await qApi.getAll().catch(() => []);
      const hasRunning = Array.isArray(all) && all.some(x =>
        !x.type && (x.status === "running" || x.status === "pending")
      );
      await tick();
      ivTimeout = setTimeout(scheduleTick, hasRunning ? 4000 : 12000);
    };
    scheduleTick();
    return () => { clearTimeout(ivTimeout); clearInterval(cronCheck); document.removeEventListener("visibilitychange", onVisible); };
  }, [addEntry, reload]);

  const addBatch = async (items) => {
    const BATCH = 100;
    for (let i = 0; i < items.length; i += BATCH) await qApi.save(items.slice(i, i + BATCH));
    reload();
  };
  const updateItem    = async (item) => { await qApi.update(item); reload(); };
  const removeItem    = async (id)   => { await qApi.remove(id); setQueue((p) => p.filter((x) => x.id !== id)); };
  const clearQueue    = async ()     => { await qApi.clear(); setQueue([]); };
  const cancelPending = async () => {
    const all = await qApi.getAll();
    const pending = all.filter((x) => x.status === "pending");
    for (const item of pending) await qApi.update({ ...item, status: "cancelled" });
    reload(); return pending.length;
  };
  const resumeQueue = async () => {
    const all = await qApi.getAll();
    const cancelled = all.filter((x) => x.status === "cancelled");
    for (const item of cancelled) await qApi.update({ ...item, status: "pending" });
    reload(); return cancelled.length;
  };

  return (
    <SchedulerContext.Provider value={{ queue, addBatch, updateItem, removeItem, clearQueue, cancelPending, resumeQueue, reload }}>
      {children}
    </SchedulerContext.Provider>
  );
}

// ─── AppShell ─────────────────────────────────────────────────────────────────
function AppShell() {
  const { addAccounts, accounts, reloadAccounts, syncing, loading: accountsLoading } = useAccounts();
  const { toast, showToast } = useToast();
  const { oauthUrl }         = useOAuthUrl();

  const { status: oauthStatus, openPopup, reset: resetOauth } = useOAuthPopup({
    flow: "instagram",
    onAccounts: async (accs) => {
      try {
        showToast("success", `✅ ${accs.length} conta(s) conectada(s)! Salvando...`);
        await addAccounts(accs);
        showToast("success", `✅ ${accs.length} conta(s) salvas com sucesso!`);
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

  const { status: fbStatus, openPopup: openFbPopup, reset: resetFb } = useOAuthPopup({
    flow: "facebook",
    onAccounts: async (accs) => {
      try {
        showToast("success", `✅ ${accs.length} conta(s) do Facebook conectada(s)! Salvando...`);
        await addAccounts(accs);
        showToast("success", `✅ ${accs.length} conta(s) salvas com sucesso!`);
        resetFb();
      } catch (err) {
        showToast("error", "Erro ao salvar contas: " + err.message);
        resetFb();
      }
    },
    onError: (err) => {
      if (err !== "popup_blocked" && err !== "Login cancelado.") {
        showToast("error", "Erro no login Facebook: " + (err || "Tente novamente."));
      }
    },
  });

  const location       = useLocation();
  const { addEntry }   = useHistory();

  useEffect(() => {}, [location.pathname]);

  useTokenCheck({
    accounts,
    onExpired: useCallback((expired) => {
      reloadAccounts();
      showToast("error", `Token expirado para: ${expired.map((a) => `@${a.username}`).join(", ")}. Reconecte em Contas.`);
    }, [showToast, reloadAccounts]),
  });

  useEffect(() => {
    const params  = new URLSearchParams(window.location.search);
    const encoded = params.get("accounts");
    const error   = params.get("error");
    window.history.replaceState({}, "", window.location.pathname);
    if (encoded) {
      (async () => {
        try {
          const accs = JSON.parse(atob(encoded.replace(/-/g, "+").replace(/_/g, "/")));
          showToast("success", `Salvando ${accs.length} conta(s) na nuvem...`);
          await addAccounts(accs);
          showToast("success", `✅ ${accs.length} conta(s) conectada(s) e salvas!`);
        } catch (err) { showToast("error", "Erro ao salvar contas: " + err.message); }
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
          <div style={{ display: "flex", gap: 6 }}>
            {/* Botão Instagram */}
            <button
              onClick={oauthStatus === "waiting" ? undefined : openPopup}
              disabled={oauthStatus === "waiting" || oauthStatus === "saving"}
              title="Conectar via Instagram"
              style={{ fontSize: 12, fontWeight: 600, padding: "6px 10px", borderRadius: 8, background: "linear-gradient(135deg, #e1306c, #9b4dfc)", color: "#fff", border: "none", cursor: oauthStatus === "waiting" ? "not-allowed" : "pointer", display: "flex", alignItems: "center", gap: 5, opacity: oauthStatus === "waiting" || oauthStatus === "saving" ? 0.7 : 1 }}
            >
              {oauthStatus === "waiting" ? <><span className="spinner" style={{ width: 11, height: 11, borderTopColor: "#fff" }} /></>
              : oauthStatus === "saving"  ? <><span className="spinner" style={{ width: 11, height: 11, borderTopColor: "#fff" }} /></>
              : "📷"}
              {oauthStatus === "waiting" ? " Aguardando..." : oauthStatus === "saving" ? " Salvando..." : " Instagram"}
            </button>
            {/* Botão Facebook */}
            <button
              onClick={fbStatus === "waiting" ? undefined : openFbPopup}
              disabled={fbStatus === "waiting" || fbStatus === "saving"}
              title="Conectar via Facebook"
              style={{ fontSize: 12, fontWeight: 600, padding: "6px 10px", borderRadius: 8, background: fbStatus === "waiting" || fbStatus === "saving" ? "#1877f2cc" : "#1877f2", color: "#fff", border: "none", cursor: fbStatus === "waiting" ? "not-allowed" : "pointer", display: "flex", alignItems: "center", gap: 5, opacity: fbStatus === "waiting" || fbStatus === "saving" ? 0.7 : 1 }}
            >
              {fbStatus === "waiting" ? <><span className="spinner" style={{ width: 11, height: 11, borderTopColor: "#fff" }} /></>
              : fbStatus === "saving"  ? <><span className="spinner" style={{ width: 11, height: 11, borderTopColor: "#fff" }} /></>
              : "f"}
              {fbStatus === "waiting" ? " Aguardando..." : fbStatus === "saving" ? " Salvando..." : " Facebook"}
            </button>
          </div>
        </div>

        <MobileBottomNav />

        <main style={{ flex: 1, overflow: "auto", minWidth: 0, background: "var(--bg)" }}>
          <Toast toast={toast} />
          <Routes>
            <Route path="/"               element={<Dashboard />} />
            <Route path="/contas"           element={<Accounts />} />
            <Route path="/perfis"          element={<Profiles />} />
            <Route path="/fila"           element={<Queue />} />
            <Route path="/historico"      element={<History />} />
            <Route path="/aquecimento"    element={<Warmup />} />
            <Route path="/contingencia"   element={<Contingency />} />
            <Route path="/configuracoes"  element={<Settings />} />
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
      <WarmupProvider>
        <AppShell />
      </WarmupProvider>
    </HistoryProvider>
  );
}
