// netlify/functions/queue.mjs
// Salva TODA a fila num único blob "queue-data"
// Suporta 800+ itens sem timeout — 1 write em vez de 800 writes paralelos
// Lock otimista via etag — evita race condition entre scheduler e frontend
//
// GET    /api/queue        → retorna array de itens
// POST   /api/queue        → addBatch: adiciona/substitui itens pelo id
// PUT    /api/queue        → updateItem: atualiza um item pelo id
// DELETE /api/queue?id=xxx → remove item específico
// DELETE /api/queue        → limpa tudo

import { getStore } from "@netlify/blobs";

const STORE_NAME = "insta-queue";
const BLOB_KEY   = "queue-data";

function getQueueStore() {
  const siteID = process.env.NETLIFY_SITE_ID;
  const token  = process.env.NETLIFY_TOKEN;
  if (!siteID || !token) throw new Error("Configure NETLIFY_SITE_ID e NETLIFY_TOKEN");
  return getStore({ name: STORE_NAME, siteID, token, consistency: "strong" });
}

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "";

function corsHeaders(req) {
  const origin = (req?.headers?.get ? req.headers.get("origin") : req?.headers?.origin) || "";
  const allow  = ALLOWED_ORIGIN && origin === ALLOWED_ORIGIN ? ALLOWED_ORIGIN : (ALLOWED_ORIGIN ? "" : "*");
  return {
    "Access-Control-Allow-Origin":  allow,
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type":                 "application/json",
    ...(allow && allow !== "*" ? { "Vary": "Origin" } : {}),
  };
}

function json(data, status = 200, req = null) {
  return new Response(JSON.stringify(data), { status, headers: corsHeaders(req) });
}

// ─── Lock otimista com ETag HTTP real ────────────────────────────────────────
//
// Usamos o ETag HTTP que o Netlify Blobs retorna via getWithMetadata().
// Ao escrever com store.setJSON(key, value, { etag }), o servidor rejeita
// com 412 Precondition Failed se outro processo já escreveu desde a leitura.
// Isso garante exclusão mútua real entre scheduler e frontend, sem a dupla
// leitura do etag caseiro (que criava uma janela de race condition entre
// o "readWithEtag" de verificação e o "setJSON" dentro do writeWithLock).
//
// O blob agora guarda apenas { items } — o campo "etag" foi removido do JSON.
// Blobs antigos no formato { etag, items } são tratados de forma compatível.

const MAX_RETRIES = 5;
const BASE_DELAY  = 80; // ms

async function readWithEtag(store) {
  try {
    // getWithMetadata retorna { data, etag, metadata } ou null se não existir.
    const result = await store.getWithMetadata(BLOB_KEY, { type: "json" });
    if (!result) return { items: [], etag: null };

    const { data, etag } = result;
    if (data && Array.isArray(data.items)) return { items: data.items, etag: etag || null };
    // Compatibilidade: blob antigo era só o array
    if (Array.isArray(data))               return { items: data,       etag: etag || null };
    return { items: [], etag: etag || null };
  } catch {
    return { items: [], etag: null };
  }
}

async function writeWithLock(store, etag, items) {
  // store.set() aceita { etag } como opção para conditional write (If-Match).
  // Se o blob mudou desde a leitura, o servidor retorna 412 e o SDK lança erro.
  // Usamos store.set com Blob/string em vez de setJSON porque setJSON não
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

// Executa uma função que recebe os items atuais e retorna items modificados.
// Retenta automaticamente em caso de conflito de ETag.
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
      console.warn(`[queue] conflito de escrita (ETag HTTP), tentativa ${attempt + 1}/${MAX_RETRIES} (aguardando ${Math.round(delay)}ms)`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error("Não foi possível gravar na fila após múltiplas tentativas. Tente novamente.");
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(req) });

  try {
    const store = getQueueStore();

    // GET — retorna todos os itens (comprimido para evitar ERR_HTTP2_PROTOCOL_ERROR)
    if (req.method === "GET") {
      const { items } = await readWithEtag(store);

      // Limpeza automática: remove itens done/error/posted com mais de 48h
      // Evita que o payload cresça indefinidamente e cause ERR_HTTP2_PROTOCOL_ERROR
      const cutoff = Date.now() - 48 * 60 * 60 * 1000;
      const active = items.filter((x) => {
        if (x.status === "done" || x.status === "posted" || x.status === "error") {
          const ts = x.completedAt || x.failedAt || x.scheduledAt;
          if (ts && new Date(ts).getTime() < cutoff) return false;
        }
        return true;
      });

      // Strips campos pesados — mediaUrls não é enviado ao frontend (só a contagem)
      // Isso reduz drasticamente o payload e evita ERR_HTTP2_PROTOCOL_ERROR
      const slim = active.map((x) => {
        if (x.type === "per_account" || x.type === "video_finish") return x;
        const { mediaUrls, ...rest } = x;
        return {
          ...rest,
          ...(mediaUrls ? { mediaUrlsCount: mediaUrls.length } : {}),
        };
      });

      // NOTA: gzip manual foi removido — causava ERR_HTTP2_PROTOCOL_ERROR no browser.
      // O Netlify CDN já comprime automaticamente respostas JSON em HTTP/2.
      const body = JSON.stringify(slim);
      return new Response(body, {
        status: 200,
        headers: { ...corsHeaders(req), "Content-Type": "application/json" },
      });
    }

    // POST — addBatch: insere ou substitui itens pelo id
    if (req.method === "POST") {
      const body = await req.json();
      const news = Array.isArray(body) ? body : [body];

      const updated = await withLock(store, (queue) => {
        for (const item of news) {
          if (!item?.id) continue;
          const idx = queue.findIndex((x) => x.id === item.id);
          if (idx >= 0) queue[idx] = item;
          else queue.push(item);
        }
        return queue;
      });

      return json({ saved: news.length, total: updated.length }, 200, req);
    }

    // PUT — updateItem: atualiza um item pelo id
    if (req.method === "PUT") {
      const item = await req.json();
      if (!item?.id) return json({ error: "id obrigatório" }, 400, req);

      await withLock(store, (queue) => {
        const idx = queue.findIndex((x) => x.id === item.id);
        if (idx >= 0) queue[idx] = item;
        else queue.push(item);
        return queue;
      });

      return json(item, 200, req);
    }

    // DELETE — remove item ou limpa tudo
    if (req.method === "DELETE") {
      const url = new URL(req.url);
      const id  = url.searchParams.get("id");

      if (id) {
        const updated = await withLock(store, (queue) =>
          queue.filter((x) => String(x.id) !== String(id))
        );
        return json({ deleted: id, remaining: updated.length }, 200, req);
      } else {
        await withLock(store, () => []);
        return json({ cleared: true }, 200, req);
      }
    }

    return json({ error: "Método não permitido" }, 405, req);

  } catch (err) {
    console.error("[queue.mjs]", err.message);
    return json({ error: err.message }, 500, req);
  }
}
