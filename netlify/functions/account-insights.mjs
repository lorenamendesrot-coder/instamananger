// account-insights.mjs — versão mínima: só busca perfil básico (username, foto, followers)
// Usado para sincronizar dados das contas. Sem métricas de insights.

const GRAPH_FB = "https://graph.facebook.com/v21.0";
const GRAPH_IG = "https://graph.instagram.com";

function isIGToken(token) { return token?.startsWith("IGAA"); }
function graphBase(token) { return isIGToken(token) ? GRAPH_IG + "/" : GRAPH_FB + "/"; }

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || process.env.URL || "";

function corsHeaders(req) {
  const origin = (req?.headers?.get ? req.headers.get("origin") : req?.headers?.origin) || "";
  const allow  = ALLOWED_ORIGIN && origin === ALLOWED_ORIGIN ? ALLOWED_ORIGIN : (ALLOWED_ORIGIN ? "" : "*");
  return {
    "Access-Control-Allow-Origin":  allow,
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type":                 "application/json",
  };
}

function json(data, status = 200, req = null) {
  return new Response(JSON.stringify(data), { status, headers: corsHeaders(req) });
}

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(req) });
  if (req.method !== "POST") return json({ error: "Método não permitido" }, 405, req);

  let body;
  try { body = await req.json(); } catch { return json({ error: "Body inválido" }, 400, req); }

  const { instagram_id, access_token } = body || {};
  if (!instagram_id || !access_token) return json({ error: "instagram_id e access_token são obrigatórios" }, 400, req);

  try {
    const url = `${graphBase(access_token)}${instagram_id}?fields=username,name,profile_picture_url,followers_count,media_count&access_token=${access_token}`;
    const res  = await fetch(url);
    const data = await res.json();

    if (data.error) return json({ error: data.error.message }, 400, req);

    return json({
      username:         data.username        || null,
      name:             data.name            || null,
      profile_picture:  data.profile_picture_url || null,
      followers_count:  data.followers_count ?? null,
      media_count:      data.media_count     ?? null,
    }, 200, req);
  } catch (err) {
    return json({ error: err.message }, 500, req);
  }
}
