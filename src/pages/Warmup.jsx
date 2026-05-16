// Warmup.jsx
import { warmupDay, isNewAccount, buildWarmupQueue, shadowScore, fmtSize, NEW_ACCOUNT_DAYS, WARMUP_PRESET_2D, TABS, MEDIA_TYPES } from "../components/warmup/WarmupUtils.js";
import MediaUploadZone from "../components/warmup/WarmupMediaUploadZone.jsx";
import AccountMonitorCard from "../components/warmup/WarmupAccountMonitorCard.jsx";
// Foco: aquecimento rápido em 2 dias, Reels-first, proteção de contas novas
// Tabs: Upload de Mídias | Legendas | Configuração | Preview da Fila | Monitor

import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { useAccounts } from "../useAccounts.js";
import { useWarmupFiles, useScheduler } from "../App.jsx";
import { dbPut, dbGetAll } from "../useDB.js";
import BulkCaptions, { pickCaption } from "../components/BulkCaptions.jsx";

// ─── Componente Principal ─────────────────────────────────────────────────────

export default function Warmup() {
  const { accounts, addAccounts, reloadAccounts } = useAccounts();
  const { addBatch } = useScheduler();

  // Usa contexto global — arquivos persistem ao trocar de aba
  const warmupCtx = useWarmupFiles();
  const { files, setFiles, addFiles: ctxAddFiles, removeFile: ctxRemoveFile, updateFile } = warmupCtx || {
    files: { reels: [], feed: [], stories: [] },
    setFiles: () => {},
    addFiles: () => {},
    removeFile: () => {},
    updateFile: () => {},
  };
  const removeFile = ctxRemoveFile;
  const filesRef = useRef(files);

  const [bulkCaptions, setBulkCaptions] = useState("");
  const [captionMode,  setCaptionMode]  = useState("roundrobin");
  const [startDate,    setStartDate]    = useState(() => {
    // Usa data LOCAL para não avançar o dia em fusos negativos (Brasil UTC-3)
    const now = new Date();
    const localDate = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
    // Só avança para amanhã depois das 23h locais — mantém hoje como padrão o dia todo
    if (now.getHours() >= 23) {
      localDate.setDate(localDate.getDate() + 1);
    }
    return localDate.toISOString().slice(0, 10);
  });
  const [distribution, setDistribution] = useState("roundrobin");
  const [useNewOnly,   setUseNewOnly]   = useState(true);
  const [selectedAccIds, setSelectedAccIds] = useState(null); // null = todas selecionadas
  const [urlInputs,    setUrlInputs]    = useState({ reels: "", feed: "", stories: "" });
  const [thumbUrl,     setThumbUrl]     = useState(""); // capa para Reels
  const [dayConfig, setDayConfig] = useState(WARMUP_PRESET_2D.days);
  const [configMode,   setConfigMode]   = useState("drive"); // somente "drive"
  // Estado do modo target
  const [targetConfig, setTargetConfig] = useState({ reels: 10, feed: 0, stories: 0, periodHours: 1, days: 1, windowStart: "09:00", windowEnd: "21:00" });
  const [selectedDays,    setSelectedDays]    = useState(() => WARMUP_PRESET_2D.days.map((d) => d.day)); // dias ativos
  const [loopEnabled,     setLoopEnabled]     = useState(false);
  const [loopDays,        setLoopDays]        = useState(7); // quantos dias extras em loop
  const [queue,        setQueue]        = useState([]);
  const [saving,       setSaving]       = useState(false);
  const [saved,        setSaved]        = useState(false);
  const [dbQueue,      setDbQueue]      = useState([]);
  const [tab,          setTab]          = useState("upload");
  const [syncingNames, setSyncingNames] = useState(false);
  const [syncResult,   setSyncResult]   = useState(null); // { updated: n, total: n }

  // ─── Config de agendamento Drive ─────────────────────────────────────────────
  const nowLocalStr = () => {
    const d = new Date(Date.now() + 15 * 60 * 1000);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const [driveStartTime,  setDriveStartTime]  = useState(nowLocalStr);
  const [drivePostType,   setDrivePostType]   = useState("REEL");
  const [driveGapMinutes, setDriveGapMinutes] = useState(60);
  const [driveJitterMin,  setDriveJitterMin]  = useState(10);
  const [driveCaption,    setDriveCaption]    = useState("");
  const [driveLoop,       setDriveLoop]       = useState(false);

  // Contas que passam no filtro de dias
  const eligibleAccounts = useMemo(
    () => accounts.filter((a) => !useNewOnly || isNewAccount(a)),
    [accounts, useNewOnly]
  );

  // Contas efetivamente selecionadas para o aquecimento (null = todas elegíveis)
  const selectedAccounts = useMemo(
    () => selectedAccIds === null
      ? eligibleAccounts
      : eligibleAccounts.filter((a) => selectedAccIds.includes(a.id)),
    [eligibleAccounts, selectedAccIds]
  );

  // Helpers de seleção
  const toggleAccount = (id) => {
    setSelectedAccIds((prev) => {
      const base = prev === null ? eligibleAccounts.map((a) => a.id) : [...prev];
      return base.includes(id) ? base.filter((x) => x !== id) : [...base, id];
    });
  };
  const selectAll  = () => setSelectedAccIds(null);
  const selectNone = () => setSelectedAccIds([]);

  // Sincroniza username/foto de todas as contas elegíveis via account-insights
  // NOTA: definida APÓS eligibleAccounts para evitar referência antes da inicialização
  const syncUsernames = useCallback(async () => {
    if (syncingNames || eligibleAccounts.length === 0) return;
    setSyncingNames(true);
    setSyncResult(null);
    let updated = 0;

    for (const acc of eligibleAccounts) {
      if (!acc.access_token) continue;
      try {
        const res  = await fetch("/api/account-insights", {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ instagram_id: acc.id, access_token: acc.access_token }),
        });
        const json = await res.json();
        if (res.ok && !json.error && json.username) {
          const changed = json.username !== acc.username || json.profile_picture !== acc.profile_picture;
          if (changed) {
            await addAccounts([{
              ...acc,
              username:        json.username,
              name:            json.name            || acc.name,
              profile_picture: json.profile_picture || acc.profile_picture,
              followers_count: json.followers_count ?? acc.followers_count,
            }]);
            updated++;
          }
        }
      } catch { /* ignora falhas individuais */ }
    }

    await reloadAccounts();
    setSyncResult({ updated, total: eligibleAccounts.length });
    setSyncingNames(false);
  }, [syncingNames, eligibleAccounts, addAccounts, reloadAccounts]);

  const addFiles = useCallback((typeId, newFiles) => {
    const entries = Array.from(newFiles).map((file) => ({
      id: `${typeId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      file, name: file.name, size: file.size,
      status: "idle", progress: 0, url: "", error: "", typeId,
    }));
    setFiles((prev) => ({ ...prev, [typeId]: [...(prev[typeId] || []), ...entries] }));
  }, []);

  const removeAllFiles = useCallback((typeId) => {
    setFiles((prev) => ({ ...prev, [typeId]: [] }));
  }, [setFiles]);

  const resetAllFiles = useCallback(() => {
    setFiles({ reels: [], feed: [], stories: [] });
  }, [setFiles]);

  // Adiciona mídias a partir de URLs externas (já prontas, sem upload)
  const addFilesByUrl = useCallback((typeId, urls) => {
    const entries = urls.map((url) => {
      const name = url.split("/").pop().split("?")[0] || "media";
      return {
        id:       `${typeId}-url-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        file:     null,
        name,
        size:     0,
        status:   "done",   // já está pronta — não precisa de upload
        sanitizationReport: null,
        progress: 100,
        url,
        error:    "",
        typeId,
        fromUrl:  true,
      };
    });
    setFiles((prev) => ({ ...prev, [typeId]: [...(prev[typeId] || []), ...entries] }));
  }, []);

  // Atualiza o campo de texto de URL por tipo
  const updateUrlInput = useCallback((typeId, value) => {
    setUrlInputs((prev) => ({ ...prev, [typeId]: value }));
  }, []);


  const stats = useMemo(() => {
    const count = (t, s) => (files[t] || []).filter((f) => f.status === s).length;
    return {
      reelsDone:    count("reels",   "done"),
      feedDone:     count("feed",    "done"),
      storiesDone:  count("stories", "done"),
      totalDone:    ["reels","feed","stories"].reduce((s, t) => s + count(t, "done"), 0),
      totalPending: ["reels","feed","stories"].reduce((s, t) => s + count(t, "idle") + count(t, "error"), 0),
    };
  }, [files]);

  // Mantém filesRef sempre atualizado para evitar stale closure no generateQueue
  useEffect(() => { filesRef.current = files; }, [files]);

  const reelFiles      = (files.reels || []).filter((f) => f.file);
  const parsedCaptions = useMemo(() => bulkCaptions.split("\n").map((l) => l.trim()).filter(Boolean), [bulkCaptions]);

  const generateQueue = useCallback(() => {
    const currentFiles = filesRef.current;
    const totalDone = ["reels","feed","stories"].reduce((s, t) => s + (currentFiles[t]||[]).filter(f=>f.status==="done").length, 0);
    if (!totalDone) { alert("Adicione pelo menos 1 URL de mídia antes de gerar a fila."); return; }
    if (!selectedAccounts.length) { alert("Selecione pelo menos uma conta para o aquecimento."); return; }
    const mediaByType = {
      reels:   (currentFiles.reels   || []).filter((f) => f.status === "done").map((f) => ({ url: f.url, name: f.name })),
      feed:    (currentFiles.feed    || []).filter((f) => f.status === "done").map((f) => ({ url: f.url, name: f.name })),
      stories: (currentFiles.stories || []).filter((f) => f.status === "done").map((f) => ({ url: f.url, name: f.name })),
    };

    let generated;

    if (configMode === "target") {
      // Modo target: gera dias sintéticos baseados na meta
      const { reels, feed, stories, periodHours, days, windowStart, windowEnd } = targetConfig;
      const totalT = reels + feed + stories;
            const syntheticDays = Array.from({ length: days }, (_, i) => ({
        day: i + 1,
        label: `Dia ${i + 1}`,
        reels, feed, stories,
        windowStart, windowEnd,
        intervalMinMin: 60,
        intervalMinMax: 120,
        targetMode: true,
        targetCount: totalT,
        targetPeriodHours: periodHours,
      }));
      generated = buildWarmupQueue({
        accounts: selectedAccounts, mediaByType,
        captions: parsedCaptions, captionMode,
        preset: { ...WARMUP_PRESET_2D, days: syntheticDays },
        startDateStr: startDate, distribution,
        loopEnabled: false, loopDays: 0,
        thumbUrl,
      });
    } else {
      // Modo preset (por dia)
      const activeDays = dayConfig.filter((d) => selectedDays.includes(d.day));
      if (!activeDays.length) { alert("Selecione pelo menos um dia para gerar a fila."); return; }
      generated = buildWarmupQueue({
        accounts: selectedAccounts, mediaByType,
        captions: parsedCaptions, captionMode,
        preset: { ...WARMUP_PRESET_2D, days: activeDays },
        startDateStr: startDate, distribution,
        loopEnabled, loopDays,
        thumbUrl,
      });
    }

    if (!generated.length) { alert("Nenhum post gerado. Verifique se há mídias prontas compatíveis com os tipos configurados."); return; }
    setQueue(generated);
    setSaved(false);
    // fila gerada
  }, [selectedAccounts, parsedCaptions, captionMode, dayConfig, selectedDays, startDate, distribution, loopEnabled, loopDays, configMode, targetConfig]);

  const cancelWarmupQueue = useCallback(async () => {
    if (!window.confirm("Cancelar toda a fila de aquecimento pendente? Posts já publicados não serão desfeitos.")) return;
    try {
      const all = await dbGetAll("queue");
      const toRemove = all.filter((x) => x.warmup && x.status === "pending");
      for (const item of toRemove) {
        await dbPut("queue", { ...item, status: "cancelled" });
      }
      const q = await dbGetAll("queue");
      setDbQueue(q.filter((x) => x.warmup));
      setQueue([]);
    } catch (err) {
      alert("Erro ao cancelar fila: " + err.message);
    }
  }, []);

  const confirmQueue = useCallback(async () => {
    if (!queue.length) return;
    setSaving(true);
    try {
      await addBatch(queue);
      window.dispatchEvent(new CustomEvent("sw:queue-update"));
      setSaved(true);
      // monitoramento removido
      const q = await dbGetAll("queue");
      setDbQueue(q.filter((x) => x.warmup));
    } catch (err) {
      alert(`Erro ao salvar: ${err.message}`);
    } finally {
      setSaving(false);
    }
  }, [queue, addBatch]);

  const updateDayConfig = (dayNum, key, value) => {
    setDayConfig((prev) =>
      prev.map((d) => d.day === dayNum ? { ...d, [key]: value } : d)
    );
  };

  const previewStats = useMemo(() => {
    const byAcc  = {};
    // Filtrar reels bloqueados (< 5s) antes de agendar
    const MIN_REEL_DURATION = 5;
    const byType = { reels: 0, feed: 0, stories: 0 };
    queue.forEach((s) => {
      byAcc[s.username] = (byAcc[s.username] || 0) + 1;
      if (byType[s.mediaCategory] !== undefined) byType[s.mediaCategory]++;
    });
    return { byAcc, byType, total: queue.length };
  }, [queue]);

  // ─── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="page" style={{ maxWidth: 980 }}>

      {/* Header */}
      <div className="page-header">
        <div>
          <h1 className="page-title">🔥 Aquecimento de Contas</h1>
          <p className="page-subtitle">
            Aquece contas novas em 2 dias com Reels, Feed e Stories — proteção máxima e agendamento inteligente.
          </p>
        </div>
        <div style={{ display: "flex", gap: 10, flexShrink: 0 }}>
          {[
            { icon: "👥", value: selectedAccounts.length, label: "contas novas",   color: "var(--accent)"  },
            { icon: "📁", value: stats.totalDone,          label: "mídias prontas", color: "var(--success)" },
            { icon: "📅", value: queue.length,             label: "na fila",        color: "var(--warning)" },
          ].map(({ icon, value, label, color }) => (
            <div key={label} className="card card-sm" style={{ textAlign: "center", minWidth: 72 }}>
              <div style={{ fontSize: 18, fontWeight: 800, color }}>{value}</div>
              <div style={{ fontSize: 9, color: "var(--muted)", marginTop: 1 }}>{label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: 2, marginBottom: 24, background: "var(--bg2)", padding: 4, borderRadius: 12, width: "fit-content", overflowX: "auto" }}>
        {TABS.map(({ id, icon, label }) => (
          <button key={id} onClick={() => setTab(id)} style={{
            padding: "8px 14px", borderRadius: 9, fontSize: 12, fontWeight: tab === id ? 700 : 400,
            background: tab === id ? "var(--accent)" : "transparent",
            color: tab === id ? "#fff" : "var(--muted)",
            border: "none", cursor: "pointer", whiteSpace: "nowrap",
            display: "flex", alignItems: "center", gap: 5, transition: "all 0.15s",
          }}>
            <span style={{ fontSize: 13 }}>{icon}</span>
            {label}
            {id === "preview" && queue.length > 0 && !saved && (
              <span style={{ fontSize: 10, fontWeight: 800, padding: "1px 6px", background: "rgba(255,255,255,0.25)", borderRadius: 20 }}>
                {queue.length}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* ══ TAB: Upload ══════════════════════════════════════════════════════════ */}
      {tab === "upload" && (
        <div>
          {/* Botão reset geral — só aparece se há arquivos */}
          {(stats.reelsTotal > 0 || stats.feedTotal > 0 || stats.storiesTotal > 0) && (
            <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 10 }}>
              <button
                className="btn btn-ghost btn-sm"
                style={{ fontSize: 11, color: "var(--danger)", borderColor: "rgba(239,68,68,0.3)" }}
                onClick={resetAllFiles}
              >
                🗑 Limpar todas as mídias
              </button>
            </div>
          )}
          <div style={{
            padding: "12px 16px", borderRadius: 10, marginBottom: 20,
            background: "rgba(124,92,252,0.06)", border: "1px solid rgba(124,92,252,0.2)",
            fontSize: 12, color: "var(--muted)", display: "flex", gap: 10,
          }}>
            <span style={{ fontSize: 16, flexShrink: 0 }}>💡</span>
            <div>
              <b style={{ color: "var(--text)" }}>Estratégia:</b> priorize Reels (maior alcance orgânico),
              adicione Feeds para credibilidade do perfil e Stories para engajamento diário.
              Cada conta recebe a distribuição proporcional ao plano configurado.
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 14, marginBottom: 20 }}>
            {MEDIA_TYPES.map((typeConfig) => (
              <div key={typeConfig.id} className="card">
                <MediaUploadZone
                  typeConfig={typeConfig}
                  files={files}
                  onAddFiles={addFiles}
                  onRemoveFile={removeFile}
                  onRemoveAll={removeAllFiles}
                  urlInput={urlInputs[typeConfig.id]}
                  onUrlInputChange={updateUrlInput}
                  onAddUrl={addFilesByUrl}
                  onUpdateFile={updateFile}
                />
              </div>
            ))}
          </div>

          {/* Capa para Reels */}
          {reelFiles.length > 0 && (
            <div className="card" style={{ marginBottom: 12, padding: "14px 16px" }}>
              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>🖼 Capa do Reel (opcional)</div>
              <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 8 }}>
                URL de uma imagem JPG/PNG que será usada como thumbnail do Reel. Se não definida, o Instagram usa o primeiro frame.
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  type="url"
                  value={thumbUrl}
                  onChange={(e) => setThumbUrl(e.target.value)}
                  placeholder="https://exemplo.com/capa.jpg"
                  style={{ flex: 1, fontSize: 12, fontFamily: "monospace" }}
                />
                {thumbUrl && (
                  <button className="btn btn-ghost btn-sm" onClick={() => setThumbUrl("")}>✕</button>
                )}
              </div>
              {thumbUrl && (
                <div style={{ marginTop: 8, borderRadius: 8, overflow: "hidden", maxWidth: 120 }}>
                  <img src={thumbUrl} alt="capa" style={{ width: "100%", display: "block", borderRadius: 8 }}
                    onError={(e) => { e.target.style.display = "none"; }} />
                </div>
              )}
            </div>
          )}


          {stats.totalDone > 0 && (
            <div style={{
              marginTop: 20, padding: "14px 18px", borderRadius: 12,
              background: "rgba(34,197,94,0.06)", border: "1px solid rgba(34,197,94,0.2)",
              display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10,
            }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: 13 }}>✅ {stats.totalDone} mídia{stats.totalDone > 1 ? "s" : ""} prontas</div>
                <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
                  🎬 {stats.reelsDone} Reels · 🖼 {stats.feedDone} Feed · ⭕ {stats.storiesDone} Stories
                </div>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="btn btn-ghost btn-sm" onClick={() => setTab("captions")}>💬 Legendas</button>
                <button className="btn btn-primary btn-sm" onClick={() => setTab("config")}>⚙️ Configurar →</button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ══ TAB: Legendas ════════════════════════════════════════════════════════ */}
      {tab === "captions" && (
        <div>
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 11, color: "var(--muted)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>
              Exemplos por categoria
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {[
                { label: "🔥 Motivacional",
                  lines: ["Cada dia é uma nova oportunidade de ser melhor 💪 #motivação #crescimento","Não desista. O começo é sempre o mais difícil 🚀 #foco #sucesso","Acredite no processo, os resultados vêm ✨ #mindset #evolução"] },
                { label: "💰 Vendas",
                  lines: ["Promoção exclusiva só hoje! Aproveite 🔥 #oferta #desconto","Qualidade que você merece, preço que cabe no bolso 💎 #qualidade","Últimas unidades disponíveis — corre! 🏃 #limitado #exclusivo"] },
                { label: "❤️ Engajamento",
                  lines: ["Me conta nos comentários: qual é o seu plano para hoje? 👇 #comunidade","Salva esse post para não esquecer! ⭐ #dica #conteúdo","Compartilha com quem precisa ver isso agora 🙌 #compartilha"] },
                { label: "🎯 Viral",
                  lines: ["Isso que você não te contaram sobre 👀 #segredo #viral","POV: quando você finalmente descobre o truque 😮 #pov #relatable","Quem mais passou por isso? 😅 #reels #fyp"] },
              ].map(({ label, lines }) => (
                <button key={label} className="btn btn-ghost btn-xs" onClick={() => setBulkCaptions(lines.join("\n"))}>
                  {label}
                </button>
              ))}
            </div>
          </div>

          <BulkCaptions
            value={bulkCaptions}
            onChange={setBulkCaptions}
            mode={captionMode}
            onModeChange={setCaptionMode}
            previewCount={Math.min(stats.totalDone || 3, 6)}
          />

          <div style={{ marginTop: 16, display: "flex", justifyContent: "flex-end" }}>
            <button className="btn btn-primary btn-sm" onClick={() => setTab("config")}>⚙️ Ir para Configuração →</button>
          </div>
        </div>
      )}

      {/* ══ TAB: Configuração ════════════════════════════════════════════════════ */}
      {tab === "config" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>

          {/* Seletor de modo */}
          <div className="card">
            <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 12 }}>⚙️ Modo de Configuração</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {/* Google Drive */}
              <button onClick={() => setConfigMode("drive")} style={{
                flex: 1, minWidth: 140, padding: "12px 14px", borderRadius: 10, cursor: "pointer", textAlign: "left",
                border: `1.5px solid ${configMode === "drive" ? "rgba(66,133,244,0.7)" : "var(--border)"}`,
                background: configMode === "drive"
                  ? "linear-gradient(135deg, rgba(66,133,244,0.1) 0%, rgba(52,168,83,0.07) 50%, rgba(251,188,5,0.06) 100%)"
                  : "var(--bg3)",
                transition: "all 0.15s",
              }}>
                <div style={{ marginBottom: 6 }}>
                  <svg width="24" height="24" viewBox="0 0 87.3 78" xmlns="http://www.w3.org/2000/svg">
                    <path d="m6.6 66.85 3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3l13.75-23.8h-27.5c0 1.55.4 3.1 1.2 4.5z" fill="#0066da"/>
                    <path d="m43.65 25-13.75-23.8c-1.35.8-2.5 1.9-3.3 3.3l-25.4 44a9.06 9.06 0 0 0 -1.2 4.5h27.5z" fill="#00ac47"/>
                    <path d="m73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 7.65-13.25c.8-1.4 1.2-2.95 1.2-4.5h-27.502l5.852 11.5z" fill="#ea4335"/>
                    <path d="m43.65 25 13.75-23.8c-1.35-.8-2.9-1.2-4.5-1.2h-18.5c-1.6 0-3.15.45-4.5 1.2z" fill="#00832d"/>
                    <path d="m59.8 53h-32.3l-13.75 23.8c1.35.8 2.9 1.2 4.5 1.2h50.8c1.6 0 3.15-.45 4.5-1.2z" fill="#2684fc"/>
                    <path d="m73.4 26.5-12.7-22c-.8-1.4-1.95-2.5-3.3-3.3l-13.75 23.8 16.15 27h27.45c0-1.55-.4-3.1-1.2-4.5z" fill="#ffba00"/>
                  </svg>
                </div>
                <div style={{ fontWeight: 700, fontSize: 13, color: configMode === "drive" ? "#4285f4" : "var(--text)" }}>Google Drive</div>
                <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>Agenda posts direto do seu Drive com horário e intervalo personalizados</div>
              </button>
            </div>
          </div>

          {/* ── Modo Target ── */}
          {/* Preset ativo */}

          {/* Seleção de contas */}
          <div className="card">
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
              <div style={{ fontWeight: 600, fontSize: 13 }}>👥 Contas para Aquecimento</div>
              <button
                className="btn btn-ghost btn-xs"
                onClick={syncUsernames}
                disabled={syncingNames || eligibleAccounts.length === 0}
                title="Atualizar usernames e fotos das contas via Meta API"
                style={{ display: "flex", alignItems: "center", gap: 5 }}
              >
                {syncingNames
                  ? <><span className="spinner" style={{ width: 11, height: 11 }} /> Sincronizando...</>
                  : "↻ Sincronizar nomes"}
              </button>
            </div>

            {/* Resultado da sincronização */}
            {syncResult && (
              <div style={{
                marginBottom: 10, padding: "6px 12px", borderRadius: 7, fontSize: 11,
                background: syncResult.updated > 0 ? "rgba(34,197,94,0.08)" : "var(--bg3)",
                border: `1px solid ${syncResult.updated > 0 ? "rgba(34,197,94,0.25)" : "var(--border)"}`,
                color: syncResult.updated > 0 ? "var(--success)" : "var(--muted)",
                display: "flex", alignItems: "center", gap: 6,
              }}>
                {syncResult.updated > 0
                  ? `✓ ${syncResult.updated} conta(s) atualizada(s) de ${syncResult.total}`
                  : `✓ Todos os usernames já estão atualizados (${syncResult.total} conta(s))`}
                <button onClick={() => setSyncResult(null)} style={{ marginLeft: "auto", background: "none", border: "none", color: "var(--muted)", cursor: "pointer", fontSize: 13, padding: 0, lineHeight: 1 }}>×</button>
              </div>
            )}
            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", textTransform: "none", letterSpacing: 0, fontSize: 13, color: "var(--text)", marginBottom: 12 }}>
              <input
                type="checkbox"
                checked={useNewOnly}
                onChange={(e) => setUseNewOnly(e.target.checked)}
                style={{ width: 16, height: 16, accentColor: "var(--accent)" }}
              />
              Usar apenas contas novas ({NEW_ACCOUNT_DAYS} dias ou menos)
            </label>

            {eligibleAccounts.length === 0 ? (
              <div style={{ padding: "10px 14px", borderRadius: 8, background: "rgba(245,158,11,0.06)", border: "1px solid rgba(245,158,11,0.2)", fontSize: 12, color: "var(--warning)" }}>
                ⚠️ Nenhuma conta elegível. {useNewOnly ? "Desmarque o filtro ou aguarde contas novas." : "Conecte contas primeiro."}
              </div>
            ) : (
              <>
                {/* Botões de seleção rápida */}
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                  <span style={{ fontSize: 11, color: "var(--muted)" }}>
                    {selectedAccounts.length} de {eligibleAccounts.length} selecionada{eligibleAccounts.length !== 1 ? "s" : ""}
                  </span>
                  <button className="btn btn-ghost btn-xs" onClick={selectAll}
                    style={{ color: selectedAccIds === null ? "var(--accent-light)" : undefined }}>
                    ✓ Todas
                  </button>
                  <button className="btn btn-ghost btn-xs" onClick={selectNone}>
                    ✕ Nenhuma
                  </button>
                </div>

                {/* Grid de contas com checkbox */}
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))", gap: 8 }}>
                  {eligibleAccounts.map((acc) => {
                    const day = warmupDay(acc.connected_at || new Date().toISOString());
                    const isSelected = selectedAccIds === null || selectedAccIds.includes(acc.id);
                    return (
                      <div
                        key={acc.id}
                        onClick={() => toggleAccount(acc.id)}
                        style={{
                          padding: "8px 12px", borderRadius: 8, cursor: "pointer",
                          background: isSelected ? "rgba(124,92,252,0.08)" : "var(--bg3)",
                          border: `1px solid ${isSelected ? "var(--accent)" : "var(--border)"}`,
                          display: "flex", alignItems: "center", gap: 8,
                          transition: "all 0.12s",
                          opacity: isSelected ? 1 : 0.5,
                        }}
                      >
                        {/* Checkbox visual */}
                        <div style={{
                          width: 16, height: 16, borderRadius: 4, flexShrink: 0,
                          border: `2px solid ${isSelected ? "var(--accent)" : "var(--border2)"}`,
                          background: isSelected ? "var(--accent)" : "transparent",
                          display: "flex", alignItems: "center", justifyContent: "center",
                          transition: "all 0.12s",
                        }}>
                          {isSelected && <span style={{ color: "#fff", fontSize: 10, fontWeight: 900, lineHeight: 1 }}>✓</span>}
                        </div>
                        {/* Avatar com foto ou inicial */}
                        <div style={{ width: 24, height: 24, borderRadius: "50%", flexShrink: 0, overflow: "hidden", border: "1px solid var(--border2)" }}>
                          {acc.profile_picture
                            ? <img src={acc.profile_picture} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} onError={(e) => { e.target.style.display = "none"; }} />
                            : <div style={{ width: "100%", height: "100%", background: "linear-gradient(135deg, var(--accent), #9b4dfc)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 700, color: "#fff" }}>
                                {(acc.nickname || acc.name || acc.username || "?")[0].toUpperCase()}
                              </div>}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 12, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {acc.nickname || acc.name || `@${acc.username}`}
                          </div>
                          <div style={{ fontSize: 10, color: "var(--muted)" }}>@{acc.username} · Dia {day}</div>
                        </div>
                        <div style={{ width: 7, height: 7, borderRadius: "50%", background: isNewAccount(acc) ? "var(--success)" : "var(--muted)", flexShrink: 0 }} />
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>


          {/* ══ Modo Google Drive ══════════════════════════════════════════════════ */}
          {configMode === "drive" && (
          <div className="card" style={{
            border: "1px solid rgba(66,133,244,0.3)",
            background: "linear-gradient(135deg, rgba(66,133,244,0.04) 0%, rgba(52,168,83,0.03) 50%, rgba(251,188,5,0.03) 100%)",
          }}>
            {/* Header */}
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20 }}>
              <div style={{
                width: 40, height: 40, borderRadius: 11,
                background: "rgba(255,255,255,0.07)",
                border: "1px solid rgba(66,133,244,0.25)",
                display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
              }}>
                <svg width="24" height="24" viewBox="0 0 87.3 78" xmlns="http://www.w3.org/2000/svg">
                  <path d="m6.6 66.85 3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3l13.75-23.8h-27.5c0 1.55.4 3.1 1.2 4.5z" fill="#0066da"/>
                  <path d="m43.65 25-13.75-23.8c-1.35.8-2.5 1.9-3.3 3.3l-25.4 44a9.06 9.06 0 0 0 -1.2 4.5h27.5z" fill="#00ac47"/>
                  <path d="m73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 7.65-13.25c.8-1.4 1.2-2.95 1.2-4.5h-27.502l5.852 11.5z" fill="#ea4335"/>
                  <path d="m43.65 25 13.75-23.8c-1.35-.8-2.9-1.2-4.5-1.2h-18.5c-1.6 0-3.15.45-4.5 1.2z" fill="#00832d"/>
                  <path d="m59.8 53h-32.3l-13.75 23.8c1.35.8 2.9 1.2 4.5 1.2h50.8c1.6 0 3.15-.45 4.5-1.2z" fill="#2684fc"/>
                  <path d="m73.4 26.5-12.7-22c-.8-1.4-1.95-2.5-3.3-3.3l-13.75 23.8 16.15 27h27.45c0-1.55-.4-3.1-1.2-4.5z" fill="#ffba00"/>
                </svg>
              </div>
              <div>
                <div style={{ fontWeight: 700, fontSize: 15, color: "#4285f4" }}>Google Drive</div>
                <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 1 }}>
                  Agendamento direto da sua nuvem
                </div>
              </div>
            </div>

            <div style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 12 }}>
              Configuração de Agendamento
            </div>

            <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(140px,1fr))", gap:10, marginBottom: 12 }}>
              <div>
                <div style={{ fontSize:11, color:"var(--muted)", marginBottom:4 }}>
                  Início <span style={{ color:"var(--accent-light)", fontWeight:600 }}>(Brasília)</span>
                </div>
                <input type="datetime-local" value={driveStartTime} onChange={e=>setDriveStartTime(e.target.value)}
                  style={{ background:"var(--bg3)", color:"var(--fg)", border:"1px solid var(--border)", borderRadius:7, padding:"6px 10px", fontSize:13, width:"100%" }} />
                <div style={{ fontSize:10, color:"var(--muted)", marginTop:3 }}>🇧🇷 BRT (UTC-3) — padrão: agora + 15 min</div>
              </div>
              <div>
                <div style={{ fontSize:11, color:"var(--muted)", marginBottom:4 }}>Tipo de post</div>
                <select value={drivePostType} onChange={e=>setDrivePostType(e.target.value)}
                  style={{ background:"var(--bg3)", color:"var(--fg)", border:"1px solid var(--border)", borderRadius:7, padding:"6px 10px", fontSize:13, width:"100%" }}>
                  <option value="REEL">🎬 Reel</option>
                  <option value="FEED">🖼 Feed (vídeo)</option>
                  <option value="STORY">⭕ Story</option>
                </select>
              </div>
              <div>
                <div style={{ fontSize:11, color:"var(--muted)", marginBottom:4 }}>Intervalo entre posts</div>
                <select value={driveGapMinutes} onChange={e=>setDriveGapMinutes(Number(e.target.value))}
                  style={{ background:"var(--bg3)", color:"var(--fg)", border:"1px solid var(--border)", borderRadius:7, padding:"6px 10px", fontSize:13, width:"100%" }}>
                  <option value={10}>10 min</option>
                  <option value={30}>30 min</option>
                  <option value={60}>1 hora</option>
                  <option value={120}>2 horas</option>
                  <option value={360}>6 horas</option>
                  <option value={720}>12 horas</option>
                  <option value={1440}>1 dia</option>
                </select>
              </div>
              <div>
                <div style={{ fontSize:11, color:"var(--muted)", marginBottom:4 }}>Variação (jitter)</div>
                <select value={driveJitterMin} onChange={e=>setDriveJitterMin(Number(e.target.value))}
                  style={{ background:"var(--bg3)", color:"var(--fg)", border:"1px solid var(--border)", borderRadius:7, padding:"6px 10px", fontSize:13, width:"100%" }}>
                  <option value={0}>Sem variação</option>
                  <option value={5}>± 5 min</option>
                  <option value={10}>± 10 min</option>
                  <option value={15}>± 15 min</option>
                  <option value={20}>± 20 min</option>
                  <option value={30}>± 30 min</option>
                </select>
              </div>
            </div>

            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize:11, color:"var(--muted)", marginBottom:4 }}>Legenda (opcional)</div>
              <textarea value={driveCaption} onChange={e=>setDriveCaption(e.target.value)}
                placeholder="Escreva a legenda dos posts do Drive..."
                rows={2}
                style={{ background:"var(--bg3)", color:"var(--fg)", border:"1px solid var(--border)", borderRadius:7, padding:"6px 10px", fontSize:13, width:"100%", resize:"vertical", fontFamily:"inherit" }} />
            </div>

            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", flexWrap:"wrap", gap:10 }}>
              <label style={{ display:"flex", alignItems:"center", gap:7, cursor:"pointer", userSelect:"none", fontSize:12, color:driveLoop?"var(--accent-light)":"var(--muted)" }}>
                <div onClick={()=>setDriveLoop(v=>!v)} style={{ width:36, height:20, borderRadius:10, position:"relative", background:driveLoop?"var(--accent)":"var(--bg3)", border:`1px solid ${driveLoop?"var(--accent)":"var(--border)"}`, transition:"all 0.2s", cursor:"pointer", flexShrink:0 }}>
                  <div style={{ position:"absolute", top:2, left:driveLoop?17:2, width:14, height:14, borderRadius:"50%", background:"#fff", transition:"left 0.2s" }} />
                </div>
                🔁 Loop diário
              </label>
            </div>

            <div style={{ marginTop: 16, padding:"9px 12px", borderRadius:8, background:"rgba(66,133,244,0.06)", border:"1px solid rgba(66,133,244,0.15)", fontSize:11, color:"var(--muted)", lineHeight:1.6 }}>
              <span style={{ color:"#4285f4", fontWeight:700 }}>Como usar:</span> selecione os vídeos no seletor do Drive (aba Upload de Mídias), configure o horário e intervalo acima, depois clique em <b>Gerar Fila</b>.
            </div>
          </div>
          )}

          {/* Blocos exclusivos do modo Preset */}

          <button
            className="btn btn-primary"
            onClick={generateQueue}
            disabled={!selectedAccounts.length || !stats.totalDone}
            style={{ width: "100%", padding: "14px", fontSize: 14 }}
          >
            {!stats.totalDone
              ? "📎 Adicione URLs de mídias primeiro"
              : !selectedAccounts.length
                ? "👥 Nenhuma conta elegível"
                : `🚀 Gerar Fila — ${selectedAccounts.length} conta(s)`}
          </button>

          <div style={{ padding: "12px 16px", borderRadius: 10, background: "rgba(245,158,11,0.05)", border: "1px solid rgba(245,158,11,0.15)", fontSize: 11, color: "var(--muted)" }}>
            🛡️ <b style={{ color: "var(--warning)" }}>Proteção ativada:</b> jitter de ±40 minutos e segundos aleatórios em cada slot para evitar padrões detectáveis.
            Sanitização de metadados aplicada automaticamente no momento da publicação via publish.mjs.
          </div>
        </div>
      )}

    </div>
  );
}
