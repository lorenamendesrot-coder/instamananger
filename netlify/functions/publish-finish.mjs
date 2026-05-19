// publish-finish.mjs
// Finaliza containers de vídeo que ficaram pendentes no publish principal.
// Estratégia: checa status UMA vez por chamada — se FINISHED publica imediatamente,
// se IN_PROGRESS retorna not_ready para o scheduler reagendar (sem desperdiçar tempo).

import { getStore } from "@netlify/blobs";

const GRAPH_FB       = "https://graph.facebook.com/v21.0";
const GRAPH_IG       = "https://graph.instagram.com";
function isIGToken(t) { return t?.startsWith("IGAA"); }
function graph(t)    { return isIGToken(t) ? GRAPH_IG : GRAPH_FB; }
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || process.env.URL || "";
const sleep          = (ms) => new Promise((r) => setTimeout(r, ms));

async function getFreshToken(accountId) {
  try {
    const store = getStore({
      name: "insta-accounts",
      siteID: process.env.NETLIFY_SITE_ID,
      token:  process.env.NETLIFY_TOKEN,
      consistency: "strong",
    });
    const acc = await store.get(`account-${accountId}`, { type: "json" });
    return acc?.access_token || null;
  } catch {
    return null;
  }
}

// FIX: checa status_code E status para pegar o erro real do Instagram
// checkContainer faz UM único check por chamada — sem loop de retries interno.
// O scheduler já reagenda a cada 90s; múltiplos checks aqui só consomem tempo
// de função e arriscam estourar o timeout de 26s da Netlify Function.
async function checkContainer(creationId, token) {
  try {
    const r = await fetch(`${graph(token)}/${creationId}?fields=status_code,status&access_token=${token}`);
    const d = await r.json();

    if (d.error) {
      console.error(`[publish-finish] API error para container ${creationId}:`, d.error);
      return { ready: false, expired: true, error: `${d.error.message} (code ${d.error.code})`, errorCode: d.error.code };
    }

    console.log(`[publish-finish] container ${creationId} — status_code: ${d.status_code}, status: ${d.status || "n/a"}`);

    if (d.status_code === "FINISHED") return { ready: true };
    if (d.status_code === "ERROR") {
      const subcode = d.error_subcode || null;
      const igMsg   = d.error_message || d.status || "ERROR";
      const detail  = subcode ? `${igMsg} (subcode ${subcode})` : igMsg;
      console.error(`[publish-finish] container ${creationId} ERRO Instagram: ${detail}`);
      return { ready: false, error: `Instagram rejeitou o vídeo: ${detail}`, errorCode: subcode };
    }

    // IN_PROGRESS ou status desconhecido — scheduler vai reagendar
    return { ready: false, not_ready: true };
  } catch (e) {
    console.warn(`[publish-finish] exceção ao checar ${creationId}:`, e.message);
    return { ready: false, not_ready: true };
  }
}

// Tenta publicar com até 3 tentativas para o caso de "Media ID not available"
async function tryPublish(accountId, creationId, token, username) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(2000); // 2s é suficiente para "Media ID not available" — 4s arriscava estourar o timeout
    try {
      const pRes  = await fetch(`${graph(token)}/${accountId}/media_publish`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ creation_id: creationId, access_token: token }),
      });
      const pData = await pRes.json();

      if (!pData.error) {
        console.log(`[publish-finish] ✅ publicado @${username} media_id: ${pData.id}`);
        return { account_id: accountId, username, success: true, media_id: pData.id, published_at: new Date().toISOString() };
      }

      console.error(`[publish-finish] erro ao publicar @${username} tentativa ${attempt + 1}:`, pData.error);

      // "Media ID not available" é transitório — tenta novamente
      if (pData.error.code === 9007 || pData.error.message?.includes("Media ID")) {
        continue;
      }

      // Qualquer outro erro é definitivo
      return { account_id: accountId, username, success: false, error: pData.error.message, errorCode: pData.error.code };

    } catch (err) {
      console.warn(`[publish-finish] exceção ao publicar @${username} tentativa ${attempt + 1}:`, err.message);
      if (attempt < 2) continue;
      return { account_id: accountId, username, success: false, error: err.message };
    }
  }
  return { account_id: accountId, username, success: false, error: "Media ID not available após 3 tentativas" };
}

export const handler = async (event) => {
  const reqOrigin  = event.headers?.origin || "";
  const corsOrigin = ALLOWED_ORIGIN && reqOrigin === ALLOWED_ORIGIN ? ALLOWED_ORIGIN : ALLOWED_ORIGIN || "*";
  const headers    = {
    "Access-Control-Allow-Origin":  corsOrigin,
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type":                 "application/json",
    ...(corsOrigin !== "*" && { "Vary": "Origin" }),
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers };
  if (event.httpMethod !== "POST")    return { statusCode: 405, headers, body: JSON.stringify({ error: "Método não permitido" }) };

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: "JSON inválido" }) }; }

  const { pending = [], accounts = [] } = body;
  if (!pending.length) return { statusCode: 400, headers, body: JSON.stringify({ error: "Nenhum item pendente" }) };

  console.log(`[publish-finish] processando ${pending.length} item(s) em paralelo`);

  // Processa todas as contas em paralelo — reduz latência de N*T para T
  const settled = await Promise.allSettled(
    pending.map(async (item) => {
      const { account_id, creation_id } = item;
      const account    = accounts.find((a) => a.id === account_id);
      const freshToken = await getFreshToken(account_id);
      const token      = freshToken || account?.access_token;

      if (!token || !creation_id) {
        console.error(`[publish-finish] token ou creation_id ausente para ${account_id}`);
        return { account_id, username: item.username || account?.username, success: false, error: "Token ou creation_id ausente" };
      }

      const check = await checkContainer(creation_id, token);

      if (check.not_ready) {
        console.log(`[publish-finish] @${item.username} ainda IN_PROGRESS`);
        return null; // null = não pronto, scheduler vai reagendar
      }

      if (check.expired || (!check.ready && check.error)) {
        return { account_id, username: item.username || account?.username, success: false, error: check.error, errorCode: check.errorCode };
      }

      if (check.ready) {
        return await tryPublish(account_id, creation_id, token, item.username || account?.username);
      }

      return null;
    })
  );

  // Filtra resultados:
  // - null = ainda IN_PROGRESS (não inclui, scheduler vai reagendar)
  // - rejected = erro inesperado (inclui como erro explícito para o SW não tratar como IN_PROGRESS)
  const results = settled
    .map((s, i) => {
      if (s.status === "fulfilled") return s.value; // null ou objeto resultado
      // Promise rejeitada — exceção inesperada dentro do map
      const item = pending[i];
      console.error(`[publish-finish] exceção inesperada para @${item?.username}:`, s.reason?.message || s.reason);
      return { account_id: item?.account_id, username: item?.username, success: false, error: s.reason?.message || "Erro interno", errorCode: null };
    })
    .filter((r) => r !== null);

  return { statusCode: 200, headers, body: JSON.stringify({ results }) };
};
