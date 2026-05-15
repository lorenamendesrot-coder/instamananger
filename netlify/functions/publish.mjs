// publish.mjs
import { getStore } from "@netlify/blobs";

const GRAPH_FB       = "https://graph.facebook.com/v21.0";
const GRAPH_IG       = "https://graph.instagram.com";
function isIGToken(t) { return t?.startsWith("IGAA"); }
function graph(t)    { return isIGToken(t) ? GRAPH_IG : GRAPH_FB; }
const sleep          = (ms) => new Promise((r) => setTimeout(r, ms));
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || process.env.URL || "";

// ─── Rate limit persistido no Netlify Blobs ───────────────────────────────────

function getRLStore() {
  const siteID = process.env.NETLIFY_SITE_ID;
  const token  = process.env.NETLIFY_TOKEN;
  if (!siteID || !token) throw new Error("Configure NETLIFY_SITE_ID e NETLIFY_TOKEN");
  return getStore({ name: "insta-ratelimit", siteID, token, consistency: "strong" });
}

const MAX_DAY  = parseInt(process.env.MAX_POSTS_PER_DAY  || "50");
const MAX_HOUR = parseInt(process.env.MAX_POSTS_PER_HOUR || "1");
const MIN_GAP  = parseInt(process.env.MIN_GAP_MINUTES    || "10");
// W_START e W_END em hora LOCAL — default 0h-24h (sem restricao de janela).
const W_START  = parseInt(process.env.POST_WINDOW_START  || "0");
const W_END    = parseInt(process.env.POST_WINDOW_END    || "24");
// Offset do fuso em horas. Brasil/BRT = -3. Ajuste via env var se necessário.
const TZ_OFFSET = parseInt(process.env.TZ_OFFSET_HOURS   || "-3");

// Tamanho máximo do batch por invocação. Env var permite ajustar sem redeploy.
// Com 5 contas em paralelo e ~400ms por conta na Meta API, cada invocação
// termina em ~2-4s — bem dentro do limite de 26s do Netlify.
const BATCH_SIZE = parseInt(process.env.PUBLISH_BATCH_SIZE || "5");

function fmtWait(ms) {
  if (ms <= 0) return "agora";
  const s = Math.ceil(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h}h ${r}m` : `${h}h`;
}

async function loadState(store, id) {
  const now    = new Date();
  // Usa hora local (ajustada pelo TZ_OFFSET) para as chaves de janela.
  // Assim o reset diário e horário acontece na meia-noite local, não UTC.
  const localH = ((now.getUTCHours() + TZ_OFFSET) % 24 + 24) % 24;
  const localNow = new Date(now.getTime() + TZ_OFFSET * 3600000);
  const dk  = localNow.toISOString().slice(0, 10);
  const hk  = `${dk}-${localH}`;
  let s = { postsToday: 0, postsHour: 0, lastPostAt: null, dateKey: "", hourKey: "" };
  try {
    const raw = await store.get(`rl-${id}`, { type: "json" });
    if (raw) s = raw;
  } catch {}
  if (s.dateKey !== dk) { s.postsToday = 0; s.dateKey = dk; }
  if (s.hourKey !== hk) { s.postsHour  = 0; s.hourKey = hk; }
  return s;
}

async function saveState(store, id, s) {
  try {
    await store.setJSON(`rl-${id}`, s);
  } catch (err) {
    console.warn(`[publish] aviso: não foi possível salvar rate-limit de ${id}:`, err.message);
  }
}

async function canPublish(store, id) {
  const s      = await loadState(store, id);
  const now    = Date.now();
  // Converte para hora local usando TZ_OFFSET
  const localH = ((new Date(now).getUTCHours() + TZ_OFFSET) % 24 + 24) % 24;
  if (localH < W_START || localH >= W_END) {
    // Calcula quanto falta para W_START na hora local
    const n = new Date(now);
    const hoursUntilStart = localH >= W_END
      ? (24 - localH + W_START)   // passou do fim: próximo dia
      : (W_START - localH);        // antes do início: hoje mesmo
    const w = hoursUntilStart * 3600000 - (new Date(now).getMinutes() * 60000 + new Date(now).getSeconds() * 1000);
    return { ok: false, state: s, reason: `Fora da janela (${W_START}h–${W_END}h local). Aguardar ${fmtWait(Math.max(w, 0))}.`, waitMs: Math.max(w, 0) };
  }
  if (s.postsToday >= MAX_DAY) {
    // Próximo W_START local = próxima meia-noite local + W_START horas
    const n = new Date(now);
    n.setUTCHours(n.getUTCHours() + (24 - localH), 0, 0, 0); // meia-noite local em UTC
    n.setTime(n.getTime() + W_START * 3600000);
    const w = n - now;
    return { ok: false, state: s, reason: `Limite diário (${s.postsToday}/${MAX_DAY}). Aguardar ${fmtWait(w)}.`, waitMs: w };
  }
  if (s.postsHour >= MAX_HOUR) {
    const n = new Date(now); n.setUTCMinutes(60, 0, 0);
    const w = n - now;
    return { ok: false, state: s, reason: `Limite/hora (${s.postsHour}/${MAX_HOUR}). Aguardar ${fmtWait(w)}.`, waitMs: w };
  }
  if (s.lastPostAt) {
    const el = now - s.lastPostAt, mg = MIN_GAP * 60000;
    if (el < mg) {
      const w = mg - el;
      return { ok: false, state: s, reason: `Intervalo mínimo ${MIN_GAP}min. Aguardar ${fmtWait(w)}.`, waitMs: w };
    }
  }
  return { ok: true, state: s };
}

async function recordPost(store, id, state, success) {
  if (!success) return;
  state.postsToday++;
  state.postsHour++;
  state.lastPostAt = Date.now();
  await saveState(store, id, state);
}

// ─── Polling do container de vídeo ───────────────────────────────────────────
async function waitForContainer(id, token) {
  for (let i = 0; i < 5; i++) {
    await sleep(4000);
    try {
      const r = await fetch(`${graph(token)}/${id}?fields=status_code&access_token=${token}`);
      const d = await r.json();
      if (d.status_code === "FINISHED") return { ready: true };
      if (d.status_code === "ERROR")    return { ready: false, error: "Instagram: erro no processamento do vídeo" };
    } catch (_) {}
  }
  return { ready: false, pending: true, creation_id: id };
}

// ─── Publicação por conta ─────────────────────────────────────────────────────
async function publishOne({ account, media_url, media_type, post_type, caption }) {
  const token = account.access_token;
  if (!token) return { success: false, error: "Token não encontrado. Reconecte a conta." };

  const isVideo = media_type === "VIDEO";
  let payload = { access_token: token };

  if (post_type === "REEL") {
    if (!isVideo) return { success: false, error: "Reels só aceita vídeo." };
    payload = { ...payload, video_url: media_url, media_type: "REELS", caption, share_to_feed: true };
  } else if (post_type === "FEED") {
    payload = isVideo
      ? { ...payload, video_url: media_url, media_type: "REELS", caption }
      : { ...payload, image_url: media_url, caption };
  } else if (post_type === "STORY") {
    payload = isVideo
      ? { ...payload, video_url: media_url, media_type: "REELS", share_to_feed: false }
      : { ...payload, image_url: media_url, media_type: "STORIES" };
  }

  try {
    const cRes  = await fetch(`${graph(token)}/${account.id}/media`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const cData = await cRes.json();
    if (cData.error) {
      let errMsg = cData.error.message;
      if (cData.error.code === 2207077 || errMsg?.includes("Media upload has failed")) {
        errMsg = "Instagram não conseguiu baixar o vídeo. Verifique se a URL é pública e acessível (catbox.moe e hosts similares são bloqueados pela Meta). Use uma URL de CDN pública ou Google Drive com link direto.";
      }
      return { success: false, error: errMsg, errorCode: cData.error.code };
    }

    if (isVideo || post_type === "REEL") {
      const result = await waitForContainer(cData.id, token);
      if (result.pending) return { success: false, pending: true, creation_id: cData.id, error: "Vídeo processando. Será publicado automaticamente em breve." };
      if (!result.ready)  return { success: false, error: result.error };
    }

    const pRes  = await fetch(`${graph(token)}/${account.id}/media_publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ creation_id: cData.id, access_token: token }),
    });
    const pData = await pRes.json();
    if (pData.error) return { success: false, error: pData.error.message, errorCode: pData.error.code };

    return { success: true, media_id: pData.id, published_at: new Date().toISOString() };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ─── Processa uma conta (rate-limit + publish) ────────────────────────────────
