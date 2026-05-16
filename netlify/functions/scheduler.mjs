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

// ─── Lock otimista ────────────────────────────────────────────────────────────

const MAX_RETRIES = 10;
const BASE_DELAY  = 150;

async function readWithEtag(store) {
  try {
    const data = await store.get(BLOB_KEY, { type: "json" });
    if (data && Array.isArray(data.items)) return { items: data.items, etag: data.etag || null };
    if (Array.isArray(data))              return { items: data, etag: null };
    return { items: [], etag: null };
  } catch {
    return { items: [], etag: null };
  }
}

async function writeWithLock(store, etag, items) {
  const current = await readWithEtag(store);
  if (etag !== null && current.etag !== etag) throw new Error("etag_mismatch");
  const newEtag = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  await store.setJSON(BLOB_KEY, { etag: newEtag, items });
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
      console.warn(`[scheduler] conflito de escrita, tentativa ${attempt + 1}/${MAX_RETRIES} (${Math.round(delay)}ms)`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error("Não foi possível gravar na fila após múltiplas tentativas.");
}

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

// ─── Publish em batches resilientes ──────────────────────────────────────────
// Cada batch é chamado individualmente.
// Se um batch falhar, as contas dele são registradas como falha no resultado
// e os demais batches continuam normalmente.

const BATCH_SIZE     = parseInt(process.env.PUBLISH_BATCH_SIZE || "5");
const RETRY_DELAY_MS = 10 * 60 * 1000; // 10 minutos

async function callPublishAllBatches(item, mediaUrl) {
  const allResults = [];
  let offset = 0;

  while (offset < item.accounts.length) {
    try {
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

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      allResults.push(...(data.results || []));

      if (!data.has_more) break;
      offset = data.next_offset;
    } catch (err) {
      // Batch falhou — registra cada conta desse batch e continua para o próximo
      console.warn(`[scheduler] batch offset=${offset} falhou: ${err.message}`);
      const batchAccounts = item.accounts.slice(offset, offset + BATCH_SIZE);
      for (const acc of batchAccounts) {
        allResults.push({
          account_id:  acc.id,
          username:    acc.username,
          success:     false,
          error:       err.message,
          batch_error: true,
        });
      }
      offset += BATCH_SIZE;
    }
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

      // Acumula resultado no item pai para o histórico ficar correto
      await pushResultToParent(store, vf.historyId, {
        account_id:   vf.account_id,
        username:     vf.username,
        success:      true,
        media_id:     result.media_id,
        published_at: result.published_at,
      });
      return;
    }

    if (result && !result.success) {
      console.error(`[scheduler] ❌ video_finish @${vf.username}: ${result.error}`);
      await queueUpdate(store, { ...vf, status: "error", error: result.error });

      // Acumula falha no item pai também
      await pushResultToParent(store, vf.historyId, {
        account_id: vf.account_id,
        username:   vf.username,
        success:    false,
        error:      result.error,
      });
      return;
    }

    const attempts = (vf.attempts || 0) + 1;
    if (attempts >= (vf.maxAttempts || 20)) {
      await queueUpdate(store, { ...vf, status: "error", error: "Timeout: vídeo não processou após múltiplas tentativas" });
      await pushResultToParent(store, vf.historyId, {
        account_id: vf.account_id,
        username:   vf.username,
        success:    false,
        error:      "Timeout: vídeo não processou",
      });
    } else {
      console.log(`[scheduler] video_finish @${vf.username} IN_PROGRESS (tentativa ${attempts})`);
      await queueUpdate(store, { ...vf, status: "pending", attempts, scheduledAt: Date.now() + 20000 });
    }
  } catch (err) {
    const attempts = (vf.attempts || 0) + 1;
    if (attempts >= (vf.maxAttempts || 20)) {
      await queueUpdate(store, { ...vf, status: "error", error: err.message });
      await pushResultToParent(store, vf.historyId, {
        account_id: vf.account_id,
        username:   vf.username,
        success:    false,
        error:      err.message,
      });
    } else {
      await queueUpdate(store, { ...vf, status: "pending", attempts, scheduledAt: Date.now() + 20000 });
    }
  }
}

