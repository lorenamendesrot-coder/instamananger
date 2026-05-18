// publish.mjs
import { getStore } from "@netlify/blobs";

const GRAPH_FB       = "https://graph.facebook.com/v21.0";
const GRAPH_IG       = "https://graph.instagram.com";
function isIGToken(t) { return t?.startsWith("IGAA"); }
function graph(t)    { return isIGToken(t) ? GRAPH_IG : GRAPH_FB; }
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || process.env.URL || "";

// ─── Configuração dos dois Apps Meta ─────────────────────────────────────────
// App 1 (principal): META_APP_ID + META_APP_SECRET  (ou META_FB_APP_ID etc.)
// App 2 (fallback) : META_APP_ID_2 + META_APP_SECRET_2
//
// Códigos de erro que indicam rate limit a NÍVEL DE APLICATIVO (não de conta):
//   4   → Application Request Limit Reached
//   32  → Page-level throttling / app rate limit
//   613 → Calls to this api have exceeded the rate limit
// Quando detectados, o sistema tenta automaticamente renovar o token
// do usuário usando o App 2 e repostar.

const META_APP_CONFIGS = [
  {
    label:     "App1",
    appId:     process.env.META_APP_ID     || process.env.META_FB_APP_ID,
    appSecret: process.env.META_APP_SECRET || process.env.META_FB_APP_SECRET,
  },
  {
    label:     "App2",
    appId:     process.env.META_APP_ID_2,
    appSecret: process.env.META_APP_SECRET_2,
  },
].filter(c => c.appId && c.appSecret);

// Códigos Meta que indicam throttle a nível de aplicativo
const APP_RATE_LIMIT_CODES = new Set([4, 32, 613]);

function isAppRateLimitError(errorCode) {
  return APP_RATE_LIMIT_CODES.has(Number(errorCode));
}

// Troca um token existente pelo equivalente via outro app Meta.
// Usa fb_exchange_token para obter um novo long-lived token emitido pelo App2.
// Se o token for IGAA (Instagram Login), usa a API do Graph IG.
async function exchangeTokenViaApp(currentToken, appConfig) {
  try {
    const { appId, appSecret } = appConfig;
    if (isIGToken(currentToken)) {
      // Instagram Login token → renova via Graph IG
      const url = `${GRAPH_IG}/access_token?grant_type=ig_exchange_token&client_secret=${appSecret}&access_token=${currentToken}`;
      const res  = await fetch(url);
      const data = await res.json();
      if (data.access_token) return data.access_token;
      console.warn(`[publish] Troca IG token via ${appConfig.label} falhou:`, data.error?.message);
      return null;
    } else {
      // Facebook/Page token → renova via Graph FB
      const url = `${GRAPH_FB}/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${currentToken}`;
      const res  = await fetch(url);
      const data = await res.json();
      if (data.access_token) return data.access_token;
      console.warn(`[publish] Troca FB token via ${appConfig.label} falhou:`, data.error?.message);
      return null;
    }
  } catch (err) {
    console.warn(`[publish] Erro ao trocar token via ${appConfig.label}:`, err.message);
    return null;
  }
}

