// scheduler.mjs
import { getStore } from "@netlify/blobs";

const SITE_URL = process.env.URL || process.env.NETLIFY_URL || "";

// Máximo de tentativas para verificar se o vídeo foi processado pela Meta.
// 4 checks × ~90s por check ≈ ~6min. Deve bater com o valor do App.jsx (VIDEO_FINISH_MAX_ATTEMPTS).
const VIDEO_FINISH_MAX_ATTEMPTS = 4;

// Máximo de timeouts de rede (AbortError) consecutivos antes de desistir.
// Sem esse limite o item pode ficar em loop de reagendamento indefinidamente.
const MAX_TIMEOUT_ATTEMPTS = 3;

function getQueueStore() {
  return getStore({
    name:        "insta-queue",
    siteID:      process.env.NETLIFY_SITE_ID,
    token:       process.env.NETLIFY_TOKEN,
    consistency: "strong",
  });
}

const BLOB_KEY = "queue-data";

// ─── Lock otimista com ETag HTTP real ────────────────────────────────────────
//
// Usamos o ETag HTTP que o Netlify Blobs retorna no header da resposta.
// store.get() com { type: "blob" } retorna um Response-like com o header
// etag preenchido pelo servidor — ele muda a cada escrita, então dois
// deploys simultâneos que leram o mesmo ETag vão colidir de verdade:
// o segundo recebe 412 Precondition Failed e faz retry, em vez de
// silenciosamente sobrescrever o primeiro (comportamento do ETag caseiro).
//
// API usada:
//   store.get(key, { type: "blob" })     → { data: Blob, etag: string }
//   store.set(key, value, { etag })      → lança se ETag não bater (412)

const MAX_RETRIES = 10;
const BASE_DELAY  = 150;

async function readWithEtag(store) {
  try {
    // { type: "blob" } faz o SDK expor o ETag HTTP no objeto retornado.
    // Se a chave não existe, retorna null.
    const result = await store.getWithMetadata(BLOB_KEY, { type: "json" });
    if (!result) return { items: [], etag: null };

    const { data, etag } = result;
    if (data && Array.isArray(data.items)) return { items: data.items, etag: etag || null };
    if (Array.isArray(data))              return { items: data,       etag: etag || null };
    return { items: [], etag: etag || null };
  } catch {
    return { items: [], etag: null };
  }
}

async function writeWithLock(store, etag, items) {
  // store.set() aceita { etag } como opção para conditional write (If-Match).
  // Se o blob mudou desde a leitura, o servidor retorna 412 e o SDK lança erro.
  // Usamos store.set com string JSON em vez de setJSON porque setJSON não
  // repassa as opções de conditional write na v8 do SDK.
  const body    = JSON.stringify({ items });
  const options = { contentType: "application/json", ...(etag ? { etag } : {}) };
  try {
    await store.set(BLOB_KEY, body, options);
  } catch (err) {
    const msg = err?.message || "";
    if (
      err?.status === 412 ||
      msg.includes("412") ||
      msg.toLowerCase().includes("precondition") ||
      msg.toLowerCase().includes("etag") ||
      msg.toLowerCase().includes("conflict")
    ) {
      throw new Error("etag_mismatch");
    }
    throw err;
  }
}

