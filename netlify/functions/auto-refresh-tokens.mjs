// netlify/functions/auto-refresh-tokens.mjs
// Roda automaticamente toda segunda-feira às 9h UTC.
// Renova tokens que estão com menos de 30 dias para expirar.
// Não precisa de nenhuma ação manual — o Netlify chama isso sozinho.

import { getStore } from "@netlify/blobs";

const GRAPH      = "https://graph.facebook.com/v21.0";
const GRAPH_IG   = "https://graph.instagram.com";
const STORE_NAME = "insta-accounts";

function isIGToken(token) { return token?.startsWith("IGAA"); }

function getAccountsStore() {
  return getStore({
    name:        STORE_NAME,
    siteID:      process.env.NETLIFY_SITE_ID,
    token:       process.env.NETLIFY_TOKEN,
    consistency: "strong",
  });
}

async function debugToken(token) {
  const APP_ID     = process.env.META_APP_ID;
  const APP_SECRET = process.env.META_APP_SECRET;
  // Tokens do Instagram Login (IGAA) são validados pelo graph.instagram.com —
  // o endpoint debug_token do FB Graph não reconhece esses tokens e retorna is_valid=false
  // mesmo com o token ainda válido.
  if (isIGToken(token)) {
    const res  = await fetch(`${GRAPH_IG}/me?fields=id&access_token=${token}`);
    const data = await res.json();
    if (data.error) return { is_valid: false, error_code: data.error.code, error_message: data.error.message };
    return { is_valid: true, type: "INSTAGRAM", expires_at: 0, scopes: [] };
  }
  const res  = await fetch(
    `${GRAPH}/debug_token?input_token=${token}&access_token=${APP_ID}|${APP_SECRET}`
  );
  const data = await res.json();
  return data.data || data;
}

async function refreshToken(token) {
  const APP_ID     = process.env.META_APP_ID;
  const APP_SECRET = process.env.META_APP_SECRET;
  // Tokens do Instagram Login renovam via graph.instagram.com/refresh_access_token —
  // o fb_exchange_token do FB Graph não funciona com tokens IGAA.
  if (isIGToken(token)) {
    const res  = await fetch(
      `${GRAPH_IG}/refresh_access_token?grant_type=ig_refresh_token&access_token=${token}`
    );
    return res.json();
  }
  const res  = await fetch(
    `${GRAPH}/oauth/access_token?grant_type=fb_exchange_token&client_id=${APP_ID}&client_secret=${APP_SECRET}&fb_exchange_token=${token}`
  );
  return res.json();
}

export default async function handler() {
  console.log("[auto-refresh-tokens] Iniciando às", new Date().toISOString());

  const store       = getAccountsStore();
  const { blobs }   = await store.list();
  const results     = [];
  let   renewed     = 0;
  let   alreadyOk   = 0;
  let   expired     = 0;
  let   errors      = 0;

  for (const { key } of blobs) {
    let acc;
    try { acc = await store.get(key, { type: "json" }); } catch { continue; }
    if (!acc?.id || !acc?.access_token) continue;

    try {
      // 1. Verificar estado atual do token
      const debug    = await debugToken(acc.access_token);
      const isValid  = debug.is_valid === true;
      const daysLeft = debug.expires_at && debug.expires_at > 0
        ? Math.round((debug.expires_at * 1000 - Date.now()) / 86_400_000)
        : null; // null = nunca expira (token de página permanente)

      if (!isValid) {
        // Token inválido segundo debug_token — tenta refresh antes de desistir.
        // Isso cobre o caso de revogação por rate limit: o debug retorna is_valid=false
        // mas o token ainda pode ser trocado por um novo via fb_exchange_token.
        console.log(`[auto-refresh-tokens] @${acc.username} token inválido — tentando refresh antes de marcar expired`);
        const refreshed = await refreshToken(acc.access_token);
        if (refreshed.access_token) {
          await store.setJSON(key, {
            ...acc,
            access_token:       refreshed.access_token,
            token_status:       "valid",
            token_refreshed_at: new Date().toISOString(),
            token_expires_in:   refreshed.expires_in,
            updated_at:         new Date().toISOString(),
          });
          results.push({ username: acc.username, status: "recovered", expires_in: refreshed.expires_in });
          renewed++;
          console.log(`[auto-refresh-tokens] ✅ @${acc.username} recuperado via refresh`);
        } else {
          // Refresh também falhou — agora sim marca como expirado definitivamente
          await store.setJSON(key, { ...acc, token_status: "expired", updated_at: new Date().toISOString() });
          results.push({ username: acc.username, status: "expired", refresh_error: refreshed.error });
          expired++;
          console.warn(`[auto-refresh-tokens] ❌ @${acc.username} expirado definitivamente (refresh falhou: ${JSON.stringify(refreshed.error)})`);
        }
        continue;
      }

      // Tokens que nunca expiram (expires_at === 0, tipo Page Token do FB) não precisam de renovação.
      // EXCEÇÃO: tokens do Instagram Login (IGAA) também retornam expires_at=0 porque o IG Graph não
      // expõe o campo — mas eles expiram em 60 dias. Por isso sempre renovamos tokens IGAA mesmo com
      // daysLeft === null, em vez de pular o refresh.
      if (daysLeft === null && !isIGToken(acc.access_token)) {
        await store.setJSON(key, { ...acc, token_status: "valid", updated_at: new Date().toISOString() });
        results.push({ username: acc.username, status: "never_expires" });
        alreadyOk++;
        continue;
      }

      // 2. Renovar se faltar menos de 30 dias (ou proativamente sempre)
      // Meta recomenda renovar sempre que possível — tokens de página podem ser estendidos indefinidamente
      const refreshed = await refreshToken(acc.access_token);

      if (refreshed.access_token) {
        await store.setJSON(key, {
          ...acc,
          access_token:        refreshed.access_token,
          token_status:        "valid",
          token_refreshed_at:  new Date().toISOString(),
          token_expires_in:    refreshed.expires_in,
          updated_at:          new Date().toISOString(),
        });
        results.push({
          username:   acc.username,
          status:     "renewed",
          expires_in: refreshed.expires_in,
          days_left:  daysLeft,
        });
        renewed++;
        console.log(`[auto-refresh-tokens] ✅ @${acc.username} renovado (era ${daysLeft} dias restantes)`);
      } else {
        results.push({ username: acc.username, status: "refresh_failed", error: refreshed.error });
        errors++;
      }

    } catch (err) {
      results.push({ username: acc.username, status: "error", error: err.message });
      errors++;
    }
  }

  const summary = { renewed, already_ok: alreadyOk, expired, errors, total: blobs.length };
  console.log("[auto-refresh-tokens] Concluído:", summary);

  return new Response(JSON.stringify({ summary, results }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// Roda toda segunda-feira às 9h UTC
// Para mudar: https://crontab.guru
export const config = {
  schedule: "0 9 * * 1",
};
