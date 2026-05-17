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

// ─── Lock otimista ────────────────────────────────────────────────────────────
// O blob guarda { etag, items } em vez de só o array.
// etag é um timestamp gerado a cada escrita.
// Se ao gravar o etag lido for diferente do atual, outra instância
// escreveu antes — tenta de novo com backoff (até MAX_RETRIES vezes).

const MAX_RETRIES = 5;
const BASE_DELAY  = 80; // ms

async function readWithEtag(store) {
  try {
    const data = await store.get(BLOB_KEY, { type: "json" });
    if (data && Array.isArray(data.items)) {
      return { items: data.items, etag: data.etag || null };
    }
    // Compatibilidade: blob antigo era só o array
    if (Array.isArray(data)) {
      return { items: data, etag: null };
    }
    return { items: [], etag: null };
  } catch {
    return { items: [], etag: null };
  }
}

async function writeWithLock(store, etag, items) {
  // Verifica se o etag ainda é o mesmo antes de gravar
  const current = await readWithEtag(store);
  if (etag !== null && current.etag !== etag) {
    throw new Error("etag_mismatch");
  }
  const newEtag = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  await store.setJSON(BLOB_KEY, { etag: newEtag, items });
  return newEtag;
}

// Executa uma função que recebe { items, etag } e retorna items modificados.
// Retenta automaticamente em caso de conflito.
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
      console.warn(`[queue] conflito de escrita, tentativa ${attempt + 1}/${MAX_RETRIES} (aguardando ${Math.round(delay)}ms)`);
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

      // Strips campos pesados de sub-itens que o frontend não exibe diretamente
      // mediaUrls pode ter 120 URLs longas — guardamos só a contagem
      const slim = items.map((x) => {
        if (x.type === "per_account" || x.type === "video_finish") return x;
        const { mediaUrls, ...rest } = x;
        return {
          ...rest,
          ...(mediaUrls ? { mediaUrlsCount: mediaUrls.length, mediaUrls } : {}),
        };
      });

      const body    = JSON.stringify(slim);
      const encoder = new TextEncoder();
      const bytes   = encoder.encode(body);

      // Gzip se o cliente aceitar (todos os browsers modernos aceitam)
      const acceptEncoding = req.headers.get ? req.headers.get("accept-encoding") || "" : "";
      if (acceptEncoding.includes("gzip") && typeof CompressionStream !== "undefined") {
        const cs     = new CompressionStream("gzip");
        const writer = cs.writable.getWriter();
        writer.write(bytes);
        writer.close();
        const compressed = await new Response(cs.readable).arrayBuffer();
        return new Response(compressed, {
          status: 200,
          headers: {
            ...corsHeaders(req),
            "Content-Encoding": "gzip",
            "Content-Type":     "application/json",
          },
        });
      }

      // Fallback sem compressão
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
