// drive-proxy-bg.mjs
// Background function (timeout 15min) para importar vídeos do Drive sem ERR_HTTP2
// POST /api/drive-proxy-bg  → retorna { job_id } imediatamente
// GET  /api/drive-proxy-bg?job_id=X → retorna { status, url?, error? }

import { getStore } from "@netlify/blobs";

const SITE_URL      = process.env.URL || process.env.NETLIFY_URL || "";
const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

function getVideoStore() {
  const siteID = process.env.NETLIFY_SITE_ID;
  const token  = process.env.NETLIFY_TOKEN;
  if (!siteID || !token) throw new Error("Configure NETLIFY_SITE_ID e NETLIFY_TOKEN");
  return getStore({ name: "drive-videos", siteID, token, consistency: "strong" });
}

function getJobStore() {
  const siteID = process.env.NETLIFY_SITE_ID;
  const token  = process.env.NETLIFY_TOKEN;
  if (!siteID || !token) throw new Error("Configure NETLIFY_SITE_ID e NETLIFY_TOKEN");
  return getStore({ name: "drive-jobs", siteID, token, consistency: "strong" });
}

async function renewAccessToken(refreshToken) {
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
  if (!data.access_token) throw new Error(data.error_description || "Falha ao renovar token");
  return data.access_token;
}

// Importa sanitizeMP4 e patchMoovAtoms inline (mesma lógica do drive-proxy.mjs)
function patchMoovAtoms(bytes, view, start, end, rng) {
  let offset = start;
  while (offset + 8 <= end) {
    const atomSize = view.getUint32(offset, false);
    const atomType = String.fromCharCode(bytes[offset+4], bytes[offset+5], bytes[offset+6], bytes[offset+7]);
    if (atomSize < 8 || offset + atomSize > end) break;
    if (atomType === "mvhd" || atomType === "tkhd") {
      const version = bytes[offset + 8];
      if (version === 0) {
        const ts = (rng() % 1000000) + 1000000;
        view.setUint32(offset + 12, ts, false);
        view.setUint32(offset + 16, ts + (rng() % 1000), false);
      } else if (version === 1) {
        view.setUint32(offset + 16, 0, false);
        view.setUint32(offset + 20, (rng() % 1000000) + 1000000, false);
        view.setUint32(offset + 24, 0, false);
        view.setUint32(offset + 28, (rng() % 1000000) + 1000000, false);
      }
    }
    if (["trak","udta","mdia","minf","stbl","meta"].includes(atomType)) {
      patchMoovAtoms(bytes, view, offset + 8, offset + atomSize, rng);
    }
    offset += atomSize;
  }
}

function sanitizeMP4(buffer, accountId) {
  const view  = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const len   = bytes.length;
  const seed  = accountId + Date.now().toString(36) + Math.random().toString(36);
  let rngState = 0;
  for (let i = 0; i < seed.length; i++) rngState = (rngState * 31 + seed.charCodeAt(i)) >>> 0;
  function rng() { rngState = (rngState * 1664525 + 1013904223) >>> 0; return rngState; }
  let offset = 0, mdatStart = -1, mdatSize = 0;
  while (offset + 8 <= len) {
    let atomSize = view.getUint32(offset, false);
    const atomType = String.fromCharCode(bytes[offset+4], bytes[offset+5], bytes[offset+6], bytes[offset+7]);
    if (atomSize === 1) {
      if (offset + 16 > len) break;
      atomSize = view.getUint32(offset + 8, false) * 0x100000000 + view.getUint32(offset + 12, false);
    }
    if (atomSize < 8 || offset + atomSize > len) break;
    if (atomType === "moov") patchMoovAtoms(bytes, view, offset + 8, offset + atomSize, rng);
    if (atomType === "mdat") { mdatStart = offset + 8; mdatSize = atomSize - 8; }
    offset += atomSize;
  }
  if (mdatStart > 0 && mdatSize > 64) {
    const noiseOffset = mdatStart + 2 + (rng() % Math.min(32, mdatSize - 4));
    bytes[noiseOffset]     = (rng() & 0xFF);
    bytes[noiseOffset + 1] = (rng() & 0xFF);
  }
  const metaTags = [
    [0xA9,0x6E,0x61,0x6D],[0xA9,0x74,0x6F,0x6F],[0xA9,0x63,0x6D,0x74],
    [0xA9,0x41,0x52,0x54],[0x58,0x4D,0x50,0x5F],
  ];
  for (const tag of metaTags) {
    let pos = 0;
    while (pos < len - 12) {
      if (bytes[pos]===tag[0]&&bytes[pos+1]===tag[1]&&bytes[pos+2]===tag[2]&&bytes[pos+3]===tag[3]) {
        const tagSize = view.getUint32(pos - 4, false);
        if (tagSize > 12 && pos - 4 + tagSize <= len) bytes.fill(0x20, pos + 8, pos - 4 + tagSize);
      }
      pos++;
    }
  }
  return bytes.buffer;
}

