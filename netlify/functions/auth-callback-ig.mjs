// auth-callback-ig.mjs — OAuth via Instagram Business Login
// Ref: https://developers.facebook.com/docs/instagram/platform/instagram-api/business-login
//
// Fluxo:
//   1. Frontend abre popup → www.instagram.com/oauth/authorize
//   2. Usuário autoriza
//   3. Instagram redireciona com ?code=...&state=popup
//   4. POST api.instagram.com/oauth/access_token  → token curto
//      Resposta: { "data": [{ "access_token": "...", "user_id": "..." }] }
//   5. GET graph.instagram.com/access_token?grant_type=ig_exchange_token → token longo
//   6. GET graph.instagram.com/me?fields=...&access_token=... → perfil
//   7. postMessage ao popup pai

const IG_AUTH  = "https://api.instagram.com";
const IG_GRAPH = "https://graph.instagram.com"; // sem versão — endpoints do IG Login não usam /v21.0

// Campos suportados pelo Instagram Business Login
// biography, website, follows_count podem não estar disponíveis dependendo das permissões
const IG_FIELDS = "id,username,name,profile_picture_url,followers_count,media_count";

async function apiFetch(url, options = {}) {
  const res  = await fetch(url, options);
  const data = await res.json();
  return data;
}

export const handler = async (event) => {
  const params  = event.queryStringParameters || {};
  const code    = params.code;
  const state   = params.state;
  const isPopup = state === "popup" || state === "popup_app2";
  const isApp2  = state === "popup_app2";

  if (params.error) {
    const reason = params.error_description || params.error || "Acesso negado";
    return respondWith({ error: reason }, isPopup, isApp2);
  }

  if (!code) {
    return respondWith({ error: "Código de autorização ausente" }, isPopup, isApp2);
  }

  const APP_ID     = isApp2
    ? (process.env.META_IG_APP_ID_2 || process.env.META_APP_ID_2 || process.env.META_IG_APP_ID || process.env.META_APP_ID)
    : (process.env.META_IG_APP_ID   || process.env.META_APP_ID);
  const APP_SECRET = isApp2
    ? (process.env.META_IG_APP_SECRET_2 || process.env.META_APP_SECRET_2 || process.env.META_IG_APP_SECRET || process.env.META_APP_SECRET)
    : (process.env.META_IG_APP_SECRET   || process.env.META_APP_SECRET);
  const REDIRECT_URI = isApp2
    ? (process.env.META_REDIRECT_URI_IG_2 || process.env.META_REDIRECT_URI_IG)
    : (process.env.META_REDIRECT_URI_IG || (process.env.URL ? process.env.URL + "/api/auth-callback-ig" : ""));

  if (!APP_ID || !APP_SECRET) {
    return respondWith({ error: "Configuração do app ausente (META_IG_APP_ID / META_IG_APP_SECRET)" }, isPopup, isApp2);
  }

  try {
    // ── 1. Trocar code por token curto ────────────────────────────────────
    const shortRes = await apiFetch(`${IG_AUTH}/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id:     APP_ID,
        client_secret: APP_SECRET,
        grant_type:    "authorization_code",
        redirect_uri:  REDIRECT_URI,
        code,
      }),
    });

    console.log("[auth-callback-ig] short token response:", JSON.stringify(shortRes));

    // Resposta pode ser { data: [{ access_token, user_id }] } ou { access_token } direto
    let shortToken, userId;
    if (shortRes.data && Array.isArray(shortRes.data) && shortRes.data[0]?.access_token) {
      shortToken = shortRes.data[0].access_token;
      userId     = shortRes.data[0].user_id;
    } else if (shortRes.access_token) {
      shortToken = shortRes.access_token;
      userId     = shortRes.user_id;
    } else {
      throw new Error(`Token curto falhou: ${shortRes.error_message || shortRes.error_type || JSON.stringify(shortRes)}`);
    }

    // ── 2. Trocar por token longo (60 dias) ───────────────────────────────
    // NOTA: A API do Instagram exige POST (não GET) para ig_exchange_token
    const longRes = await apiFetch(`${IG_GRAPH}/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type:    "ig_exchange_token",
        client_secret: APP_SECRET,
        access_token:  shortToken,
      }),
    });

    console.log("[auth-callback-ig] long token response:", JSON.stringify(longRes));

    const longToken = longRes.access_token || shortToken;
    const expiresIn = longRes.expires_in   || null;
    const expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null;

    // ── 3. Buscar perfil ──────────────────────────────────────────────────
    const profile = await apiFetch(
      `${IG_GRAPH}/me?fields=${IG_FIELDS}&access_token=${longToken}`
    );

    console.log("[auth-callback-ig] profile response:", JSON.stringify(profile));

    if (profile.error) {
      throw new Error(`Perfil: ${profile.error.message} (code: ${profile.error.code})`);
    }

    // Se for App2, salva como token_app2
    const tokenFields = isApp2
      ? { token_app2: longToken, token_app2_connected_at: new Date().toISOString() }
      : { access_token: longToken, token_expires_at: expiresAt, token_status: "active", added_via: "instagram_login" };

    const account = {
      id:               String(profile.id || userId),
      username:         profile.username        || "",
      name:             profile.name            || profile.username || "",
      biography:        profile.biography       || "",
      website:          profile.website         || "",
      profile_picture:  profile.profile_picture_url || "",
      account_type:     "BUSINESS",
      followers_count:  profile.followers_count ?? null,
      follows_count:    profile.follows_count   ?? null,
      media_count:      profile.media_count     ?? null,
      ...tokenFields,
      added_via:        "instagram_login",
      page_id:          null,
      page_name:        null,
      ...(isApp2 ? {} : { connected_at: new Date().toISOString() }),
    };

    return respondWith({ accounts: [account] }, isPopup, isApp2);

  } catch (err) {
    console.error("[auth-callback-ig] error:", err);
    return respondWith({ error: err.message }, isPopup, isApp2);
  }
};

