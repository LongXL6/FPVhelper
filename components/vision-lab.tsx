"use client";

import { useRef, useState, type ChangeEvent, type KeyboardEvent, type PointerEvent } from "react";
import { Icon } from "@/components/ui/icon";
import { useVisionLab } from "@/hooks/use-vision-lab";
import type { VisionCropPreset, VisionLabController, VisionRect, VisionResolvedEvent } from "@/lib/vision-lab-types";
import styles from "./vision-lab.module.css";

const crops: { value: VisionCropPreset; label: string; short: string }[] = [
  { value: "full", label: "完整画面", short: "全画面" },
  { value: "top-left", label: "四格 · 左上", short: "左上" },
  { value: "top-right", label: "四格 · 右上", short: "右上" },
  { value: "bottom-left", label: "四格 · 左下", short: "左下" },
  { value: "bottom-right", label: "四格 · 右下", short: "右下" },
];

const statusLabels: Record<VisionLabController["status"], string> = {
  idle: "等待素材", loading: "正在准备", analyzing: "本机分析中", cancelled: "分析已取消", complete: "分析已完成", error: "需要处理",
};

const eventLabels: Record<VisionResolvedEvent["status"], string> = {
  pending: "待复核", confirmed: "人工确认", rejected: "已排除",
};

function timecode(timeMs: number) {
  const value = Math.max(0, Number.isFinite(timeMs) ? Math.round(timeMs) : 0);
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.floor(value / 1_000) % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(value % 1_000).padStart(3, "0")}`;
}

function shortDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "日期未记录" : date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function normalizeRect(rect: VisionRect): VisionRect {
  const width = clamp(rect.width, 0.01, 1);
  const height = clamp(rect.height, 0.01, 1);
  return { x: clamp(rect.x, 0, 1 - width), y: clamp(rect.y, 0, 1 - height), width, height };
}

function ReferenceSelection({ reference, disabled, onChange }: {
  reference: NonNullable<VisionLabController["reference"]>;
  disabled: boolean;
  onChange: (rect: VisionRect) => void;
}) {
  const imageRef = useRef<HTMLImageElement>(null);
  const drag = useRef<{ id: number; x: number; y: number; original: VisionRect } | null>(null);
  const rect = reference.rect;
  const point = (event: PointerEvent<HTMLDivElement>) => {
    const bounds = imageRef.current?.getBoundingClientRect();
    if (!bounds || bounds.width <= 0 || bounds.height <= 0 || !imageRef.current?.naturalWidth) return null;
    return { x: clamp((event.clientX - bounds.left) / bounds.width, 0, 1), y: clamp((event.clientY - bounds.top) / bounds.height, 0, 1) };
  };
  const start = (event: PointerEvent<HTMLDivElement>) => {
    if (disabled || event.button !== 0) return;
    const position = point(event);
    if (!position) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { id: event.pointerId, ...position, original: rect };
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const origin = drag.current;
    if (disabled || !origin || origin.id !== event.pointerId) return;
    const position = point(event);
    if (!position) return;
    onChange(normalizeRect({ x: Math.min(origin.x, position.x), y: Math.min(origin.y, position.y), width: Math.abs(position.x - origin.x), height: Math.abs(position.y - origin.y) }));
  };
  const end = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.id !== event.pointerId) return;
    if (event.type === "pointercancel") onChange(drag.current.original);
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const moveWithKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (disabled || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    const delta = event.shiftKey ? 0.05 : 0.01;
    onChange(normalizeRect({ ...rect, x: rect.x + (event.key === "ArrowLeft" ? -delta : event.key === "ArrowRight" ? delta : 0), y: rect.y + (event.key === "ArrowUp" ? -delta : event.key === "ArrowDown" ? delta : 0) }));
  };

  return <div className={styles.referenceEditor}>
    <div className={styles.referenceImage} onPointerDown={start} onPointerMove={move} onPointerUp={end} onPointerCancel={end} data-disabled={disabled}>
      {/* eslint-disable-next-line @next/next/no-img-element -- The reference is a local Blob URL and must retain its decoded geometry for selection. */}
      <img ref={imageRef} src={reference.url} alt="本机计时门参考照片" draggable={false} />
      <div className={styles.referenceRect} role="button" tabIndex={disabled ? -1 : 0} aria-disabled={disabled} aria-label="门框选区，用方向键移动，或使用下方数值调整大小" onKeyDown={moveWithKeyboard}
        style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%` }}><span>计时门</span></div>
    </div>
    <p className={styles.hint}>拖动框选完整门框。方向键移动选区；下方可精细调整。</p>
    <div className={styles.rectFields}>
      {([{ key: "x", label: "左" }, { key: "y", label: "上" }, { key: "width", label: "宽" }, { key: "height", label: "高" }] as const).map(({ key, label }) => <label key={key}>
        <span>{label} %</span>
        <input type="number" min={key === "width" || key === "height" ? 1 : 0} max="100" step="1" value={Math.round(rect[key] * 100)} disabled={disabled} aria-label={`门框${label}百分比`} onChange={(event) => {
          const value = event.currentTarget.valueAsNumber;
          if (Number.isFinite(value)) onChange(normalizeRect({ ...rect, [key]: value / 100 }));
        }} />
      </label>)}
    </div>
  </div>;
}

