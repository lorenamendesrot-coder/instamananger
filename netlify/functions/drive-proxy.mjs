// drive-proxy.mjs
// Baixa um vídeo do Google Drive usando refresh_token (não expira)
// e armazena no Netlify Blobs, retornando uma URL pública permanente.
//
// Funciona para loops: cada rodada chama o proxy, que re-baixa o vídeo
// com um access_token renovado a partir do refresh_token salvo.
//
// POST /api/drive-proxy
//   body: { file_id, file_name, refresh_token }
//   retorna: { url, blob_key, size }
//
// GET  /api/drive-proxy?key=BLOB_KEY
//   Serve o vídeo diretamente para a API da Meta

import { getStore } from "@netlify/blobs";

const ALLOWED_ORIGIN  = process.env.ALLOWED_ORIGIN || process.env.URL || "";
const SITE_URL        = process.env.URL || process.env.NETLIFY_URL || "";
const CLIENT_ID       = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET   = process.env.GOOGLE_CLIENT_SECRET;

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGIN && origin === ALLOWED_ORIGIN ? ALLOWED_ORIGIN : ALLOWED_ORIGIN || "*";
  return {
    "Access-Control-Allow-Origin":  allowed,
    "Access-Control-Allow-Headers": "Content-Type",
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

async function renewAccessToken(refreshToken) {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET nao configurados no Netlify");
  }
  const res  = await fetch("https://oauth2.googleapis.com/token", {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:    new URLSearchParams({
      grant_type:    "refresh_token",
      refresh_token: refreshToken,
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });
  const data = await res.json();
  if (!data.access_token) {
    throw new Error(data.error_description || data.error || "Falha ao renovar token do Drive");
  }
  return data.access_token;
}

async function downloadFromDrive(fileId, accessToken) {
  const apiUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
  console.log(`[drive-proxy] baixando fileId=${fileId}`);

  const res = await fetch(apiUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    if (res.status === 401) throw new Error("Token do Drive invalido. Reconecte o Drive no app.");
    if (res.status === 403) throw new Error("Sem permissao para acessar este arquivo no Drive.");
    if (res.status === 404) throw new Error("Arquivo nao encontrado no Drive. Foi deletado?");
    throw new Error(`Drive API retornou ${res.status}`);
  }

  const sizeHeader = res.headers.get("content-length");
  const sizeBytes  = sizeHeader ? parseInt(sizeHeader) : null;
  if (sizeBytes && sizeBytes > 1_073_741_824) {
    throw new Error(`Arquivo muito grande: ${(sizeBytes / 1e6).toFixed(0)}MB (max 1GB)`);
  }

  console.log(`[drive-proxy] ${sizeBytes ? (sizeBytes / 1e6).toFixed(1) + "MB" : "tamanho desconhecido"}`);
  const buffer = await res.arrayBuffer();
  return { buffer, sizeBytes: buffer.byteLength };
}

export default async function handler(req) {
  const origin  = req.headers.get?.("origin") || "";
  const headers = corsHeaders(origin);

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });

  function json(data, status = 200) {
    return new Response(JSON.stringify(data), { status, headers });
  }

  // GET — serve o video para a API da Meta
  if (req.method === "GET") {
    const key = new URL(req.url).searchParams.get("key");
    if (!key) return json({ error: "key obrigatorio" }, 400);
    try {
      const store  = getVideoStore();
      const buffer = await store.get(key, { type: "arrayBuffer" });
      if (!buffer) return new Response("Video nao encontrado", { status: 404 });
      return new Response(buffer, {
        status: 200,
        headers: {
          "Content-Type":                "video/mp4",
          "Content-Length":              String(buffer.byteLength),
          "Access-Control-Allow-Origin": "*",
          "Cache-Control":               "public, max-age=86400",
          "Accept-Ranges":               "bytes",
        },
      });
    } catch (err) {
      console.error("[drive-proxy] GET erro:", err.message);
      return new Response("Erro ao servir video", { status: 500 });
    }
  }

  // POST — baixa do Drive e armazena (chamado pelo DrivePicker E pelo scheduler no loop)
  if (req.method === "POST") {
    let body;
    try { body = await req.json(); }
    catch { return json({ error: "JSON invalido" }, 400); }

    const { file_id, file_name, refresh_token } = body;

    if (!file_id)       return json({ error: "file_id obrigatorio" }, 400);
    if (!refresh_token) return json({ error: "refresh_token obrigatorio" }, 400);

    try {
      const accessToken           = await renewAccessToken(refresh_token);
      const { buffer, sizeBytes } = await downloadFromDrive(file_id, accessToken);

      const store   = getVideoStore();
      const blobKey = `video-${file_id}`;
      await store.set(blobKey, buffer, {
        metadata: {
          file_name:   file_name || file_id,
          uploaded_at: new Date().toISOString(),
          size:        String(sizeBytes),
        },
      });

      const proxyUrl = `${SITE_URL}/.netlify/functions/drive-proxy?key=${blobKey}`;
      console.log(`[drive-proxy] OK ${file_name || file_id} (${(sizeBytes / 1e6).toFixed(1)}MB) -> ${proxyUrl}`);
      return json({ url: proxyUrl, blob_key: blobKey, size: sizeBytes });

    } catch (err) {
      console.error("[drive-proxy] POST erro:", err.message);
      return json({ error: err.message }, 500);
    }
  }

  return json({ error: "Metodo nao permitido" }, 405);
}