function respondWith({ accounts, error }, isPopup, isApp2 = false) {
  if (isPopup) {
    const msgType = isApp2 ? "OAUTH_APP2_ACCOUNTS" : "OAUTH_ACCOUNTS";
    const payload = accounts
      ? JSON.stringify({ type: msgType, accounts })
      : JSON.stringify({ type: "OAUTH_ERROR", error: error || "Erro desconhecido" });

    const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Conectando...</title>
<style>
  body { font-family: system-ui, sans-serif; background: #0d0d12; color: #fff;
         display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
  .box { text-align: center; padding: 32px; }
  .ok   { font-size: 40px; margin-bottom: 12px; }
  h2    { font-size: 16px; margin: 0 0 6px; }
  p     { font-size: 13px; color: rgba(255,255,255,0.5); margin: 0; }
</style>
</head>
<body>
<div class="box">
  ${accounts
    ? `<div class="ok">✅</div>
       <h2>${isApp2 ? "App 2 vinculado!" : (accounts[0]?.username ? "@" + accounts[0].username : "Conta") + " conectada!"}</h2>
       <p>${isApp2 ? "Fallback automático ativo." : "Fechando automaticamente..."}</p>`
    : `<div class="ok">❌</div>
       <h2>Erro ao conectar</h2>
       <p>${error || "Tente novamente."}</p>`
  }
</div>
<script>
  try {
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage(${payload}, window.location.origin);
    }
  } catch(e) {}
  setTimeout(() => window.close(), ${accounts ? 1500 : 3000});
</script>
</body>
</html>`;

    return {
      statusCode: 200,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cross-Origin-Opener-Policy": "unsafe-none", "Cross-Origin-Embedder-Policy": "unsafe-none" },
      body: html,
    };
  }

  if (accounts) {
    const encoded = Buffer.from(JSON.stringify(accounts)).toString("base64url");
    return { statusCode: 302, headers: { Location: `/?accounts=${encoded}` } };
  }
  return { statusCode: 302, headers: { Location: `/?error=${encodeURIComponent(error)}` } };
}
