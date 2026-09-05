"use client";

import { memo, useCallback, useEffect, useId, useRef, useState, type ChangeEvent } from "react";
import { Icon } from "@/components/ui/icon";
import { VisionReferenceSelection } from "@/components/vision-reference-selection";
import type { LiveGateSummaryData } from "@/components/live-gate-summary";
import { useLiveVision } from "@/hooks/use-live-vision";
import { LIVE_VISION_SAMPLE_FPS, type LiveVisionController, type LiveVisionOptions } from "@/lib/live-vision-types";
import type { VisionRect, VisionResolvedEvent } from "@/lib/vision-lab-types";
import type { VisionTrackerRejection } from "@/lib/vision-timing";
import styles from "./live-gate-panel.module.css";

interface LiveGatePanelProps extends LiveVisionOptions {
  configurationLocked?: boolean;
  startBlockReason?: string | null;
  sourceLabel?: string;
  onProfileChange: (pilotChannelId: string, profileId: string | null) => void;
  onSummaryChange?: (summary: LiveGateSummaryData) => void;
}

const states: Record<LiveVisionController["state"], string> = {
  idle: "待准备", loading: "准备模型", monitoring: "监测中", stopped: "已停止", interrupted: "已中断", error: "需要处理",
};
const eventStates: Record<VisionResolvedEvent["status"], string> = { pending: "待确认", confirmed: "人工确认", rejected: "已排除" };
const fullRect: VisionRect = { x: 0, y: 0, width: 1, height: 1 };

function clockText(timeMs: number) {
  const value = Math.max(0, Number.isFinite(timeMs) ? Math.round(timeMs) : 0);
  return `${String(Math.floor(value / 60_000)).padStart(2, "0")}:${String(Math.floor(value / 1_000) % 60).padStart(2, "0")}.${String(value % 1_000).padStart(3, "0")}`;
}
function dateText(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "未记录日期" : date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}
function messageFor(error: unknown) { return error instanceof Error ? error.message : "操作未完成，请重试"; }

const trackerRejections: Record<VisionTrackerRejection, string> = {
  insufficient_observations: "匹配帧数不足", insufficient_growth: "目标面积增长不足",
  cooldown: "仍在候选冷却期", observation_gap: "分析观测间隔过长", matched_gap: "有效匹配间隔过长",
};
function diagnosticStatus(live: LiveVisionController) {
  const sample = live.diagnostics?.lastSample;
  if (!sample) return "等待第一帧分析结果";
  const tracker = sample.tracker;
  if (tracker.status === "rejected" && tracker.lastRejection) return `${trackerRejections[tracker.lastRejection]}，本次未形成穿越候选`;
  if (tracker.status === "proposed") return "已形成穿越候选，等待人工确认";
  if (tracker.status === "waiting_exit") return "匹配暂时离开画面，等待离场确认";
  if (sample.acceptedMatches === 0) return sample.bestMatch ? "本帧最佳匹配低于阈值，尚未进入穿越跟踪" : "本帧没有可用匹配框";
  if (tracker.trackObservations < tracker.requiredObservations) return `已匹配 ${tracker.trackObservations} 帧，至少需要 ${tracker.requiredObservations} 帧`;
  if ((tracker.growthRatio ?? 0) < tracker.requiredGrowthRatio) return `已匹配 ${tracker.trackObservations} 帧，目标面积增长仍不足 ${Math.round((tracker.requiredGrowthRatio - 1) * 100)}%`;
  return "接近条件已满足，等待目标离场或明显缩小";
}
function diagnosticNumber(value: number | null | undefined, decimals = 1) {
  return value === null || value === undefined || !Number.isFinite(value) ? "—" : value.toFixed(decimals);
}

