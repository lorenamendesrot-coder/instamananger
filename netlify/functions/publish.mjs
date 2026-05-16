// publish.mjs
import { getStore } from "@netlify/blobs";

const GRAPH_FB       = "https://graph.facebook.com/v21.0";
const GRAPH_IG       = "https://graph.instagram.com";
function isIGToken(t) { return t?.startsWith("IGAA"); }
function graph(t)    { return isIGToken(t) ? GRAPH_IG : GRAPH_FB; }
const sleep          = (ms) => new Promise((r) => setTimeout(r, ms));
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || process.env.URL || "";

// ─── Conversão de URL do Google Drive ────────────────────────────────────────
// Aceita qualquer formato de link do Drive e converte para download direto.
// Formatos suportados:
//   https://drive.google.com/file/d/FILE_ID/view
//   https://drive.google.com/file/d/FILE_ID/view?usp=sharing
//   https://drive.google.com/open?id=FILE_ID
//   https://drive.google.com/uc?id=FILE_ID  (já no formato antigo)
function resolveGoogleDriveUrl(url) {
  if (!url || !url.includes("drive.google.com")) return url;

  let fileId = null;

  // Formato /file/d/FILE_ID/...
  const fileMatch = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (fileMatch) fileId = fileMatch[1];

  // Formato ?id=FILE_ID ou &id=FILE_ID
  if (!fileId) {
    const idMatch = url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    if (idMatch) fileId = idMatch[1];
  }

  if (!fileId) {
    console.warn("[publish] Link do Google Drive não reconhecido, usando como está:", url);
    return url;
  }

  const direct = `https://drive.google.com/uc?export=download&id=${fileId}`;
  console.log(`[publish] Google Drive convertido: ${fileId} -> ${direct}`);
  return direct;
}

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
const W_START  = parseInt(process.env.POST_WINDOW_START  || "0");
const W_END    = parseInt(process.env.POST_WINDOW_END    || "24");
const TZ_OFFSET = parseInt(process.env.TZ_OFFSET_HOURS   || "-3");
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
    console.warn(`[publish] aviso: nao foi possivel salvar rate-limit de ${id}:`, err.message);
  }
}

async function canPublish(store, id) {
  const s      = await loadState(store, id);
  const now    = Date.now();
  const localH = ((new Date(now).getUTCHours() + TZ_OFFSET) % 24 + 24) % 24;
  if (localH < W_START || localH >= W_END) {
    const hoursUntilStart = localH >= W_END
      ? (24 - localH + W_START)
      : (W_START - localH);
    const w = hoursUntilStart * 3600000 - (new Date(now).getMinutes() * 60000 + new Date(now).getSeconds() * 1000);
    return { ok: false, state: s, reason: `Fora da janela (${W_START}h-${W_END}h local). Aguardar ${fmtWait(Math.max(w, 0))}.`, waitMs: Math.max(w, 0) };
  }
  if (s.postsToday >= MAX_DAY) {
    const n = new Date(now);
    n.setUTCHours(n.getUTCHours() + (24 - localH), 0, 0, 0);
    n.setTime(n.getTime() + W_START * 3600000);
    const w = n - now;
    return { ok: false, state: s, reason: `Limite diario (${s.postsToday}/${MAX_DAY}). Aguardar ${fmtWait(w)}.`, waitMs: w };
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
      return { ok: false, state: s, reason: `Intervalo minimo ${MIN_GAP}min. Aguardar ${fmtWait(w)}.`, waitMs: w };
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

// ─── Polling do container de video ───────────────────────────────────────────
// FIX: aumentado de 5x4s (20s) para 12x6s (72s) — Reels frequentemente
// levam 30-60s para processar. Com 20s jogava para o publish-finish cedo demais.
async function waitForContainer(id, token) {
  for (let i = 0; i < 12; i++) {
    await sleep(6000);
    try {
      const r = await fetch(`${graph(token)}/${id}?fields=status_code&access_token=${token}`);
      const d = await r.json();
      if (d.status_code === "FINISHED") return { ready: true };
      if (d.status_code === "ERROR")    return { ready: false, error: "Instagram: erro no processamento do video" };
    } catch (_) {}
  }
  return { ready: false, pending: true, creation_id: id };
}

// ─── Publicacao por conta ─────────────────────────────────────────────────────
async function publishOne({ account, media_url, media_type, post_type, caption }) {
  const token = account.access_token;
  if (!token) return { success: false, error: "Token nao encontrado. Reconecte a conta." };

  // FIX: converte links do Google Drive para URL de download direto
  const resolved_url = resolveGoogleDriveUrl(media_url);

  const isVideo = media_type === "VIDEO";
  let payload = { access_token: token };

  if (post_type === "REEL") {
    if (!isVideo) return { success: false, error: "Reels so aceita video." };
    payload = { ...payload, video_url: resolved_url, media_type: "REELS", caption, share_to_feed: true };
  } else if (post_type === "FEED") {
    payload = isVideo
      // FIX: era "REELS" — video no Feed deve usar "VIDEO"
      ? { ...payload, video_url: resolved_url, media_type: "VIDEO", caption }
      : { ...payload, image_url: resolved_url, media_type: "IMAGE", caption };
  } else if (post_type === "STORY") {
    payload = isVideo
      // FIX: era "REELS" — story de video deve usar "STORIES"
      ? { ...payload, video_url: resolved_url, media_type: "STORIES" }
      : { ...payload, image_url: resolved_url, media_type: "STORIES" };
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
        errMsg = "Instagram nao conseguiu baixar o video. Verifique se o arquivo no Google Drive esta com permissao publica ('Qualquer pessoa com o link'). Se estiver usando outro host, certifique-se que a URL e publica e acessivel (catbox.moe e bloqueado pela Meta).";
      }
      return { success: false, error: errMsg, errorCode: cData.error.code };
    }

    if (isVideo || post_type === "REEL") {
      const result = await waitForContainer(cData.id, token);
      if (result.pending) return { success: false, pending: true, creation_id: cData.id, error: "Video processando. Sera publicado automaticamente em breve." };
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
  if (event.httpMethod !== "POST")    return { statusCode: 405, headers, body: JSON.stringify({ error: "Metodo nao permitido" }) };

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: "JSON invalido" }) }; }

  const { accounts, media_url, media_type, post_type, captions, default_caption, skip_rate_limit,
          batch_offset = 0 } = body;

  if (!accounts?.length || !media_url || !media_type || !post_type)
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Campos obrigatorios ausentes" }) };

  let store;
  try {
    store = getRLStore();
  } catch (err) {
    console.warn("[publish] Blobs nao configurado, rate-limit desativado:", err.message);
  }

  const batch     = accounts.slice(batch_offset, batch_offset + BATCH_SIZE);
  const next      = batch_offset + BATCH_SIZE;
  const has_more  = next < accounts.length;

  console.log(`[publish] batch ${batch_offset}-${batch_offset + batch.length - 1} de ${accounts.length} conta(s)`);

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
