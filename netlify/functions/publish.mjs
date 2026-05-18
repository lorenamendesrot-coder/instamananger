// publish.mjs
import { getStore } from "@netlify/blobs";

const GRAPH_FB       = "https://graph.facebook.com/v21.0";
const GRAPH_IG       = "https://graph.instagram.com";
function isIGToken(t) { return t?.startsWith("IGAA"); }
function graph(t)    { return isIGToken(t) ? GRAPH_IG : GRAPH_FB; }
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || process.env.URL || "";

// ─── Conversão de URL do Google Drive ────────────────────────────────────────

/** Extrai o fileId e monta a URL de download direto. Retorna { fileId, direct } ou null. */
function parseGoogleDriveUrl(url) {
  if (!url || !url.includes("drive.google.com")) return null;

  let fileId = null;

  const fileMatch = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (fileMatch) fileId = fileMatch[1];

  if (!fileId) {
    const idMatch = url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    if (idMatch) fileId = idMatch[1];
  }

  if (!fileId) return null;

  // "confirm=t" bypassa a tela de confirmação de antivírus do Google Drive
  // que bloqueia downloads de arquivos grandes (vídeos) sem interação humana.
  // Sem esse parâmetro, o Instagram recebe uma página HTML em vez do vídeo.
  const direct = `https://drive.google.com/uc?export=download&confirm=t&id=${fileId}`;
  return { fileId, direct };
}

/**
 * Converte URL do Drive e valida acessibilidade via HEAD request.
 * Lança erro imediatamente se o arquivo não for acessível publicamente,
 * evitando a falha silenciosa ~20 min depois no processamento do Instagram.
 *
 * @param {string} url  URL original (Drive ou qualquer outra)
 * @returns {Promise<string>}  URL resolvida e validada
 * @throws {Error}  Se o Drive retornar 403/404 ou não for um tipo de mídia aceito
 */
async function resolveGoogleDriveUrl(url) {
  if (!url || !url.includes("drive.google.com")) return url;

  const parsed = parseGoogleDriveUrl(url);

  if (!parsed) {
    console.warn("[publish] Link do Google Drive não reconhecido, usando como está:", url);
    return url;
  }

  const { fileId, direct } = parsed;
  console.log(`[publish] Google Drive convertido: ${fileId} -> ${direct}`);

  // ── Validação prévia via HEAD ──────────────────────────────────────────────
  // O Instagram só descobre que o arquivo é inacessível ~20 min depois.
  // Fazemos um HEAD aqui para falhar rápido e dar feedback útil ao usuário.
  try {
    const headRes = await fetch(direct, {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(10_000), // 10 s — Drive pode redirecionar
    });

    const status      = headRes.status;
    const contentType = headRes.headers.get("content-type") || "";

    if (status === 401 || status === 403) {
      throw new Error(
        `Arquivo do Google Drive não está acessível publicamente (HTTP ${status}). ` +
        `Verifique se a permissão está como "Qualquer pessoa com o link pode ver".`
      );
    }

    if (status === 404) {
      throw new Error(
        `Arquivo do Google Drive não encontrado (HTTP 404). ` +
        `Confirme que o link está correto e que o arquivo não foi removido.`
      );
    }

    if (status >= 400) {
      throw new Error(
        `Google Drive retornou erro inesperado (HTTP ${status}). ` +
        `Tente novamente ou use outro serviço de hospedagem.`
      );
    }

    // Se o Drive retornar HTML, é a página de "confirmação de vírus" ou login —
    // o Instagram vai receber HTML em vez do vídeo e falhar silenciosamente.
    if (contentType.includes("text/html")) {
      throw new Error(
        `Google Drive retornou uma página HTML em vez do arquivo de mídia. ` +
        `Isso geralmente indica: 1) Permissão restrita (arquivo não público); ` +
        `2) Tela de confirmação de antivírus para arquivos grandes. ` +
        `Tente baixar e re-hospedar o arquivo em um serviço como Cloudinary ou S3.`
      );
    }

    console.log(
      `[publish] Drive validado: HTTP ${status}, Content-Type: ${contentType || "(não informado)"}`
    );
  } catch (err) {
    // Timeout de rede
    if (err.name === "TimeoutError") {
      throw new Error(
        `Google Drive demorou mais de 10 s para responder ao HEAD request. ` +
        `O Instagram pode não conseguir baixar o arquivo. ` +
        `Verifique a URL ou re-hospede a mídia.`
      );
    }
    // Re-lança erros de validação lançados acima
    throw err;
  }

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

// ─── Publicacao por conta ─────────────────────────────────────────────────────
async function publishOne({ account, media_url, media_type, post_type, caption }) {
  const token = account.access_token;
  if (!token) return { success: false, error: "Token nao encontrado. Reconecte a conta." };

  let resolved_url;
  try {
    resolved_url = await resolveGoogleDriveUrl(media_url);
  } catch (driveErr) {
    return { success: false, error: driveErr.message };
  }

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
    console.log(`[publish] @${batch[i].username}: ${result.success ? "✅ ok" : result.rate_limited ? "⏳ rate limited" : `❌ ${result.error}`}`);
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
