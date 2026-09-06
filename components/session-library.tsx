"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { TrainingSessionExportResult } from "@/hooks/use-training-session";
import { SessionCaptureSummary } from "@/components/session-capture-summary";
import { CAPTURE_GAP_THRESHOLD_MS } from "@/lib/training-capture-quality";
import { hasCurrentSessionExport, sessionMediaStatusText } from "@/lib/training-session-metadata";
import { normalizeSessionNotes } from "@/lib/training-session";
import { formatDvrReviewChecklist } from "@/lib/training-session-summary";
import type { TrainingSessionSummary } from "@/lib/training-session-index";
import type {
  TrainingSession,
  TrainingSessionInvalidReason,
  TrainingSessionMarkerKind,
} from "@/lib/training-session";

interface SessionLibraryProps {
  sessions: TrainingSessionSummary[];
  loadSession: (id: string) => Promise<TrainingSession | null>;
  selectedSessionId: string | null;
  revealSessionId?: string | null;
  onSelectSession: (id: string) => void;
  onExport: (session: TrainingSessionSummary) => Promise<TrainingSessionExportResult>;
  onUpdateNotes: (id: string, notes: string) => Promise<void>;
  onGoToLive: () => void;
  isRecording: boolean;
  storageState: "loading" | "ready" | "error";
  saveState: "idle" | "saving" | "saved" | "error";
  unsavedSessionIds?: string[];
  pendingMediaSessionId?: string;
  pendingTerminationSessionId?: string;
}

type SourceFilter = "all" | "real" | "demo";
type NoteStatus = "saving" | "saved" | "error";

const invalidReasonCopy: Record<TrainingSessionInvalidReason, string> = {
  source_not_ground_rc: "这条记录没有使用真实遥控输入。",
  mixed_sources: "记录包含演示数据，不能计入有效训练。",
  too_short: "记录不足 60 秒。",
  too_few_unique_samples: "不重复的遥控样本不足 300 个。",
  non_monotonic: "部分样本时间顺序异常。",
  no_athlete_code: "尚未关联选手代号。",
  rx_link_lost: "遥控链路曾丢失，这条记录需要结合现场情况复核。",
  interrupted: "记录曾被中断，请结合现场情况复核。",
};

const markerCopy: Record<TrainingSessionMarkerKind, string> = {
  manual: "重点片段",
  crash: "炸机",
  gate_hit: "碰门",
  clean: "顺畅通过",
  throttle: "油门控制",
};

function formatDuration(durationMs: number) {
  const totalSeconds = Math.floor(Math.max(0, durationMs) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatMarkerTime(elapsedMs: number) {
  return `${formatDuration(elapsedMs)}.${Math.floor((Math.max(0, elapsedMs) % 1000) / 100)}`;
}

function formatDate(value: string, includeDate = true) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    ...(includeDate ? { month: "2-digit", day: "2-digit" } as const : {}),
    hour: "2-digit",
    minute: "2-digit",
    ...(includeDate ? {} : { second: "2-digit" } as const),
    hour12: false,
  }).format(date);
}

function sessionSources(session: TrainingSessionSummary) {
  return new Set([session.initialSource, ...session.dataSources]);
}

function sourceLabel(session: TrainingSessionSummary) {
  const sources = sessionSources(session);
  return sources.size > 1 ? "混合来源" : sources.has("ground_rc") ? "真实遥控" : "演示数据";
}

function statusLabel(session: TrainingSessionSummary) {
  if (session.validity.valid) return "有效训练";
  return sessionSources(session).has("ground_rc") ? "需复核" : "演示记录";
}

