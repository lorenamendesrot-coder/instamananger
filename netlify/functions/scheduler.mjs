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

// ─── Inserção em lote atômica (1 write para N sub-itens) ─────────────────────
async function queueSaveMany(store, newItems) {
  await withLock(store, (queue) => {
    for (const item of newItems) {
      const idx = queue.findIndex((x) => x.id === item.id);
      if (idx >= 0) queue[idx] = item;
      else queue.push(item);
    }
    return queue;
  });
}

// ─── Constantes ───────────────────────────────────────────────────────────────

// Intervalo entre sub-itens per_account (substitui o delay interno do publish).
// Cada conta é agendada com esse gap — o scheduler despacha 1 conta por tick,
// sem nenhum sleep dentro da função. Padrão: 15s (cabe folgado em 5 ticks/min).
const ACCOUNT_GAP_MS = parseInt(process.env.ACCOUNT_GAP_MS || "15000");

const RETRY_DELAY_MS = 10 * 60 * 1000; // 10 minutos

// ─── Publish-finish via HTTP ──────────────────────────────────────────────────
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
      await pushResultToParent(store, vf.historyId, {
        account_id: vf.account_id,
        username:   vf.username,
        success:    false,
        error:      result.error,
      });
      return;
    }

    const attempts = (vf.attempts || 0) + 1;
    if (attempts >= (vf.maxAttempts || 40)) {
      await queueUpdate(store, { ...vf, status: "error", error: "Timeout: vídeo não processou após múltiplas tentativas" });
      await pushResultToParent(store, vf.historyId, {
        account_id: vf.account_id,
        username:   vf.username,
        success:    false,
        error:      "Timeout: vídeo não processou",
      });
    } else {
      console.log(`[scheduler] video_finish @${vf.username} IN_PROGRESS (tentativa ${attempts})`);
      await queueUpdate(store, { ...vf, status: "pending", attempts, scheduledAt: Date.now() + 30000 });
    }
  } catch (err) {
    const attempts = (vf.attempts || 0) + 1;
    if (attempts >= (vf.maxAttempts || 40)) {
      await queueUpdate(store, { ...vf, status: "error", error: err.message });
      await pushResultToParent(store, vf.historyId, {
        account_id: vf.account_id,
        username:   vf.username,
        success:    false,
        error:      err.message,
      });
    } else {
      await queueUpdate(store, { ...vf, status: "pending", attempts, scheduledAt: Date.now() + 30000 });
    }
  }
}

