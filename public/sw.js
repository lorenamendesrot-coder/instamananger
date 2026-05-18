// Service Worker — Insta Manager Scheduler v6
// Fix: vídeos pendentes salvos no IDB, atualizando o mesmo item do histórico
const TICK_INTERVAL = 60000; // 1 tick/min — era 20s (3x/min), reduzido para poupar GET /api/queue

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

    // 2. Itens video_finish — agrupados por historyId para 1 chamada HTTP por lote
    // Em vez de N chamadas separadas (1 por conta), faz 1 chamada por lote de contas
    const dueFin = queue.filter(
      (x) => x.type === "video_finish" && x.status === "pending" && x.scheduledAt <= now
    );
    const vfGroups = {};
    for (const item of dueFin) {
      const key = item.historyId || item.id;
      if (!vfGroups[key]) vfGroups[key] = [];
      vfGroups[key].push(item);
    }
    for (const group of Object.values(vfGroups)) {
      await runVideoFinishGroup(group);
    }
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
          scheduledAt:   Date.now() + 90000,  // 1º check em 90s
          historyId,
          parentQueueId: item.id,
          mediaUrl,
          postType:      item.postType,
          mediaType:     item.mediaType,
          caption:       item.caption || "",
          createdAt:     new Date().toISOString(),
          attempts:      0,
          maxAttempts:   5,  // 5 tentativas × delays crescentes = ~25min de margem
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

// ─── runVideoFinishGroup — processa um lote de contas numa única chamada HTTP ──
// Antes: 10 contas = 10 chamadas ao publish-finish = 10 × 3 checks na Graph API
// Agora: 10 contas = 1 chamada ao publish-finish  = 1 × 3 checks (em paralelo no server)
async function runVideoFinishGroup(items) {
  if (!items || items.length === 0) return;

  // Marca todos como running
  for (const item of items) {
    await updateItem(item.id, { status: "running" });
  }

  const origin   = self.location.origin;
  const accounts = items[0].accounts || [];

  try {
    const res = await fetch(`${origin}/.netlify/functions/publish-finish`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pending:  items.map((x) => ({
          account_id:  x.account_id,
          creation_id: x.creation_id,
          username:    x.username,
        })),
        accounts,
      }),
    });

    if (!res.ok) throw new Error(`publish-finish HTTP ${res.status}`);
    const data    = await res.json();
    const results = data.results || [];

    // Mapa account_id → resultado
    const resultMap = {};
    for (const r of results) resultMap[r.account_id] = r;

    for (const item of items) {
      const result = resultMap[item.account_id];

      if (result?.success) {
        // ── Sucesso ──────────────────────────────────────────────────────────
        const histEntry = await getHistoryItem(item.historyId);
        if (histEntry) {
          const prevResults    = (histEntry.results || []).filter((r) => r.account_id !== item.account_id);
          const updatedResults = [...prevResults, result];
          const updatedPending = (histEntry.pending_accounts || []).filter((a) => a.account_id !== item.account_id);
          await saveItem("history", { ...histEntry, results: updatedResults, pending_accounts: updatedPending });
        }
        await deleteItemFromBlob(item.id);
        await updateItem(item.id, { status: "done", result, finishedAt: new Date().toISOString() });
        console.log(`[SW] video_finish ✅ @${item.username} media_id:${result.media_id}`);
        await maybeCloseParentItem(item.historyId, item.id, "done");

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
        // ── Erro do Instagram ────────────────────────────────────────────────
        const errMsg  = result.error || "Erro desconhecido";
        const errCode = result.errorCode;
        const isRateLimit = [4, 32, 613].includes(errCode);
        const attempts    = (item.attempts || 0) + 1;

        if (isRateLimit && attempts < item.maxAttempts) {
          // Backoff exponencial: 15min, 30min, 30min...
          // Era 5min/10min/20min — muito agressivo, esgotava a quota novamente
          const retryDelay = 30 * 60 * 1000; // 30min fixo para rate limit — sem exponencial para não perder controle
          console.warn(`[SW] video_finish rate limit @${item.username} retry em ${Math.round(retryDelay/60000)}min (${attempts}/${item.maxAttempts})`);
          await updateItem(item.id, { status: "pending", attempts, scheduledAt: Date.now() + retryDelay, lastError: errMsg });
          continue;
        }

        console.warn(`[SW] video_finish ERRO @${item.username}: ${errMsg} (code ${errCode || "?"})`);
        const histEntry = await getHistoryItem(item.historyId);
        if (histEntry) {
          const updatedResults = [...(histEntry.results || []), { account_id: item.account_id, username: item.username, success: false, error: errMsg, errorCode: errCode }];
          const updatedPending = (histEntry.pending_accounts || []).filter((a) => a.account_id !== item.account_id);
          await saveItem("history", { ...histEntry, results: updatedResults, pending_accounts: updatedPending });
        }
        await deleteItemFromBlob(item.id);
        await updateItem(item.id, { status: "error", error: errMsg });
        await maybeCloseParentItem(item.historyId, item.id, "error");

      } else {
        // ── Ainda IN_PROGRESS — reagenda com backoff exponencial ─────────────
        const attempts = (item.attempts || 0) + 1;
        if (attempts >= item.maxAttempts) {
          const errMsg = `Timeout: vídeo não processou após ${attempts} tentativas`;
          const histEntry = await getHistoryItem(item.historyId);
          if (histEntry) {
            const updatedResults = [...(histEntry.results || []), { account_id: item.account_id, username: item.username, success: false, error: errMsg }];
            const updatedPending = (histEntry.pending_accounts || []).filter((a) => a.account_id !== item.account_id);
            await saveItem("history", { ...histEntry, results: updatedResults, pending_accounts: updatedPending });
          }
          await deleteItemFromBlob(item.id);
          await updateItem(item.id, { status: "error", error: errMsg });
          await maybeCloseParentItem(item.historyId, item.id, "error");
        } else {
          // Backoff: 2min, 5min, 10min, 15min, 30min
          // Conservador para não esgotar cota com 10+ contas simultâneas
          const delays = [120, 300, 600, 900, 1800];
          const delay  = (delays[attempts - 1] || 300) * 1000;
          console.log(`[SW] video_finish IN_PROGRESS @${item.username} — retry em ${delay/1000}s (${attempts}/${item.maxAttempts})`);
          await updateItem(item.id, { status: "pending", attempts, scheduledAt: Date.now() + delay });
        }
      }
    }

  } catch (err) {
    // Erro de rede — reagenda todos com backoff
    for (const item of items) {
      const attempts = (item.attempts || 0) + 1;
      const delay    = attempts >= item.maxAttempts ? null : Math.min(120000 * attempts, 600000); // max 10min por erro de rede
      if (delay === null) {
        await updateItem(item.id, { status: "error", error: err.message });
      } else {
        await updateItem(item.id, { status: "pending", attempts, scheduledAt: Date.now() + delay });
      }
    }
  }

  notifyClients({ type: "QUEUE_UPDATE" });
}