function ReviewEditor({ event, fromMs, toMs, disabled, onReview, onUseCurrentTime, currentTimeMs }: {
  event: VisionResolvedEvent;
  fromMs: number;
  toMs: number;
  disabled: boolean;
  onReview: VisionLabController["reviewEvent"];
  onUseCurrentTime: boolean;
  currentTimeMs: number;
}) {
  const [seconds, setSeconds] = useState((event.timeMs / 1_000).toFixed(3));
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const timeMs = Number(seconds) * 1_000;
  const validTime = seconds.trim() !== "" && Number.isFinite(timeMs) && timeMs >= fromMs && timeMs <= toMs;
  const timeChanged = Math.abs(timeMs - event.timeMs) >= 0.5;
  const ready = validTime && reason.trim().length > 0 && !disabled && !saving;
  const submit = async (action: "confirm" | "reject" | "adjust") => {
    if (!ready) return;
    setSaving(true);
    setError(null);
    try { await onReview(event.id, action, action === "adjust" ? timeMs : event.timeMs, reason.trim()); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "未能保存这次修正，请重试"); }
    finally { setSaving(false); }
  };

  return <div className={styles.reviewEditor} aria-label="复核选中事件">
    <div className={styles.reviewHeading}><b>复核这个时刻</b><span>{timecode(event.timeMs)}</span></div>
    <p className={styles.hint}>{event.origin === "manual" ? "人工补记" : "模型候选"} · {eventLabels[event.status]}。请对照视频确认真实穿越。</p>
    {event.reason ? <p className={styles.hint}>已有说明：{event.reason}</p> : null}
    <label className={styles.field}><span>穿越时刻（秒）</span><input type="number" min={fromMs / 1_000} max={toMs / 1_000} step="0.001" value={seconds} disabled={disabled || saving} onChange={(change) => setSeconds(change.target.value)} /></label>
    {onUseCurrentTime ? <button type="button" className={styles.textButton} disabled={disabled || saving || currentTimeMs < fromMs || currentTimeMs > toMs} onClick={() => setSeconds((currentTimeMs / 1_000).toFixed(3))}>使用视频当前时刻</button> : null}
    <label className={styles.field}><span>复核理由 <small>必填</small></span><textarea rows={2} maxLength={500} value={reason} disabled={disabled || saving} onChange={(change) => setReason(change.target.value)} placeholder="例如：逐帧查看，已正向穿过起终点门" /></label>
    <div className={styles.reviewActions}>
      <button type="button" className={styles.primaryButton} disabled={!ready || timeChanged} onClick={() => void submit("confirm")}><Icon name="check" size={15} />确认穿越</button>
      <button type="button" className={styles.button} disabled={!ready || timeChanged} onClick={() => void submit("reject")}>排除</button>
      <button type="button" className={styles.button} disabled={!ready || !timeChanged} onClick={() => void submit("adjust")}>改时刻并确认</button>
    </div>
    {!validTime ? <p className={styles.inlineError}>请输入本次分析范围 {timecode(fromMs)}–{timecode(toMs)} 内的时刻。</p> : null}
    {validTime && timeChanged ? <p className={styles.hint}>保存新时刻会人工确认这次穿越；原始候选保留。</p> : null}
    {error ? <p className={styles.inlineError} role="alert">{error}</p> : null}
    <p className={styles.hint}>每次操作追加保存，原始模型候选保留。</p>
  </div>;
}

