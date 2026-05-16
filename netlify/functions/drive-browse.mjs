// drive-browse.mjs
// Lista pastas e vídeos do Google Drive via Service Account.
// GET  /api/drive-browse?folder=root       → lista pasta raiz
// GET  /api/drive-browse?folder=FOLDER_ID  → lista subpasta

import { webcrypto } from "node:crypto";
const crypto = globalThis.crypto ?? webcrypto;

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || process.env.URL || "";

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGIN && origin === ALLOWED_ORIGIN ? ALLOWED_ORIGIN : ALLOWED_ORIGIN || "*";
  return {
    "Access-Control-Allow-Origin":  allowed,
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type":                 "application/json",
    ...(allowed !== "*" && { Vary: "Origin" }),
  };
}

// ─── JWT / Service Account ────────────────────────────────────────────────────

// Cria JWT assinado com RS256 para autenticar a Service Account
async function createJWT(serviceAccount) {
  const now = Math.floor(Date.now() / 1000);
  const header  = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss:   serviceAccount.client_email,
    scope: "https://www.googleapis.com/auth/drive.readonly",
    aud:   "https://oauth2.googleapis.com/token",
    iat:   now,
    exp:   now + 3600,
  };

  const b64 = (obj) => btoa(JSON.stringify(obj))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");

  const unsigned = `${b64(header)}.${b64(payload)}`;

  // Importa a chave privada PEM da Service Account
  const pemBody = serviceAccount.private_key
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");

  const keyData = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8", keyData.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false, ["sign"]
  );

  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(unsigned)
  );

  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");

  return `${unsigned}.${sigB64}`;
}

async function getAccessToken(serviceAccount) {
  const jwt = await createJWT(serviceAccount);
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion:  jwt,
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`Auth falhou: ${data.error_description || data.error}`);
  return data.access_token;
}

// ─── Drive API ────────────────────────────────────────────────────────────────

const VIDEO_MIMES = [
  "video/mp4", "video/quicktime", "video/x-msvideo",
  "video/x-matroska", "video/webm", "video/3gpp",
];

async function listFolder(token, folderId) {
  const q = `'${folderId}' in parents and trashed = false and (mimeType = 'application/vnd.google-apps.folder' or ${VIDEO_MIMES.map((m) => `mimeType = '${m}'`).join(" or ")})`;

  const params = new URLSearchParams({
    q,
    fields: "files(id,name,mimeType,size,thumbnailLink,videoMediaMetadata,modifiedTime)",
    orderBy: "name",
    pageSize: "200",
  });

  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `Drive API ${res.status}`);
  }

  const data = await res.json();

  const folders = [];
  const videos  = [];

  for (const f of data.files || []) {
    if (f.mimeType === "application/vnd.google-apps.folder") {
      folders.push({ id: f.id, name: f.name, type: "folder" });
    } else {
      const dur = f.videoMediaMetadata?.durationMillis
        ? Math.round(f.videoMediaMetadata.durationMillis / 1000)
        : null;
      videos.push({
        id:          f.id,
        name:        f.name,
        type:        "video",
        mimeType:    f.mimeType,
        size:        parseInt(f.size || "0"),
        thumbnail:   f.thumbnailLink || null,
        duration:    dur,
        modifiedAt:  f.modifiedTime,
        // URL de download direto — o publish.mjs já sabe lidar com este formato
        url: `https://drive.google.com/uc?export=download&id=${f.id}`,
      });
    }
  }

  return { folders, videos };
}

// Retorna o nome da pasta para montar o breadcrumb
async function getFolderName(token, folderId) {
  if (folderId === "root") return "Meu Drive";
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${folderId}?fields=id,name`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json().catch(() => ({}));
  return data.name || folderId;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export default async function handler(req) {
  const origin  = req.headers.get?.("origin") || "";
  const headers = corsHeaders(origin);

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });

  function json(data, status = 200) {
    return new Response(JSON.stringify(data), { status, headers });
  }

  // Lê a Service Account do env var GOOGLE_SERVICE_ACCOUNT (JSON completo em base64 ou raw)
  const saRaw = process.env.GOOGLE_SERVICE_ACCOUNT;
  if (!saRaw) {
    return json({ error: "GOOGLE_SERVICE_ACCOUNT não configurado nas variáveis de ambiente do Netlify." }, 500);
  }

  let serviceAccount;
  try {
    // Aceita tanto JSON puro quanto JSON em base64
    const decoded = saRaw.startsWith("{") ? saRaw : atob(saRaw);
    serviceAccount = JSON.parse(decoded);
  } catch {
    return json({ error: "GOOGLE_SERVICE_ACCOUNT inválido. Deve ser o JSON da Service Account (ou em base64)." }, 500);
  }

  const url      = new URL(req.url);
  const folderId = url.searchParams.get("folder") || "root";

  try {
    const token      = await getAccessToken(serviceAccount);
    const folderName = await getFolderName(token, folderId);
    const { folders, videos } = await listFolder(token, folderId);

    return json({
      folderId,
      folderName,
      folders,
      videos,
      total: folders.length + videos.length,
    });
  } catch (err) {
    console.error("[drive-browse] Erro:", err.message);
    return json({ error: err.message }, 500);
  }
}
