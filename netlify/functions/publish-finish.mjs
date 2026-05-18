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
async function checkContainer(creationId, token) {
  for (let i = 0; i < 3; i++) {
    if (i > 0) await sleep(4000);
    try {
      const r = await fetch(`${graph(token)}/${creationId}?fields=status_code,status&access_token=${token}`);
      const d = await r.json();

      // FIX: retorna o erro real da API em vez de mensagem genérica
      if (d.error) {
        console.error(`[publish-finish] API error para container ${creationId}:`, d.error);
        // CRÍTICO: passar errorCode para o SW detectar rate limit (code 4) e reagendar
        // Sem isso, isRateLimit no SW fica false e a conta é abandonada em vez de reagendada
        return { ready: false, expired: true, error: `${d.error.message} (code ${d.error.code})`, errorCode: d.error.code };
      }

      console.log(`[publish-finish] container ${creationId} — status_code: ${d.status_code}, status: ${d.status || "n/a"} (check ${i + 1}/3)`);

      if (d.status_code === "FINISHED") return { ready: true };
      if (d.status_code === "ERROR")    return { ready: false, error: `Instagram rejeitou o vídeo. Status: ${d.status || "ERROR"}` };
      // IN_PROGRESS ou outro: continua esperando
    } catch (e) {
      console.warn(`[publish-finish] exceção ao checar ${creationId}:`, e.message);
    }
  }
  // Ainda IN_PROGRESS após 3 checks — scheduler vai tentar de novo
  return { ready: false, not_ready: true };
}

// Tenta publicar com até 3 tentativas para o caso de "Media ID not available"
async function tryPublish(accountId, creationId, token, username) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(4000);
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

  // Filtra resultados: null = ainda processando (não inclui em results)
  const results = settled
    .filter((s) => s.status === "fulfilled" && s.value !== null)
    .map((s) => s.value);

  return { statusCode: 200, headers, body: JSON.stringify({ results }) };
};