function throttleOverview(session: TrainingSession, durationMs: number) {
  const samples = session.samples;
  if (samples.length === 0) return [];
  const stride = Math.max(1, Math.ceil(samples.length / 360));
  const indices = new Set([0, samples.length - 1]);

  // Keep both extremes in each window so a short throttle spike stays visible.
  for (let start = 0; start < samples.length; start += stride) {
    let minimum = start;
    let maximum = start;
    for (let index = start + 1; index < Math.min(start + stride, samples.length); index += 1) {
      if (samples[index].rc.throttleStickPercent < samples[minimum].rc.throttleStickPercent) minimum = index;
      if (samples[index].rc.throttleStickPercent > samples[maximum].rc.throttleStickPercent) maximum = index;
    }
    indices.add(minimum);
    indices.add(maximum);
  }

  const breaks = new Set<number>();
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const sample = samples[index];
    const interval = sample.elapsedMs - previous.elapsedMs;
    if (interval <= 0 || interval > CAPTURE_GAP_THRESHOLD_MS || sample.source !== previous.source) {
      breaks.add(index);
      indices.add(index - 1);
      indices.add(index);
    }
  }
  const segments: string[][] = [[]];
  for (const index of [...indices].sort((left, right) => left - right)) {
    const sample = samples[index];
    const x = 20 + Math.min(1, Math.max(0, sample.elapsedMs / durationMs)) * 960;
    const y = 200 - Math.min(100, Math.max(0, sample.rc.throttleStickPercent)) * 1.8;
    if (breaks.has(index)) segments.push([]);
    segments.at(-1)!.push(`${x.toFixed(2)},${y.toFixed(2)}`);
  }
  return segments.filter((segment) => segment.length > 0).map((segment) => segment.join(" "));
}

