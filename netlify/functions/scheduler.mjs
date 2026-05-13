// scheduler.mjs
// Cron function — roda a cada 5 minutos no servidor, independente do browser.
// Lê a fila do Netlify Blobs, processa itens vencidos e publica via publish.mjs.
// O scheduler do React continua funcionando como fallback quando o site está aberto.
//
// Fluxo:
//   1. Lê toda a fila (GET /api/queue)
//   2. Separa itens "due" (scheduledAt <= agora, status === "pending")
//   3. Para cada item: marca "running", chama /publish ou /publish-finish, atualiza status
//   4. Itens com loop são reagendados para +24h
//   5. Itens video_finish não prontos são reagendados para +20s
//
// Proteção contra dupla execução:
//   Marca o item como "running" ANTES de chamar a API.
//   Se a função for invocada novamente em 5 min e o item ainda estiver "running"
//   por mais de 3 minutos (stuck), ele é resetado para "pending".

import { getStore } from "@netlify/blobs";

const SITE_URL = process.env.URL || process.env.NETLIFY_URL || "";

// ─── Helpers da fila (mesma interface do frontend) ────────────────────────────

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

// ─── Chamadas internas às functions ──────────────────────────────────────────

async function callPublish(item, mediaUrl) {
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
      delay_seconds:   0,
      skip_rate_limit: !!item.warmup,
    }),
  });
  if (!res.ok) throw new Error(`publish HTTP ${res.status}`);
  return res.json();
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

// ─── Processamento de um item de vídeo pendente ───────────────────────────────

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
      console.error(`[scheduler] ❌ video_finish @${vf.username} erro: ${result.error}`);
      await queueUpdate(store, { ...vf, status: "error", error: result.error });
      return;
    }

    // Sem resultado = vídeo ainda IN_PROGRESS — reagenda em 20s
    const attempts = (vf.attempts || 0) + 1;
    if (attempts >= (vf.maxAttempts || 20)) {
      await queueUpdate(store, { ...vf, status: "error", error: "Timeout: vídeo não processou após múltiplas tentativas" });
    } else {
      console.log(`[scheduler] video_finish @${vf.username} ainda processando (tentativa ${attempts})`);
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

// ─── Processamento de um item normal ─────────────────────────────────────────

async function processItem(store, item) {
  console.log(`[scheduler] processando item ${item.id} (${item.postType}, ${(item.accounts || []).length} contas)`);
  await queueUpdate(store, { ...item, status: "running" });

  try {
    const urlsToPost = item.mediaUrls || [item.mediaUrl];

    for (let mi = 0; mi < urlsToPost.length; mi++) {
      const mediaUrl = urlsToPost[mi];
      if (mi > 0) await new Promise((r) => setTimeout(r, 3000));

      // Retry com backoff (3 tentativas)
      let data, lastErr;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, 5000 * Math.pow(3, attempt - 1)));
        try {
          data = await callPublish(item, mediaUrl);
          break;
        } catch (err) {
          lastErr = err;
          console.warn(`[scheduler] tentativa ${attempt + 1} falhou para item ${item.id}: ${err.message}`);
        }
      }

      if (!data) throw lastErr || new Error("Falha ao chamar publish após 3 tentativas");

      const results         = data.results || [];
      const pendingResults  = results.filter((r) => r.pending && r.creation_id);
      const historyId       = `h-${Date.now()}-${mi}`;

      // Enfileira video_finish para cada vídeo ainda em processamento
      for (const pr of pendingResults) {
        const vfId = `vf-${historyId}-${pr.account_id}`;
        await queueSave(store, {
          id:          vfId,
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

      console.log(`[scheduler] item ${item.id} — ${results.filter((r) => r.success).length} ok, ${pendingResults.length} vídeos pendentes, ${results.filter((r) => !r.success && !r.pending).length} erros`);
    }

    if (item.loop) {
      // Loop diário: reagenda para +24h
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
    console.error(`[scheduler] ❌ item ${item.id} erro: ${err.message}`);
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
    console.error("[scheduler] URL do site não configurada (env var URL ou NETLIFY_URL). Abortando.");
    return new Response(JSON.stringify({ error: "SITE_URL não configurada" }), { status: 500 });
  }

  let store;
  try {
    store = getQueueStore();
  } catch (err) {
    console.error("[scheduler] não foi possível abrir o store:", err.message);
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }

  const queue = await queueReadAll(store);
  const now   = Date.now();

  // Reseta itens "running" travados por mais de 3 minutos (deploy ou crash anterior)
  const STUCK_MS  = 3 * 60 * 1000;
  const stuckItems = queue.filter(
    (x) => x.status === "running" && x.startedAt && now - new Date(x.startedAt).getTime() > STUCK_MS
  );
  for (const item of stuckItems) {
    console.warn(`[scheduler] resetando item travado ${item.id}`);
    await queueUpdate(store, { ...item, status: "pending", scheduledAt: now + 5000 });
  }

  // Separa itens vencidos por tipo
  const dueNormal = queue.filter((x) => !x.type        && x.status === "pending" && x.scheduledAt <= now);
  const dueFinish = queue.filter((x) => x.type === "video_finish" && x.status === "pending" && x.scheduledAt <= now);

  const total = dueNormal.length + dueFinish.length;
  console.log(`[scheduler] ${dueNormal.length} posts + ${dueFinish.length} video_finish vencidos`);

  if (total === 0) {
    return new Response(JSON.stringify({ ok: true, processed: 0 }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }

  // Processa video_finish primeiro (são mais rápidos)
  for (const vf of dueFinish) {
    await processVideoFinish(store, { ...vf, startedAt: new Date().toISOString() });
  }

  // Processa posts normais
  for (const item of dueNormal) {
    await processItem(store, { ...item, startedAt: new Date().toISOString() });
  }

  console.log(`[scheduler] concluído — ${total} item(s) processados`);
  return new Response(JSON.stringify({ ok: true, processed: total }), {
    status: 200, headers: { "Content-Type": "application/json" },
  });
}

// Roda a cada 5 minutos
export const config = {
  schedule: "*/5 * * * *",
};
