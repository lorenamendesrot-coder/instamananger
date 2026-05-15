// scheduler.mjs — dispara posts da fila a cada 5 min
// Lógica: pega itens pendentes com scheduledAt <= agora e publica.
// Após publicar, se loop=true, reagenda para scheduledAt + 1h.

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

async function readQueue(store) {
  try {
    const data = await store.get(BLOB_KEY, { type: "json" });
    if (data && Array.isArray(data.items)) return { items: data.items, etag: data.etag || null };
    if (Array.isArray(data)) return { items: data, etag: null };
    return { items: [], etag: null };
  } catch {
    return { items: [], etag: null };
  }
}

async function writeQueue(store, etag, items) {
  const current = await readQueue(store);
  if (etag !== null && current.etag !== etag) throw new Error("etag_mismatch");
  const newEtag = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  await store.setJSON(BLOB_KEY, { etag: newEtag, items });
}

async function withLock(store, fn) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const { items, etag } = await readQueue(store);
    const updated = await fn(items);
    try {
      await writeQueue(store, etag, updated);
      return updated;
    } catch (err) {
      if (err.message !== "etag_mismatch") throw err;
      const delay = 100 * Math.pow(2, attempt) + Math.random() * 50;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error("Não foi possível salvar na fila.");
}

async function updateItem(store, updated) {
  await withLock(store, (items) => {
    const idx = items.findIndex((x) => x.id === updated.id);
    if (idx >= 0) items[idx] = updated;
    else items.push(updated);
    return items;
  });
}

async function publishItem(item) {
  const res = await fetch(`${SITE_URL}/.netlify/functions/publish`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      accounts:        item.accounts,
      media_url:       item.mediaUrl,
      media_type:      item.mediaType,
      post_type:       item.postType,
      captions:        item.captions        || {},
      default_caption: item.caption         || "",
      skip_rate_limit: true,
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export default async function handler(request) {
  if (request?.method === "GET") {
    return new Response(JSON.stringify({ ok: true, cron: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  console.log("[scheduler] tick", new Date().toISOString());

  if (!SITE_URL) {
    return new Response(JSON.stringify({ error: "SITE_URL não configurada" }), { status: 500 });
  }

  let store;
  try { store = getQueueStore(); }
  catch (err) { return new Response(JSON.stringify({ error: err.message }), { status: 500 }); }

  const { items: queue } = await readQueue(store);
  const now = Date.now();

  // Reseta itens travados em "running" por mais de 5 min
  for (const item of queue.filter((x) => x.status === "running")) {
    const startedAt = item.startedAt ? new Date(item.startedAt).getTime() : 0;
    if (now - startedAt > 5 * 60_000) {
      await updateItem(store, { ...item, status: "pending", scheduledAt: now + 10_000 });
    }
  }

  const { items: fresh } = await readQueue(store);
  const due = fresh.filter((x) => x.status === "pending" && x.scheduledAt <= now);

  if (!due.length) {
    return new Response(JSON.stringify({ ok: true, processed: 0 }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }

  for (const item of due) {
    await updateItem(store, { ...item, status: "running", startedAt: new Date().toISOString() });
    try {
      const data    = await publishItem(item);
      const results = data.results || [];

      if (item.loop) {
        await updateItem(store, {
          ...item,
          status:      "pending",
          scheduledAt: item.scheduledAt + 60 * 60_000,
          runCount:    (item.runCount || 0) + 1,
          lastResults: results,
          lastRanAt:   new Date().toISOString(),
        });
      } else {
        await updateItem(store, { ...item, status: "done", results, completedAt: new Date().toISOString() });
      }
    } catch (err) {
      await updateItem(store, { ...item, status: "error", error: err.message, failedAt: new Date().toISOString() });
    }
  }

  return new Response(JSON.stringify({ ok: true, processed: due.length }), {
    status: 200, headers: { "Content-Type": "application/json" },
  });
}

export const config = { schedule: "*/5 * * * *" };
