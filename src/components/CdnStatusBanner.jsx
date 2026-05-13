// src/components/CdnStatusBanner.jsx
// Banner de aviso que aparece quando o CDN das mídias está fora do ar.
// Mostra: motivo, quando foi detectado, tempo até próxima verificação,
// e botão para verificar manualmente ou retomar manualmente.

import { useState, useEffect } from "react";
import { useScheduler } from "../App.jsx";

function timeAgo(isoStr) {
  if (!isoStr) return "—";
  const diff = Date.now() - new Date(isoStr).getTime();
  const min  = Math.floor(diff / 60_000);
  if (min < 1)   return "agora mesmo";
  if (min < 60)  return `há ${min} min`;
  const h = Math.floor(min / 60);
  return `há ${h}h ${min % 60}m`;
}

export default function CdnStatusBanner() {
  const { cdnPaused, cdnStatus, resumeCdn } = useScheduler();
  const [checking,   setChecking]   = useState(false);
  const [checkResult, setCheckResult] = useState(null);
  const [countdown,  setCountdown]  = useState(null); // segundos até próxima verificação

  // Countdown até próxima verificação automática (5 min = 300s)
  useEffect(() => {
    if (!cdnPaused || !cdnStatus?.checkedAt) return;
    const interval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - new Date(cdnStatus.checkedAt).getTime()) / 1000);
      const remaining = 300 - elapsed; // 5 min
      setCountdown(remaining > 0 ? remaining : 0);
    }, 1000);
    return () => clearInterval(interval);
  }, [cdnPaused, cdnStatus?.checkedAt]);

  if (!cdnPaused) return null;

  const checkNow = async () => {
    setChecking(true);
    setCheckResult(null);
    try {
      const res  = await fetch("/api/check-cdn?url=" + encodeURIComponent(
        "https://files.catbox.moe/favicon.ico" // URL leve para testar o Catbox
      ));
      const data = await res.json();
      setCheckResult(data);
      if (data.ok) {
        // Voltou! Retoma automaticamente
        await resumeCdn(false);
      }
    } catch (err) {
      setCheckResult({ ok: false, error: err.message });
    }
    setChecking(false);
  };

  const forceResume = async () => {
    await resumeCdn(true);
  };

  return (
    <div style={{
      margin: "0 0 16px",
      padding: "14px 16px",
      borderRadius: 12,
      background: "rgba(239,68,68,0.08)",
      border: "1px solid rgba(239,68,68,0.3)",
      borderLeft: "4px solid var(--danger)",
    }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "var(--danger)", marginBottom: 4, display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: 16 }}>🔴</span>
            Fila pausada — {cdnStatus?.cdn || "CDN"} indisponível
          </div>
          <div style={{ fontSize: 12, color: "var(--text2)", lineHeight: 1.5 }}>
            {cdnStatus?.error || "Serviço de hospedagem de mídias fora do ar"}
          </div>
          <div style={{ display: "flex", gap: 12, marginTop: 6, flexWrap: "wrap" }}>
            <span style={{ fontSize: 11, color: "var(--muted)" }}>
              Detectado {timeAgo(cdnStatus?.checkedAt)}
            </span>
            {countdown !== null && countdown > 0 && (
              <span style={{ fontSize: 11, color: "var(--muted)" }}>
                Próxima verificação em {Math.floor(countdown / 60)}:{String(countdown % 60).padStart(2, "0")}
              </span>
            )}
            {countdown === 0 && (
              <span style={{ fontSize: 11, color: "var(--warning)" }}>
                ↻ Verificando agora...
              </span>
            )}
          </div>
        </div>

        {/* Ações */}
        <div style={{ display: "flex", flexDirection: "column", gap: 6, flexShrink: 0 }}>
          <button
            className="btn btn-sm"
            onClick={checkNow}
            disabled={checking}
            style={{
              background: "rgba(56,189,248,0.12)", color: "var(--info)",
              border: "1px solid rgba(56,189,248,0.3)", fontSize: 12,
            }}
          >
            {checking
              ? <><span className="spinner" style={{ width: 11, height: 11 }} /> Verificando</>
              : "↻ Verificar agora"}
          </button>
          <button
            className="btn btn-sm btn-ghost"
            onClick={forceResume}
            style={{ fontSize: 11 }}
            title="Retoma a fila mesmo sem confirmar que o CDN voltou"
          >
            ▶ Retomar mesmo assim
          </button>
        </div>
      </div>

      {/* Resultado da verificação manual */}
      {checkResult && (
        <div style={{
          marginTop: 10, padding: "8px 12px", borderRadius: 8, fontSize: 12,
          background: checkResult.ok ? "rgba(34,197,94,0.08)" : "rgba(239,68,68,0.06)",
          color: checkResult.ok ? "var(--success)" : "var(--danger)",
          border: `1px solid ${checkResult.ok ? "rgba(34,197,94,0.2)" : "rgba(239,68,68,0.2)"}`,
        }}>
          {checkResult.ok
            ? "✅ CDN voltou! Fila retomada automaticamente."
            : `✗ CDN ainda fora: ${checkResult.error || "inacessível"}`}
        </div>
      )}

      {/* Info adicional */}
      <div style={{ marginTop: 10, fontSize: 11, color: "var(--muted)", lineHeight: 1.6 }}>
        💡 As publicações serão retomadas automaticamente quando o serviço voltar.
        Verificação automática a cada 5 minutos enquanto estiver fora.
      </div>
    </div>
  );
}