function LiveGateDiagnostics({ live, disabled, perform }: {
  live: LiveVisionController;
  disabled: boolean;
  perform: (action: () => Promise<void>) => Promise<void>;
}) {
  const diagnostics = live.diagnostics;
  const sample = diagnostics?.lastSample;
  const tracker = sample?.tracker;
  const attachCanvas = live.attachDiagnosticCanvas;
  const canvasRef = useCallback((canvas: HTMLCanvasElement | null) => { attachCanvas(canvas); }, [attachCanvas]);
  return <section className={styles.diagnostics} aria-label="本机识别诊断">
    <div className={styles.diagnosticSummary}>
      <div><span>输入呈现 fps</span><b data-testid="live-input-fps">{diagnosticNumber(diagnostics?.inputFps)}</b></div>
      <div><span>实际分析 fps</span><b data-testid="live-analysis-fps">{diagnosticNumber(diagnostics?.analysisFps)}</b></div>
      <div><span>分析上限 fps</span><b>{diagnostics?.targetFps ?? "—"}</b></div>
      <div><span>计算后端</span><b>{diagnostics?.backend ?? "尚未加载"}</b></div>
    </div>
    <p className={styles.diagnosticStatus} data-testid="live-matching-status">{diagnosticStatus(live)}</p>
    {diagnostics?.fallbackReason ? <p className={styles.hint}>后端回退：{diagnostics.fallbackReason}</p> : null}
    <details className={styles.diagnosticDetails} open>
      <summary>查看匹配画面与分析原因</summary>
      <div className={styles.diagnosticGrid}>
        <div>
          <div className={styles.diagnosticPreview}>
            <canvas ref={canvasRef} aria-label="最近分析画面" />
            {!sample ? <span>开始后显示实际送入模型的取景</span> : null}
          </div>
          <p className={styles.hint}>最近分析画面 · 黄框低于阈值，绿框达到阈值；匹配框不代表已穿越。</p>
        </div>
        <div>
          <dl className={styles.diagnosticMetrics}>
            <div><dt>最佳余弦相似度</dt><dd data-testid="live-best-similarity">{diagnosticNumber(sample?.bestMatch?.similarity, 3)}</dd></div>
            <div><dt>匹配阈值</dt><dd>{diagnosticNumber(diagnostics?.threshold, 3)}</dd></div>
            <div><dt>匹配 / 分析帧</dt><dd>{tracker ? `${tracker.matchedObservations} / ${tracker.observations}` : "—"}</dd></div>
            <div><dt>当前跟踪帧</dt><dd>{tracker ? `${tracker.trackObservations} / 至少 ${tracker.requiredObservations}` : "—"}</dd></div>
            <div><dt>峰值 / 初始面积</dt><dd>{tracker ? `${diagnosticNumber(tracker.growthRatio, 2)} / 需 ${tracker.requiredGrowthRatio.toFixed(2)}` : "—"}</dd></div>
            <div><dt>推理 P50 / P95</dt><dd>{diagnosticNumber(diagnostics?.inferenceP50Ms, 0)} / {diagnosticNumber(diagnostics?.inferenceP95Ms, 0)} ms</dd></div>
          </dl>
          <p className={styles.hint}>相似度是余弦分数，并非识别概率。静止看见门但缺少接近、离场过程时，不会自动记为穿越。</p>
        </div>
      </div>
      <div className={styles.diagnosticFoot}>
        <div>
          {sample ? <p className={styles.hint}>最近一帧：取景 {diagnosticNumber(sample.captureMs, 0)} ms · Worker 往返 {diagnosticNumber(sample.roundTripMs, 0)} ms · 预处理 {diagnosticNumber(sample.preprocessMs, 0)} ms · 模型 {diagnosticNumber(sample.modelMs, 0)} ms · 匹配 {diagnosticNumber(sample.matchingMs, 0)} ms</p> : null}
          {diagnostics ? <p className={styles.hint}>未分析呈现帧：忙碌 {diagnostics.counters.busy} · 节流 {diagnostics.counters.throttled} · 重复 {diagnostics.counters.duplicate} · 回调未报告 {diagnostics.counters.unreported}。上限只限制请求，实际速度以完成分析为准。</p> : null}
          {tracker ? <p className={styles.hint}>跟踪结束原因：{Object.entries(tracker.rejectionCounts).map(([reason, count]) => `${trackerRejections[reason as VisionTrackerRejection]} ${count}`).join(" · ")}。</p> : null}
        </div>
        <button className={styles.button} type="button" disabled={disabled || !diagnostics} onClick={() => void perform(live.exportDiagnostics)}>导出本机诊断 JSON</button>
      </div>
      <p className={styles.hint}>诊断 JSON 包含最近最多 120 次分析元数据，不包含图片，不上传画面。</p>
    </details>
  </section>;
}

