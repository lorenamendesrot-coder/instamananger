// netlify/functions/check-cdn.mjs
// Verifica se URLs de CDN estão acessíveis (Catbox, R2, etc.)
// Chamado pelo frontend antes de publicar e de 5 em 5 min durante pause
//
// POST /api/check-cdn { urls: ["https://files.catbox.moe/...", ...] }
// GET  /api/check-cdn?url=https://... (verifica uma URL específica)

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || process.env.URL || "";

function buildCors(req) {
  const origin     = (req?.headers?.get ? req.headers.get("origin") : req?.headers?.origin) || "";
  const corsOrigin = ALLOWED_ORIGIN ? (origin === ALLOWED_ORIGIN ? ALLOWED_ORIGIN : origin) : "*";
  return {
    "Access-Control-Allow-Origin":  corsOrigin,
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type":                 "application/json",
    ...(corsOrigin !== "*" ? { "Vary": "Origin" } : {}),
  };
}

const TIMEOUT_MS = 8_000;

// Tenta um HEAD request para verificar se a URL está acessível
// HEAD é mais leve que GET — só baixa os headers
async function checkUrl(url) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method:  "HEAD",
      signal:  ctrl.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; InstaManager/1.0)" },
    });
    clearTimeout(timer);
    return {
      url,
      ok:     res.ok || res.status === 200 || res.status === 206,
      status: res.status,
      error:  res.ok ? null : `HTTP ${res.status}`,
    };
  } catch (err) {
    clearTimeout(timer);
    const isTimeout = err.name === "AbortError";
    return {
      url,
      ok:    false,
      status: 0,
      error: isTimeout ? `Timeout (${TIMEOUT_MS}ms)` : err.message,
    };
  }
}

// Detecta qual CDN é o host
function detectCdn(url) {
  try {
    const host = new URL(url).hostname;
    if (host.includes("catbox.moe"))    return "Catbox";
    if (host.includes("r2.dev"))        return "Cloudflare R2";
    if (host.includes("cloudinary"))    return "Cloudinary";
    if (host.includes("amazonaws"))     return "AWS S3";
    if (host.includes("drive.google"))  return "Google Drive";
    if (host.includes("googleapis"))    return "Google APIs";
    return host;
  } catch {
    return "Desconhecido";
  }
}

export default async function handler(req) {
  const CORS = buildCors(req);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  function json(data, status = 200) {
    return new Response(JSON.stringify(data), { status, headers: CORS });
  }

  try {
    // ── GET — verifica URL única ───────────────────────────────────────────
    if (req.method === "GET") {
      const url = new URL(req.url).searchParams.get("url");
      if (!url) return json({ error: "url obrigatório" }, 400);

      const result = await checkUrl(url);
      return json({
        ...result,
        cdn:       detectCdn(url),
        checkedAt: new Date().toISOString(),
      });
    }

    // ── POST — verifica múltiplas URLs ou detecta CDN da fila ─────────────
    if (req.method === "POST") {
      const body = await req.json();
      const urls = Array.isArray(body.urls)
        ? body.urls.filter((u) => typeof u === "string" && u.startsWith("http"))
        : [];

      if (!urls.length) return json({ error: "urls[] obrigatório" }, 400);

      // Verifica todas em paralelo (máx 5 simultâneas)
      const BATCH = 5;
      const results = [];
      for (let i = 0; i < urls.length; i += BATCH) {
        const batch   = urls.slice(i, i + BATCH);
        const checked = await Promise.all(batch.map(checkUrl));
        results.push(...checked);
      }

      // Agrupa por CDN
      const byCdn = {};
      for (const r of results) {
        const cdn = detectCdn(r.url);
        if (!byCdn[cdn]) byCdn[cdn] = { ok: 0, fail: 0, errors: [] };
        if (r.ok) byCdn[cdn].ok++;
        else { byCdn[cdn].fail++; byCdn[cdn].errors.push(r.error); }
      }

      const allOk     = results.every((r) => r.ok);
      const anyFailed = results.some((r) => !r.ok);

      // Identifica quais CDNs estão fora
      const cdnsDown = Object.entries(byCdn)
        .filter(([, v]) => v.fail > 0)
        .map(([name, v]) => ({ name, fail: v.fail, errors: [...new Set(v.errors)] }));

      return json({
        ok:        allOk,
        anyFailed,
        total:     results.length,
        okCount:   results.filter((r) =>  r.ok).length,
        failCount: results.filter((r) => !r.ok).length,
        cdnsDown,
        byCdn,
        results,
        checkedAt: new Date().toISOString(),
      });
    }

    return json({ error: "Método não permitido" }, 405);

  } catch (err) {
    console.error("[check-cdn] Erro:", err.message);
    return json({ error: err.message }, 500);
  }
}
