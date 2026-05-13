// scheduler.mjs
import { getStore } from "@netlify/blobs";

const SITE_URL = process.env.URL || process.env.NETLIFY_URL || "";

function getQueueStore() {
  return getStore({
    name:        "insta-queue",
    siteID:      process.env.NETLIFY_SITE_ID,
    token:       process.env.NETLIFY_TOKEN,
    consistency: "strong",
  });
}

const BLOB_KEY = "queue-data";

// ─── Lock otimista (mesmo mecanismo do queue.mjs) ─────────────────────────────

const MAX_RETRIES = 5;
const BASE_DELAY  = 80;

async function readWithEtag(store) {
  try {
    const data = await store.get(BLOB_KEY, { type: "json" });
    if (data && Array.isArray(data.items)) {
      return { items: data.items, etag: data.etag || null };
    }
    if (Array.isArray(data)) {
      return { items: data, etag: null };
    }
    return { items: [], etag: null };
  } catch {
    return { items: [], etag: null };
  }
}

async function writeWithLock(store, etag, items) {
  const current = await readWithEtag(store);
  if (etag !== null && current.etag !== etag) {
    throw new Error("etag_mismatch");
  }
  const newEtag = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  await store.setJSON(BLOB_KEY, { etag: newEtag, items });
  return newEtag;
}

async function withLock(store, fn) {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const { items, etag } = await readWithEtag(store);
    const updated = await fn(items);
    try {
      await writeWithLock(store, etag, updated);
      return updated;
    } catch (err) {
      if (err.message !== "etag_mismatch") throw err;
      const delay = BASE_DELAY * Math.pow(2, attempt) + Math.random() * 30;
      console.warn(`[scheduler] conflito de escrita, tentativa ${attempt + 1}/${MAX_RETRIES} (aguardando ${Math.round(delay)}ms)`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error("Não foi possível gravar na fila após múltiplas tentativas.");
}

// ─── Helpers de fila usando withLock ─────────────────────────────────────────

async function queueReadAll(store) {
  const { items } = await readWithEtag(store);
  return items;
}

async function queueUpdate(store, updatedItem) {
  await withLock(store, (queue) => {
    const idx = queue.findIndex((x) => x.id === updatedItem.id);
    if (idx >= 0) queue[idx] = updatedItem;
    else queue.push(updatedItem);
    return queue;
  });
}

async function queueSave(store, newItem) {
  await withLock(store, (queue) => {
    const idx = queue.findIndex((x) => x.id === newItem.id);
    if (idx >= 0) queue[idx] = newItem;
    else queue.push(newItem);
    return queue;
  });
}

// ─── Chama publish em batches até processar todas as contas ──────────────────
async function callPublishAllBatches(item, mediaUrl) {
  const allResults = [];
  let offset = 0;

  while (offset < item.accounts.length) {
    const res = await fetch(`${SITE_URL}/.netlify/functions/publish`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accounts:        item.accounts,
        media_url:       mediaUrl,
        media_type:      item.mediaType,
        post_type:       item.postType,
        captions:        item.captions        || {},
        default_caption: item.caption         || "",
        skip_rate_limit: !!item.warmup,
        batch_offset:    offset,
      }),
    });

    if (!res.ok) throw new Error(`publish HTTP ${res.status} (offset ${offset})`);
    const data = await res.json();

    allResults.push(...(data.results || []));

    if (!data.has_more) break;
    offset = data.next_offset;
  }

  return { results: allResults };
}

async function callPublishFinish(vf) {
  const res = await fetch(`${SITE_URL}/.netlify/functions/publish-finish`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      pending:  [{ account_id: vf.account_id, creation_id: vf.creation_id, username: vf.username }],
      accounts: vf.accounts || [],
    }),
  });
  if (!res.ok) throw new Error(`publish-finish HTTP ${res.status}`);
  return res.json();
}

// ─── Processamento de video_finish ───────────────────────────────────────────
async function processVideoFinish(store, vf) {
  console.log(`[scheduler] video_finish @${vf.username} (${vf.creation_id})`);
  await queueUpdate(store, { ...vf, status: "running" });

  try {
    const data   = await callPublishFinish(vf);
    const result = (data.results || [])[0];

    if (result?.success) {
      console.log(`[scheduler] ✅ video_finish @${vf.username} publicado`);
      await queueUpdate(store, { ...vf, status: "done", result, finishedAt: new Date().toISOString() });
      return;
    }

    if (result && !result.success) {
      console.error(`[scheduler] ❌ video_finish @${vf.username}: ${result.error}`);
      await queueUpdate(store, { ...vf, status: "error", error: result.error });
      return;
    }

    const attempts = (vf.attempts || 0) + 1;
    if (attempts >= (vf.maxAttempts || 20)) {
      await queueUpdate(store, { ...vf, status: "error", error: "Timeout: vídeo não processou após múltiplas tentativas" });
    } else {
      console.log(`[scheduler] video_finish @${vf.username} IN_PROGRESS (tentativa ${attempts})`);
      await queueUpdate(store, { ...vf, status: "pending", attempts, scheduledAt: Date.now() + 20000 });
    }
  } catch (err) {
    const attempts = (vf.attempts || 0) + 1;
    if (attempts >= (vf.maxAttempts || 20)) {
      await queueUpdate(store, { ...vf, status: "error", error: err.message });
    } else {
      await queueUpdate(store, { ...vf, status: "pending", attempts, scheduledAt: Date.now() + 20000 });
    }
  }
}

