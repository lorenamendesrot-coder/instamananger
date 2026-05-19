// drive-auth.mjs — Callback OAuth do Google Drive
// GET  /api/drive-auth           → redireciona para o login Google
// GET  /api/drive-auth?code=...  → troca o code por access_token + refresh_token
//                                  e manda para o popup pai via postMessage
//
// Variáveis de ambiente necessárias:
//   GOOGLE_CLIENT_ID     — Client ID do OAuth 2.0 (Google Cloud Console)
//   GOOGLE_CLIENT_SECRET — Client Secret

const SCOPES = "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file";

function getRedirectUri(origin) {
  // Usa a origem real da requisição para montar o redirect_uri
  return `${origin}/api/drive-auth`;
}

export default async function handler(req) {
  const url    = new URL(req.url);
  const origin = url.origin;

  const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
  const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

  if (!CLIENT_ID || !CLIENT_SECRET) {
    return htmlPage("Configuração incompleta", `
      <p>Configure as variáveis de ambiente <code>GOOGLE_CLIENT_ID</code> e
      <code>GOOGLE_CLIENT_SECRET</code> no Netlify.</p>
      <p>Crie um OAuth 2.0 Client ID em <a href="https://console.cloud.google.com/apis/credentials" target="_blank">Google Cloud Console</a>
      e adicione <code>${origin}/api/drive-auth</code> como URI de redirecionamento autorizado.</p>
    `, "error");
  }

  const redirect_uri = getRedirectUri(origin);
  const code         = url.searchParams.get("code");
  const error        = url.searchParams.get("error");

  // ── Etapa 2: recebeu o code, troca por token ────────────────────────────
  if (code) {
    try {
      const res  = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id:     CLIENT_ID,
          client_secret: CLIENT_SECRET,
          redirect_uri,
          grant_type:    "authorization_code",
        }),
      });

      const data = await res.json();

      if (data.error || !data.access_token) {
        throw new Error(data.error_description || data.error || "Token inválido");
      }

      // Envia token para a janela pai via postMessage e fecha o popup
      return htmlPage("Google Drive conectado!", `
        <p style="color:#4ade80;font-size:18px">✅ Drive conectado! Fechando...</p>
        <script>
          const token = ${JSON.stringify({
            access_token:  data.access_token,
            refresh_token: data.refresh_token || null,
            expires_in:    data.expires_in    || 3600,
            token_type:    data.token_type    || "Bearer",
            obtained_at:   Date.now(),
          })};
          if (window.opener) {
            window.opener.postMessage({ type: "DRIVE_TOKEN", token }, window.location.origin);
            setTimeout(() => window.close(), 500);
          } else {
            document.body.innerHTML += "<p>Feche esta janela e volte ao app.</p>";
          }
        <\/script>
      `);
    } catch (err) {
      return htmlPage("Erro na autenticação", `
        <p style="color:#f87171">${err.message}</p>
        <script>
          if (window.opener) {
            window.opener.postMessage({ type: "DRIVE_ERROR", error: ${JSON.stringify(err.message)} }, window.location.origin);
            setTimeout(() => window.close(), 1500);
          }
        <\/script>
      `, "error");
    }
  }

  // Usuário negou o acesso
  if (error) {
    return htmlPage("Acesso negado", `
      <p style="color:#f87171">Você negou o acesso ao Google Drive.</p>
      <script>
        if (window.opener) {
          window.opener.postMessage({ type: "DRIVE_ERROR", error: "access_denied" }, window.location.origin);
          setTimeout(() => window.close(), 1000);
        }
      <\/script>
    `, "error");
  }

  // ── Etapa 1: redireciona para o login Google ────────────────────────────
  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id",     CLIENT_ID);
  authUrl.searchParams.set("redirect_uri",  redirect_uri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope",         SCOPES);
  authUrl.searchParams.set("access_type",   "offline");   // pede refresh_token
  authUrl.searchParams.set("prompt",        "consent");   // força re-consent para garantir refresh_token

  return Response.redirect(authUrl.toString(), 302);
}

// ─── Helper: página HTML mínima ───────────────────────────────────────────────
function htmlPage(title, body, type = "ok") {
  const bg    = type === "error" ? "#1a0a0a" : "#0a1a0a";
  const color = "#e2e8f0";
  return new Response(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title} — Insta Manager</title>
  <style>
    body { margin: 0; display: flex; align-items: center; justify-content: center;
           min-height: 100vh; background: ${bg}; color: ${color};
           font-family: -apple-system, BlinkMacSystemFont, sans-serif; text-align: center; padding: 24px; }
    code { background: rgba(255,255,255,0.1); padding: 2px 6px; border-radius: 4px; font-size: 13px; }
    a    { color: #818cf8; }
    p    { margin: 8px 0; font-size: 15px; line-height: 1.5; }
  </style>
</head>
<body>
  <div><h2 style="margin:0 0 16px">${title}</h2>${body}</div>
</body>
</html>`, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
