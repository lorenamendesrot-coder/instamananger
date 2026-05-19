// drive-browse.mjs
// Lista pastas e vídeos do Google Drive via OAuth do usuário.
// O token é enviado pelo frontend no header Authorization.
//
// GET  /api/drive-browse?folder=root       → lista pasta raiz
// GET  /api/drive-browse?folder=FOLDER_ID  → lista subpasta
// POST /api/drive-browse                   → renova access_token com refresh_token
//   body: { refresh_token: "..." }
//   retorna: { access_token, expires_in, obtained_at }

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || process.env.URL || "";

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGIN ? (origin === ALLOWED_ORIGIN ? ALLOWED_ORIGIN : origin) : "*";
  return {
    "Access-Control-Allow-Origin":  allowed,
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type":                 "application/json",
    ...(allowed !== "*" && { Vary: "Origin" }),
  };
}

const VIDEO_MIMES = [
  "video/mp4", "video/quicktime", "video/x-msvideo",
  "video/x-matroska", "video/webm", "video/3gpp",
];

const CSV_MIMES = [
  "text/csv", "text/plain", "application/csv",
  "application/vnd.ms-excel",
  // xlsx
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel.sheet.macroEnabled.12",
];

const ALL_MIMES = [...VIDEO_MIMES, ...CSV_MIMES];

async function listFolder(token, folderId) {
  const q = `'${folderId}' in parents and trashed = false and (mimeType = 'application/vnd.google-apps.folder' or ${ALL_MIMES.map((m) => `mimeType = '${m}'`).join(" or ")})`;

  const params = new URLSearchParams({
    q,
    fields:   "files(id,name,mimeType,size,thumbnailLink,videoMediaMetadata,modifiedTime)",
    orderBy:  "name",
    pageSize: "200",
  });

  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    // 401 = token expirado
    if (res.status === 401) throw Object.assign(new Error("token_expired"), { tokenExpired: true });
    throw new Error(err.error?.message || `Drive API ${res.status}`);
  }

  const data    = await res.json();
  const folders = [];
  const videos  = [];
  const csvs    = [];

  for (const f of data.files || []) {
    if (f.mimeType === "application/vnd.google-apps.folder") {
      folders.push({ id: f.id, name: f.name, type: "folder" });
    } else if (CSV_MIMES.includes(f.mimeType) || f.name.toLowerCase().endsWith(".csv") || f.name.toLowerCase().endsWith(".xlsx") || f.name.toLowerCase().endsWith(".xls")) {
      csvs.push({
        id:         f.id,
        name:       f.name,
        type:       "csv",
        mimeType:   f.mimeType,
        size:       parseInt(f.size || "0"),
        modifiedAt: f.modifiedTime,
      });
    } else {
      const dur = f.videoMediaMetadata?.durationMillis
        ? Math.round(f.videoMediaMetadata.durationMillis / 1000)
        : null;
      videos.push({
        id:         f.id,
        name:       f.name,
        type:       "video",
        mimeType:   f.mimeType,
        size:       parseInt(f.size || "0"),
        thumbnail:  f.thumbnailLink || null,
        duration:   dur,
        modifiedAt: f.modifiedTime,
        url: `https://drive.google.com/uc?export=download&id=${f.id}`,
      });
    }
  }

  return { folders, videos, csvs };
}

async function getFolderName(token, folderId) {
  if (folderId === "root") return "Meu Drive";
  const res  = await fetch(
    `https://www.googleapis.com/drive/v3/files/${folderId}?fields=id,name`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json().catch(() => ({}));
  return data.name || folderId;
}

// Renova o access_token usando o refresh_token (Client Credentials do servidor)
async function refreshAccessToken(refreshToken) {
  const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
  const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET não configurados");
  }

  const res  = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type:    "refresh_token",
      refresh_token: refreshToken,
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });

  const data = await res.json();
  if (!data.access_token) {
    throw new Error(data.error_description || data.error || "Falha ao renovar token");
  }

  return {
    access_token: data.access_token,
    expires_in:   data.expires_in || 3600,
    obtained_at:  Date.now(),
  };
}

// ─── Handler ──────────────────────────────────────────────────────────────────
export default async function handler(req) {
  const origin  = req.headers.get?.("origin") || "";
  const headers = corsHeaders(origin);

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });

  function json(data, status = 200) {
    return new Response(JSON.stringify(data), { status, headers });
  }

  // POST → renova token
  if (req.method === "POST") {
    try {
      const body         = await req.json();
      const refreshToken = body?.refresh_token;
      if (!refreshToken) return json({ error: "refresh_token obrigatório" }, 400);
      const tokenData = await refreshAccessToken(refreshToken);
      return json(tokenData);
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  }

  // GET → lista pasta do Drive
  const authHeader = req.headers.get?.("authorization") || "";
  const token      = authHeader.replace(/^Bearer\s+/i, "").trim();

  if (!token) {
    return json({ error: "not_connected", message: "Conecte seu Google Drive primeiro." }, 401);
  }

  const url      = new URL(req.url);
  const folderId = url.searchParams.get("folder") || "root";

  try {
    const folderName = await getFolderName(token, folderId);
    const { folders, videos, csvs } = await listFolder(token, folderId);
    return json({ folderId, folderName, folders, videos, csvs, total: folders.length + videos.length + csvs.length });
  } catch (err) {
    if (err.tokenExpired) {
      return json({ error: "token_expired", message: "Sessão do Drive expirada. Reconecte." }, 401);
    }
    console.error("[drive-browse]", err.message);
    return json({ error: err.message }, 500);
  }
}