function GateReferenceSetup({ live, pilotChannelId, disabled, canCapture, onProfileChange, perform }: {
  live: LiveVisionController;
  pilotChannelId: string | null;
  disabled: boolean;
  canCapture: boolean;
  onProfileChange: LiveGatePanelProps["onProfileChange"];
  perform: (action: () => Promise<void>) => Promise<void>;
}) {
  const [reference, setReference] = useState<{ image: Blob; url: string; rect: VisionRect } | null>(null);
  const [name, setName] = useState("");
  const urlRef = useRef<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; if (urlRef.current) URL.revokeObjectURL(urlRef.current); };
  }, []);
  const locked = disabled;
  const loadReferenceImage = async (image: Blob) => {
    if (!["image/png", "image/jpeg", "image/webp"].includes(image.type) || image.size > 10 * 1024 * 1024) throw new Error("请使用 10 MiB 内的 PNG、JPEG 或 WebP 参考照片");
    const bitmap = await createImageBitmap(image);
    bitmap.close();
    if (!alive.current) return;
    const url = URL.createObjectURL(image);
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = url;
    setReference({ image, url, rect: fullRect });
  };
  return <details className={styles.setupDetails}>
    <summary>配置新的计时门 <span>截取当前取景或导入照片</span></summary>
    <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" hidden disabled={locked} aria-label="实时计时门参考照片" onChange={(event) => {
      const file = event.currentTarget.files?.[0];
      event.currentTarget.value = "";
      if (file) void perform(() => loadReferenceImage(file));
    }} />
    <div className={styles.referenceSetup}>
      <div>
        <div className={styles.actions}>
          <button className={styles.button} type="button" disabled={locked || !pilotChannelId || !canCapture} onClick={() => void perform(async () => loadReferenceImage(await live.captureReference()))}><Icon name="camera" size={14} />截取当前取景</button>
          <button className={styles.button} type="button" disabled={locked} onClick={() => fileRef.current?.click()}>导入门照片</button>
        </div>
        <p className={styles.hint}>截图来自当前选手的干净视频取景。圈出完整门框，保存后绑定给当前选手。</p>
        {reference ? <VisionReferenceSelection reference={reference} disabled={locked} onChange={(rect) => setReference({ ...reference, rect })} /> : <div className={styles.referenceEmpty}>让起终点门清晰入镜，再截取参考。</div>}
      </div>
      <div>
        <label className={styles.field}><span>计时门名称</span><input value={name} maxLength={80} placeholder="例如：练习场起终点门" disabled={locked} onChange={(event) => setName(event.target.value)} /></label>
        <button className={styles.primary} type="button" disabled={locked || !reference || !name.trim() || !pilotChannelId} onClick={() => void perform(async () => {
          if (!reference || !pilotChannelId) return;
          const id = await live.saveReference({ image: reference.image, name: name.trim(), rect: reference.rect });
          if (alive.current) onProfileChange(pilotChannelId, id);
        })}>保存并绑定计时门</button>
        <p className={styles.hint}>档案保存在本机，也可与录像实验台共用。更换门或场地后请重新配置；单张参考图不能保证识别所有角度。</p>
      </div>
    </div>
  </details>;
}