// Acumula resultado de um video_finish no array results[] do item pai.
// Quando o último video_finish termina, marca o pai como "done".
async function pushResultToParent(store, historyId, result) {
  if (!historyId) return;
  try {
    await withLock(store, (queue) => {
      const parent = queue.find((x) => !x.type && x.historyId === historyId);
      if (!parent) return queue;

      const existing = (parent.results || []).filter((r) => r.account_id !== result.account_id);
      const newResults = [...existing, result];

      // Verifica se ainda há video_finish pendentes/running para este historyId
      const pendingVF = queue.filter(
        (x) => x.type === "video_finish" &&
               x.historyId === historyId &&
               (x.status === "pending" || x.status === "running") &&
               x.account_id !== result.account_id // este acabou de terminar
      );

      const allDone = pendingVF.length === 0;
      const updated = {
        ...parent,
        results:     newResults,
        ...(allDone && !parent.loop ? {
          status:      "done",
          completedAt: new Date().toISOString(),
          finishedAt:  new Date().toISOString(),
        } : {}),
      };

      if (allDone && !parent.loop) {
        console.log(`[scheduler] ✅ item pai ${parent.id} concluído — ${newResults.filter(r => r.success).length}/${newResults.length} conta(s) publicadas`);
      }

      return queue.map((x) => x.id === parent.id ? updated : x);
    });
  } catch (err) {
    console.warn(`[scheduler] pushResultToParent falhou para historyId=${historyId}:`, err.message);
  }
}