// ─── Fecha item pai quando todos os video_finish do grupo terminaram ──────────
async function maybeCloseParentItem(historyId, currentVfId, currentVfStatus) {
  if (!historyId) return;
  try {
    const queue    = await readQueue();
    const siblings = queue.filter((x) => x.type === "video_finish" && x.historyId === historyId);
    if (siblings.length === 0) return;

    // Substitui o status do vf atual (evita race com IDB)
    const siblingsUpdated = siblings.map((x) =>
      x.id === currentVfId ? { ...x, status: currentVfStatus } : x
    );

    const allDone = siblingsUpdated.every((x) => x.status === "done" || x.status === "error");
    if (!allDone) {
      const pending = siblingsUpdated.filter((x) => x.status !== "done" && x.status !== "error").length;
      console.log(`[SW] grupo ${historyId} — ainda ${pending} pendente(s)`);
      return;
    }

    const ok    = siblingsUpdated.filter((s) => s.status === "done").length;
    const total = siblingsUpdated.length;
    const allOk = ok === total;

    const results = siblingsUpdated.map((s) => ({
      account_id:   s.account_id,
      username:     s.username,
      success:      s.status === "done",
      media_id:     s.result?.media_id,
      published_at: s.result?.published_at,
      error:        s.error,
    }));

    // Busca o pai pelo parentQueueId no IDB
    const parentQueueId = siblings.find((s) => s.parentQueueId)?.parentQueueId;
    let parent = parentQueueId ? queue.find((x) => x.id === parentQueueId) : null;

    // Fallback: busca por conta em comum no IDB (sem chamar /api/queue extra)
    if (!parent) {
      const siblingAccountIds = new Set(siblingsUpdated.map(s => s.account_id));
      parent = queue.find((x) =>
        !x.type &&
        x.accounts?.some?.((a) => siblingAccountIds.has(a.id))
      );
    }

    console.log(`[SW] grupo ${historyId} concluído — ${ok}/${total} publicados | pai: ${parent?.id || "NÃO ENCONTRADO"}`);

    if (parent) {
      const updatedParent = {
        ...parent,
        status:      "posted",
        results,
        completedAt: new Date().toISOString(),
        allSuccess:  allOk,
      };

      // Atualiza IDB
      await updateItem(parent.id, { status: "posted", results, completedAt: new Date().toISOString(), allSuccess: allOk });

      // Atualiza Blob — 2 tentativas (era 4, reduzido para economizar request quota)
      let blobOk = false;
      for (let attempt = 0; attempt < 2 && !blobOk; attempt++) {
        try {
          if (attempt > 0) await sleep(1500);
          const r = await fetch(`${self.location.origin}/api/queue`, {
            method:  "PUT",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify(updatedParent),
          });
          if (r.ok) blobOk = true;
        } catch (_) {}
      }
      if (!blobOk) console.warn(`[SW] ⚠️ Blob PUT falhou após 2 tentativas — pai ${parent.id}`);

      // Notifica clientes com o item já atualizado para o frontend não precisar refazer GET
      notifyClients({ type: "ITEM_POSTED", item: updatedParent });

      console.log(`[SW] ✅ pai ${parent.id} → posted (${ok}/${total}) | blob:${blobOk}`);
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

// ─── Deleta item do Blob (fila remota) para evitar acúmulo ───────────────────
async function deleteItemFromBlob(id) {
  try {
    await fetch(`${self.location.origin}/api/queue?id=${encodeURIComponent(id)}`, { method: "DELETE" });
  } catch (_) { /* não crítico */ }
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
