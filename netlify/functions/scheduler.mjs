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

async function queueReadAll(store) {
  try {
    const data = await store.get(BLOB_KEY, { type: "json" });
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

async function queueWriteAll(store, items) {
  await store.setJSON(BLOB_KEY, items);
}

async function queueUpdate(store, updatedItem) {
  const queue = await queueReadAll(store);
  const idx   = queue.findIndex((x) => x.id === updatedItem.id);
  if (idx >= 0) queue[idx] = updatedItem;
  else queue.push(updatedItem);
  await queueWriteAll(store, queue);
}

async function queueSave(store, newItem) {
  const queue = await queueReadAll(store);
  const idx   = queue.findIndex((x) => x.id === newItem.id);
  if (idx >= 0) queue[idx] = newItem;
  else queue.push(newItem);
  await queueWriteAll(store, queue);
}

// ─── Chama publish em batches até processar todas as contas ──────────────────
// Cada invocação processa BATCH_SIZE contas (padrão 5).
// Para 50 contas: 10 chamadas em sequência, cada uma ~2-4s = ~30-40s total.
// Isso fica dentro do timeout da cron (26s por função, mas a cron em si não tem limite).
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

    // Sem resultado = vídeo ainda IN_PROGRESS
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

      // Retry com backoff (3 tentativas para a sequência de batches toda)
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
