// useDriveAuth.js
// Gerencia a autenticação OAuth com o Google Drive.
// - Abre popup de login (igual ao Instagram)
// - Salva/renova token no IndexedDB
// - Expõe: { token, isConnected, isExpired, connect, disconnect, getValidToken }

import { useState, useEffect, useCallback, useRef } from "react";
import { dbGet, dbPut, dbDelete } from "./useDB.js";

const IDB_KEY   = "drive_token";
const IDB_STORE = "sessions"; // reutiliza a store existente

// Margem de segurança: renova 5 minutos antes de expirar
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

function isTokenExpired(tokenData) {
  if (!tokenData?.access_token) return true;
  const expiresAt = (tokenData.obtained_at || 0) + (tokenData.expires_in || 3600) * 1000;
  return Date.now() >= expiresAt - EXPIRY_MARGIN_MS;
}

export function useDriveAuth() {
  const [tokenData,  setTokenData]  = useState(null);  // { access_token, refresh_token, expires_in, obtained_at }
  const [status,     setStatus]     = useState("idle"); // idle | connecting | connected | expired | error
  const [errorMsg,   setErrorMsg]   = useState(null);
  const popupRef = useRef(null);
  const timerRef = useRef(null);

  // Carrega token salvo ao montar
  useEffect(() => {
    (async () => {
      try {
        const saved = await dbGet(IDB_STORE, IDB_KEY);
        if (saved?.access_token) {
          setTokenData(saved);
          setStatus(isTokenExpired(saved) ? "expired" : "connected");
        }
      } catch {}
    })();
  }, []);

  // Escuta mensagens do popup filho
  useEffect(() => {
    const handler = async (event) => {
      if (event.origin !== window.location.origin) return;
      const { type, token, error } = event.data || {};

      if (type === "DRIVE_TOKEN" && token) {
        closePopup();
        try {
          await dbPut(IDB_STORE, { ...token, id: IDB_KEY });
          setTokenData({ ...token, id: IDB_KEY });
          setStatus("connected");
          setErrorMsg(null);
        } catch (err) {
          setStatus("error");
          setErrorMsg("Erro ao salvar token: " + err.message);
        }
      }

      if (type === "DRIVE_ERROR") {
        closePopup();
        setStatus("error");
        setErrorMsg(error === "access_denied" ? "Acesso negado ao Google Drive." : (error || "Erro na autenticação."));
      }
    };

    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  const closePopup = useCallback(() => {
    if (timerRef.current)  clearInterval(timerRef.current);
    if (popupRef.current && !popupRef.current.closed) popupRef.current.close();
    popupRef.current = null;
  }, []);

  // Abre popup de login Google — mesmo padrão do Instagram
  const connect = useCallback(() => {
    const authUrl = `${window.location.origin}/api/drive-auth`;
    const w = 520, h = 640;
    const left = Math.round(window.screenX + (window.outerWidth  - w) / 2);
    const top  = Math.round(window.screenY + (window.outerHeight - h) / 2);

    const popup = window.open(
      authUrl,
      "google_drive_oauth",
      `width=${w},height=${h},left=${left},top=${top},resizable=yes,scrollbars=yes,status=yes`
    );

    if (!popup) {
      setStatus("error");
      setErrorMsg("Popup bloqueado. Permita popups para este site e tente novamente.");
      return;
    }

    popupRef.current = popup;
    setStatus("connecting");
    setErrorMsg(null);

    // Detecta se o popup fechou sem completar o fluxo
    timerRef.current = setInterval(() => {
      if (popup.closed) {
        clearInterval(timerRef.current);
        setStatus((prev) => {
          if (prev === "connecting") {
            setErrorMsg("Login cancelado.");
            return "error";
          }
          return prev;
        });
        popupRef.current = null;
      }
    }, 500);
  }, []);

  const disconnect = useCallback(async () => {
    closePopup();
    try { await dbDelete(IDB_STORE, IDB_KEY); } catch {}
    setTokenData(null);
    setStatus("idle");
    setErrorMsg(null);
  }, [closePopup]);

  // Retorna um access_token válido — renova automaticamente se necessário
  const getValidToken = useCallback(async () => {
    const saved = await dbGet(IDB_STORE, IDB_KEY).catch(() => null);
    if (!saved?.access_token) throw new Error("not_connected");

    if (!isTokenExpired(saved)) return saved.access_token;

    // Token expirado → renova usando refresh_token
    if (!saved.refresh_token) {
      setStatus("expired");
      throw new Error("token_expired");
    }

    try {
      const res  = await fetch("/api/drive-browse", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ refresh_token: saved.refresh_token }),
      });
      const data = await res.json();
      if (!data.access_token) throw new Error(data.error || "Falha ao renovar");

      const renewed = { ...saved, ...data };
      await dbPut(IDB_STORE, renewed);
      setTokenData(renewed);
      setStatus("connected");
      return renewed.access_token;
    } catch (err) {
      setStatus("expired");
      throw err;
    }
  }, []);

  return {
    tokenData,
    isConnected: status === "connected",
    isExpired:   status === "expired",
    isConnecting: status === "connecting",
    status,
    errorMsg,
    connect,
    disconnect,
    getValidToken,
  };
}
