// drive-proxy.mjs
// Baixa um vídeo do Google Drive usando o token OAuth do usuário
// e armazena no Netlify Blobs como URL pública temporária.
//
// O Instagram não consegue baixar diretamente do Drive (redireciona
// para tela de confirmação ou exige cookies). Este proxy resolve isso:
// o Netlify autentica no Drive com o token do usuário, baixa o arquivo,
// e serve uma URL pública que a API da Meta consegue acessar.
//
// POST /api/drive-proxy
//   body: { file_id, file_name, access_token }
//   retorna: { url, blob_key, size, expires_at }
//
// GET  /api/drive-proxy?key=BLOB_KEY
//   Serve o vídeo diretamente (usado como URL pública para a Meta)

import { getStore } from "@netlify/blobs";

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || process.env.URL || "";
const SITE_URL       = process.env.URL || process.env.NETLIFY_URL || "";

// Vídeos ficam disponíveis por 2 horas — suficiente para o Instagram processar
const TTL_MS = 2 * 60 * 60 * 1000;

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGIN && origin === ALLOWED_ORIGIN ? ALLOWED_ORIGIN : ALLOWED_ORIGIN || "*";
  return {
    "Access-Control-Allow-Origin":  allowed,
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type":                 "application/json",
    ...(allowed !== "*" && { Vary: "Origin" }),
  };
}

function getVideoStore() {
  const siteID = process.env.NETLIFY_SITE_ID;
  const token  = process.env.NETLIFY_TOKEN;
  if (!siteID || !token) throw new Error("Configure NETLIFY_SITE_ID e NETLIFY_TOKEN");
  return getStore({ name: "drive-videos", siteID, token, consistency: "strong" });
}

// ─── Baixa vídeo do Drive com OAuth ──────────────────────────────────────────
async function downloadFromDrive(fileId, accessToken) {
  // Tenta primeiro o endpoint de download direto via API (mais confiável que uc?export)
  const apiUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;

  console.log(`[drive-proxy] baixando fileId=${fileId} via Drive API`);

  const res = await fetch(apiUrl, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!res.ok) {
    const err = await res.text().catch(() => "");
    // 401 = token expirado
    if (res.status === 401) throw Object.assign(new Error("token_expired"), { tokenExpired: true });
    // 403 = sem permissão
    if (res.status === 403) throw new Error("Sem permissão para acessar este arquivo. Verifique se o arquivo pertence à conta conectada.");
    throw new Error(`Drive API retornou ${res.status}: ${err.slice(0, 200)}`);
  }

  const contentType   = res.headers.get("content-type") || "video/mp4";
  const contentLength = res.headers.get("content-length");
  const sizeBytes     = contentLength ? parseInt(contentLength) : null;

  // Valida tamanho (Meta aceita até 1GB para Reels)
  if (sizeBytes && sizeBytes > 1_000_000_000) {
    throw new Error(`Arquivo muito grande: ${(sizeBytes / 1e6).toFixed(0)}MB. Máximo: 1GB.`);
  }

  console.log(`[drive-proxy] baixando ${sizeBytes ? `${(sizeBytes / 1e6).toFixed(1)}MB` : "tamanho desconhecido"} (${contentType})`);

  const buffer = await res.arrayBuffer();
  return { buffer, contentType, sizeBytes: buffer.byteLength };
}

// ─── Handler ──────────────────────────────────────────────────────────────────
export default async function handler(req) {
  const origin  = req.headers.get?.("origin") || "";
  const headers = corsHeaders(origin);

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });

  function json(data, status = 200) {
    return new Response(JSON.stringify(data), { status, headers });
  }

  // ── GET — serve vídeo pelo blob key ────────────────────────────────────────
  if (req.method === "GET") {
    const url    = new URL(req.url);
    const key    = url.searchParams.get("key");
    if (!key) return json({ error: "key obrigatório" }, 400);

    try {
      const store = getVideoStore();
      const blob  = await store.get(key, { type: "arrayBuffer" });
      if (!blob) return new Response("Vídeo não encontrado ou expirado", { status: 404 });

      // Serve o vídeo com headers corretos para a API da Meta
      return new Response(blob, {
        status: 200,
        headers: {
          "Content-Type":              "video/mp4",
          "Content-Length":            String(blob.byteLength),
          "Access-Control-Allow-Origin": "*",
          "Cache-Control":             "public, max-age=7200",
          "Accept-Ranges":             "bytes",
        },
      });
    } catch (err) {
      console.error("[drive-proxy] GET erro:", err.message);
      return json({ error: err.message }, 500);
    }
  }

  // ── POST — baixa do Drive e armazena ───────────────────────────────────────
  if (req.method === "POST") {
    let body;
    try { body = await req.json(); }
    catch { return json({ error: "JSON inválido" }, 400); }

    const { file_id, file_name, access_token } = body;

    if (!file_id)      return json({ error: "file_id obrigatório" }, 400);
    if (!access_token) return json({ error: "access_token obrigatório — conecte o Drive" }, 400);

    try {
      const store = getVideoStore();

      // Chave única por arquivo — reutiliza se já foi baixado recentemente
      const blobKey    = `video-${file_id}`;
      const metaKey    = `meta-${file_id}`;

      // Verifica se já existe e ainda está válido (< 1h30 de vida)
      try {
        const existing = await store.get(metaKey, { type: "json" });
        if (existing?.expires_at && Date.now() < existing.expires_at - 30 * 60 * 1000) {
          console.log(`[drive-proxy] reutilizando blob existente para ${file_id}`);
          return json({
            url:        existing.url,
            blob_key:   blobKey,
            size:       existing.size,
            expires_at: existing.expires_at,
            cached:     true,
          });
        }
      } catch {
        // Não existe ainda — segue para baixar
      }

      // Baixa do Drive
      const { buffer, contentType, sizeBytes } = await downloadFromDrive(file_id, access_token);

      // Salva no Netlify Blobs
      await store.set(blobKey, buffer, {
        metadata: {
          file_name:    file_name || file_id,
          content_type: contentType,
          uploaded_at:  new Date().toISOString(),
        },
      });

      // URL pública que a API da Meta vai usar
      const proxyUrl  = `${SITE_URL}/.netlify/functions/drive-proxy?key=${blobKey}`;
      const expiresAt = Date.now() + TTL_MS;

      // Salva metadados para reutilização
      await store.setJSON(metaKey, {
        url:        proxyUrl,
        size:       sizeBytes,
        expires_at: expiresAt,
        file_name:  file_name || file_id,
        uploaded_at: new Date().toISOString(),
      });

      console.log(`[drive-proxy] ✅ ${file_name} (${(sizeBytes / 1e6).toFixed(1)}MB) salvo como ${blobKey}`);

      return json({
        url:        proxyUrl,
        blob_key:   blobKey,
        size:       sizeBytes,
        expires_at: expiresAt,
        cached:     false,
      });

    } catch (err) {
      console.error("[drive-proxy] POST erro:", err.message);
      const status = err.tokenExpired ? 401 : 500;
      return json({ error: err.message, token_expired: !!err.tokenExpired }, status);
    }
  }

  return json({ error: "Método não permitido" }, 405);
}
