import type { VisionCandidate, VisionCropPreset, VisionLabSettings, VisionLap, VisionRect, VisionResolvedEvent, VisionTimingRun } from "./vision-lab-types";
import type { VisionModelCandidate } from "./vision-model";

export const VISION_MAX_RANGE_MS = 180_000;
export const VISION_DEFAULT_SETTINGS: VisionLabSettings = { crop: "full", fromMs: 0, toMs: 30_000, sampleFps: 5, similarityThreshold: 0.65 };

export function visionCropRect(preset: VisionCropPreset): VisionRect {
  const corners: Record<VisionCropPreset, VisionRect> = {
    full: { x: 0, y: 0, width: 1, height: 1 },
    "top-left": { x: 0, y: 0, width: 0.5, height: 0.5 },
    "top-right": { x: 0.5, y: 0, width: 0.5, height: 0.5 },
    "bottom-left": { x: 0, y: 0.5, width: 0.5, height: 0.5 },
    "bottom-right": { x: 0.5, y: 0.5, width: 0.5, height: 0.5 },
  };
  return { ...corners[preset] };
}

export function validateVisionRange(settings: VisionLabSettings, durationMs: number) {
  if (![settings.fromMs, settings.toMs, settings.similarityThreshold, durationMs].every(Number.isFinite)
    || settings.fromMs < 0 || settings.toMs <= settings.fromMs || settings.toMs > durationMs
    || settings.toMs - settings.fromMs > VISION_MAX_RANGE_MS || ![2, 5, 10].includes(settings.sampleFps)
    || settings.similarityThreshold < 0 || settings.similarityThreshold > 1) {
    throw new Error("请选择录像内最多 3 分钟的有效区间，并使用支持的采样设置");
  }
}

export function resolveVisionEvents(run: Pick<VisionTimingRun, "candidates" | "reviews">): VisionResolvedEvent[] {
  const events = new Map<string, VisionResolvedEvent>(run.candidates.map((event) => [event.id, {
    ...event, status: "pending", origin: "model",
  }]));
  for (const review of run.reviews) {
    if (review.action === "add") {
      events.set(review.eventId, { id: review.eventId, timeMs: review.timeMs, startMs: review.timeMs, endMs: review.timeMs, status: "confirmed", origin: "manual", similarity: null, reason: review.reason });
      continue;
    }
    const event = events.get(review.eventId);
    if (!event) continue;
    events.set(event.id, {
      ...event,
      status: review.action === "reject" ? "rejected" : "confirmed",
      timeMs: review.action === "adjust" ? review.timeMs : event.timeMs,
      reason: review.reason,
    });
  }
  return [...events.values()].sort((a, b) => a.timeMs - b.timeMs || a.id.localeCompare(b.id));
}

export function deriveVisionLaps(run: Pick<VisionTimingRun, "candidates" | "reviews" | "gaps">): VisionLap[] {
  const events = resolveVisionEvents(run);
  const confirmed = events.filter((event) => event.status === "confirmed");
  return confirmed.slice(1).map((end, index) => {
    const start = confirmed[index];
    const unresolved = events.some((event) => event.status === "pending" && event.timeMs >= start.timeMs && event.timeMs <= end.timeMs);
    const gap = run.gaps.some((item) => item.startMs < end.timeMs && item.endMs > start.timeMs);
    const reason = end.timeMs <= start.timeMs ? "两个过门事件的时间重合" : unresolved ? "区间内还有待复核候选" : gap ? "区间包含未完成分析或解码缺口" : null;
    return {
      id: `${start.id}/${end.id}`, number: index + 1,
      startMs: start.timeMs, endMs: end.timeMs, durationMs: end.timeMs - start.timeMs,
      status: reason ? "incomplete" : "reviewed", reason,
    };
  });
}

interface Track {
  firstMs: number;
  lastMs: number;
  initialArea: number;
  currentArea: number;
  count: number;
  peak: VisionModelCandidate & { timeMs: number };
}

export type VisionTrackerRejection = "insufficient_observations" | "insufficient_growth" | "cooldown" | "observation_gap" | "matched_gap";

export interface VisionTrackerDiagnostics {
  readonly status: "idle" | "tracking" | "waiting_exit" | "proposed" | "rejected";
  readonly observations: number;
  readonly matchedObservations: number;
  readonly noMatchObservations: number;
  readonly proposals: number;
  readonly trackObservations: number;
  readonly initialArea: number | null;
  readonly peakArea: number | null;
  readonly currentArea: number | null;
  readonly growthRatio: number | null;
  readonly lastMatchMs: number | null;
  readonly requiredObservations: number;
  readonly requiredGrowthRatio: number;
  readonly shrinkRatio: number;
  readonly cooldownMs: number;
  readonly maxObservationGapMs: number;
  readonly exitDelayMs: number;
  readonly lastRejection: VisionTrackerRejection | null;
  readonly rejectionCounts: Readonly<Record<VisionTrackerRejection, number>>;
}