export const config = { path: "/api/drive-proxy-bg" };

export default async function handler(req) {
  const cors = {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type":                 "application/json",
  };

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  // GET — consulta status do job
  if (req.method === "GET") {
    const jobId = new URL(req.url).searchParams.get("job_id");
    if (!jobId) return new Response(JSON.stringify({ error: "job_id obrigatorio" }), { status: 400, headers: cors });
    try {
      const jobs = getJobStore();
      const raw  = await jobs.get(jobId, { type: "text" }).catch(() => null);
      if (!raw) return new Response(JSON.stringify({ status: "pending" }), { status: 200, headers: cors });
      return new Response(raw, { status: 200, headers: cors });
    } catch (err) {
      return new Response(JSON.stringify({ status: "error", error: err.message }), { status: 500, headers: cors });
    }
  }

  // POST — inicia o job e processa (background function aguenta 15min)
  if (req.method === "POST") {
    let body;
    try { body = await req.json(); } catch { return new Response(JSON.stringify({ error: "JSON invalido" }), { status: 400, headers: cors }); }

    const { file_id, file_name, refresh_token, account_id } = body;
    if (!file_id || !refresh_token) {
      return new Response(JSON.stringify({ error: "file_id e refresh_token obrigatorios" }), { status: 400, headers: cors });
    }

    const jobId  = `job-${file_id}-${account_id || "x"}-${Date.now()}`;
    const jobs   = getJobStore();

    // Salva job como "running" imediatamente
    await jobs.set(jobId, JSON.stringify({ status: "running", file_name }));

    // Processa em background (não bloqueia a resposta inicial)
    // Nota: em background functions o handler continua rodando após o return
    const process = async () => {
      try {
        const accessToken = await renewAccessToken(refresh_token);

        const apiUrl = `https://www.googleapis.com/drive/v3/files/${file_id}?alt=media`;
        const res    = await fetch(apiUrl, { headers: { Authorization: `Bearer ${accessToken}` } });

        if (!res.ok) {
          const msg = res.status === 401 ? "Token inválido" : res.status === 404 ? "Arquivo não encontrado" : `Drive erro ${res.status}`;
          throw new Error(msg);
        }

        const buffer     = await res.arrayBuffer();
        const sanitized  = sanitizeMP4(buffer, account_id || file_id);
        const sanitizedArr = new Uint8Array(sanitized);

        const store   = getVideoStore();
        const blobKey = account_id ? `video-${file_id}-${account_id}` : `video-${file_id}-${Date.now()}`;
        await store.set(blobKey, sanitizedArr, {
          metadata: { file_name: file_name || file_id, uploaded_at: new Date().toISOString(), sanitized: "true" },
        });

        const url = `${SITE_URL}/.netlify/functions/drive-proxy?key=${blobKey}`;
        console.log(`[drive-proxy-bg] ✅ ${file_name} (${(sanitizedArr.byteLength/1e6).toFixed(1)}MB) -> ${url}`);
        await jobs.set(jobId, JSON.stringify({ status: "done", url, blob_key: blobKey, size: sanitizedArr.byteLength }));
      } catch (err) {
        console.error(`[drive-proxy-bg] ❌ ${file_name}:`, err.message);
        await jobs.set(jobId, JSON.stringify({ status: "error", error: err.message }));
      }
    };

    // Dispara processamento e retorna job_id imediatamente
    process().catch(console.error);

    return new Response(JSON.stringify({ job_id: jobId, status: "running" }), { status: 202, headers: cors });
  }

  return new Response(JSON.stringify({ error: "Metodo nao permitido" }), { status: 405, headers: cors });
}
