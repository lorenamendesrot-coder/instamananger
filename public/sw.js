// Service Worker — Insta Manager Scheduler v6
// Fix: vídeos pendentes salvos no IDB, atualizando o mesmo item do histórico
const TICK_INTERVAL = 20000;

self.addEventListener("install",  (e) => { e.waitUntil(self.skipWaiting()); });
self.addEventListener("activate", (e) => { e.waitUntil(self.clients.claim()); startTicker(); });

let tickerInterval = null;
let _tickRunning   = false; // impede dois ticks simultâneos — causa do loop de video_finish

function startTicker() {
  if (tickerInterval) clearInterval(tickerInterval);
  tickerInterval = setInterval(tick, TICK_INTERVAL);
  setTimeout(tick, 1000);
}

// ─── Tick principal ───────────────────────────────────────────────────────────
async function tick() {
  // Se o tick anterior ainda não terminou, pula.
  // Com 50 contas o processamento pode levar mais que TICK_INTERVAL (20s),
  // causando ticks sobrepostos que disparam publish várias vezes no mesmo item.
  if (_tickRunning) {
    console.log("[SW] tick ignorado — anterior ainda em execução");
    return;
  }
  _tickRunning = true;
  try {
    const queue = await readQueue();
    const now   = Date.now();

    // 1. Itens normais de agendamento (sem type)
    const due = queue.filter(
      (x) => !x.type && x.scheduledAt <= now && x.status === "pending"
    );
    for (const item of due) await runItem(item);

    // 2. Itens video_finish (vídeos aguardando processamento do Instagram)
    const dueFin = queue.filter(
      (x) => x.type === "video_finish" && x.status === "pending" && x.scheduledAt <= now
    );
    for (const item of dueFin) await runVideoFinish(item);
  } finally {
    _tickRunning = false;
  }
}

// ─── runItem — agendamento normal ────────────────────────────────────────────
async function runItem(item) {
  await updateItem(item.id, { status: "running" });
  notifyClients({ type: "QUEUE_UPDATE" });

  try {
    const origin  = self.location.origin;
    const apiUrl  = `${origin}/.netlify/functions/publish`;
    const urlsToPost = item.mediaUrls?.length > 0 ? item.mediaUrls : [item.mediaUrl];

    let totalSuccesses = 0;
    let totalResults   = [];

    for (let mi = 0; mi < urlsToPost.length; mi++) {
      const mediaUrl = urlsToPost[mi];
      if (mi > 0) await sleep(3000);

      const res = await fetch(apiUrl, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accounts:        item.accounts,
          media_url:       mediaUrl,
          media_type:      item.mediaType,
          post_type:       item.postType,
          captions:        item.captions || {},
          default_caption: item.caption  || "",
          delay_seconds:   0,
        }),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      const data = await res.json();
      let results = data.results || [];

      // Separar contas com pending (vídeo ainda processando no Instagram)
      const pendingResults  = results.filter((r) => r.pending && r.creation_id);
      const finishedResults = results.filter((r) => !r.pending);

      // ID fixo para o item do histórico — calculado UMA vez antes de qualquer await
      const historyId = `h-${Date.now()}-${mi}`;

      // Salva video_finish para cada conta com pending
      for (const pr of pendingResults) {
        const vfId = `vf-${historyId}-${pr.account_id}`;
        await saveItem("queue", {
          id:            vfId,
          type:          "video_finish",
          status:        "pending",
          creation_id:   pr.creation_id,
          account_id:    pr.account_id,
          username:      pr.username || pr.account_id,
          accounts:      item.accounts,
          scheduledAt:   Date.now() + 60000,
          historyId,
          parentQueueId: item.id,   // ← id do item pai na fila
          mediaUrl,
          postType:      item.postType,
          mediaType:     item.mediaType,
          caption:       item.caption || "",
          createdAt:     new Date().toISOString(),
          attempts:      0,
          maxAttempts:   8,
        });
        console.log(`[SW] video_finish criado → @${pr.username} historyId:${historyId}`);
      }

      // Salva no histórico com os resultados já finalizados + lista de pendentes
      // O campo pending_accounts serve para o History.jsx mostrar "⏳ Processando"
      const pendingAccounts = pendingResults.map((r) => ({
        account_id: r.account_id,
        username:   r.username || r.account_id,
      }));

      await saveItem("history", {
        id:               historyId,
        post_type:        item.postType,
        media_url:        mediaUrl,
        media_type:       item.mediaType,
        default_caption:  item.caption || "",
        results:          finishedResults,
        pending_accounts: pendingAccounts,   // contas ainda processando
        created_at:       new Date().toISOString(),
        from_scheduler:   true,
        cycle_index:      mi,
        cycle_total:      urlsToPost.length,
      });
      // Notifica a página imediatamente após salvar no histórico
      // para que o History.jsx recarregue sem depender do evento final
      notifyClients({ type: "QUEUE_UPDATE" });

      totalResults   = [...totalResults, ...finishedResults];
      totalSuccesses += finishedResults.filter((r) => r.success).length;
    }

    if (item.loop) {
      await updateItem(item.id, {
        status:      "pending",
        scheduledAt: item.scheduledAt + 24 * 60 * 60 * 1000,
        runCount:    (item.runCount || 0) + 1,
        lastResults: totalResults,
      });
    } else {
      await updateItem(item.id, { status: "done", results: totalResults });
    }

    try {
      if (Notification.permission === "granted") {
        const qty   = urlsToPost.length;
        const label = qty > 1 ? `${qty} mídias` : "1 mídia";
        self.registration.showNotification("Insta Manager", {
          body: `✅ ${label} · ${totalSuccesses}/${totalResults.length} conta(s)`,
          icon: "/favicon.ico",
          tag:  `pub-${item.id}`,
        });
      }
    } catch (_) {}

  } catch (err) {
    await updateItem(item.id, { status: "error", error: err.message });
    try {
      if (Notification.permission === "granted") {
        self.registration.showNotification("Insta Manager — Erro", {
          body: `❌ ${err.message}`,
          icon: "/favicon.ico",
          tag:  `err-${item.id}`,
        });
      }
    } catch (_) {}
  }

  notifyClients({ type: "QUEUE_UPDATE" });
}