// ─── Conversão de URL do Google Drive ────────────────────────────────────────
function resolveGoogleDriveUrl(url) {
  if (!url || !url.includes("drive.google.com")) return url;

  let fileId = null;

  const fileMatch = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (fileMatch) fileId = fileMatch[1];

  if (!fileId) {
    const idMatch = url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    if (idMatch) fileId = idMatch[1];
  }

  if (!fileId) {
    console.warn("[publish] Link do Google Drive não reconhecido, usando como está:", url);
    return url;
  }

  // "confirm=t" bypassa a tela de confirmação de antivírus do Google Drive
  // que bloqueia downloads de arquivos grandes (vídeos) sem interação humana.
  // Sem esse parâmetro, o Instagram recebe uma página HTML em vez do vídeo.
  const direct = `https://drive.google.com/uc?export=download&confirm=t&id=${fileId}`;
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

const MAX_DAY   = parseInt(process.env.MAX_POSTS_PER_DAY  || "50");
const MAX_HOUR  = parseInt(process.env.MAX_POSTS_PER_HOUR || "1");
const MIN_GAP   = parseInt(process.env.MIN_GAP_MINUTES    || "10");
const W_START   = parseInt(process.env.POST_WINDOW_START  || "0");
const W_END     = parseInt(process.env.POST_WINDOW_END    || "24");
const TZ_OFFSET = parseInt(process.env.TZ_OFFSET_HOURS   || "-3");

// BATCH_SIZE ainda é respeitado para chamadas diretas do frontend (sem scheduler).
// Quando o scheduler chama, sempre manda 1 conta — batch_offset/BATCH_SIZE não importam.
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

// ─── Publicacao por conta (token pode ser sobrescrito pelo fallback) ──────────
async function publishOneWithToken({ account, token, media_url, media_type, post_type, caption }) {
  const resolved_url = resolveGoogleDriveUrl(media_url);
  const isVideo = media_type === "VIDEO";
  let payload = { access_token: token };

  if (post_type === "REEL") {
    if (!isVideo) return { success: false, error: "Reels so aceita video." };
    payload = { ...payload, video_url: resolved_url, media_type: "REELS", caption, share_to_feed: true };
  } else if (post_type === "FEED") {
    payload = isVideo
      ? { ...payload, video_url: resolved_url, media_type: "VIDEO", caption }
      : { ...payload, image_url: resolved_url, media_type: "IMAGE", caption };
  } else if (post_type === "STORY") {
    payload = isVideo
      ? { ...payload, video_url: resolved_url, media_type: "STORIES" }
      : { ...payload, image_url: resolved_url, media_type: "STORIES" };
  }

  const cRes  = await fetch(`${graph(token)}/${account.id}/media`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const cData = await cRes.json();
  if (cData.error) {
    let errMsg = cData.error.message;
    if (cData.error.code === 2207077 || errMsg?.includes("Media upload has failed")) {
      errMsg = "Instagram não conseguiu baixar o vídeo do Google Drive. Confirme que: 1) O arquivo tem permissão 'Qualquer pessoa com o link pode ver'; 2) O link é compartilhável (não restrito). O sistema já aplica 'confirm=t' automaticamente para contornar a tela de antivírus do Drive.";
    }
    return { success: false, error: errMsg, errorCode: cData.error.code };
  }

  // Vídeos: retorna pending imediatamente — publish-finish cuida do resto
  if (isVideo || post_type === "REEL") {
    return { success: false, pending: true, creation_id: cData.id };
  }

  // Imagens: publica diretamente
  const pRes  = await fetch(`${graph(token)}/${account.id}/media_publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ creation_id: cData.id, access_token: token }),
  });
  const pData = await pRes.json();
  if (pData.error) return { success: false, error: pData.error.message, errorCode: pData.error.code };

  return { success: true, media_id: pData.id, published_at: new Date().toISOString() };
}

// ─── Publicacao com fallback automático entre Apps ────────────────────────────
// Tenta publicar com o App1 (token original). Se receber erro de rate limit
// a nível de aplicativo (código 4, 32 ou 613), renova o token via App2 e
// tenta novamente. Retorna qual app foi usado no campo `app_used`.
async function publishOne({ account, media_url, media_type, post_type, caption }) {
  const originalToken = account.access_token;
  if (!originalToken) return { success: false, error: "Token nao encontrado. Reconecte a conta." };

  // Lista de tentativas: começa com token original, depois tenta apps alternativos
  const attempts = [{ token: originalToken, appLabel: META_APP_CONFIGS[0]?.label || "App1" }];

  // Pré-carrega tokens alternativos (App2, App3…) se configurados
  // Só tenta o fallback se houver pelo menos 2 apps configurados
  if (META_APP_CONFIGS.length >= 2) {
    for (let i = 1; i < META_APP_CONFIGS.length; i++) {
      attempts.push({ token: null, appConfig: META_APP_CONFIGS[i], appLabel: META_APP_CONFIGS[i].label });
    }
  }

  let lastResult = null;

  for (let i = 0; i < attempts.length; i++) {
    let { token, appConfig, appLabel } = attempts[i];

    // Para tentativas de fallback, obtém o token via exchange com o app alternativo
    if (token === null && appConfig) {
      console.log(`[publish] 🔄 @${account.username}: tentando fallback via ${appLabel} (rate limit do app anterior)`);
      token = await exchangeTokenViaApp(originalToken, appConfig);
      if (!token) {
        console.warn(`[publish] @${account.username}: não foi possível obter token via ${appLabel}, pulando`);
        continue;
      }
    }

    try {
      const result = await publishOneWithToken({ account, token, media_url, media_type, post_type, caption });
      lastResult = result;

      // Sucesso ou erro não relacionado ao rate limit do app → retorna imediatamente
      if (result.success || result.pending) {
        if (i > 0) console.log(`[publish] ✅ @${account.username}: publicado via ${appLabel} (fallback)`);
        return { ...result, app_used: appLabel };
      }

      // Erro de rate limit a nível de app → tenta próximo app
      if (isAppRateLimitError(result.errorCode) && i < attempts.length - 1) {
        console.warn(`[publish] ⚠️ @${account.username}: rate limit do ${appLabel} (código ${result.errorCode}) — tentando ${attempts[i + 1]?.appLabel}`);
        continue;
      }

      // Outro erro → retorna sem tentar fallback
      return { ...result, app_used: appLabel };

    } catch (err) {
      lastResult = { success: false, error: err.message };
      if (i < attempts.length - 1) continue;
    }
  }

  return { ...(lastResult || { success: false, error: "Falha em todas as tentativas" }), app_used: "none" };
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

  // Quando chamado pelo scheduler (per_account), sempre vem 1 conta — batch de 1.
  // Quando chamado diretamente pelo frontend, respeita BATCH_SIZE.
  const batch    = accounts.slice(batch_offset, batch_offset + BATCH_SIZE);
  const next     = batch_offset + BATCH_SIZE;
  const has_more = next < accounts.length;

  // NOTA: sem delay entre contas aqui. O gap entre publicações é controlado
  // pelo scheduler via scheduledAt escalonado dos sub-itens per_account.
  // Isso garante que nenhuma invocação do publish.mjs estoure o timeout.

  console.log(`[publish] ${batch.length} conta(s) — sem delay interno (gap gerenciado pelo scheduler)`);

  const results = [];
  for (let i = 0; i < batch.length; i++) {
    const result = await processAccount({
      store, account: batch[i], media_url, media_type,
      post_type, captions, default_caption, skip_rate_limit,
    });
    results.push(result);
    const appTag = result.app_used ? ` [${result.app_used}]` : "";
    console.log(`[publish] @${batch[i].username}${appTag}: ${result.success ? "✅ ok" : result.rate_limited ? "⏳ rate limited" : `❌ ${result.error}`}`);
  }

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