async function processAccount({ store, account, media_url, media_type, post_type, captions, default_caption, skip_rate_limit }) {
  let state = null;

  if (!skip_rate_limit && store) {
    const check = await canPublish(store, account.id);
    if (!check.ok) {
      return {
        account_id:   account.id,
        username:     account.username,
        success:      false,
        rate_limited: true,
        error:        check.reason,
        wait_ms:      check.waitMs,
        wait_human:   fmtWait(check.waitMs),
      };
    }
    state = check.state;
  }

  const caption = captions?.[account.id] ?? default_caption ?? "";
  const result  = await publishOne({ account, media_url, media_type, post_type, caption });

  if (store && state) {
    await recordPost(store, account.id, state, result.success);
  }

  return { account_id: account.id, username: account.username, ...result };
}

// ─── Handler ──────────────────────────────────────────────────────────────────
export const handler = async (event) => {
  const origin     = event.headers?.origin || "";
  const corsOrigin = ALLOWED_ORIGIN && origin === ALLOWED_ORIGIN ? ALLOWED_ORIGIN : ALLOWED_ORIGIN || "*";
  const headers    = {
    "Access-Control-Allow-Origin":  corsOrigin,
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type":                 "application/json",
    ...(corsOrigin !== "*" && { Vary: "Origin" }),
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers };
  if (event.httpMethod !== "POST")    return { statusCode: 405, headers, body: JSON.stringify({ error: "Método não permitido" }) };

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: "JSON inválido" }) }; }

  const { accounts, media_url, media_type, post_type, captions, default_caption, skip_rate_limit,
          batch_offset = 0 } = body;

  if (!accounts?.length || !media_url || !media_type || !post_type)
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Campos obrigatórios ausentes" }) };

  let store;
  try {
    store = getRLStore();
  } catch (err) {
    console.warn("[publish] Blobs não configurado, rate-limit desativado:", err.message);
  }

  // ── Fatiamento ──────────────────────────────────────────────────────────────
  // Pega só o slice desta invocação.
  // Se ainda houver contas além do batch, devolve has_more: true e next_offset
  // para o chamador (scheduler ou frontend) invocar novamente com o próximo offset.
  const batch     = accounts.slice(batch_offset, batch_offset + BATCH_SIZE);
  const next      = batch_offset + BATCH_SIZE;
  const has_more  = next < accounts.length;

  console.log(`[publish] batch ${batch_offset}–${batch_offset + batch.length - 1} de ${accounts.length} conta(s)`);

  // Publica todas as contas do batch em paralelo
  const results = await Promise.all(
    batch.map((account) =>
      processAccount({ store, account, media_url, media_type, post_type, captions, default_caption, skip_rate_limit })
    )
  );

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      results,
      has_more,
      next_offset: has_more ? next : null,
      batch_size:  BATCH_SIZE,
    }),
  };
};
