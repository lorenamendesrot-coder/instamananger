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

// ─── Sanitização MP4 ──────────────────────────────────────────────────────────
// Torna cada cópia do vídeo única sem reencoding:
//  1. Apaga átomos de metadados (©nam, ©too, ©cmt, uuid, EXIF, XMP)
//  2. Altera timestamp de criação/modificação no mvhd e tkhd
//  3. Injeta ruído de 4 bytes numa posição aleatória dentro do mdat
//     (bytes não vídeo — dentro do cabeçalho interno do mdat, seguro)
//  4. Gera novo "encoder string" no udta/meta
// Resultado: hash MD5/SHA diferente, metadados limpos, sem reencoding.
function sanitizeMP4(buffer, accountId) {
  const view  = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const len   = bytes.length;

  // Seed determinística por conta + timestamp para garantir unicidade
  const seed = accountId + Date.now().toString(36) + Math.random().toString(36);
  let rngState = 0;
  for (let i = 0; i < seed.length; i++) rngState = (rngState * 31 + seed.charCodeAt(i)) >>> 0;
  function rng() { rngState = (rngState * 1664525 + 1013904223) >>> 0; return rngState; }

  // Percorre os átomos MP4 de nível superior
  let offset = 0;
  let mdatStart = -1, mdatSize = 0;

  while (offset + 8 <= len) {
    let atomSize = view.getUint32(offset, false);
    const atomType = String.fromCharCode(bytes[offset+4], bytes[offset+5], bytes[offset+6], bytes[offset+7]);

    if (atomSize === 1) {
      // Extended size (64-bit) — lê os próximos 8 bytes
      if (offset + 16 > len) break;
      const hi = view.getUint32(offset + 8, false);
      const lo = view.getUint32(offset + 12, false);
      atomSize = hi * 0x100000000 + lo;
    }
    if (atomSize < 8 || offset + atomSize > len) break;

    // ── mvhd: zera timestamps de criação e modificação ─────────────────────
    if (atomType === "moov") {
      // Entra recursivamente para achar mvhd e tkhd dentro do moov
      patchMoovAtoms(bytes, view, offset + 8, offset + atomSize, rng);
    }

    // ── mdat: injeta ruído nos primeiros bytes livres ───────────────────────
    if (atomType === "mdat") {
      mdatStart = offset + 8; // início do payload
      mdatSize  = atomSize - 8;
    }

    offset += atomSize;
  }

  // Injeta 4 bytes de ruído no início do mdat (bytes 0-3 do payload mdat
  // são parte do cabeçalho interno NAL/MP4 — alteramos apenas 2 bytes
  // no offset 2-3 que são reservados e ignorados pelos decoders)
  if (mdatStart > 0 && mdatSize > 64) {
    const noiseOffset = mdatStart + 2 + (rng() % Math.min(32, mdatSize - 4));
    bytes[noiseOffset]     = (rng() & 0xFF);
    bytes[noiseOffset + 1] = (rng() & 0xFF);
    console.log(`[sanitize] ruído injetado em offset ${noiseOffset}`);
  }

  // Apaga strings de metadados comuns (©nam, ©too, ©cmt, ©ART, EXIF, XMP)
  const metaTags = [
    [0xA9, 0x6E, 0x61, 0x6D], // ©nam
    [0xA9, 0x74, 0x6F, 0x6F], // ©too (encoder)
    [0xA9, 0x63, 0x6D, 0x74], // ©cmt
    [0xA9, 0x41, 0x52, 0x54], // ©ART
    [0x58, 0x4D, 0x50, 0x5F], // XMP_
  ];

  for (const tag of metaTags) {
    let pos = 0;
    while (pos < len - 12) {
      if (bytes[pos] === tag[0] && bytes[pos+1] === tag[1] &&
          bytes[pos+2] === tag[2] && bytes[pos+3] === tag[3]) {
        // Apaga o conteúdo do átomo (preserva tamanho para não quebrar estrutura)
        const tagSize = view.getUint32(pos - 4, false);
        if (tagSize > 12 && pos - 4 + tagSize <= len) {
          bytes.fill(0x20, pos + 8, pos - 4 + tagSize); // preenche com espaços
        }
      }
      pos++;
    }
  }

  console.log(`[sanitize] MP4 sanitizado para conta ${accountId}`);
  return bytes.buffer;
}

