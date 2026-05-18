// useOAuthPopup.js
// Suporta dois fluxos de autenticação:
//   "facebook"  → Facebook Login (requer Página vinculada ao Instagram)
//   "instagram" → Instagram Login (direto, sem Página — lançado em jul/2024)
//
// No desktop: abre popup (window.open)
// No mobile/tablet: usa redirect da aba atual (popups são bloqueados pelo iOS/Android)
// O fluxo "instagram" é o recomendado para contas sem Página.

import { useCallback, useEffect, useRef, useState } from "react";

const FB_SCOPE = [
  "instagram_basic",
  "instagram_content_publish",
  "instagram_manage_insights",
  "pages_read_engagement",
  "pages_show_list",
  "pages_manage_posts",
  "business_management",
  "pages_manage_metadata",
].join(",");

// Scopes do Instagram Login (novos — os antigos foram depreciados em jan/2025)
const IG_SCOPE = [
  "instagram_business_basic",
  "instagram_business_content_publish",
  "instagram_business_manage_comments",
  "instagram_business_manage_messages",
].join(",");

// Detecta mobile/tablet — nesses dispositivos popups são bloqueados pelo SO/browser
function isMobile() {
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || window.innerWidth < 768;
}

function buildOAuthUrl(flow, appId, useRedirect = false) {
  const state = useRedirect ? "redirect" : "popup";
  if (flow === "instagram") {
    const redirect = encodeURIComponent(window.location.origin + "/api/auth-callback-ig");
    return `https://www.instagram.com/oauth/authorize?client_id=${appId}&redirect_uri=${redirect}&scope=${IG_SCOPE}&response_type=code&state=${state}`;
  }
  const redirect = encodeURIComponent(window.location.origin + "/api/auth-callback");
  return `https://www.facebook.com/v21.0/dialog/oauth?client_id=${appId}&redirect_uri=${redirect}&scope=${FB_SCOPE}&response_type=code&state=${state}`;
}

// flow: "instagram" | "facebook"  (padrão: "instagram")
export function useOAuthPopup({ onAccounts, onError, flow = "instagram" }) {
  const [status,   setStatus]   = useState("idle"); // idle | waiting | saving | done | error
  const [errorMsg, setErrorMsg] = useState(null);
  const popupRef = useRef(null);
  const timerRef = useRef(null);

  // Escuta mensagens do popup filho (desktop)
  useEffect(() => {
    const handler = (event) => {
      if (event.origin !== window.location.origin) return;
      const { type, accounts, error } = event.data || {};
      if (type === "OAUTH_ACCOUNTS" && accounts) {
        closePopup();
        setStatus("saving");
        onAccounts(accounts);
      }
      if (type === "OAUTH_ERROR") {
        closePopup();
        setStatus("error");
        setErrorMsg(error || "Erro no login. Tente novamente.");
        onError?.(error);
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [onAccounts, onError]);

  const closePopup = useCallback(() => {
    if (timerRef.current)  clearInterval(timerRef.current);
    if (popupRef.current && !popupRef.current.closed) popupRef.current.close();
    popupRef.current = null;
  }, []);

  const openPopup = useCallback(() => {
    const appId = flow === "instagram"
      ? (import.meta.env.VITE_META_IG_APP_ID || import.meta.env.VITE_META_APP_ID)
      : (import.meta.env.VITE_META_FB_APP_ID || import.meta.env.VITE_META_APP_ID);

    const mobile = isMobile();
    const url    = buildOAuthUrl(flow, appId, mobile);

    // ── Mobile: redirect da aba atual ──────────────────────────────────────────
    // iOS/Android bloqueiam window.open. O backend já suporta state=redirect
    // e redireciona de volta para /?accounts=... ao finalizar.
    if (mobile) {
      setStatus("waiting");
      setErrorMsg(null);
      window.location.href = url;
      return;
    }

    // ── Desktop: popup centralizado ────────────────────────────────────────────
    const w = 520, h = 680;
    const left = Math.round(window.screenX + (window.outerWidth  - w) / 2);
    const top  = Math.round(window.screenY + (window.outerHeight - h) / 2);

    const popup = window.open(
      url,
      "instagram_oauth",
      `width=${w},height=${h},left=${left},top=${top},resizable=yes,scrollbars=yes,status=yes`
    );

    if (!popup) {
      // Popup bloqueado no desktop — fallback automático para redirect
      setStatus("waiting");
      setErrorMsg(null);
      window.location.href = buildOAuthUrl(flow, appId, true);
      return;
    }

    popupRef.current = popup;
    setStatus("waiting");
    setErrorMsg(null);

    // Verifica a cada 500ms se o popup fechou sem completar
    timerRef.current = setInterval(() => {
      if (popup.closed) {
        clearInterval(timerRef.current);
        setStatus((prev) => {
          if (prev === "waiting") {
            setErrorMsg("Login cancelado.");
            return "error";
          }
          return prev;
        });
        popupRef.current = null;
      }
    }, 500);
  }, [flow, onAccounts, onError]);

  const reset = useCallback(() => {
    closePopup();
    setStatus("idle");
    setErrorMsg(null);
  }, [closePopup]);

  return { status, errorMsg, openPopup, reset };
}