// ─── Processamento de item normal ─────────────────────────────────────────────
async function processItem(store, item) {
  const total = (item.accounts || []).length;
  console.log(`[scheduler] item ${item.id} — ${total} conta(s), tipo ${item.postType}`);
  await queueUpdate(store, { ...item, status: "running" });

  try {
    const urlsToPost = item.mediaUrls || [item.mediaUrl];

    for (let mi = 0; mi < urlsToPost.length; mi++) {
      const mediaUrl = urlsToPost[mi];
      if (mi > 0) await new Promise((r) => setTimeout(r, 3000));

      let data, lastErr;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, 5000 * Math.pow(3, attempt - 1)));
        try {
          data = await callPublishAllBatches(item, mediaUrl);
          break;
        } catch (err) {
          lastErr = err;
          console.warn(`[scheduler] tentativa ${attempt + 1} falhou: ${err.message}`);
        }
      }

      if (!data) throw lastErr || new Error("Falha ao publicar após 3 tentativas");

      const results        = data.results || [];
      const pendingResults = results.filter((r) => r.pending && r.creation_id);
      const historyId      = `h-${Date.now()}-${mi}`;

      for (const pr of pendingResults) {
        await queueSave(store, {
          id:          `vf-${historyId}-${pr.account_id}`,
          type:        "video_finish",
          status:      "pending",
          creation_id: pr.creation_id,
          account_id:  pr.account_id,
          username:    pr.username || pr.account_id,
          accounts:    item.accounts,
          scheduledAt: Date.now() + 30000,
          historyId,
          mediaUrl,
          postType:    item.postType,
          mediaType:   item.mediaType,
          caption:     item.caption || "",
          createdAt:   new Date().toISOString(),
          attempts:    0,
          maxAttempts: 20,
        });
      }

      const ok  = results.filter((r) => r.success).length;
      const err = results.filter((r) => !r.success && !r.pending).length;
      console.log(`[scheduler] item ${item.id} — ${ok} ok, ${pendingResults.length} vídeos pendentes, ${err} erros`);
    }

    if (item.loop) {
      await queueUpdate(store, {
        ...item,
        status:      "pending",
        scheduledAt: item.scheduledAt + 86400000,
        runCount:    (item.runCount || 0) + 1,
      });
    } else {
      await queueUpdate(store, { ...item, status: "done", finishedAt: new Date().toISOString() });
    }
  } catch (err) {
    console.error(`[scheduler] ❌ item ${item.id}: ${err.message}`);
    await queueUpdate(store, {
      ...item,
      status:     "error",
      error:      err.message,
      failedAt:   new Date().toISOString(),
      retryCount: (item.retryCount || 0) + 1,
    });
  }
}

// ─── Handler principal ────────────────────────────────────────────────────────
export default async function handler() {
  console.log("[scheduler] tick às", new Date().toISOString());

  if (!SITE_URL) {
    console.error("[scheduler] SITE_URL não configurada. Abortando.");
    return new Response(JSON.stringify({ error: "SITE_URL não configurada" }), { status: 500 });
  }

  let store;
  try {
    store = getQueueStore();
  } catch (err) {
    console.error("[scheduler] store inacessível:", err.message);
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }

  const queue = await queueReadAll(store);
  const now   = Date.now();

  // Reseta itens "running" travados por mais de 3 minutos
  const STUCK_MS   = 3 * 60 * 1000;
  const stuckItems = queue.filter(
    (x) => x.status === "running" && x.startedAt && now - new Date(x.startedAt).getTime() > STUCK_MS
  );
  for (const item of stuckItems) {
    console.warn(`[scheduler] resetando item travado ${item.id}`);
    await queueUpdate(store, { ...item, status: "pending", scheduledAt: now + 5000 });
  }

  const dueNormal = queue.filter((x) => !x.type        && x.status === "pending" && x.scheduledAt <= now);
  const dueFinish = queue.filter((x) => x.type === "video_finish" && x.status === "pending" && x.scheduledAt <= now);

  console.log(`[scheduler] ${dueNormal.length} posts + ${dueFinish.length} video_finish vencidos`);

  if (dueNormal.length === 0 && dueFinish.length === 0) {
    return new Response(JSON.stringify({ ok: true, processed: 0 }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }

  for (const vf   of dueFinish) await processVideoFinish(store, { ...vf, startedAt: new Date().toISOString() });
  for (const item of dueNormal) await processItem(store,        { ...item, startedAt: new Date().toISOString() });

  const total = dueNormal.length + dueFinish.length;
  console.log(`[scheduler] concluído — ${total} item(s) processados`);
  return new Response(JSON.stringify({ ok: true, processed: total }), {
    status: 200, headers: { "Content-Type": "application/json" },
  });
}

export const config = {
  schedule: "*/5 * * * *",
};