// ─── runVideoFinish — finaliza vídeos pendentes ───────────────────────────────
async function runVideoFinish(item) {
  await updateItem(item.id, { status: "running" });

  const origin = self.location.origin;

  try {
    const res = await fetch(`${origin}/.netlify/functions/publish-finish`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pending:  [{ account_id: item.account_id, creation_id: item.creation_id, username: item.username }],
        accounts: item.accounts,
      }),
    });

    if (!res.ok) throw new Error(`publish-finish HTTP ${res.status}`);
    const data   = await res.json();
    const result = (data.results || [])[0];

    if (result?.success) {
      // ── Sucesso: atualiza o item do histórico (não cria um novo) ──────────
      const histEntry = await getHistoryItem(item.historyId);
      if (histEntry) {
        // Remove erros anteriores desta conta (retry bem-sucedido) e adiciona o sucesso
        const prevResults     = (histEntry.results || []).filter((r) => r.account_id !== item.account_id);
        const updatedResults  = [...prevResults, result];
        const updatedPending  = (histEntry.pending_accounts || []).filter(
          (a) => a.account_id !== item.account_id
        );
        await saveItem("history", {
          ...histEntry,
          results:          updatedResults,
          pending_accounts: updatedPending,
        });
      }

      // Remove da fila de video_finish
      await updateItem(item.id, { status: "done", result, finishedAt: new Date().toISOString() });
      console.log(`[SW] video_finish ✅ @${item.username} media_id:${result.media_id}`);

      // Verifica se todos os video_finish do mesmo grupo terminaram
      await maybeCloseParentItem(item.historyId, item.id, "done");

      notifyClients({ type: "QUEUE_UPDATE" });

      try {
        if (Notification.permission === "granted") {
          self.registration.showNotification("Insta Manager", {
            body: `✅ Reel publicado — @${item.username}`,
            icon: "/favicon.ico",
            tag:  `vf-${item.id}`,
          });
        }
      } catch (_) {}

    } else if (result && !result.success) {
      // -- Erro do Instagram --
      const errMsg  = result.error || "Erro desconhecido";
      const errCode = result.errorCode;

      // Rate limit Meta (codes 4, 32, 613) -> reagenda com backoff de 5 min
      const isRateLimit = [4, 32, 613].includes(errCode);
      const attempts    = (item.attempts || 0) + 1;

      if (isRateLimit && attempts < item.maxAttempts) {
        const retryDelay = 5 * 60 * 1000;
        console.warn("[SW] video_finish rate limit code " + errCode + " @" + item.username + " retry em 5min (" + attempts + "/" + item.maxAttempts + ")");
        await updateItem(item.id, { status: "pending", attempts, scheduledAt: Date.now() + retryDelay, lastError: errMsg });
        notifyClients({ type: "QUEUE_UPDATE" });
        return;
      }

      console.warn("[SW] video_finish ERRO @" + item.username + ": " + errMsg + " (code " + (errCode || "?") + ")");

      // Atualiza historico: move pending_accounts para results com erro
      const histEntry = await getHistoryItem(item.historyId);
      if (histEntry) {
        const updatedResults = [...(histEntry.results || []), {
          account_id: item.account_id,
          username:   item.username,
          success:    false,
          error:      errMsg,
          errorCode:  errCode,
        }];
        const updatedPending = (histEntry.pending_accounts || []).filter(
          (a) => a.account_id !== item.account_id
        );
        await saveItem("history", { ...histEntry, results: updatedResults, pending_accounts: updatedPending });
      }

      await updateItem(item.id, { status: "error", error: errMsg });
      await maybeCloseParentItem(item.historyId, item.id, "error");
      notifyClients({ type: "QUEUE_UPDATE" });

    } else {
      // ── Ainda não está pronto — reagenda ─────────────────────────────────
      const attempts = (item.attempts || 0) + 1;
      if (attempts >= item.maxAttempts) {
        const errMsg = `Timeout: vídeo não processou após ${attempts} tentativas`;
        const histEntry = await getHistoryItem(item.historyId);
        if (histEntry) {
          const updatedResults = [...(histEntry.results || []), {
            account_id: item.account_id, username: item.username, success: false, error: errMsg,
          }];
          const updatedPending = (histEntry.pending_accounts || []).filter(
            (a) => a.account_id !== item.account_id
          );
          await saveItem("history", { ...histEntry, results: updatedResults, pending_accounts: updatedPending });
        }
        await updateItem(item.id, { status: "error", error: errMsg });
        await maybeCloseParentItem(item.historyId, item.id, "error");
        notifyClients({ type: "QUEUE_UPDATE" });
      } else {
        // Ainda há tentativas — reagenda para 30s depois
        await updateItem(item.id, { status: "pending", attempts, scheduledAt: Date.now() + 30000 });
      }
    }

  } catch (err) {
    const attempts = (item.attempts || 0) + 1;
    if (attempts >= item.maxAttempts) {
      await updateItem(item.id, { status: "error", error: err.message });
      notifyClients({ type: "QUEUE_UPDATE" });
    } else {
      await updateItem(item.id, { status: "pending", attempts, scheduledAt: Date.now() + 20000 });
    }
  }
}