function patchMoovAtoms(bytes, view, start, end, rng) {
  let offset = start;
  while (offset + 8 <= end) {
    const atomSize = view.getUint32(offset, false);
    const atomType = String.fromCharCode(bytes[offset+4], bytes[offset+5], bytes[offset+6], bytes[offset+7]);
    if (atomSize < 8 || offset + atomSize > end) break;

    if (atomType === "mvhd" || atomType === "tkhd") {
      // Version 0: timestamps em 32-bit nos bytes 4-11 (creation + modification)
      // Version 1: timestamps em 64-bit nos bytes 4-19
      const version = bytes[offset + 8];
      if (version === 0) {
        // Zera creation_time e modification_time (substitui por valor aleatório baixo)
        const ts = (rng() % 1000000) + 1000000; // timestamp pequeno único
        view.setUint32(offset + 12, ts, false); // creation_time
        view.setUint32(offset + 16, ts + (rng() % 1000), false); // modification_time
      } else if (version === 1) {
        view.setUint32(offset + 16, 0, false);
        view.setUint32(offset + 20, (rng() % 1000000) + 1000000, false);
        view.setUint32(offset + 24, 0, false);
        view.setUint32(offset + 28, (rng() % 1000000) + 1000000, false);
      }
    }

    // Recursivo em trak, udta, mdia, minf, stbl
    if (["trak","udta","mdia","minf","stbl","meta"].includes(atomType)) {
      patchMoovAtoms(bytes, view, offset + 8, offset + atomSize, rng);
    }

    offset += atomSize;
  }
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

    const { file_id, file_name, refresh_token, account_id, force_refresh } = body;

    if (!file_id)       return json({ error: "file_id obrigatorio" }, 400);
    if (!refresh_token) return json({ error: "refresh_token obrigatorio" }, 400);

    // Cache hit: se o blob já existe e foi feito há menos de 6h, reutiliza.
    // Evita re-baixar o vídeo a cada tick do loop (economiza invocações + largura de banda).
    // force_refresh=true força o re-download (ex: usuário atualizou o arquivo no Drive).
    if (!force_refresh && account_id) {
      try {
        const store   = getVideoStore();
        const blobKey = `video-${file_id}-${account_id}`;
        const cached  = await store.getWithMetadata(blobKey);
        if (cached?.metadata?.uploaded_at) {
          const ageMs = Date.now() - new Date(cached.metadata.uploaded_at).getTime();
          if (ageMs < 6 * 60 * 60 * 1000) {
            const proxyUrl = `${SITE_URL}/.netlify/functions/drive-proxy?key=${blobKey}`;
            console.log(`[drive-proxy] cache hit ${file_id} conta ${account_id} (${Math.round(ageMs/60000)}min atrás)`);
            return json({ url: proxyUrl, blob_key: blobKey, size: parseInt(cached.metadata.size || "0"), file_id, sanitized: cached.metadata.sanitized === "true", cached: true });
          }
        }
      } catch {
        // cache miss ou erro de leitura — continua com download normal
      }
    }

    try {
      const accessToken           = await renewAccessToken(refresh_token);
      const { buffer, sizeBytes } = await downloadFromDrive(file_id, accessToken);

      // Sanitização: apenas quando account_id é fornecido (chamada do scheduler)
      // No upload manual (DrivePicker) não há account_id — pula sanitização para
      // evitar timeout de 26s do Netlify. A sanitização ocorre na publicação.
      let finalArr;
      let sanitizedFlag = false;
      if (account_id) {
        const sanitized = sanitizeMP4(buffer, account_id);
        finalArr        = new Uint8Array(sanitized);
        sanitizedFlag   = true;
        console.log(`[drive-proxy] sanitizado para conta ${account_id}`);
      } else {
        finalArr = new Uint8Array(buffer);
      }

      const store   = getVideoStore();
      const blobKey = account_id
        ? `video-${file_id}-${account_id}`
        : `video-${file_id}-${Date.now()}`;

      await store.set(blobKey, finalArr, {
        metadata: {
          file_name:   file_name || file_id,
          uploaded_at: new Date().toISOString(),
          size:        String(finalArr.byteLength),
          account_id:  account_id || "",
          sanitized:   String(sanitizedFlag),
          file_id:     file_id, // guarda para sanitizar na publicação
        },
      });

      const proxyUrl = `${SITE_URL}/.netlify/functions/drive-proxy?key=${blobKey}`;
      console.log(`[drive-proxy] OK ${file_name || file_id} (${(finalArr.byteLength / 1e6).toFixed(1)}MB) conta:${account_id || "n/a"} -> ${proxyUrl}`);
      return json({ url: proxyUrl, blob_key: blobKey, size: finalArr.byteLength, file_id, sanitized: sanitizedFlag });

    } catch (err) {
      console.error("[drive-proxy] POST erro:", err.message);
      return json({ error: err.message }, 500);
    }
  }

  return json({ error: "Metodo nao permitido" }, 405);
}