// ─── Processamento de item normal ─────────────────────────────────────────────
async function processItem(store, item) {
  const total = (item.accounts || []).length;
  console.log(`[scheduler] item ${item.id} — ${total} conta(s), tipo ${item.postType}`);
  await queueUpdate(store, { ...item, status: "running" });

  try {
    const urlsToPost = item.mediaUrls || [item.mediaUrl];

    const allFinishedResults = []; // acumula resultados de todas as mídias para salvar no done

    for (let mi = 0; mi < urlsToPost.length; mi++) {
      const mediaUrl = urlsToPost[mi];
      if (mi > 0) await new Promise((r) => setTimeout(r, 3000));

      const { results } = await callPublishAllBatches(item, mediaUrl);

      // ── Separa os resultados ──────────────────────────────────────────────
      const succeeded     = results.filter((r) => r.success);
      const pendingVideos = results.filter((r) => r.pending && r.creation_id);
      const failed        = results.filter((r) => !r.success && !r.pending);

      // ── Cria itens video_finish para Reels que ainda estão processando ────
      const historyId = `h-${Date.now()}-${mi}`;
      for (const pr of pendingVideos) {
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

      // Salva historyId no item pai para que pushResultToParent consiga encontrá-lo
      if (pendingVideos.length > 0) {
        await queueUpdate(store, { ...item, historyId, status: "running" });
      }

      // ── Reagenda contas que falharam (1 chance de retry por item) ─────────
      // Contas com rate_limited não entram aqui — o rate limit cuida delas.
      const failedNonRL = failed.filter((r) => !r.rate_limited);
      if (failedNonRL.length > 0) {
        const alreadyFailed = new Set(item.failedAccountIds || []);
        const toRetry = [];
        const giveUp  = [];

        for (const r of failedNonRL) {
          if (alreadyFailed.has(r.account_id)) {
            giveUp.push(r);
            console.error(`[scheduler] ❌ @${r.username} falhou 2x no item ${item.id} — desistindo: ${r.error}`);
          } else {
            toRetry.push(r);
          }
        }

        if (toRetry.length > 0) {
          const retryAccounts = item.accounts.filter((a) =>
            toRetry.some((r) => r.account_id === a.id)
          );
          await queueSave(store, {
            ...item,
            id:               `retry-${item.id}-${Date.now()}`,
            status:           "pending",
            accounts:         retryAccounts,
            scheduledAt:      Date.now() + RETRY_DELAY_MS,
            failedAccountIds: [...alreadyFailed, ...toRetry.map((r) => r.account_id)],
            retryOf:          item.id,
            createdAt:        new Date().toISOString(),
            loop:             false, // retry não herda loop
          });
          console.log(`[scheduler] ↻ ${toRetry.length} conta(s) reagendadas em 10min`);
        }
      }

      // Acumula resultados finalizados para salvar no histórico
      allFinishedResults.push(...succeeded, ...failed);

      console.log(
        `[scheduler] item ${item.id} — ` +
        `${succeeded.length} ok, ${pendingVideos.length} vídeos pendentes, ` +
        `${failedNonRL.filter((r) => !r.batch_error).length} erros de API, ` +
        `${failedNonRL.filter((r) => r.batch_error).length} erros de batch`
      );
    }

    // ── Finaliza item original ────────────────────────────────────────────
    // Verifica se ainda tem video_finish pendentes para este item
    const allQueue       = await queueReadAll(store);
    const pendingFinish  = allQueue.filter(
      (x) => x.type === "video_finish" && x.status === "pending" && x.historyId && item.historyId && x.historyId === item.historyId
    );
    const stillPending   = pendingFinish.length > 0;

    if (item.loop) {
      const HOUR_MS = 3600 * 1000;
      const JITTER  = Math.floor(Math.random() * 360 - 180) * 1000;
      await queueUpdate(store, {
        ...item,
        status:      "pending",
        scheduledAt: item.scheduledAt + HOUR_MS + JITTER,
        runCount:    (item.runCount || 0) + 1,
      });
    } else if (stillPending) {
      // Tem video_finish ainda rodando — fica como "running" até pushResultToParent
      // acumular todos os resultados. O App.jsx vai sincronizar o histórico depois.
      console.log(`[scheduler] item ${item.id} — aguardando ${pendingFinish.length} video_finish(es)`);
      // Não altera o status — permanece "running" até o último video_finish terminar
    } else {
      // Nenhum video_finish pendente — todos os resultados já foram acumulados
      await queueUpdate(store, {
        ...item,
        status:      "done",
        results:     allFinishedResults,
        completedAt: new Date().toISOString(),
        finishedAt:  new Date().toISOString(),
      });
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
export default async function handler(request) {
  // Ping de detecção: o frontend faz GET para saber se o cron está ativo.
  if (request && request.method === "GET") {
    return new Response(JSON.stringify({ ok: true, cron: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

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

  // Reseta itens "running" travados por mais de 8 minutos.
  // Aumentado de 3 → 8 min: com 50 contas, callPublishAllBatches faz até
  // 10 chamadas HTTP sequenciais (~2-3s cada) e pode levar até 7 min legítimos.
  // 15min: com delay sequencial entre contas (8-20s) + 10 contas + polling de vídeo,
  // um item legítimo pode levar até ~5min. 15min dá margem ampla antes de resetar.
  const STUCK_MS   = 15 * 60 * 1000;
  const stuckItems = queue.filter(
    (x) => x.status === "running" && x.startedAt && now - new Date(x.startedAt).getTime() > STUCK_MS
  );
  // Stuck reset ainda é sequencial — são raros e não precisam de concorrência
  for (const item of stuckItems) {
    console.warn(`[scheduler] resetando item travado ${item.id}`);
    await queueUpdate(store, { ...item, status: "pending", scheduledAt: now + 5000 });
  }

  const dueNormal = queue.filter((x) => !x.type && x.status === "pending" && x.scheduledAt <= now);
  const dueFinish = queue.filter((x) => x.type === "video_finish" && x.status === "pending" && x.scheduledAt <= now);

  console.log(`[scheduler] ${dueNormal.length} posts + ${dueFinish.length} video_finish vencidos`);

  if (dueNormal.length === 0 && dueFinish.length === 0) {
    return new Response(JSON.stringify({ ok: true, processed: 0 }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }

  // ── Concorrência limitada ────────────────────────────────────────────────
  // Processa até N items em paralelo em vez de sequencial puro.
  // video_finish são leves (1 fetch) → limite 5.
  // Posts normais são pesados (N batches × M contas) → limite 3.
  // Cada lote aguarda todos terminarem antes do próximo — garante que o
  // tempo total da função cabe dentro do timeout da Netlify (26s agendadas).
  const CONCURRENT_NORMAL = 3;
  const CONCURRENT_FINISH = 5;

  await runConcurrent(
    dueFinish,
    (vf) => processVideoFinish(store, { ...vf, startedAt: new Date().toISOString() }),
    CONCURRENT_FINISH,
  );
  await runConcurrent(
    dueNormal,
    (item) => processItem(store, { ...item, startedAt: new Date().toISOString() }),
    CONCURRENT_NORMAL,
  );

  const total = dueNormal.length + dueFinish.length;
  console.log(`[scheduler] concluído — ${total} item(s) processados`);
  return new Response(JSON.stringify({ ok: true, processed: total }), {
    status: 200, headers: { "Content-Type": "application/json" },
  });
}

// ─── Concorrência limitada ────────────────────────────────────────────────────
// Executa fn() em lotes de até `limit` promises simultâneas.
// Aguarda cada lote terminar antes do próximo — sem estourar memória nem
// gerar contention excessivo no lock do Blob com muitas escritas paralelas.
async function runConcurrent(items, fn, limit) {
  for (let i = 0; i < items.length; i += limit) {
    const batch = items.slice(i, i + limit);
    await Promise.allSettled(batch.map(fn));
  }
}

export const config = {
  schedule: "*/5 * * * *",
};
