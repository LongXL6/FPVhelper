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

export function resolveVisionEvents(run: VisionTimingRun): VisionResolvedEvent[] {
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

export function deriveVisionLaps(run: VisionTimingRun): VisionLap[] {
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
  count: number;
  peak: VisionModelCandidate & { timeMs: number };
}

/** Reference motion only proposes review points; it never confirms a physical gate crossing. */
export function createVisionCandidateTracker({ sampleFps, idFactory }: { sampleFps: number; idFactory: () => string }) {
  const stepMs = 1000 / sampleFps;
  let track: Track | null = null;
  let lastMs = -Infinity;
  let lastProposal = -Infinity;
  function finish(reason: string): VisionCandidate[] {
    const current = track;
    track = null;
    if (!current || current.count < 3 || current.peak.box.width * current.peak.box.height < current.initialArea * 1.3
      || current.peak.timeMs - lastProposal < 1500) return [];
    lastProposal = current.peak.timeMs;
    return [{ id: idFactory(), timeMs: current.peak.timeMs, startMs: current.firstMs, endMs: current.lastMs,
      similarity: current.peak.similarity, box: current.peak.box, reason }];
  }
  return {
    push(timeMs: number, candidates: VisionModelCandidate[]): VisionCandidate[] {
      if (!Number.isFinite(timeMs) || timeMs < 0 || timeMs <= lastMs) throw new Error("录像观察时间必须严格递增");
      if (timeMs - lastMs > stepMs * 2.5) track = null;
      lastMs = timeMs;
      const best = candidates[0];
      if (!best) return track && timeMs - track.lastMs >= stepMs * 1.5
        ? finish("相似目标接近后离开画面；请确认是否过门并调整时刻") : [];
      const area = best.box.width * best.box.height;
      if (!track) {
        track = { firstMs: timeMs, lastMs: timeMs, initialArea: area, count: 1, peak: { ...best, timeMs } };
        return [];
      }
      if (timeMs - track.lastMs > stepMs * 2.5) {
        track = null;
        return [];
      }
      const peakArea = track.peak.box.width * track.peak.box.height;
      if (area < peakArea * 0.55 && track.count >= 3) {
        const found = finish("相似目标由近变远；请排除绕门、反向和转身");
        track = { firstMs: timeMs, lastMs: timeMs, initialArea: area, count: 1, peak: { ...best, timeMs } };
        return found;
      }
      track.lastMs = timeMs;
      track.count += 1;
      if (area > peakArea || (area === peakArea && best.similarity > track.peak.similarity)) track.peak = { ...best, timeMs };
      return [];
    },
    finish: () => finish("片段结束前相似目标曾接近；穿越尚未确认"),
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