async function withLock(store, fn) {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const { items, etag } = await readWithEtag(store);
    const updated = await fn(items);
    // Guard: se fn esquecer de retornar a queue, aborta em vez de apagar tudo silenciosamente
    if (!Array.isArray(updated)) throw new Error(`withLock: fn deve retornar um array, recebeu ${typeof updated}`);
    try {
      await writeWithLock(store, etag, updated);
      return updated;
    } catch (err) {
      if (err.message !== "etag_mismatch") throw err;
      const delay = BASE_DELAY * Math.pow(2, attempt) + Math.random() * 30;
      console.warn(`[scheduler] conflito de escrita (ETag HTTP), tentativa ${attempt + 1}/${MAX_RETRIES} (${Math.round(delay)}ms)`);
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

// ─── Constantes ───────────────────────────────────────────────────────────────

// Intervalo entre sub-itens per_account (substitui o delay interno do publish).
// Cada conta é agendada com esse gap — o scheduler despacha 1 conta por tick,
// sem nenhum sleep dentro da função. Padrão: 15s (cabe folgado em 5 ticks/min).
const ACCOUNT_GAP_MS = parseInt(process.env.ACCOUNT_GAP_MS || "15000");

const RETRY_DELAY_MS = 60 * 60 * 1000; // 60 minutos (era 10min — aumentado para não dobrar consumo de cota em falhas transitórias)

// Erros definitivos da Meta API — não vale fazer retry, o conteúdo precisa ser corrigido
const ERROS_DEFINITIVOS = new Set([
  2207026, // formato de vídeo não suportado
  2207027, // aspect ratio inválido
  2207028, // duração inválida
  2207036, // tamanho de arquivo excede o limite
  36003,   // permissão insuficiente na conta
  100,     // parâmetro inválido
]);

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
        _subItemId:   vf.id,
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
        _subItemId: vf.id,
        account_id: vf.account_id,
        username:   vf.username,
        success:    false,
        error:      result.error,
      });
      return;
    }

    const attempts = (vf.attempts || 0) + 1;
    if (attempts >= (vf.maxAttempts ?? VIDEO_FINISH_MAX_ATTEMPTS)) {
      await queueUpdate(store, { ...vf, status: "error", error: "Timeout: vídeo não processou após múltiplas tentativas" });
      await pushResultToParent(store, vf.historyId, {
        _subItemId: vf.id,
        account_id: vf.account_id,
        username:   vf.username,
        success:    false,
        error:      "Timeout: vídeo não processou",
      });
    } else {
      console.log(`[scheduler] video_finish @${vf.username} IN_PROGRESS (tentativa ${attempts})`);
      await queueUpdate(store, { ...vf, status: "pending", attempts, scheduledAt: Date.now() + 90000 }); // 90s entre checks (era 30s — reduzido para poupar chamadas à Meta API)
    }
  } catch (err) {
    const attempts = (vf.attempts || 0) + 1;
    if (attempts >= (vf.maxAttempts ?? VIDEO_FINISH_MAX_ATTEMPTS)) {
      await queueUpdate(store, { ...vf, status: "error", error: err.message });
      await pushResultToParent(store, vf.historyId, {
        _subItemId: vf.id,
        account_id: vf.account_id,
        username:   vf.username,
        success:    false,
        error:      err.message,
      });
    } else {
      await queueUpdate(store, { ...vf, status: "pending", attempts, scheduledAt: Date.now() + 90000 }); // 90s entre checks
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

      // Remove resultado anterior do mesmo sub-item para evitar duplicatas.
      // Se o resultado tem _subItemId, deduplica pelo id único do sub-item (preferencial).
      // Senão, cai no fallback legado e deduplica por account_id.
      const existing = (parent.results || []).filter((r) =>
        result._subItemId
          ? r._subItemId !== result._subItemId   // preferencial: id único do sub-item
          : r.account_id !== result.account_id   // fallback legado: account_id
      );
      const newResults = [...existing, result];

      // Verifica se ainda há sub-itens pendentes/running para este historyId.
      // Usa o _subItemId do resultado para excluir apenas o sub-item que acabou de
      // terminar — evitar excluir por account_id, que descartaria erroneamente
      // retries ou sub-itens de múltiplas mídias da mesma conta ainda em andamento.
      const finishedSubItemId = result._subItemId || null;
      const pendingChildren = queue.filter(
        (x) => x.historyId === historyId &&
               // Exclui apenas o sub-item exato que originou este resultado
               (finishedSubItemId ? x.id !== finishedSubItemId : x.account_id !== result.account_id) &&
               (
                 // per_account ainda processando
                 (x.type === "per_account" && (x.status === "pending" || x.status === "running")) ||
                 // per_account aguardando video_finish (status=done mas vídeo não confirmado)
                 (x.type === "per_account" && x.status === "done" && x.awaitingVideoFinish) ||
                 // video_finish ainda processando
                 (x.type === "video_finish" && (x.status === "pending" || x.status === "running")) ||
                 // retry pendente (1ª falha, ainda vai tentar de novo)
                 (x.type === "per_account" && x.status === "pending" && x.retryOf)
               )
      );

      // allDone requer tanto ausência de filhos pendentes quanto total de resultados
      // batendo com totalAccounts. Sem a segunda condição, posts com múltiplas mídias
      // podem fechar "allDone" antes de todas as mídias terminarem se os resultados
      // chegarem fora de ordem.
      const expectedTotal = parent.totalAccounts ?? 0;
      const allDone = pendingChildren.length === 0 &&
        (expectedTotal === 0 || newResults.length >= expectedTotal);
      let loopNext = {};
      if (allDone && parent.loop) {
        const HOUR_MS = 3600 * 1000;
        const JITTER  = Math.floor(Math.random() * 360 - 180) * 1000;
        // Usa Date.now() como base — não parent.scheduledAt — para evitar que atrasos
        // (retries, scheduler travado) façam o próximo ciclo cair no passado e disparar imediatamente.
        loopNext = { scheduledAt: Date.now() + HOUR_MS + JITTER };
      }
      const updated = {
        ...parent,
        results: newResults,
        ...loopNext,
        ...(allDone ? {
          status:      "posted",
          completedAt: new Date().toISOString(),
          finishedAt:  new Date().toISOString(),
        } : {}),
      };

      if (allDone) {
        console.log(`[scheduler] ✅ item pai ${parent.id} concluído — ${newResults.filter(r => r.success).length}/${newResults.length} conta(s) publicadas${parent.loop ? " (loop — próximo em " + new Date(updated.scheduledAt).toLocaleTimeString("pt-BR") + ")" : ""}`);
      }

      // Remove itens loop órfãos que ficaram pending/running sem processar.
      // Critério de identidade: mesmo loopGroupId (preferencial) ou mesma combinação de
      // accounts + mediaUrl + caption. Usar só caption era inseguro: dois posts distintos
      // com a mesma legenda poderiam cancelar um ao outro incorretamente.
      if (allDone && parent.loop) {
        const sameGroup = (x) => {
          // Preferencial: loopGroupId explícito (gerado na criação do item)
          if (parent.loopGroupId && x.loopGroupId) return x.loopGroupId === parent.loopGroupId;
          // Fallback: accounts[] + mediaUrl + caption devem bater todos
          const sameAccounts = JSON.stringify((x.accounts || []).slice().sort()) ===
                               JSON.stringify((parent.accounts || []).slice().sort());
          const sameMedia    = (x.mediaUrl || "") === (parent.mediaUrl || "");
          const sameCaption  = (x.caption  || "") === (parent.caption  || "");
          return sameAccounts && sameMedia && sameCaption;
        };
        return queue.map((x) => {
          if (
            x.id !== parent.id &&
            !x.type &&
            x.loop &&
            x.status === "pending" &&
            sameGroup(x) &&
            x.scheduledAt < updated.scheduledAt
          ) {
            return { ...x, status: "cancelled" };
          }
          return x === parent ? updated : x;
        });
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
          account_id:    item.accounts?.[0]?.id || item.account_id || null,
        }),
      });
      const proxyData = await proxyRes.json();
      if (!proxyRes.ok || !proxyData.url) {
        throw new Error(proxyData.error || `drive-proxy HTTP ${proxyRes.status}`);
      }
      mediaUrl = proxyData.url;
      if (proxyData.sanitized) item = { ...item, _sanitizedConfirmed: true };
      console.log(`[scheduler] 📂 Drive proxy OK: ${mediaUrl} sanitized=${!!proxyData.sanitized}`);
    } catch (proxyErr) {
      console.error(`[scheduler] ❌ drive-proxy falhou para @${item.username}:`, proxyErr.message);
      await queueUpdate(store, { ...item, status: "error", error: `Falha ao baixar vídeo do Drive: ${proxyErr.message}`, finishedAt: new Date().toISOString() });
      await pushResultToParent(store, item.historyId, {
        _subItemId: item.originSubItemId ?? item.id,
        account_id: item.account_id,
        username:   item.username,
        success:    false,
        error:      `Falha ao baixar vídeo do Drive: ${proxyErr.message}`,
      });
      return;
    }
  }

  try {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 22000); // 22s < timeout da function (26s)
    let res;
    try {
      res = await fetch(`${SITE_URL}/.netlify/functions/publish`, {
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
        }),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data   = await res.json();
    const result = (data.results || [])[0];

    if (!result) throw new Error("Resposta sem result");

    if (result.rate_limited) {
      // Reagenda para depois do wait_ms indicado pelo rate limit
      const delay = result.wait_ms || RETRY_DELAY_MS;
      console.log(`[scheduler] ⏳ @${item.username} rate limited — reagendando em ${Math.round(delay/60000)}min`);
      // Zera timeoutCount ao reagendar por rate limit — os timeouts anteriores
      // não são consecutivos a este reagendamento e não devem contar para o limite.
      await queueUpdate(store, { ...item, status: "pending", scheduledAt: Date.now() + delay, timeoutCount: 0 });
      return;
    }

    if (result.pending && result.creation_id) {
      // Vídeo ainda processando → cria video_finish
      console.log(`[scheduler] 🎬 @${item.username} vídeo em processamento — criando video_finish`);
      // ID inclui mediaIndex para evitar colisão quando o mesmo item tem múltiplas mídias
      // (mediaUrls[0] e mediaUrls[1] da mesma conta gerariam o mesmo ID sem esse campo)
      const vfId = item.mediaIndex != null
        ? `vf-${item.historyId}-m${item.mediaIndex}-${item.account_id}`
        : `vf-${item.historyId}-${item.account_id}`; // fallback para itens legados sem mediaIndex
      await queueSave(store, {
        id:          vfId,
        type:        "video_finish",
        status:      "pending",
        creation_id: result.creation_id,
        account_id:  item.account_id,
        username:    item.username,
        accounts:    [item.account],
        scheduledAt: Date.now() + 90000,  // 1º check em 90s — vídeos curtos já costumam estar prontos
        historyId:   item.historyId,
        parentId:    item.parentId,
        mediaUrl:    item.mediaUrl,
        postType:    item.postType,
        mediaType:   item.mediaType,
        caption:     item.caption || "",
        createdAt:   new Date().toISOString(),
        attempts:    0,
        maxAttempts: VIDEO_FINISH_MAX_ATTEMPTS, // definido no topo do arquivo — altere lá se precisar mudar
      });
      // Marca o sub-item como aguardando video_finish (não done ainda)
      await queueUpdate(store, { ...item, status: "done", awaitingVideoFinish: true });
      return;
    }

    if (result.success) {
      console.log(`[scheduler] ✅ @${item.username} publicado`);
      await queueUpdate(store, { ...item, status: "done", result, finishedAt: new Date().toISOString() });
      await pushResultToParent(store, item.historyId, {
        _subItemId:   item.id,
        account_id:   item.account_id,
        username:     item.username,
        success:      true,
        media_id:     result.media_id,
        published_at: result.published_at,
        sanitized:    !!(item._sanitizedConfirmed),
      });
      return;
    }

    // Falha — retry 1x apenas para erros recuperáveis (rede, timeout, 5xx)
    const errMsg = result.error || "Erro desconhecido";
    console.error(`[scheduler] ❌ @${item.username}: ${errMsg}`);
    const alreadyFailed = item.failedAccountIds || [];
    const ehDefinitivo  = ERROS_DEFINITIVOS.has(result.errorCode);

    if (ehDefinitivo) {
      // Erro de conteúdo (formato inválido, aspect ratio, etc.) — não adianta retryar
      console.warn(`[scheduler] ⛔ @${item.username} erro definitivo (code ${result.errorCode}) — sem retry`);
      await queueUpdate(store, { ...item, status: "error", error: errMsg, finishedAt: new Date().toISOString() });
      await pushResultToParent(store, item.historyId, {
        _subItemId: item.originSubItemId ?? item.id,
        account_id: item.account_id,
        username:   item.username,
        success:    false,
        error:      errMsg,
      });
    } else if (!alreadyFailed.includes(item.account_id)) {
      // 1ª falha recuperável → reagenda em 60min
      // originSubItemId: preserva o _subItemId original para que pushResultToParent
      // consiga localizar e substituir o resultado provisório inserido abaixo.
      // Sem isso o retry criaria um 2º registro no histórico em vez de sobrescrever.
      const originSubItemId = item.originSubItemId ?? item.id;
      await queueSave(store, {
        ...item,
        id:               `retry-${item.id}-${Date.now()}`,
        status:           "pending",
        scheduledAt:      Date.now() + RETRY_DELAY_MS,
        failedAccountIds: [...alreadyFailed, item.account_id],
        retryOf:          item.id,
        originSubItemId,          // ← garante deduplicação correta no pushResultToParent
        createdAt:        new Date().toISOString(),
      });
      await queueUpdate(store, { ...item, status: "done", skippedForRetry: true });
      // Registra resultado provisório para que a conta apareça na lista
      // (pushResultToParent sobrescreve se _subItemId já existir)
      await pushResultToParent(store, item.historyId, {
        _subItemId: originSubItemId,
        account_id: item.account_id,
        username:   item.username,
        success:    false,
        error:      `${errMsg} (retry em 60min…)`,
        retrying:   true,
      });
      console.log(`[scheduler] ↻ @${item.username} reagendado em 60min`);
    } else {
      // 2ª falha → desiste
      await queueUpdate(store, { ...item, status: "error", error: errMsg, finishedAt: new Date().toISOString() });
      await pushResultToParent(store, item.historyId, {
        _subItemId: item.originSubItemId ?? item.id,
        account_id: item.account_id,
        username:   item.username,
        success:    false,
        error:      errMsg,
      });
    }

  } catch (err) {
    // Timeout de rede: reagenda em 5min, mas conta a tentativa.
    // Sem o contador o item poderia ficar em loop infinito de timeouts
    // sem nunca atingir o limite normal de falhas (failedAccountIds).
    if (err.name === "AbortError") {
      const timeoutCount = (item.timeoutCount || 0) + 1;
      if (timeoutCount >= MAX_TIMEOUT_ATTEMPTS) {
        console.warn(`[scheduler] ⏱ @${item.username} timeout ${timeoutCount}× seguidos — desistindo`);
        await queueUpdate(store, { ...item, status: "error", error: "Timeout de rede repetido", finishedAt: new Date().toISOString() });
        await pushResultToParent(store, item.historyId, {
          _subItemId: item.originSubItemId ?? item.id,
          account_id: item.account_id,
          username:   item.username,
          success:    false,
          error:      `Timeout de rede ${timeoutCount}× seguidos`,
        });
        return;
      }
      console.warn(`[scheduler] ⏱ @${item.username} timeout (${timeoutCount}/${MAX_TIMEOUT_ATTEMPTS}) — reagendando em 5min`);
      await queueUpdate(store, { ...item, status: "pending", scheduledAt: Date.now() + 5 * 60 * 1000, timeoutCount });
      return;
    }
    console.error(`[scheduler] ❌ per_account @${item.username}: ${err.message}`);
    await queueUpdate(store, { ...item, status: "error", error: err.message, finishedAt: new Date().toISOString() });
    await pushResultToParent(store, item.historyId, {
      _subItemId: item.originSubItemId ?? item.id,
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

  // Guard: accounts vazio criaria um group sem filhos preso em "running" para sempre
  // (stuckItems exclui groups, então nunca seria resetado automaticamente)
  if (total === 0) {
    console.error(`[scheduler] ⛔ item ${item.id} sem contas — marcando como erro`);
    await queueUpdate(store, { ...item, status: "error", error: "Nenhuma conta configurada", finishedAt: new Date().toISOString() });
    return;
  }

  console.log(`[scheduler] item ${item.id} — explodindo em ${total} sub-itens per_account`);

  const historyId = item.historyId || `h-${item.id}-${Date.now()}`;

  // Guarda contra processamento duplo: se já existem sub-itens com este historyId,
  // o scheduler bateu duas vezes no mesmo item (cron overlap). Aborta.
  // Lê a fila direto do store para ter a versão mais recente.
  const currentQueue = await queueReadAll(store);
  const existingChildren = currentQueue.filter(
    (x) => x.historyId === historyId && x.type === "per_account"
  );
  if (existingChildren.length > 0) {
    console.warn(`[scheduler] ⚠️ sub-itens já existem para historyId=${historyId} — abortando processItem para evitar duplicatas`);
    return;
  }

  const now = Date.now();

  // filter(Boolean) remove undefined/null caso mediaUrls e mediaUrl sejam ambos ausentes
  const urlsToPost = (item.mediaUrls || [item.mediaUrl]).filter(Boolean);

  // Guard: sem mídia válida não há o que publicar
  if (urlsToPost.length === 0) {
    console.error(`[scheduler] ⛔ item ${item.id} sem mediaUrl — marcando como erro`);
    await queueUpdate(store, { ...item, status: "error", error: "Nenhuma URL de mídia configurada", finishedAt: new Date().toISOString() });
    return;
  }

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

  // Escreve pai (convertido para group) + todos os sub-itens num único write atômico.
  // O runCount é incrementado aqui mesmo para itens loop — elimina o segundo
  // queueUpdate separado que antes sobrescrevia o groupItem com o item original
  // (sem results:[] e sem startedAt), causando estado inconsistente no pai.
  await withLock(store, (queue) => {
    // Converte o item pai para type="group"
    const parentIdx = queue.findIndex((x) => x.id === item.id);
    const groupItem = {
      ...item,
      type:          "group",
      historyId,
      status:        "running",
      results:       [],
      startedAt:     new Date().toISOString(),
      totalAccounts: total * urlsToPost.length,
      // runCount incrementado aqui para itens loop — não precisa de write extra
      ...(item.loop ? { runCount: (item.runCount || 0) + 1 } : {}),
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
  // IMPORTANTE: grupos (type="group") ficam "running" durante toda a publicação
  // dos sub-itens (pode durar N contas × ACCOUNT_GAP_MS) e são fechados pelo
  // pushResultToParent quando o último sub-item termina. Resetá-los para "pending"
  // causaria um loop eterno: processItem aborta pelo guard de existingChildren e
  // o grupo nunca vira "posted". Por isso grupos são EXCLUÍDOS do stuckItems.
  // Itens legados sem type (não-group, não-per_account) também são ignorados
  // para evitar reset acidental de formatos desconhecidos.
  const STUCK_MS_PERACCCOUNT = 5 * 60 * 1000;   // 5 min — timeout do publish + margem
  const STUCK_MS_VF          = 25 * 60 * 1000;  // 25 min — 4 checks × 5min + folga

  const stuckItems = queue.filter((x) => {
    if (x.status !== "running") return false;
    // Grupos gerenciados por pushResultToParent — nunca resetar
    if (x.type === "group") return false;
    // Usa startedAt se disponível; senão cai para scheduledAt ou createdAt como
    // estimativa conservadora — garante que itens legados (sem startedAt) também
    // sejam detectados e resetados em vez de ficarem presos para sempre.
    const ref = x.startedAt || x.scheduledAt || x.createdAt;
    if (!ref) return false;
    const age = now - new Date(ref).getTime();
    if (x.type === "per_account") return age > STUCK_MS_PERACCCOUNT;
    if (x.type === "video_finish") return age > STUCK_MS_VF;
    // Itens sem type reconhecido: não resetar para evitar comportamento inesperado
    return false;
  });

  // Reset atômico: todos os stuckItems são gravados num único withLock.
  // O loop anterior (um queueUpdate por item) fazia N writes separados, cada um
  // com seu próprio lock/ETag — em caso de contention os writes intermediários
  // podiam conflitar e deixar o estado inconsistente.
  if (stuckItems.length > 0) {
    const stuckIds = new Set(stuckItems.map((x) => x.id));
    await withLock(store, (q) =>
      q.map((x) =>
        stuckIds.has(x.id)
          ? (console.warn(`[scheduler] resetando item travado ${x.id} (${x.type || "normal"})`),
             { ...x, status: "pending", scheduledAt: now + 5000 })
          : x
      )
    );
  }

  // Relê a queue após os resets de stuck items para garantir que dueNormal/duePerAccount/dueFinish
  // enxerguem o estado atual do store — sem isso, itens resetados ainda aparecem
  // como "running" na variável em memória e causariam processamento inconsistente.
  const freshQueue = stuckItems.length > 0 ? await queueReadAll(store) : queue;

  // Itens pendentes vencidos por tipo — ordenados por scheduledAt para respeitar a ordem cronológica
  const dueNormal     = freshQueue.filter((x) => !x.type && (x.status === "pending" || (x.status === "posted" && x.loop)) && x.scheduledAt <= now).sort((a, b) => a.scheduledAt - b.scheduledAt);
  const duePerAccount = freshQueue.filter((x) => x.type === "per_account" && x.status === "pending" && x.scheduledAt <= now).sort((a, b) => a.scheduledAt - b.scheduledAt);
  const dueFinish     = freshQueue.filter((x) => x.type === "video_finish" && x.status === "pending" && x.scheduledAt <= now).sort((a, b) => a.scheduledAt - b.scheduledAt);

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

// ─── Concorrência limitada (pool contínuo) ───────────────────────────────────
// Mantém exatamente `limit` tarefas rodando ao mesmo tempo.
// A versão anterior usava batches fixos: se 1 item de um batch de 3 travasse
// por 22s (timeout), os outros 2 slots ficavam ociosos até ele terminar.
// Com o pool, assim que qualquer slot libera o próximo item já entra — sem esperar.
async function runConcurrent(items, fn, limit) {
  const queue = [...items];
  const active = new Set();

  const runNext = () => {
    while (active.size < limit && queue.length > 0) {
      const item = queue.shift();
      const p = Promise.resolve().then(() => fn(item)).finally(() => {
        active.delete(p);
        runNext();
      });
      active.add(p);
    }
  };

  runNext();
  // Aguarda todas as tarefas ativas terminarem (incluindo as que ainda serão lançadas)
  while (active.size > 0) {
    await Promise.race(active);
  }
}

export const config = {
  schedule: "*/5 * * * *",  // A cada 5 minutos — suficiente para gap de 15s entre contas (cobre até 20 contas por tick)
};