// ─── pushResultToParent ───────────────────────────────────────────────────────
// Acumula resultado de um sub-item (per_account ou video_finish) no item pai.
// Quando o último sub-item termina, marca o pai como "done".
async function pushResultToParent(store, historyId, result) {
  if (!historyId) return;
  try {
    await withLock(store, (queue) => {
      // Pai pode ser um item normal (sem type) ou um item com type="group"
      const parent = queue.find((x) => x.historyId === historyId && (x.type === "group" || !x.type));
      if (!parent) return queue;

      const existing   = (parent.results || []).filter((r) => r.account_id !== result.account_id);
      const newResults = [...existing, result];

      // Verifica se ainda há sub-itens pendentes/running para este historyId
      const pendingChildren = queue.filter(
        (x) => (x.type === "per_account" || x.type === "video_finish") &&
               x.historyId === historyId &&
               (x.status === "pending" || x.status === "running") &&
               x.account_id !== result.account_id
      );

      const allDone = pendingChildren.length === 0;
      const updated = {
        ...parent,
        results: newResults,
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

// ─── Processamento de sub-item per_account ────────────────────────────────────
// Cada sub-item representa 1 conta de 1 publicação original.
// publish.mjs é chamado com 1 conta, sem batch, sem delay interno.
async function processPerAccount(store, item) {
  console.log(`[scheduler] per_account @${item.username} (${item.historyId})`);
  await queueUpdate(store, { ...item, status: "running" });

  // ── Se for origem Google Drive, resolve URL fresca antes de publicar ────────
  // O drive-proxy baixa o vídeo com refresh_token (não expira) e retorna
  // uma URL pública do Netlify Blobs que a API da Meta consegue acessar.
  // Isso funciona em loops: cada rodada re-baixa o vídeo do Drive.
  let mediaUrl = item.mediaUrl;
  if (item.driveFileId && item.driveRefreshToken) {
    try {
      console.log(`[scheduler] 📂 resolvendo Drive proxy para @${item.username} (${item.driveName || item.driveFileId})`);
      const proxyRes = await fetch(`${SITE_URL}/.netlify/functions/drive-proxy`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          file_id:       item.driveFileId,
          file_name:     item.driveName || item.driveFileId,
          refresh_token: item.driveRefreshToken,
        }),
      });
      const proxyData = await proxyRes.json();
      if (!proxyRes.ok || !proxyData.url) {
        throw new Error(proxyData.error || `drive-proxy HTTP ${proxyRes.status}`);
      }
      mediaUrl = proxyData.url;
      console.log(`[scheduler] 📂 Drive proxy OK: ${mediaUrl}`);
    } catch (proxyErr) {
      console.error(`[scheduler] ❌ drive-proxy falhou para @${item.username}:`, proxyErr.message);
      await queueUpdate(store, { ...item, status: "error", error: `Falha ao baixar vídeo do Drive: ${proxyErr.message}`, finishedAt: new Date().toISOString() });
      await pushResultToParent(store, item.historyId, {
        account_id: item.account_id,
        username:   item.username,
        success:    false,
        error:      `Falha ao baixar vídeo do Drive: ${proxyErr.message}`,
      });
      return;
    }
  }

  try {
    const res = await fetch(`${SITE_URL}/.netlify/functions/publish`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accounts:        [item.account],
        media_url:       mediaUrl,
        media_type:      item.mediaType,
        post_type:       item.postType,
        captions:        item.captions        || {},
        default_caption: item.caption         || "",
        skip_rate_limit: !!item.warmup,
        // batch_offset 0 → publica só a 1 conta do array
      }),
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data   = await res.json();
    const result = (data.results || [])[0];

    if (!result) throw new Error("Resposta sem result");

    if (result.rate_limited) {
      // Reagenda para depois do wait_ms indicado pelo rate limit
      const delay = result.wait_ms || RETRY_DELAY_MS;
      console.log(`[scheduler] ⏳ @${item.username} rate limited — reagendando em ${Math.round(delay/60000)}min`);
      await queueUpdate(store, { ...item, status: "pending", scheduledAt: Date.now() + delay });
      return;
    }

    if (result.pending && result.creation_id) {
      // Vídeo ainda processando → cria video_finish
      console.log(`[scheduler] 🎬 @${item.username} vídeo em processamento — criando video_finish`);
      await queueSave(store, {
        id:          `vf-${item.historyId}-${item.account_id}`,
        type:        "video_finish",
        status:      "pending",
        creation_id: result.creation_id,
        account_id:  item.account_id,
        username:    item.username,
        accounts:    [item.account],
        scheduledAt: Date.now() + 30000,
        historyId:   item.historyId,
        parentId:    item.parentId,
        mediaUrl:    item.mediaUrl,
        postType:    item.postType,
        mediaType:   item.mediaType,
        caption:     item.caption || "",
        createdAt:   new Date().toISOString(),
        attempts:    0,
        maxAttempts: 40, // ~20 minutos de margem para o Instagram processar
      });
      // Marca o sub-item como aguardando video_finish (não done ainda)
      await queueUpdate(store, { ...item, status: "done", awaitingVideoFinish: true });
      return;
    }

    if (result.success) {
      console.log(`[scheduler] ✅ @${item.username} publicado`);
      await queueUpdate(store, { ...item, status: "done", result, finishedAt: new Date().toISOString() });
      await pushResultToParent(store, item.historyId, {
        account_id:   item.account_id,
        username:     item.username,
        success:      true,
        media_id:     result.media_id,
        published_at: result.published_at,
      });
      return;
    }

    // Falha — retry 1x (salvo se já é retry)
    const errMsg = result.error || "Erro desconhecido";
    console.error(`[scheduler] ❌ @${item.username}: ${errMsg}`);
    const alreadyFailed = item.failedAccountIds || [];

    if (!alreadyFailed.includes(item.account_id)) {
      // 1ª falha → reagenda em 10min
      await queueSave(store, {
        ...item,
        id:               `retry-${item.id}-${Date.now()}`,
        status:           "pending",
        scheduledAt:      Date.now() + RETRY_DELAY_MS,
        failedAccountIds: [...alreadyFailed, item.account_id],
        retryOf:          item.id,
        createdAt:        new Date().toISOString(),
      });
      await queueUpdate(store, { ...item, status: "done", skippedForRetry: true });
      console.log(`[scheduler] ↻ @${item.username} reagendado em 10min`);
    } else {
      // 2ª falha → desiste
      await queueUpdate(store, { ...item, status: "error", error: errMsg, finishedAt: new Date().toISOString() });
      await pushResultToParent(store, item.historyId, {
        account_id: item.account_id,
        username:   item.username,
        success:    false,
        error:      errMsg,
      });
    }

  } catch (err) {
    console.error(`[scheduler] ❌ per_account @${item.username}: ${err.message}`);
    await queueUpdate(store, { ...item, status: "error", error: err.message, finishedAt: new Date().toISOString() });
    await pushResultToParent(store, item.historyId, {
      account_id: item.account_id,
      username:   item.username,
      success:    false,
      error:      err.message,
    });
  }
}

// ─── Processamento de item normal → explode em per_account ───────────────────
// Não publica nada. Cria N sub-itens per_account com scheduledAt escalonado
// e marca o item original como grupo (type="group", status="running").
// Retorna imediatamente — sem timeout.
async function processItem(store, item) {
  const accounts = item.accounts || [];
  const total    = accounts.length;
  console.log(`[scheduler] item ${item.id} — explodindo em ${total} sub-itens per_account`);

  const historyId = item.historyId || `h-${item.id}-${Date.now()}`;
  const now       = Date.now();

  const urlsToPost = item.mediaUrls || [item.mediaUrl];

  // Para múltiplas mídias, escalonamos: mídia 0 conta 0, mídia 0 conta 1, ...,
  // mídia 1 conta 0, etc. Gap entre cada publicação = ACCOUNT_GAP_MS.
  const subItems = [];
  let slotIndex  = 0;

  for (let mi = 0; mi < urlsToPost.length; mi++) {
    const mediaUrl = urlsToPost[mi];
    for (let ai = 0; ai < accounts.length; ai++) {
      const account = accounts[ai];
      subItems.push({
        id:          `pa-${historyId}-m${mi}-${account.id}`,
        type:        "per_account",
        status:      "pending",
        historyId,
        parentId:    item.id,
        account,
        account_id:  account.id,
        username:    account.username || account.id,
        mediaUrl,
        mediaIndex:  mi,
        mediaType:   item.mediaType,
        postType:    item.postType,
        captions:    item.captions || {},
        caption:     item.caption  || "",
        warmup:      item.warmup   || false,
        scheduledAt: now + slotIndex * ACCOUNT_GAP_MS,
        createdAt:   new Date().toISOString(),
        failedAccountIds:  item.failedAccountIds  || [],
        driveFileId:       item.driveFileId       || null,
        driveName:         item.driveName         || null,
        driveRefreshToken: item.driveRefreshToken || null,
      });
      slotIndex++;
    }
  }

  // Escreve todos os sub-itens num único write atômico
  await withLock(store, (queue) => {
    // Converte o item pai para type="group"
    const parentIdx = queue.findIndex((x) => x.id === item.id);
    const groupItem = {
      ...item,
      type:      "group",
      historyId,
      status:    "running",
      results:   [],
      startedAt: new Date().toISOString(),
      totalAccounts: total * urlsToPost.length,
    };
    if (parentIdx >= 0) queue[parentIdx] = groupItem;
    else queue.push(groupItem);

    // Adiciona os sub-itens
    for (const sub of subItems) {
      const idx = queue.findIndex((x) => x.id === sub.id);
      if (idx >= 0) queue[idx] = sub;
      else queue.push(sub);
    }

    return queue;
  });

  const lastSlotMs = (slotIndex - 1) * ACCOUNT_GAP_MS;
  console.log(`[scheduler] ✅ item ${item.id} → ${subItems.length} sub-itens criados, último slot em ${Math.round(lastSlotMs/1000)}s`);

  // Loop: reagenda o grupo para daqui a 1h (depois que todos sub-itens terminarem)
  // A checagem de conclusão acontece no pushResultToParent.
  if (item.loop) {
    const HOUR_MS = 3600 * 1000;
    const JITTER  = Math.floor(Math.random() * 360 - 180) * 1000;
    // O item pai é atualizado novamente para loop após todos sub-itens concluírem
    // Aqui apenas registramos o próximo scheduledAt no grupo
    await queueUpdate(store, {
      ...item,
      type:        "group",
      historyId,
      status:      "running",
      scheduledAt: item.scheduledAt + HOUR_MS + JITTER,
      runCount:    (item.runCount || 0) + 1,
      totalAccounts: total * urlsToPost.length,
    });
  }
}

// ─── Handler principal ────────────────────────────────────────────────────────
export default async function handler(request) {
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

  // Reseta itens "running" travados.
  // Grupos (type="group") nunca ficam "running" por muito tempo — eles só
  // transitam para running durante a explosão em sub-itens (< 2s).
  // per_account travados: 5 min de margem.
  const STUCK_MS_PERACCCOUNT = 5 * 60 * 1000;
  const STUCK_MS_VF          = 15 * 60 * 1000;

  const stuckItems = queue.filter((x) => {
    if (x.status !== "running" || !x.startedAt) return false;
    const age = now - new Date(x.startedAt).getTime();
    if (x.type === "per_account") return age > STUCK_MS_PERACCCOUNT;
    if (x.type === "video_finish") return age > STUCK_MS_VF;
    return age > STUCK_MS_VF; // grupos e legados
  });

  for (const item of stuckItems) {
    console.warn(`[scheduler] resetando item travado ${item.id} (${item.type || "normal"})`);
    await queueUpdate(store, { ...item, status: "pending", scheduledAt: now + 5000 });
  }

  // Itens pendentes vencidos por tipo
  const dueNormal     = queue.filter((x) => !x.type && x.status === "pending" && x.scheduledAt <= now);
  const duePerAccount = queue.filter((x) => x.type === "per_account" && x.status === "pending" && x.scheduledAt <= now);
  const dueFinish     = queue.filter((x) => x.type === "video_finish" && x.status === "pending" && x.scheduledAt <= now);

  console.log(`[scheduler] ${dueNormal.length} posts + ${duePerAccount.length} per_account + ${dueFinish.length} video_finish vencidos`);

  if (dueNormal.length === 0 && duePerAccount.length === 0 && dueFinish.length === 0) {
    return new Response(JSON.stringify({ ok: true, processed: 0 }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }

  // ── Processamento ────────────────────────────────────────────────────────────
  // Itens normais → processItem() apenas cria sub-itens na fila (< 2s cada).
  //   Pode rodar até 5 em paralelo sem risco de timeout.
  // per_account → 1 fetch para o publish (~2-5s). Limite 3 em paralelo para
  //   não sobrecarregar a API do Instagram com burst simultâneo.
  // video_finish → 1 fetch leve. Limite 5.

  await runConcurrent(
    dueNormal,
    (item) => processItem(store, item),
    5,
  );
  await runConcurrent(
    dueFinish,
    (vf) => processVideoFinish(store, { ...vf, startedAt: new Date().toISOString() }),
    5,
  );
  await runConcurrent(
    duePerAccount,
    (item) => processPerAccount(store, { ...item, startedAt: new Date().toISOString() }),
    3,
  );

  const total = dueNormal.length + duePerAccount.length + dueFinish.length;
  console.log(`[scheduler] concluído — ${total} item(s) processados`);
  return new Response(JSON.stringify({ ok: true, processed: total }), {
    status: 200, headers: { "Content-Type": "application/json" },
  });
}

// ─── Concorrência limitada ────────────────────────────────────────────────────
async function runConcurrent(items, fn, limit) {
  for (let i = 0; i < items.length; i += limit) {
    const batch = items.slice(i, i + limit);
    await Promise.allSettled(batch.map(fn));
  }
}

export const config = {
  schedule: "*/1 * * * *",  // A cada 1 minuto — sub-itens com gap de 15s precisam de ticks mais frequentes
};