/** Reference motion only proposes review points; it never confirms a physical gate crossing. */
export function createVisionCandidateTracker({ sampleFps, idFactory, maxObservationGapMs, exitDelayMs }: {
  sampleFps: number;
  idFactory: () => string;
  maxObservationGapMs?: number;
  exitDelayMs?: number;
}) {
  const stepMs = 1000 / sampleFps;
  const maxGap = maxObservationGapMs ?? stepMs * 2.5;
  const exitDelay = exitDelayMs ?? stepMs * 1.5;
  if (![sampleFps, maxGap, exitDelay].every((value) => Number.isFinite(value) && value > 0)) throw new Error("跟踪采样率与时间窗口必须为有限正数");
  const requiredObservations = 3;
  const requiredGrowthRatio = 1.3;
  const shrinkRatio = 0.55;
  const cooldownMs = 1500;
  const increment = (value: number) => Math.min(Number.MAX_SAFE_INTEGER, value + 1);
  let track: Track | null = null;
  let lastMs = -Infinity;
  let lastProposal = -Infinity;
  let status: VisionTrackerDiagnostics["status"] = "idle";
  let observations = 0;
  let matchedObservations = 0;
  let noMatchObservations = 0;
  let proposals = 0;
  let lastRejection: VisionTrackerRejection | null = null;
  const rejectionCounts: Record<VisionTrackerRejection, number> = {
    insufficient_observations: 0, insufficient_growth: 0, cooldown: 0, observation_gap: 0, matched_gap: 0,
  };
  function reject(reason: VisionTrackerRejection) {
    lastRejection = reason;
    rejectionCounts[reason] = increment(rejectionCounts[reason]);
    status = "rejected";
    track = null;
  }
  function begin(timeMs: number, best: VisionModelCandidate) {
    const area = best.box.width * best.box.height;
    track = { firstMs: timeMs, lastMs: timeMs, initialArea: area, currentArea: area, count: 1, peak: { ...best, timeMs } };
    status = "tracking";
  }
  function finish(reason: string): VisionCandidate[] {
    const current = track;
    track = null;
    if (!current) return [];
    const rejection = current.count < requiredObservations ? "insufficient_observations"
      : current.peak.box.width * current.peak.box.height < current.initialArea * requiredGrowthRatio ? "insufficient_growth"
        : current.peak.timeMs - lastProposal < cooldownMs ? "cooldown" : null;
    if (rejection) { reject(rejection); return []; }
    lastProposal = current.peak.timeMs;
    proposals = increment(proposals);
    status = "proposed";
    return [{ id: idFactory(), timeMs: current.peak.timeMs, startMs: current.firstMs, endMs: current.lastMs,
      similarity: current.peak.similarity, box: current.peak.box, reason }];
  }
  return {
    push(timeMs: number, candidates: VisionModelCandidate[]): VisionCandidate[] {
      if (!Number.isFinite(timeMs) || timeMs < 0 || timeMs <= lastMs) throw new Error("录像观察时间必须严格递增");
      observations = increment(observations);
      if (track && timeMs - lastMs > maxGap) reject("observation_gap");
      lastMs = timeMs;
      const best = candidates[0];
      if (!best) {
        noMatchObservations = increment(noMatchObservations);
        if (!track) return [];
        status = "waiting_exit";
        return timeMs - track.lastMs >= exitDelay
          ? finish("相似目标接近后离开画面；请确认是否过门并调整时刻") : [];
      }
      matchedObservations = increment(matchedObservations);
      const area = best.box.width * best.box.height;
      if (track && timeMs - track.lastMs > maxGap) reject("matched_gap");
      if (!track) {
        begin(timeMs, best);
        return [];
      }
      const peakArea = track.peak.box.width * track.peak.box.height;
      if (area < peakArea * shrinkRatio && track.count >= requiredObservations) {
        const found = finish("相似目标由近变远；请排除绕门、反向和转身");
        begin(timeMs, best);
        return found;
      }
      track.lastMs = timeMs;
      track.currentArea = area;
      track.count = increment(track.count);
      status = "tracking";
      if (area > peakArea || (area === peakArea && best.similarity > track.peak.similarity)) track.peak = { ...best, timeMs };
      return [];
    },
    finish: () => finish("片段结束前相似目标曾接近；穿越尚未确认"),
    getDiagnostics(): VisionTrackerDiagnostics {
      const peakArea = track ? track.peak.box.width * track.peak.box.height : null;
      return Object.freeze({ status, observations, matchedObservations, noMatchObservations, proposals,
        trackObservations: track?.count ?? 0, initialArea: track?.initialArea ?? null, peakArea,
        currentArea: track?.currentArea ?? null, growthRatio: track && track.initialArea > 0 ? peakArea! / track.initialArea : null,
        lastMatchMs: track?.lastMs ?? null, requiredObservations, requiredGrowthRatio, shrinkRatio, cooldownMs,
        maxObservationGapMs: maxGap, exitDelayMs: exitDelay, lastRejection,
        rejectionCounts: Object.freeze({ ...rejectionCounts }),
      });
    },
  };
}

function csvCell(value: string | number) {
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function visionLapsCsv(run: VisionTimingRun) {
  const rows: Array<Array<string | number>> = [["run_id", "gate", "video", "lap", "start_ms", "end_ms", "duration_ms", "status", "reason"]];
  for (const lap of deriveVisionLaps(run)) rows.push([run.id, run.profile.name, run.video.name, lap.number, lap.startMs, lap.endMs, lap.durationMs, lap.status, lap.reason ?? "人工复核的起终点间隔；非完整赛道验证"]);
  return `\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

export function visionExportFilename(id: string, revision: number, format: "json" | "csv", exportId: string) {
  const clean = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
  return `fpv-vision-${clean(id)}-v${Math.max(1, revision)}-${clean(exportId)}.${format}`;
}
