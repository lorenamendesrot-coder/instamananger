// netlify/functions/accounts.mjs
// CRUD de contas — usa Netlify Blobs com configuração explícita via env vars
//
// Variáveis necessárias no painel do Netlify (Site settings > Environment variables):
//   NETLIFY_SITE_ID  → Settings > General > Site ID  (ex: abc123-...)
//   NETLIFY_TOKEN    → User settings > Applications > Personal access tokens

import { getStore } from "@netlify/blobs";

const STORE_NAME = "insta-accounts";

function getAccountsStore() {
  const siteID = process.env.NETLIFY_SITE_ID;
  const token  = process.env.NETLIFY_TOKEN;

  if (!siteID || !token) {
    throw new Error(
      "Configure as variáveis NETLIFY_SITE_ID e NETLIFY_TOKEN no painel do Netlify " +
      "(Site settings > Environment variables)"
    );
  }

  return getStore({ name: STORE_NAME, siteID, token, consistency: "strong" });
}

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "";

function corsHeaders(origin) {
  const corsOrigin = ALLOWED_ORIGIN ? ALLOWED_ORIGIN : "*";
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin":  corsOrigin,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    ...(corsOrigin !== "*" ? { "Vary": "Origin" } : {}),
  };
}

// Processa um array em lotes de `limit` em paralelo — evita burst de requests ao Blobs
async function mapConcurrent(arr, fn, limit = 10) {
  const results = [];
  for (let i = 0; i < arr.length; i += limit) {
    const batch = await Promise.all(arr.slice(i, i + limit).map(fn));
    results.push(...batch);
  }
  return results;
}

export const handler = async (event) => {
  const origin = event.headers?.origin || "";
  const HEADERS = corsHeaders(origin);

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: HEADERS, body: "" };

  try {
    const store = getAccountsStore();

    // GET — listar todas (máx 10 fetches simultâneos para não estourar rate limit do Blobs)
    if (event.httpMethod === "GET") {
      const { blobs } = await store.list();
      const accounts = (
        await mapConcurrent(blobs, async ({ key }) => {
          try { return await store.get(key, { type: "json" }); }
          catch { return null; }
        }, 10)
      ).filter(Boolean);
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ accounts }) };
    }

    // POST — salvar/atualizar (rejeita contas sem access_token)
    if (event.httpMethod === "POST") {
      const body = JSON.parse(event.body || "{}");
      const accs = Array.isArray(body) ? body : (body.accounts || [body]);
      const invalid = accs.filter(a => a?.id && !a?.access_token).map(a => a.id);
      if (invalid.length) {
        console.warn("[accounts] POST rejeitado — contas sem access_token:", invalid);
        return {
          statusCode: 400,
          headers: HEADERS,
          body: JSON.stringify({ error: `Contas sem access_token: ${invalid.join(", ")}` }),
        };
      }
      for (const acc of accs) {
        if (!acc?.id) continue;
        await store.setJSON(`account-${acc.id}`, { ...acc, updated_at: new Date().toISOString() });
      }
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ ok: true, saved: accs.length }) };
    }

    // DELETE — remover por id
    if (event.httpMethod === "DELETE") {
      const id = event.queryStringParameters?.id;
      if (!id) return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: "id obrigatório" }) };
      await store.delete(`account-${id}`);
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: "Método não permitido" }) };

  } catch (err) {
    console.error("accounts.mjs error:", err);
    const origin2 = event.headers?.origin || "";
    return { statusCode: 500, headers: corsHeaders(origin2), body: JSON.stringify({ error: err.message }) };
  }
};