// ─── Fecha item pai quando todos os video_finish do grupo terminaram ──────────
async function maybeCloseParentItem(historyId, currentVfId, currentVfStatus) {
  if (!historyId) return;
  try {
    const queue    = await readQueue();
    const siblings = queue.filter((x) => x.type === "video_finish" && x.historyId === historyId);
    if (siblings.length === 0) return;

    // Substitui o status do vf atual pelo status recém gravado (evita race com IDB)
    const siblingsUpdated = siblings.map((x) =>
      x.id === currentVfId ? { ...x, status: currentVfStatus } : x
    );

    const allDone = siblingsUpdated.every((x) => x.status === "done" || x.status === "error");
    if (!allDone) {
      const pending = siblingsUpdated.filter((x) => x.status !== "done" && x.status !== "error").length;
      console.log(`[SW] grupo ${historyId} — ainda ${pending} pendente(s)`);
      return;
    }

    const parentQueueId = siblings[0]?.parentQueueId;
    const parent = parentQueueId ? queue.find((x) => x.id === parentQueueId) : null;

    const ok    = siblingsUpdated.filter((s) => s.status === "done").length;
    const total = siblingsUpdated.length;
    const allOk = ok === total;

    console.log(`[SW] grupo ${historyId} concluído — ${ok}/${total} publicados${parent ? "" : " (pai não encontrado: " + parentQueueId + ")"}`);

    if (parent) {
      const results = siblingsUpdated.map((s) => ({
        account_id:   s.account_id,
        username:     s.username,
        success:      s.status === "done",
        media_id:     s.result?.media_id,
        published_at: s.result?.published_at,
        error:        s.error,
      }));

      const updatedParent = {
        ...parent,
        status:      "posted",
        results,
        completedAt: new Date().toISOString(),
        allSuccess:  allOk,
      };

      // Atualiza IDB local
      await updateItem(parent.id, {
        status:      "posted",
        results,
        completedAt: new Date().toISOString(),
        allSuccess:  allOk,
      });

      // Atualiza Netlify Blob via API (a página lê daqui)
      try {
        await fetch(`${self.location.origin}/api/queue`, {
          method:  "PUT",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify(updatedParent),
        });
        console.log(`[SW] ✅ pai ${parent.id} → posted (IDB + Blob)`);
      } catch (e) {
        console.warn("[SW] falha ao atualizar Blob:", e.message);
      }
    }

    notifyClients({ type: "QUEUE_UPDATE" });

    try {
      if (Notification.permission === "granted") {
        self.registration.showNotification("Insta Manager", {
          body: allOk
            ? `✅ Postado com sucesso em ${total} conta(s)!`
            : `⚠️ Publicado em ${ok}/${total} conta(s)`,
          icon: "/favicon.ico",
          tag:  `group-${historyId}`,
        });
      }
    } catch (_) {}
  } catch (err) {
    console.warn("[SW] maybeCloseParentItem erro:", err.message);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// DB version deve ser SEMPRE igual ao useDB.js — atualmente v5
const SW_DB_VERSION = 5;
let _db = null;

function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("insta_manager", SW_DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains("queue")) {
        db.createObjectStore("queue", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("history")) {
        const hs = db.createObjectStore("history", { keyPath: "id" });
        try { hs.createIndex("created_at", "created_at", { unique: false }); } catch(_){}
      }
      if (!db.objectStoreNames.contains("sessions")) {
        db.createObjectStore("sessions", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("protection")) {
        db.createObjectStore("protection", { keyPath: "id" });
      }
    };
    req.onsuccess = () => {
      _db = req.result;
      _db.onclose = () => { _db = null; };
      _db.onerror = () => { _db = null; };
      resolve(_db);
    };
    req.onerror  = () => reject(req.error);
    req.onblocked = () => console.warn("[SW] IDB bloqueado por outra aba.");
  });
}

async function readQueue() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction("queue", "readonly");
    const req = tx.objectStore("queue").getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror   = () => reject(req.error);
  });
}

async function updateItem(id, patch) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction("queue", "readwrite");
    const store = tx.objectStore("queue");
    const req   = store.get(id);
    req.onsuccess = () => {
      if (!req.result) return resolve();
      store.put({ ...req.result, ...patch });
      tx.oncomplete = resolve;
      tx.onerror    = reject;
    };
    req.onerror = reject;
  });
}

// Salva (put) em qualquer store
async function saveItem(store, item) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).put(item);
    tx.oncomplete = resolve;
    tx.onerror    = reject;
  });
}

// Busca item do histórico por id
async function getHistoryItem(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction("history", "readonly");
    const req = tx.objectStore("history").get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror   = () => reject(req.error);
  });
}

function notifyClients(msg) {
  self.clients.matchAll({ includeUncontrolled: true })
    .then((cs) => cs.forEach((c) => c.postMessage(msg)));
}

self.addEventListener("message", (e) => {
  if (e.data?.type === "PING")       e.source?.postMessage({ type: "PONG" });
  if (e.data?.type === "FORCE_TICK") tick();
});