function LiveEventReview({ event, durationMs, disabled, onReview }: {
  event: VisionResolvedEvent;
  durationMs: number;
  disabled: boolean;
  onReview: LiveVisionController["reviewEvent"];
}) {
  const initialSeconds = (event.timeMs / 1_000).toFixed(3);
  const [seconds, setSeconds] = useState(initialSeconds);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const changed = Number(seconds) !== Number(initialSeconds);
  // Formatting alone must not change the source timestamp or invalidate an event at the run end.
  const timeMs = changed ? Number(seconds) * 1_000 : event.timeMs;
  const validTime = seconds.trim() !== "" && Number.isFinite(timeMs) && timeMs >= 0 && timeMs <= durationMs;
  const ready = !disabled && !busy && validTime && reason.trim().length > 0;
  const submit = async (action: "confirm" | "reject" | "adjust") => {
    if (!ready || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try { await onReview(event.id, action, action === "adjust" ? timeMs : event.timeMs, reason.trim()); }
    catch (failure) { setError(messageFor(failure)); }
    finally { inFlight.current = false; setBusy(false); }
  };
  return <div className={styles.reviewEditor} aria-label="实时穿越复核">
    <div className={styles.reviewTitle}><b>{clockText(event.timeMs)}</b><span>{event.origin === "model" ? "模型候选" : "人工补记"} · {eventStates[event.status]}</span></div>
    {event.reason ? <p className={styles.hint}>{event.reason}</p> : null}
    <div className={styles.reviewFields}>
      <label className={styles.field}><span>穿越时刻（秒）</span><input type="number" min="0" max={durationMs / 1_000} step="0.001" value={seconds} disabled={disabled || busy} onChange={(change) => setSeconds(change.target.value)} /></label>
      <label className={styles.field}><span>复核理由（必填）</span><input value={reason} maxLength={500} placeholder="说明现场观察或录像复核依据" disabled={disabled || busy} onChange={(change) => setReason(change.target.value)} /></label>
    </div>
    <div className={styles.actions}>
      <button className={styles.primary} type="button" disabled={!ready || changed} onClick={() => void submit("confirm")}>确认穿越</button>
      <button className={styles.button} type="button" disabled={!ready || changed} onClick={() => void submit("reject")}>排除候选</button>
      <button className={styles.button} type="button" disabled={!ready || !changed} onClick={() => void submit("adjust")}>改时刻并确认</button>
    </div>
    {!validTime ? <p className={styles.error}>时刻须在本轮 00:00–{clockText(durationMs)} 内。</p> : null}
    {error ? <p className={styles.error} role="alert">{error}</p> : null}
  </div>;
}

export const LiveGatePanel = memo(function LiveGatePanel({ configurationLocked = false, startBlockReason = null, sourceLabel = "当前视频输入", onProfileChange, onSummaryChange, ...options }: LiveGatePanelProps) {
  const [sampleFps, setSampleFps] = useState(options.sampleFps === 15 ? 15 : LIVE_VISION_SAMPLE_FPS);
  const live = useLiveVision({ ...options, sampleFps });
  const readinessId = useId();
  const [actionPending, setActionPending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [pendingOnly, setPendingOnly] = useState(true);
  const [manualReason, setManualReason] = useState("");
  const actionRef = useRef(false);
  const stopRef = useRef(false);
  const profileFileRef = useRef<HTMLInputElement>(null);
  const runFileRef = useRef<HTMLInputElement>(null);
  const locked = live.isActive || live.state === "loading" || actionPending || stopping;
  const events = live.events.filter((event) => !pendingOnly || event.status === "pending");
  const selectedEvent = events.find((event) => event.id === selectedEventId) ?? events[0] ?? null;
  const pendingCount = live.events.filter((event) => event.status === "pending").length;
  const reviewedLaps = live.laps.filter((lap) => lap.status === "reviewed");
  const lastLap = reviewedLaps.at(-1);
  const fastest = reviewedLaps.length ? Math.min(...reviewedLaps.map((lap) => lap.durationMs)) : null;
  const lastCrossing = live.events.filter((event) => event.status === "confirmed").at(-1);
  const lapElapsed = live.state === "monitoring" && lastCrossing ? Math.max(0, live.elapsedMs - lastCrossing.timeMs) : null;
  const currentContext = `${options.pilotName.trim() || "未命名选手"} · ${options.sourceId ? sourceLabel : "未接入画面"}`;
  const cropped = options.crop.x !== 0 || options.crop.y !== 0 || options.crop.width !== 1 || options.crop.height !== 1;
  const readinessReason = startBlockReason
    ?? (!options.stream ? "先在上方打开当前选手的视频画面。"
      : !options.pilotName.trim() ? "先在上方填写当前选手姓名，或连接飞控读取名称。"
        : !options.profileId ? "请选择本机计时门，或展开下方配置新的计时门。"
          : live.profile?.id !== options.profileId ? "正在读取所选门档案；若读取失败，请刷新档案或重新选择。"
            : live.hasUnsavedChanges && !live.canStart ? "上轮结果尚未保存，请先重试保存，或导出 JSON 并确认下载。"
              : !live.canStart && !live.isActive ? "请确认当前视频输入与选手取景仍在线。" : null);
  const summaryGateName = live.run?.profile.name ?? live.profile?.name ?? null;
  const summaryPilotName = live.run?.source.pilotName ?? options.pilotName;
  const hasRun = Boolean(live.run);
  const reviewedLapCount = reviewedLaps.length;
  useEffect(() => {
    onSummaryChange?.({ state: live.state, gateName: summaryGateName, pilotName: summaryPilotName, hasRun, lapElapsedMs: lapElapsed, reviewedLapCount, pendingCount });
  }, [onSummaryChange, live.state, summaryGateName, summaryPilotName, hasRun, lapElapsed, reviewedLapCount, pendingCount]);
  const perform = async (action: () => Promise<void>) => {
    if (actionRef.current) return;
    actionRef.current = true;
    setActionPending(true);
    setActionError(null);
    try { await action(); }
    catch (failure) { setActionError(messageFor(failure)); }
    finally { actionRef.current = false; setActionPending(false); }
  };
  const stop = async () => {
    if (stopRef.current) return;
    stopRef.current = true;
    setStopping(true);
    setActionError(null);
    try { await live.stop(); }
    catch (failure) { setActionError(messageFor(failure)); }
    finally { stopRef.current = false; setStopping(false); }
  };
  const importFile = (event: ChangeEvent<HTMLInputElement>, action: (file: File) => Promise<void>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (file && !locked) void perform(() => action(file));
  };
  return <section className={styles.panel} id="live-gate-panel" tabIndex={-1} aria-label="实时过门计时" data-state={live.state}>
    <input ref={profileFileRef} type="file" accept="application/json,.json" hidden disabled={locked || configurationLocked} aria-label="导入实时计时门档案" onChange={(event) => importFile(event, async (file) => {
      if (!options.pilotChannelId) return;
      const id = await live.importProfile(file);
      onProfileChange(options.pilotChannelId, id);
    })} />
    <input ref={runFileRef} type="file" accept="application/json,.json" hidden disabled={locked} aria-label="导入实时计时记录" onChange={(event) => importFile(event, live.importRun)} />
    <header className={styles.header}>
      <div><p className={styles.eyebrow}>LIVE GATE TIMING <span>实验</span></p><h2>飞行画面旁的过门计时。</h2><p className={styles.context}>{currentContext} · {cropped ? "裁切取景" : "完整取景"} · 单起终点门</p></div>
      <div className={styles.headerActions}>
        <span className={styles.status} data-state={live.state}><i />{states[live.state]}</span>
        {live.isActive || live.state === "loading" ? <button className={styles.stop} type="button" disabled={stopping} onClick={() => void stop()}>{stopping ? "正在保存…" : live.state === "loading" ? "取消准备" : "停止过门计时"}</button>
          : <button className={styles.primary} type="button" disabled={!live.canStart || actionPending || stopping || Boolean(startBlockReason)} title={readinessReason ?? undefined} aria-describedby={readinessReason ? readinessId : undefined} onClick={() => void perform(live.start)}><Icon name="clock" size={14} />开始过门计时</button>}
      </div>
    </header>

    <div className={styles.configuration}>
      <label className={styles.profileField}><span>当前计时门</span><select aria-label="当前选手计时门" value={options.profileId ?? ""} disabled={locked || configurationLocked || !options.pilotChannelId} onChange={(event) => {
        if (options.pilotChannelId) onProfileChange(options.pilotChannelId, event.target.value || null);
      }}><option value="">选择本机门档案</option>{live.profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} · v{profile.revision}</option>)}</select></label>
      <div className={styles.actions}>
        <button className={styles.button} type="button" disabled={locked} onClick={() => void perform(live.refreshProfiles)}>刷新档案</button>
        <button className={styles.button} type="button" disabled={locked || configurationLocked || !options.pilotChannelId} onClick={() => profileFileRef.current?.click()}>导入档案</button>
      </div>
      <label className={styles.rateField}><span>分析上限</span><select aria-label="实时分析上限" value={sampleFps} disabled={locked} onChange={(event) => {
        const value = Number(event.target.value);
        if (!locked && (value === 15 || value === 30)) setSampleFps(value);
      }}><option value={15}>15 fps</option><option value={30}>30 fps</option></select></label>
      <p className={styles.modelNote}>首次按后端下载模型与运行库：WebGPU 约 44.4 MB，WASM 约 24.5 MB，仅在本机分析画面。优先处理新帧，实际 fps 取决于本机性能，不代表精确计时。</p>
    </div>
    <GateReferenceSetup key={`${options.sourceId}:${options.pilotChannelId}:${JSON.stringify(options.crop)}`} live={live} pilotChannelId={options.pilotChannelId} canCapture={Boolean(options.stream)} disabled={locked || configurationLocked} onProfileChange={onProfileChange} perform={perform} />

    {(live.error || actionError) ? <p className={styles.errorBanner} role="alert">{actionError ?? live.error}</p> : null}
    {live.notice ? <p className={styles.notice} role="status">{live.notice}</p> : null}
    {readinessReason && !live.isActive ? <p className={styles.hint} id={readinessId}>{readinessReason}</p> : null}

    <div className={styles.metrics}>
      <div className={styles.liveClock}><span>本圈参考计时</span><strong data-testid="live-gate-lap-clock">{lapElapsed === null ? "—" : clockText(lapElapsed)}</strong><small>{lastCrossing ? "从最近一次人工确认的穿越起计" : "首次确认穿越后开始计算圈速"}</small></div>
      <dl><div><dt>已复核圈数</dt><dd>{reviewedLaps.length}</dd></div><div><dt>最快已复核</dt><dd>{fastest === null ? "—" : clockText(fastest)}</dd></div><div><dt>上一已复核圈</dt><dd>{lastLap ? clockText(lastLap.durationMs) : "—"}</dd></div><div><dt>待确认穿越</dt><dd>{pendingCount}</dd></div></dl>
    </div>
    <div className={styles.runtime}><span>本轮经过 <b data-testid="live-gate-elapsed">{clockText(live.elapsedMs)}</b></span><span>已分析 {live.progress.analyzedFrames} 帧{live.progress.inferenceMs === null ? "" : ` · 最近推理 ${Math.round(live.progress.inferenceMs)} ms`}</span><span>{live.progress.message}</span></div>
    <LiveGateDiagnostics live={live} disabled={actionPending || stopping} perform={perform} />
    <p className={styles.hint}>模型结果需要人工确认。使用主机呈现时间估计，尚未校准物理穿越时刻与打杆数据；单门不验证完整赛道。</p>
    <p className={styles.hint}>{options.trainingSessionId ? "已关联正在录制的训练；结束训练也会结束本轮过门计时。" : "需要同时保存视频与打杆数据：先点击顶部「开始记录」，再开始过门计时。"}</p>

    <div className={styles.reviewGrid}>
      <section className={styles.eventSection} aria-label="实时穿越候选">
        <div className={styles.sectionHeading}><h3>穿越与复核</h3><div className={styles.tabs}><button type="button" aria-pressed={pendingOnly} onClick={() => setPendingOnly(true)}>待确认 {pendingCount}</button><button type="button" aria-pressed={!pendingOnly} onClick={() => setPendingOnly(false)}>全部 {live.events.length}</button></div></div>
        {events.length ? <ol className={styles.eventList}>{events.map((event) => <li key={event.id}><button type="button" aria-pressed={event.id === selectedEvent?.id} onClick={() => setSelectedEventId(event.id)}><span><b>{clockText(event.timeMs)}</b><small>{event.similarity === null ? "人工补记" : `余弦相似度 ${event.similarity.toFixed(2)}`}</small></span><em data-state={event.status}>{eventStates[event.status]}</em></button></li>)}</ol> : <p className={styles.empty}>{pendingOnly ? "暂无待确认的穿越。" : "开始监测后，这里保留模型候选与人工穿越。"}</p>}
        {selectedEvent ? <LiveEventReview key={`${live.run?.id}:${selectedEvent.id}:${selectedEvent.timeMs}`} event={selectedEvent} durationMs={live.elapsedMs} disabled={actionPending || stopping || live.state === "loading"} onReview={live.reviewEvent} /> : null}
        <div className={styles.manual}>
          <label className={styles.field}><span>现场人工确认理由</span><input value={manualReason} maxLength={500} placeholder="例如：现场观察，已正向穿过起终点门" disabled={live.state !== "monitoring" || actionPending || stopping} onChange={(event) => setManualReason(event.target.value)} /></label>
          <button className={styles.button} type="button" disabled={live.state !== "monitoring" || actionPending || stopping || !manualReason.trim()} onClick={() => {
            const atMs = live.getCurrentTimeMs();
            void perform(() => live.addEvent(atMs, manualReason.trim()));
          }}><Icon name="flag" size={14} />人工确认一次穿越</button>
          <small>采用点击时的主机时间；人工反应延迟仍存在。</small>
        </div>
      </section>
      <section className={styles.results} aria-label="实时圈速与记录">
        <div className={styles.sectionHeading}><h3>本轮圈速</h3><span>{live.laps.length} 圈</span></div>
        {live.run ? <p className={styles.runContext}>记录：{live.run.source.pilotName} · {live.run.profile.name}{live.run.provenance === "imported" ? " · 导入记录，未经本机重新分析" : ""}{live.run.source.trainingSessionId ? " · 已关联训练记录，未校准同步" : " · 独立计时记录"}</p> : null}
        {live.laps.length ? <div className={styles.tableScroll}><table><thead><tr><th>圈</th><th>时长</th><th>复核状态</th></tr></thead><tbody>{live.laps.map((lap) => <tr key={lap.id}><td>{lap.number}</td><td>{clockText(lap.durationMs)}</td><td>{lap.status === "reviewed" ? "已复核" : "不完整"}{lap.reason ? <small>{lap.reason}</small> : null}</td></tr>)}</tbody></table></div> : <p className={styles.empty}>确认两次穿越后形成第一圈。</p>}
        {live.run?.stopReason ? <p className={styles.hint}>本轮结束：{live.run.stopReason}</p> : null}
        <div className={styles.actions}>
          <button className={styles.button} type="button" disabled={!live.run || actionPending || stopping || live.state === "loading"} onClick={() => void perform(live.saveRun)}>保存计时记录</button>
          <button className={styles.button} type="button" disabled={!live.run || actionPending || stopping || live.state === "loading"} onClick={() => void perform(() => live.exportRun("json"))}>JSON</button>
          <button className={styles.button} type="button" disabled={!live.run || actionPending || stopping || live.state === "loading"} onClick={() => void perform(() => live.exportRun("csv"))}>CSV</button>
        </div>
        {live.backupAwaitingConfirmation ? <div className={styles.backupPrompt}><p>浏览器已开始下载，应用无法确认文件是否完成保存。</p><button className={styles.button} type="button" disabled={live.isActive || actionPending || stopping} onClick={() => void perform(async () => live.acknowledgeBackup())}>我已确认 JSON 下载完成，允许切换记录</button></div> : null}
        <label className={styles.field}><span>恢复本机计时记录</span><select aria-label="恢复实时计时记录" value="" disabled={locked} onChange={(event) => { const id = event.target.value; if (id) void perform(() => live.loadRun(id)); }}><option value="">选择已保存记录</option>{live.savedRuns.map((run) => <option key={run.id} value={run.id}>{dateText(run.createdAt)} · {run.pilotName} · {run.gateName}</option>)}</select></label>
        <button className={styles.textButton} type="button" disabled={locked} onClick={() => runFileRef.current?.click()}>导入计时 JSON</button>
        <p className={styles.hint}>计时档案与视频分开保存。导出会发起浏览器下载，请确认下载完成。</p>
      </section>
    </div>
    <footer className={styles.footer}><Icon name="info" size={14} /><span>每次只分析当前一路取景。切换选手、视频源、取景、门档案或训练记录会结束本轮；离开浏览器标签页也会中断。停止后需手动重新开始。</span></footer>
  </section>;
});
