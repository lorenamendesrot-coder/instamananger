// src/useCdnMonitor.js
// Hook que monitora se o CDN das mídias está acessível.
// - Quando uma publicação falha com erro de URL, verifica o CDN
// - Se o CDN estiver fora, pausa TODA a fila e inicia verificações a cada 5 min
// - Quando o CDN volta, retoma a fila automaticamente e notifica
//
// Estado salvo no IDB store "protection" com id "cdn_status"
// para persistir entre reloads sem perder o estado de pausa.

import { useState, useEffect, useRef, useCallback } from "react";
import { dbGet, dbPut } from "./useDB.js";

const IDB_KEY      = "cdn_status";
const IDB_STORE    = "protection";
const CHECK_INTERVAL_DOWN = 5 * 60_000;   // verifica a cada 5 min quando fora
const CHECK_INTERVAL_UP   = 30 * 60_000;  // verifica a cada 30 min quando ok
const MIN_FAILS_TO_PAUSE  = 2;            // precisa de 2 falhas consecutivas para pausar

// Palavras-chave nos erros que indicam problema de CDN (não de API)
const CDN_ERROR_PATTERNS = [
  "não conseguiu baixar",
  "could not download",
  "url is not accessible",
  "invalid image",
  "invalid video",
  "media url",
  "failed to download",
  "cannot access",
  "connection refused",
  "ECONNREFUSED",
  "catbox",
  "timeout",
];

export function isCdnError(errorMsg) {
  if (!errorMsg) return false;
  const lower = errorMsg.toLowerCase();
  return CDN_ERROR_PATTERNS.some((p) => lower.includes(p.toLowerCase()));
}

// Extrai URLs de mídia da fila para testar
function extractTestUrls(queue) {
  const urls = new Set();
  for (const item of queue) {
    if (item.type) continue; // ignora video_finish etc
    const allUrls = item.mediaUrls?.length > 0 ? item.mediaUrls : [item.mediaUrl];
    for (const u of allUrls) {
      if (u && u.startsWith("http")) urls.add(u);
      if (urls.size >= 3) break; // basta testar 3 URLs
    }
    if (urls.size >= 3) break;
  }
  return [...urls];
}

export function useCdnMonitor(queue, onStatusChange) {
  const [cdnStatus, setCdnStatus] = useState({
    paused:      false,
    checkedAt:   null,
    error:       null,
    cdn:         null,
    failCount:   0,
    manualResume: false,
  });

  const timerRef    = useRef(null);
  const checkingRef = useRef(false);

  // Carrega estado do IDB ao montar
  useEffect(() => {
    dbGet(IDB_STORE, IDB_KEY).then((saved) => {
      if (saved) setCdnStatus(saved);
    }).catch(() => {});
  }, []);

  // Persiste no IDB sempre que muda
  const saveStatus = useCallback(async (newStatus) => {
    const full = { id: IDB_KEY, ...newStatus };
    await dbPut(IDB_STORE, full);
    setCdnStatus(newStatus);
  }, []);

  // Verifica o CDN via /api/check-cdn
  const checkCdn = useCallback(async (urlsToTest) => {
    if (checkingRef.current) return null;
    checkingRef.current = true;
    try {
      const urls = urlsToTest?.length > 0 ? urlsToTest : extractTestUrls(queue);
      if (!urls.length) return null; // sem URLs para testar

      const res  = await fetch("/api/check-cdn", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ urls }),
      });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    } finally {
      checkingRef.current = false;
    }
  }, [queue]);

  // Pausa a fila por problema de CDN
  const pauseForCdn = useCallback(async (errorMsg, cdnName) => {
    const newStatus = {
      paused:       true,
      checkedAt:    new Date().toISOString(),
      error:        errorMsg,
      cdn:          cdnName || "CDN",
      failCount:    (cdnStatus.failCount || 0) + 1,
      manualResume: false,
    };
    await saveStatus(newStatus);
    onStatusChange?.({ type: "paused", ...newStatus });
    console.warn(`[useCdnMonitor] CDN pausado: ${errorMsg}`);
  }, [cdnStatus.failCount, saveStatus, onStatusChange]);

  // Retoma a fila
  const resumeCdn = useCallback(async (manual = false) => {
    const newStatus = {
      paused:       false,
      checkedAt:    new Date().toISOString(),
      error:        null,
      cdn:          cdnStatus.cdn,
      failCount:    0,
      manualResume: manual,
    };
    await saveStatus(newStatus);
    onStatusChange?.({ type: "resumed", manual });
    console.log(`[useCdnMonitor] CDN retomado (${manual ? "manual" : "automático"})`);
  }, [cdnStatus.cdn, saveStatus, onStatusChange]);

  // Polling automático quando pausado
  useEffect(() => {
    clearInterval(timerRef.current);

    if (!cdnStatus.paused) {
      // Verifica de 30 em 30 min mesmo quando ok (detecção proativa)
      timerRef.current = setInterval(async () => {
        const result = await checkCdn();
        if (!result) return;
        if (!result.ok && result.anyFailed) {
          // Detectou problema proativamente
          const cdnDown = result.cdnsDown?.[0]?.name || "CDN";
          await pauseForCdn(`${cdnDown} indisponível (detectado preventivamente)`, cdnDown);
        }
      }, CHECK_INTERVAL_UP);
      return;
    }

    // CDN está pausado — verifica a cada 5 min se voltou
    const poll = async () => {
      console.log("[useCdnMonitor] Verificando se CDN voltou...");
      const result = await checkCdn();
      if (!result) return;

      if (result.ok) {
        // CDN voltou! Retoma automaticamente
        await resumeCdn(false);
        // Notificação do browser
        try {
          if (Notification.permission === "granted") {
            new Notification("Insta Manager — CDN voltou! ✅", {
              body: "As publicações foram retomadas automaticamente.",
              icon: "/favicon.ico",
            });
          }
        } catch (_) {}
      } else {
        // Ainda fora — atualiza o checkedAt e os CDNs com problema
        const cdnDown = result.cdnsDown?.[0]?.name || cdnStatus.cdn || "CDN";
        await saveStatus({
          ...cdnStatus,
          checkedAt: new Date().toISOString(),
          error:     `${cdnDown}: ${result.cdnsDown?.[0]?.errors?.[0] || "indisponível"}`,
          cdn:       cdnDown,
        });
        console.log("[useCdnMonitor] CDN ainda fora, próxima verificação em 5 min");
      }
    };

    // Primeira verificação imediata (30s após pausar)
    const firstCheck = setTimeout(poll, 30_000);
    timerRef.current = setInterval(poll, CHECK_INTERVAL_DOWN);

    return () => {
      clearTimeout(firstCheck);
      clearInterval(timerRef.current);
    };
  }, [cdnStatus.paused, checkCdn, pauseForCdn, resumeCdn, saveStatus]);

  // Limpar ao desmontar
  useEffect(() => () => clearInterval(timerRef.current), []);

  return {
    cdnStatus,
    cdnPaused:    cdnStatus.paused,
    checkCdn,
    pauseForCdn,
    resumeCdn,
    isCdnError,
  };
}