export function VisionLab() {
  const { videoRef, ...lab }: VisionLabController = useVisionLab();
  const [actionPending, setActionPending] = useState(false);
  const actionPendingRef = useRef(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [currentTimeMs, setCurrentTimeMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [stepFps, setStepFps] = useState(30);
  const [jumpSeconds, setJumpSeconds] = useState("");
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [eventFilter, setEventFilter] = useState<"all" | "pending">("all");
  const [manualReason, setManualReason] = useState("");
  const videoInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const profileInputRef = useRef<HTMLInputElement>(null);
  const runInputRef = useRef<HTMLInputElement>(null);
  const locked = lab.busy || actionPending;
  const durationMs = lab.video?.durationMs ?? 0;
  const selectionDurationMs = lab.settings.toMs - lab.settings.fromMs;
  const runVideoMatches = Boolean(lab.video && (!lab.run || (lab.run.video.sha256 === lab.video.sha256 && lab.run.settings.crop === lab.settings.crop)));
  const currentTimeInRun = Boolean(lab.run && currentTimeMs >= lab.run.settings.fromMs && currentTimeMs <= lab.run.settings.toMs);
  const displayedEvents = lab.events.filter((event) => eventFilter === "all" || event.status === "pending");
  const selectedEvent = displayedEvents.find((event) => event.id === selectedEventId) ?? displayedEvents[0] ?? null;
  const pendingCount = lab.events.filter((event) => event.status === "pending").length;
  const reviewedLaps = lab.laps.filter((lap) => lap.status === "reviewed");
  const fastestMs = reviewedLaps.length ? Math.min(...reviewedLaps.map((lap) => lap.durationMs)) : null;
  const progress = lab.progress.total > 0 ? clamp(lab.progress.completed / lab.progress.total, 0, 1) : 0;

  const perform = async (action: () => Promise<void>) => {
    if (actionPendingRef.current) return;
    actionPendingRef.current = true;
    setActionError(null);
    setActionPending(true);
    try { await action(); }
    catch (failure) { setActionError(failure instanceof Error ? failure.message : "操作未完成，请重试"); }
    finally { actionPendingRef.current = false; setActionPending(false); }
  };
  const importFile = (event: ChangeEvent<HTMLInputElement>, action: (file: File) => Promise<void>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (file && !locked) void perform(() => action(file));
  };
  const seek = (timeMs: number) => {
    const video = videoRef.current;
    if (!video || !lab.video || !Number.isFinite(timeMs)) return;
    const target = clamp(timeMs, 0, durationMs);
    video.pause();
    try { video.currentTime = target / 1_000; setCurrentTimeMs(target); }
    catch { setActionError("暂时无法定位这个时刻，请等待录像加载后重试"); }
  };
  const selectEvent = (event: VisionResolvedEvent) => {
    setSelectedEventId(event.id);
    if (runVideoMatches) seek(event.timeMs);
  };
  const changeSeconds = (key: "fromMs" | "toMs", value: number) => {
    if (Number.isFinite(value)) lab.updateSettings({ [key]: clamp(value * 1_000, 0, durationMs) });
  };
  const selectedCrop = crops.find((crop) => crop.value === lab.settings.crop)!;

  return <main className={styles.lab}>
    <input ref={videoInputRef} type="file" accept="video/*" className={styles.hidden} disabled={locked} aria-label="导入本地录像文件" onChange={(event) => importFile(event, lab.importVideo)} />
    <input ref={imageInputRef} type="file" accept="image/*" className={styles.hidden} disabled={locked} aria-label="导入计时门照片" onChange={(event) => importFile(event, lab.importReference)} />
    <input ref={profileInputRef} type="file" accept="application/json,.json" className={styles.hidden} disabled={locked} aria-label="导入计时门档案" onChange={(event) => importFile(event, lab.importProfile)} />
    <input ref={runInputRef} type="file" accept="application/json,.json" className={styles.hidden} disabled={locked} aria-label="导入视觉分析记录" onChange={(event) => importFile(event, lab.importRun)} />

    <header className={styles.header}>
      <a href="/" target="_blank" rel="noopener noreferrer" className={styles.brand} aria-label="在新标签页打开 FPVHelper 训练工作台"><Icon name="flag" size={27} /><span>FPVHelper<small>本地视觉实验台</small></span></a>
      <div className={styles.headerActions}><span className={styles.localBadge}><Icon name="shield" size={14} />照片与录像在本机处理</span><a className={styles.backLink} href="/" target="_blank" rel="noopener noreferrer">训练工作台 <Icon name="arrow-right" size={15} /></a></div>
    </header>

    <div className={styles.pageHeading}>
      <div><p className={styles.eyebrow}>VIDEO REVIEW <span> / </span> 单起终点门</p><h1>从一段录像，开始过门复盘。</h1><p>选定你的计时门，分析相似画面，再对照录像确认圈速。</p></div>
      <span className={styles.status} data-state={lab.status}><i />{statusLabels[lab.status]}</span>
    </div>

    {(lab.error || actionError) ? <div className={styles.errorBanner} role="alert"><Icon name="info" /><span>{actionError ?? lab.error}</span></div> : null}
    {lab.notice ? <div className={styles.notice} role="status">{lab.notice}</div> : null}

    <div className={styles.workspace}>
      <aside className={styles.setup} aria-label="素材与计时门设置">
        <section className={styles.panel}>
          <div className={styles.sectionHeading}><span className={styles.step}>01</span><h2>设置计时门</h2></div>
          <p className={styles.hint}>用自己的门照片，或从录像选一帧。</p>
          <div className={styles.fileActions}><button type="button" className={styles.button} disabled={locked} onClick={() => imageInputRef.current?.click()}><Icon name="camera" size={16} />{lab.reference ? "更换照片" : "选择门照片"}</button><button type="button" className={styles.textButton} disabled={locked || !lab.video} onClick={() => void perform(lab.captureReference)}>取视频当前画面</button></div>
          {lab.reference ? <ReferenceSelection reference={lab.reference} disabled={locked} onChange={lab.setReferenceRect} /> : <div className={styles.referenceEmpty}><Icon name="expand" size={32} /><b>圈出你的起终点门</b><span>完整门框与清晰纹理有助于匹配</span></div>}
          <label className={styles.field}><span>计时门名称</span><input value={lab.gateName} maxLength={80} placeholder="例如：俱乐部起终点门" disabled={locked} onChange={(event) => lab.setGateName(event.target.value)} /></label>
          <div className={styles.buttonRow}><button type="button" className={styles.button} disabled={locked || !lab.reference || !lab.gateName.trim()} onClick={() => void perform(lab.saveProfile)}>保存门档案</button><button type="button" className={styles.textButton} disabled={locked || !lab.reference} onClick={() => void perform(lab.exportProfile)}>导出档案</button></div>
          <p className={styles.hint}>单张照片是匹配参考，无法单独证明真实穿门。</p>
        </section>

        <section className={styles.panel}>
          <div className={styles.sectionHeading}><span className={styles.step}>02</span><h2>分析范围</h2></div>
          <label className={styles.field}><span>选手画面</span><select value={lab.settings.crop} disabled={locked} onChange={(event) => lab.updateSettings({ crop: event.target.value as VisionCropPreset })}>{crops.map((crop) => <option key={crop.value} value={crop.value}>{crop.label}</option>)}</select></label>
          <div className={styles.cropDiagram} aria-label={`当前分析${selectedCrop.label}`} data-full={lab.settings.crop === "full"}>{crops.slice(1).map((crop) => <button type="button" key={crop.value} aria-label={`分析${crop.label}`} aria-pressed={lab.settings.crop === crop.value} disabled={locked} onClick={() => lab.updateSettings({ crop: crop.value })}>{crop.short}</button>)}</div>
          <div className={styles.rangeFields}><label className={styles.field}><span>开始（秒）</span><input type="number" min="0" max={durationMs / 1_000} step="0.1" value={Number((lab.settings.fromMs / 1_000).toFixed(3))} disabled={locked || !lab.video} onChange={(event) => changeSeconds("fromMs", event.target.valueAsNumber)} /></label><label className={styles.field}><span>结束（秒）</span><input type="number" min="0" max={durationMs / 1_000} step="0.1" value={Number((lab.settings.toMs / 1_000).toFixed(3))} disabled={locked || !lab.video} onChange={(event) => changeSeconds("toMs", event.target.valueAsNumber)} /></label></div>
          <p className={styles.hint}>每次分析最长 180 秒，长录像可分段选择。</p>
          {lab.video && (selectionDurationMs <= 0 || selectionDurationMs > 180_000) ? <p className={styles.inlineWarning}>请设置先于结束的开始时刻，并将本次范围控制在 180 秒以内。</p> : null}
          <details className={styles.details}><summary>分析设置</summary>
            <label className={styles.field}><span>采样密度</span><select value={lab.settings.sampleFps} disabled={locked} onChange={(event) => lab.updateSettings({ sampleFps: Number(event.target.value) as 2 | 5 | 10 })}><option value={2}>每秒 2 帧</option><option value={5}>每秒 5 帧（默认）</option><option value={10}>每秒 10 帧</option></select></label>
            <label className={styles.field}><span>相似度阈值 <output>{lab.settings.similarityThreshold.toFixed(2)}</output></span><input type="range" min="0" max="1" step="0.01" value={lab.settings.similarityThreshold} disabled={locked} aria-label="相似度阈值" onChange={(event) => lab.updateSettings({ similarityThreshold: event.target.valueAsNumber })} /></label>
            <p className={styles.hint}>离线采样用于发现候选，不是精确逐帧检测；未通过 100 ms 计时精度验收。</p>
          </details>
        </section>

        <section className={styles.panel}>
          <div className={styles.sectionHeading}><Icon name="folder" size={17} /><h2>本机档案</h2></div>
          <label className={styles.field}><span>恢复计时门</span><select value="" disabled={locked || !lab.profiles.length} onChange={(event) => { if (event.target.value) void perform(() => lab.loadProfile(event.target.value)); }}><option value="">{lab.profiles.length ? "选择已保存的门" : "尚无已保存计时门"}</option>{lab.profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} · v{profile.revision}</option>)}</select></label>
          <button type="button" className={styles.textButton} disabled={locked} onClick={() => profileInputRef.current?.click()}>导入门档案 JSON</button>
          <label className={styles.field}><span>恢复分析记录</span><select value="" disabled={locked || !lab.savedRuns.length} onChange={(event) => { if (event.target.value) void perform(() => lab.loadRun(event.target.value)); }}><option value="">{lab.savedRuns.length ? "选择本机分析记录" : "尚无已保存分析记录"}</option>{lab.savedRuns.map((run) => <option key={run.id} value={run.id}>{run.gateName} · {run.videoName} · {shortDate(run.createdAt)}</option>)}</select></label>
          <button type="button" className={styles.textButton} disabled={locked} onClick={() => runInputRef.current?.click()}>导入分析记录 JSON</button>
          <p className={styles.hint}>重新打开录像后可继续复核。浏览器数据可能被清理，请导出重要档案。</p>
        </section>
      </aside>

      <div className={styles.center}>
        <section className={styles.videoPanel} aria-label="本地录像预览">
          <div className={styles.videoHeading}><div><Icon name="camera" size={18} /><b>{lab.video ? lab.video.name : "导入你的 FPV 录像"}</b></div><button type="button" className={styles.button} disabled={locked} onClick={() => videoInputRef.current?.click()}>{lab.video ? "更换录像" : "选择录像"}</button></div>
          <div className={styles.videoStage} data-loaded={Boolean(lab.video)} style={{ aspectRatio: lab.video?.width && lab.video.height ? `${lab.video.width} / ${lab.video.height}` : "16 / 9" }}>
            <video ref={videoRef} src={lab.video?.url} className={styles.video} data-crop={lab.settings.crop} preload="metadata" playsInline muted aria-label="本地 FPV 录像" onLoadedMetadata={() => { setCurrentTimeMs(0); setPlaying(false); }} onTimeUpdate={(event) => setCurrentTimeMs(event.currentTarget.currentTime * 1_000)} onSeeked={(event) => setCurrentTimeMs(event.currentTarget.currentTime * 1_000)} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} onError={() => { if (lab.video) setActionError("这段录像暂时无法播放，请确认文件完整且浏览器支持其编码"); }} />
            {!lab.video ? <div className={styles.videoEmpty}><div><Icon name="live" size={46} /></div><h2>让每一次穿越都可以复盘</h2><p>选择本地录像开始。文件留在这台电脑。</p><button type="button" className={styles.primaryButton} disabled={locked} onClick={() => videoInputRef.current?.click()}><Icon name="folder" size={16} />导入本地录像</button><small>支持浏览器可解码的 MP4、WebM 等格式</small></div> : <span className={styles.viewportBadge}>{selectedCrop.label}</span>}
          </div>
          <div className={styles.playback}>
            <div className={styles.timeRow}><output>{timecode(currentTimeMs)}</output><span>{lab.video ? `源 ${lab.video.width} × ${lab.video.height}` : "本地录像"}</span><output>{timecode(durationMs)}</output></div>
            <input className={styles.timeline} type="range" min="0" max={Math.max(1, durationMs)} step="1" value={clamp(currentTimeMs, 0, Math.max(1, durationMs))} disabled={!lab.video} aria-label="录像时间位置" onChange={(event) => seek(event.target.valueAsNumber)} />
            <div className={styles.playbackActions}><div className={styles.buttonRow}>
              <button type="button" className={styles.button} disabled={!lab.video} onClick={() => { const video = videoRef.current; if (!video) return; if (video.paused) void video.play().catch(() => setActionError("播放未能开始，请重新点击播放")); else video.pause(); }}>{playing ? "暂停" : "播放"}</button>
              <button type="button" className={styles.button} disabled={!lab.video} aria-label={`回退约 ${Math.round(1_000 / stepFps)} 毫秒`} onClick={() => seek(currentTimeMs - 1_000 / stepFps)}><Icon name="arrow-left" size={14} />步进</button>
              <button type="button" className={styles.button} disabled={!lab.video} aria-label={`前进约 ${Math.round(1_000 / stepFps)} 毫秒`} onClick={() => seek(currentTimeMs + 1_000 / stepFps)}>步进<Icon name="arrow-right" size={14} /></button>
              <select className={styles.stepSelect} value={stepFps} onChange={(event) => setStepFps(Number(event.target.value))} aria-label="近似帧步进的参考帧率"><option value={24}>1/24 秒</option><option value={25}>1/25 秒</option><option value={30}>1/30 秒</option><option value={50}>1/50 秒</option><option value={60}>1/60 秒</option></select>
            </div><form className={styles.jumpForm} onSubmit={(event) => { event.preventDefault(); if (jumpSeconds.trim()) seek(Number(jumpSeconds) * 1_000); }}><label className={styles.hiddenLabel} htmlFor="vision-jump-time">跳转到秒</label><input id="vision-jump-time" type="number" min="0" max={durationMs / 1_000} step="0.001" placeholder="秒" value={jumpSeconds} disabled={!lab.video} onChange={(event) => setJumpSeconds(event.target.value)} /><button type="submit" className={styles.button} disabled={!lab.video || !jumpSeconds.trim()}>跳转</button></form></div>
            <p className={styles.hint}>步进按所选时间间隔近似定位，不代表已知录像的真实帧率。</p>
          </div>
        </section>

        <section className={styles.analysisPanel} aria-label="离线分析">
          <div className={styles.analysisHeading}><div><h2>{lab.status === "analyzing" ? "正在查找相似画面" : lab.status === "loading" ? "正在准备，请稍候" : "发现候选，再由你确认"}</h2><p>{lab.status === "analyzing" ? lab.progress.message : lab.status === "loading" ? "准备过程可取消；照片与录像在本机处理。" : `按每秒 ${lab.settings.sampleFps} 帧在本机分析。模型结果全部进入待复核列表。`}</p></div>
            {lab.busy ? <button type="button" className={styles.button} onClick={lab.cancel}><Icon name="stop" size={15} />{lab.status === "loading" ? "取消准备" : "取消分析"}</button> : <button type="button" className={styles.primaryButton} disabled={!lab.canAnalyze || locked || selectionDurationMs <= 0 || selectionDurationMs > 180_000} onClick={() => void perform(lab.analyze)}><Icon name="search" size={16} />{lab.run ? "重新分析" : "开始分析"}</button>}
          </div>
          {lab.status === "analyzing" ? <div className={styles.progressBlock}><progress max="1" value={progress} aria-label="录像分析进度" /><div role="status"><span>{Math.round(progress * 100)}% · {timecode(lab.progress.timeMs)}</span><span>{lab.progress.completed} / {lab.progress.total} 帧</span></div></div> : null}
          {!lab.canAnalyze && !locked ? <p className={styles.hint}>准备好录像、门照片和有效选区后即可开始。</p> : null}
          <p className={styles.hint}>首次分析需联网加载约 24.5 MB 模型权重与运行库，仅下载资源，不上传照片或视频。默认每 200 ms 取样发现候选，未达到 100 ms 计时精度验收。</p>
          {lab.run ? <div className={styles.analysisFacts}><span>本轮已分析 <b>{lab.run.analyzedFrames}</b> 帧</span><span>至 <b>{timecode(lab.run.analyzedUntilMs)}</b></span><span>观察缺口 <b>{lab.run.gaps.length}</b></span></div> : null}
          {lab.status === "cancelled" ? <p className={styles.hint}>本轮分析未覆盖完整范围；已发现的候选仍可复核，结果保留中断状态。</p> : null}
        </section>

        <section className={styles.panel} aria-label="圈速结果">
          <div className={styles.resultHeading}><div><p className={styles.eyebrow}>REVIEWED LAPS</p><h2>人工复核后的圈速</h2></div><span className={styles.experimentalBadge}>实验结果</span></div>
          {lab.run?.provenance === "imported" ? <p className={styles.inlineWarning}>导入记录，未经本机重新分析。</p> : null}
          <div className={styles.metrics}><div><span>已复核区间</span><strong>{reviewedLaps.length}<small>圈</small></strong></div><div><span>最快复核圈</span><strong>{fastestMs === null ? "—" : timecode(fastestMs)}</strong></div><div><span>待复核事件</span><strong>{pendingCount}<small>个</small></strong></div></div>
          {lab.laps.length ? <div className={styles.tableScroll}><table className={styles.lapTable}><thead><tr><th>圈次</th><th>开始 / 结束</th><th>圈速</th><th>状态</th></tr></thead><tbody>{lab.laps.map((lap) => <tr key={lap.id}><td>{String(lap.number).padStart(2, "0")}</td><td><button type="button" className={styles.timeLink} disabled={!runVideoMatches} onClick={() => seek(lap.startMs)}>{timecode(lap.startMs)}</button><small>{timecode(lap.endMs)}</small></td><td className={styles.lapDuration}>{timecode(lap.durationMs)}</td><td><span className={styles.eventBadge} data-state={lap.status === "reviewed" ? "confirmed" : "pending"}>{lap.status === "reviewed" ? "已复核" : "不完整"}</span>{lap.reason ? <small>{lap.reason}</small> : null}</td></tr>)}</tbody></table></div> : <div className={styles.resultsEmpty}><Icon name="clock" size={23} /><p>确认两次起终点穿越后，生成第一个圈速。</p><span>首次确认只建立起点，未完成的半圈不计成绩。</span></div>}
          <p className={styles.hint}>圈速表示再次穿过同一门的间隔，不能证明中途完成了全部赛道。采样与漏检可能影响结果。</p>
          <div className={styles.exportBar}><button type="button" className={styles.button} disabled={locked || !lab.run} onClick={() => void perform(lab.saveRun)}><Icon name="folder" size={15} />保存本机记录</button><div className={styles.buttonRow}><button type="button" className={styles.button} disabled={locked || !lab.run} onClick={() => void perform(() => lab.exportRun("json"))}><Icon name="download" size={15} />JSON</button><button type="button" className={styles.button} disabled={locked || !lab.run} onClick={() => void perform(() => lab.exportRun("csv"))}>CSV</button></div></div>
          <p className={styles.hint}>JSON 保留候选与修正记录，CSV 用于圈速表。下载发起后，请在浏览器中确认文件已保存。</p>
        </section>
      </div>

      <aside className={styles.reviewRail} aria-label="穿越候选复核">
        <section className={styles.panel}>
          <div className={styles.sectionHeading}><span className={styles.step}>03</span><h2>复核穿越</h2><span className={styles.count}>{lab.events.length}</span></div>
          <p className={styles.hint}>相似画面不是穿越证明。点击候选定位，再确认或排除。</p>
          <div className={styles.filters}><button type="button" aria-pressed={eventFilter === "all"} onClick={() => setEventFilter("all")}>全部 {lab.events.length}</button><button type="button" aria-pressed={eventFilter === "pending"} onClick={() => setEventFilter("pending")}>待复核 {pendingCount}</button></div>
          {displayedEvents.length ? <ol className={styles.eventList}>{displayedEvents.map((event) => <li key={event.id}><button type="button" className={styles.eventItem} aria-pressed={selectedEvent?.id === event.id} onClick={() => selectEvent(event)}><span><b>{timecode(event.timeMs)}</b><small>{event.origin === "manual" ? "人工补记" : `余弦相似度 ${event.similarity === null ? "未记录" : event.similarity.toFixed(2)}`}</small></span><span className={styles.eventBadge} data-state={event.status}>{eventLabels[event.status]}</span></button></li>)}</ol> : <div className={styles.candidatesEmpty}><Icon name="flag" size={26} /><b>{eventFilter === "pending" && lab.events.length ? "本轮候选已全部复核" : "候选穿越会出现在这里"}</b><span>分析真实录像后查看结果，也可以手动补记。</span></div>}
          {lab.run && !runVideoMatches ? <p className={styles.inlineWarning}>复核前请重新选择原录像，并将选手画面设为“{crops.find((crop) => crop.value === lab.run?.settings.crop)?.label}”。</p> : null}
          {selectedEvent ? <ReviewEditor key={`${lab.run?.id}:${selectedEvent.id}:${selectedEvent.timeMs}:${selectedEvent.status}`} event={selectedEvent} fromMs={lab.run?.settings.fromMs ?? 0} toMs={lab.run?.settings.toMs ?? durationMs} disabled={locked || !runVideoMatches} onReview={(id, action, time, reason) => perform(() => lab.reviewEvent(id, action, time, reason))} onUseCurrentTime={runVideoMatches} currentTimeMs={currentTimeMs} /> : null}
        </section>

        <section className={styles.panel}>
          <div className={styles.sectionHeading}><Icon name="flag" size={17} /><h2>手动补记</h2></div>
          <p className={styles.hint}>录像里看到了未被发现的穿越，可在当前时刻补记。</p>
          {!lab.run ? <p className={styles.hint}>请先分析一段录像，建立记录后再补记穿越。</p> : null}
          <div className={styles.manualTime}>{runVideoMatches ? timecode(currentTimeMs) : "等待对应录像"}</div>
          {lab.run && runVideoMatches && !currentTimeInRun ? <p className={styles.inlineWarning}>请定位到本次分析范围 {timecode(lab.run.settings.fromMs)}–{timecode(lab.run.settings.toMs)} 内再补记。</p> : null}
          <label className={styles.field}><span>补记理由</span><textarea rows={2} maxLength={500} placeholder="例如：门被 OSD 遮挡，已人工确认穿越" value={manualReason} disabled={locked || !lab.run || !runVideoMatches} onChange={(event) => setManualReason(event.target.value)} /></label>
          <button type="button" className={styles.button} disabled={locked || !lab.run || !runVideoMatches || !currentTimeInRun || !manualReason.trim()} onClick={() => void perform(async () => { await lab.addEvent(currentTimeMs, manualReason.trim()); setManualReason(""); })}>补记当前时刻</button>
        </section>
      </aside>
    </div>
    <footer className={styles.footer}><span>FPVHelper · Local vision lab</span><span>实验圈速，用于训练复盘，不作为正式赛事计时。</span></footer>
  </main>;
}