export function SessionLibrary({
  sessions,
  loadSession,
  selectedSessionId,
  revealSessionId = null,
  onSelectSession,
  onExport,
  onUpdateNotes,
  onGoToLive,
  isRecording,
  storageState,
  saveState,
  pendingMediaSessionId,
  pendingTerminationSessionId,
  unsavedSessionIds = [],
}: SessionLibraryProps) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<SourceFilter>("all");
  const [visibleCount, setVisibleCount] = useState(50);
  const [detail, setDetail] = useState<{ id: string; session: TrainingSession | null; error: string | null } | null>(null);
  const [detailRevision, setDetailRevision] = useState(0);
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({});
  const [noteStatuses, setNoteStatuses] = useState<Record<string, NoteStatus>>({});
  const [activeMarker, setActiveMarker] = useState<{ sessionId: string; markerId: string } | null>(null);
  const [exportFeedback, setExportFeedback] = useState<{ sessionId: string; message: string; failed: boolean } | null>(null);
  const [exportingSessionId, setExportingSessionId] = useState<string | null>(null);
  const [copyFeedback, setCopyFeedback] = useState<{ sessionId: string; message: string } | null>(null);
  const exportingRef = useRef(false);
  const hasUnsavedNotes = useMemo(() => {
    const persistedNotes = new Map(sessions.map((session) => [session.id, session.notes ?? ""]));
    return Object.entries(noteDrafts).some(([id, notes]) => (
      notes !== (persistedNotes.get(id) ?? "") || noteStatuses[id] === "saving" || noteStatuses[id] === "error"
    ));
  }, [noteDrafts, noteStatuses, sessions]);

  useEffect(() => {
    if (!revealSessionId) return;
    const timer = window.setTimeout(() => {
      setQuery("");
      setFilter("all");
    }, 0);
    return () => window.clearTimeout(timer);
  }, [revealSessionId]);

  useEffect(() => {
    if (!hasUnsavedNotes) return;
    const warnBeforeLeaving = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeLeaving);
    return () => window.removeEventListener("beforeunload", warnBeforeLeaving);
  }, [hasUnsavedNotes]);

  const filteredSessions = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    return sessions.filter((session) => {
      const matchesAthlete = !search || (session.athleteCode ?? "未命名选手").toLocaleLowerCase().includes(search);
      const sources = sessionSources(session);
      const matchesSource = filter === "all" || sources.has(filter === "real" ? "ground_rc" : "demo");
      return matchesAthlete && matchesSource;
    }).sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt));
  }, [sessions, query, filter]);
  const selectedSession = filteredSessions.find((session) => session.id === selectedSessionId) ?? filteredSessions[0] ?? null;
  const detailId = selectedSession?.id;
  useEffect(() => {
    if (!detailId) return;
    let cancelled = false;
    void loadSession(detailId).then((session) => {
      if (!cancelled) setDetail({ id: detailId, session, error: session ? null : "这条记录的样本无法完整读取，请检查本机存储或使用归档文件恢复。" });
    }).catch((error: unknown) => {
      if (!cancelled) setDetail({ id: detailId, session: null, error: error instanceof Error ? error.message : "读取样本失败" });
    });
    return () => { cancelled = true; };
  }, [detailId, loadSession, detailRevision]);
  const detailedSession = detail && detail.id === detailId ? detail.session : null;
  const detailError = detail && detail.id === detailId ? detail.error : null;
  const selectedDurationMs = selectedSession
    ? Math.max(1, selectedSession.durationMs, detailedSession?.samples.at(-1)?.elapsedMs ?? 0)
    : 1;
  const graphSegments = useMemo(() => detailedSession ? throttleOverview(detailedSession, selectedDurationMs) : [], [detailedSession, selectedDurationMs]);
  const selectedNote = selectedSession ? noteDrafts[selectedSession.id] ?? selectedSession.notes ?? "" : "";
  const noteIsDirty = selectedSession ? selectedNote !== (selectedSession.notes ?? "") : false;
  const noteStatus = selectedSession ? noteStatuses[selectedSession.id] : undefined;
  const isPureDemo = selectedSession ? !sessionSources(selectedSession).has("ground_rc") : false;
  const selectedSessionIsSaved = selectedSession ? storageState === "ready" && !unsavedSessionIds.includes(selectedSession.id) : false;
  const dvrChecklist = selectedSession ? formatDvrReviewChecklist(selectedSession) : "";

  async function saveNotes(session: TrainingSessionSummary) {
    const notes = noteDrafts[session.id] ?? session.notes ?? "";
    setNoteStatuses((current) => ({ ...current, [session.id]: "saving" }));
    try {
      await onUpdateNotes(session.id, notes);
      setNoteDrafts((current) => ({ ...current, [session.id]: normalizeSessionNotes(notes) ?? "" }));
      setNoteStatuses((current) => ({ ...current, [session.id]: "saved" }));
    } catch {
      setNoteStatuses((current) => ({ ...current, [session.id]: "error" }));
    }
  }

  async function exportSelectedSession(session: TrainingSessionSummary) {
    if (exportingRef.current) return;
    exportingRef.current = true;
    setExportingSessionId(session.id);
    const notes = normalizeSessionNotes(selectedNote);
    try {
      const result = await onExport({ ...session, notes });
      setExportFeedback({ sessionId: session.id, message: result.message, failed: result.status === "failed" || !result.localStateSaved });
      if (result.status === "confirmed" && result.localStateSaved) {
        setNoteDrafts((current) => ({ ...current, [session.id]: notes ?? "" }));
        setNoteStatuses((current) => ({ ...current, [session.id]: "saved" }));
      }
    } catch {
      setExportFeedback({ sessionId: session.id, message: "未能发起 JSON 下载，请重试。备注草稿仍保留在页面中。", failed: true });
    } finally {
      exportingRef.current = false;
      setExportingSessionId(null);
    }
  }

  async function copyDvrChecklist(session: TrainingSessionSummary) {
    try {
      if (!navigator.clipboard) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(formatDvrReviewChecklist(session));
      setCopyFeedback({ sessionId: session.id, message: "DVR 复盘清单已复制" });
    } catch {
      setCopyFeedback({ sessionId: session.id, message: "未能自动复制，请在下方文本框中全选并复制。" });
    }
  }

  return (
    <section className="session-library" aria-labelledby="session-library-title">
      <header className="session-library-header">
        <div>
          <h2 id="session-library-title">每一次训练，都有迹可循。</h2>
          <p className="session-subtitle">查看本机记录，找到关键时刻，留下下一次训练的方向。</p>
        </div>
        <button className="session-button session-button--primary" type="button" onClick={onGoToLive}>
          {isRecording ? "返回正在记录的训练" : "开始一段训练"}<span aria-hidden="true">↗</span>
        </button>
      </header>

      {storageState === "error" || saveState === "error" ? (
        <p className="session-notice session-notice--warning" role="status">
          {pendingTerminationSessionId ? "遥控样本已入库，终止状态更新尚未确认；请重试保存终止状态。" : "本机存储暂不可用。页面内已有记录仍可查看，请先导出重要记录。"}
        </p>
      ) : null}
      {isRecording ? (
        <p className="session-notice" role="status">训练仍在后台记录。结束后，新记录会出现在这里。</p>
      ) : null}

      {sessions.length === 0 ? (
        <div className="session-empty">
          <span className="session-empty-mark" aria-hidden="true">◎</span>
          <h2>{storageState === "loading" ? "正在读取本机记录" : "从第一段训练开始"}</h2>
          <p>{storageState === "loading" ? "正在打开这个浏览器中的训练记录。" : "接入遥控输入，选择选手代号，开始记录。训练结束后即可在这里查看和导出。"}</p>
          {storageState !== "loading" ? <button className="session-button session-button--primary" type="button" onClick={onGoToLive}>前往训练工作台<span aria-hidden="true">→</span></button> : null}
          <span className="session-empty-note">记录保存在当前浏览器 · JSON 保存原始遥控、标记与采集信息</span>
        </div>
      ) : (
        <>
          <div className="session-toolbar">
            <label className="session-search">
              <span>搜索选手</span>
              <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="输入选手代号…" />
            </label>
            <div className="session-filters" role="group" aria-label="记录数据来源">
              {([{ value: "all", label: "全部记录" }, { value: "real", label: "真实遥控" }, { value: "demo", label: "演示数据" }] as const).map((option) => (
                <button key={option.value} className={`session-filter${filter === option.value ? " session-filter--active" : ""}`} type="button" aria-pressed={filter === option.value} onClick={() => setFilter(option.value)}>{option.label}</button>
              ))}
            </div>
            <span className="session-result-count" aria-live="polite">{filteredSessions.length} 条记录</span>
          </div>

          {selectedSession ? (
            <div className="session-library-grid">
              <aside className="session-list-panel" aria-label="训练记录">
                <div className="session-list-heading"><span>训练记录</span><small>按时间排序</small></div>
                <ul className="session-list">
                  {filteredSessions.slice(0, visibleCount).map((session) => (
                    <li key={session.id}>
                      <button className={`session-list-item${session.id === selectedSession.id ? " session-list-item--selected" : ""}`} type="button" aria-pressed={session.id === selectedSession.id} onClick={() => onSelectSession(session.id)}>
                        <span className="session-list-item-top"><strong>{session.athleteCode || "未命名选手"}</strong><span className="session-list-duration">{formatDuration(session.durationMs)}</span></span>
                        <span className="session-list-date">{formatDate(session.startedAt)}<span>{sourceLabel(session)}</span></span>
                        <span className="session-list-item-bottom"><span className={`session-badge${session.validity.valid ? " session-badge--valid" : ""}`}>{statusLabel(session)}</span><small>{unsavedSessionIds.includes(session.id) ? "尚未写入本机" : `${session.markers.length} 个标记`}</small></span>
                      </button>
                    </li>
                  ))}
                </ul>
                {visibleCount < filteredSessions.length ? <button className="session-button" type="button" onClick={() => setVisibleCount((count) => count + 50)}>显示更多记录</button> : null}
              </aside>

              <article className="session-detail" aria-labelledby="session-detail-title">
                <header className="session-detail-header">
                  <div>
                    <p className="session-eyebrow">训练复盘</p>
                    <h2 id="session-detail-title">{selectedSession.athleteCode || "未命名选手"}<span>训练记录</span></h2>
                    <p className="session-detail-date">{formatDate(selectedSession.startedAt)} · 本地时间</p>
                    <span className={`session-badge${selectedSessionIsSaved ? " session-badge--valid" : ""}`}>
                      {selectedSessionIsSaved ? "遥控数据已保存到本机" : "尚未保存"}
                    </span>
                  </div>
                  <button className="session-button" type="button" disabled={exportingSessionId !== null || noteStatus === "saving"} onClick={() => void exportSelectedSession(selectedSession)}>
                    {exportingSessionId === selectedSession.id ? "正在保存文件…" : "导出 JSON"}<span aria-hidden="true">↓</span>
                  </button>
                </header>

                {exportFeedback?.sessionId === selectedSession.id ? (
                  <p className={`session-save-feedback${exportFeedback.failed ? " session-save-feedback--error" : ""}`} role="status">
                    {exportFeedback.message}
                  </p>
                ) : null}

                <p className="session-save-feedback" role="status">{sessionMediaStatusText(selectedSession, pendingMediaSessionId === selectedSession.id)}</p>
                <p className="session-save-feedback">{hasCurrentSessionExport(selectedSession) ? "最新内容已确认导出。" : selectedSession.exportedAt ? "已有历史导出；最新内容尚未确认导出，旧文件仍保留。" : "尚未确认 JSON 文件导出。"}</p>
                {pendingTerminationSessionId === selectedSession.id ? <p role="status">遥控样本已保存，终止状态升级待重试；当前导出只包含已确认的终止事实。</p> : null}
                <dl className="session-metrics">
                  <div><dt>训练时长</dt><dd>{formatDuration(selectedSession.durationMs)}</dd></div>
                  <div><dt>遥控样本</dt><dd>{selectedSession.sampleCount.toLocaleString()}</dd></div>
                  <div><dt>估算采样率</dt><dd>{selectedSession.estimatedRcSampleRateHz === null ? "—" : <>{selectedSession.estimatedRcSampleRateHz.toFixed(1)}<small>Hz</small></>}</dd></div>
                  <div><dt>数据来源</dt><dd className="session-metric-source">{sourceLabel(selectedSession)}</dd></div>
                </dl>

                {unsavedSessionIds.includes(selectedSession.id) ? <p className="session-notice session-notice--warning" role="status">这条记录尚未成功写入本机。请先导出 JSON，避免关闭页面后丢失。</p> : null}

                <section className={`session-assessment${selectedSession.validity.valid ? " session-assessment--valid" : ""}`} aria-label="记录有效性">
                  <div>
                    <strong>{isPureDemo ? "演示记录，供体验与练习使用" : selectedSession.validity.valid ? "这是一条有效训练记录" : "这条记录未满足有效训练条件"}</strong>
                    <span>{isPureDemo ? "可以练习标记、备注与导出流程。演示数据不计入有效训练。" : selectedSession.validity.valid ? "真实遥控输入、时长、样本数量与时间顺序符合要求。" : "仍可查看和导出，以下信息帮助你判断记录是否可用于复盘。"}</span>
                  </div>
                  {!selectedSession.validity.valid && !isPureDemo ? (
                    <ul>{selectedSession.validity.reasons.map((reason) => <li key={reason}>{invalidReasonCopy[reason]}</li>)}</ul>
                  ) : null}
                  {isPureDemo && selectedSession.validity.reasons.length > 0 ? (
                    <details>
                      <summary>查看记录检查详情</summary>
                      <ul>{selectedSession.validity.reasons.map((reason) => <li key={reason}>{invalidReasonCopy[reason]}</li>)}</ul>
                    </details>
                  ) : null}
                </section>

                <SessionCaptureSummary session={selectedSession} />

                <section className="session-chart-section" aria-labelledby="session-chart-title">
                  <div className="session-section-heading">
                    <div><h3 id="session-chart-title">油门概览</h3><p>按原始样本时间排列 · 0–100% · 采集缺口处断开</p></div>
                    <span>{selectedSession.markers.length} 个标记</span>
                  </div>
                  {graphSegments.length > 0 ? (
                    <div className="session-chart">
                      <svg viewBox="0 0 1000 220" role="img" aria-label="本次训练的遥控油门曲线，纵向范围为百分之零至百分之一百，竖线表示手动标记">
                        <line className="session-chart-grid" x1="20" y1="20" x2="980" y2="20" />
                        <line className="session-chart-grid" x1="20" y1="110" x2="980" y2="110" />
                        <line className="session-chart-grid" x1="20" y1="200" x2="980" y2="200" />
                        {graphSegments.map((points, index) => {
                          if (points.includes(" ")) return <polyline key={index} className="session-chart-line" points={points} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" />;
                          const [cx, cy] = points.split(",");
                          return <circle key={index} className="session-chart-line" cx={cx} cy={cy} r="2" fill="currentColor" />;
                        })}
                        {selectedSession.markers.map((marker) => {
                          const x = 20 + Math.min(1, Math.max(0, marker.elapsedMs / selectedDurationMs)) * 960;
                          const isActive = activeMarker?.sessionId === selectedSession.id && activeMarker.markerId === marker.id;
                          return (
                            <line key={marker.id} className={`session-chart-marker${isActive ? " session-chart-marker--active" : ""}`} x1={x} y1="15" x2={x} y2="205">
                              <title>{markerCopy[marker.kind]} · {formatMarkerTime(marker.elapsedMs)}</title>
                            </line>
                          );
                        })}
                      </svg>
                      <div className="session-chart-axis"><span>00:00</span><span>{formatDuration(selectedDurationMs / 2)}</span><span>{formatDuration(selectedDurationMs)}</span></div>
                    </div>
                  ) : <p className="session-inline-empty" role="status">{detailError ?? (detailedSession ? "这条记录还没有可绘制的遥控样本。" : "正在读取这次训练的原始样本…")}</p>}
                  {detailError ? <button className="session-button" type="button" onClick={() => { setDetail(null); setDetailRevision((value) => value + 1); }}>重新读取样本</button> : null}
                </section>

                <section className="session-markers" aria-labelledby="session-markers-title">
                  <div className="session-section-heading"><div><h3 id="session-markers-title">值得再看一遍的时刻</h3><p>标记时间可用于人工对照 DVR；尚未校准视频时间偏移。</p></div></div>
                  {selectedSession.markers.length > 0 ? (
                    <ol className="session-marker-list">
                      {selectedSession.markers.map((marker) => {
                        const isActive = activeMarker?.sessionId === selectedSession.id && activeMarker.markerId === marker.id;
                        return (
                          <li key={marker.id}>
                            <button
                              className={`session-marker${isActive ? " session-marker--active" : ""}`}
                              type="button"
                              aria-pressed={isActive}
                              onClick={() => setActiveMarker({ sessionId: selectedSession.id, markerId: marker.id })}
                            >
                              <span className="session-marker-time">{formatMarkerTime(marker.elapsedMs)}</span>
                              <strong>{markerCopy[marker.kind]}</strong>
                              <span className="session-marker-walltime">{formatDate(marker.wallClockAt, false)}</span>
                              <span aria-hidden="true">↗</span>
                            </button>
                          </li>
                        );
                      })}
                    </ol>
                  ) : <p className="session-inline-empty">本次没有添加标记。下次训练中，遇到值得复盘的操作可以立即标记。</p>}
                </section>

                <section className="session-notes" aria-labelledby="session-dvr-title">
                  <div className="session-section-heading">
                    <div><h3 id="session-dvr-title">DVR 复盘清单</h3><p>保留人工标记与本地时间，方便对照独立的视频文件。</p></div>
                    <button className="session-button" type="button" onClick={() => void copyDvrChecklist(selectedSession)}>复制清单</button>
                  </div>
                  <textarea readOnly rows={Math.min(8, Math.max(3, selectedSession.markers.length + 2))} value={dvrChecklist} aria-label="DVR 复盘清单，可全选复制" onFocus={(event) => event.currentTarget.select()} />
                  {copyFeedback?.sessionId === selectedSession.id ? <p className="session-save-feedback" role="status">{copyFeedback.message}</p> : null}
                </section>

                <form className="session-notes" onSubmit={(event) => { event.preventDefault(); void saveNotes(selectedSession); }}>
                  <div className="session-section-heading"><div><h3><label htmlFor="session-review-notes">留给下一次训练</label></h3><p>记下一个发现，或一个下一次想改善的动作。</p></div></div>
                  <textarea
                    id="session-review-notes"
                    rows={4}
                    value={selectedNote}
                    maxLength={2000}
                    disabled={noteStatus === "saving" || exportingSessionId === selectedSession.id}
                    placeholder="例如：进弯前收油过急，下次先练习保持连续油门。"
                    onChange={(event) => {
                      const value = event.target.value;
                      setNoteDrafts((current) => ({ ...current, [selectedSession.id]: value }));
                      setNoteStatuses((current) => {
                        const next = { ...current };
                        delete next[selectedSession.id];
                        return next;
                      });
                    }}
                  />
                  <div className="session-notes-footer">
                    <span className={`session-save-feedback${noteStatus === "error" ? " session-save-feedback--error" : ""}`} role="status">
                      {noteStatus === "saving" ? "正在保存备注…" : noteStatus === "error" ? "备注未保存，草稿仍保留，请重试。" : noteStatus === "saved" && !noteIsDirty ? "备注已保存到本机" : noteIsDirty ? "有尚未保存的修改" : "备注仅保存在本机"}
                    </span>
                    <button className="session-button session-button--primary" type="submit" disabled={(!noteIsDirty && noteStatus !== "error" && !unsavedSessionIds.includes(selectedSession.id)) || noteStatus === "saving" || exportingSessionId === selectedSession.id}>
                      {noteStatus === "saving" ? "保存中…" : "保存备注"}
                    </button>
                  </div>
                </form>

                <footer className="session-detail-footer"><span>记录 ID · {selectedSession.id.slice(0, 8)}</span><span>JSON 不包含视频 · 视频文件请单独查看</span></footer>
              </article>
            </div>
          ) : (
            <div className="session-empty session-empty--filtered"><h2>没有找到对应记录</h2><p>试试其他选手代号，或显示全部数据来源。</p><button className="session-button" type="button" onClick={() => { setQuery(""); setFilter("all"); }}>清除筛选</button></div>
          )}
        </>
      )}
    </section>
  );
}
