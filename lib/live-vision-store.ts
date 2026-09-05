import type { LiveVisionObservation, LiveVisionRun, LiveVisionRunSummary } from "./live-vision-types";
import { LIVE_VISION_MAX_DURATION_MS } from "./live-vision-types";
import type { VisionRect, VisionReview } from "./vision-lab-types";
import { deriveVisionLaps } from "./vision-timing";

const DATABASE = "fpvhelper-live-vision";
const MAX_JSON_BYTES = 20 * 1024 ** 2;
function invalid(field: string): never { throw new Error(`实时视觉记录无效：${field}`); }
function object(value: unknown, field: string, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) invalid(field);
  return value as Record<string, unknown>;
}
function text(value: unknown, field: string, maximum = 2000) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) invalid(field);
  return value;
}
function identifier(value: unknown, field: string) {
  const result = text(value, field, 512);
  return result;
}
function number(value: unknown, field: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) invalid(field);
  return value;
}
function integer(value: unknown, field: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  const result = number(value, field, minimum, maximum);
  if (!Number.isSafeInteger(result)) invalid(field);
  return result;
}
function choice<T extends string>(value: unknown, field: string, choices: readonly T[]): T {
  if (typeof value !== "string" || !choices.includes(value as T)) invalid(field);
  return value as T;
}
function hash(value: unknown, field: string) {
  const result = text(value, field, 64);
  if (!/^[a-f0-9]{64}$/.test(result)) invalid(field);
  return result;
}
function date(value: unknown, field: string) {
  const result = text(value, field, 40);
  if (!Number.isFinite(Date.parse(result)) || new Date(result).toISOString() !== result) invalid(field);
  return result;
}
function array(value: unknown, field: string, maximum = 5000): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) invalid(field);
  return value;
}
export function validateLiveVisionRect(value: unknown): VisionRect {
  const raw = object(value, "crop", ["x", "y", "width", "height"]);
  const rect = { x: number(raw.x, "crop.x", 0, 1), y: number(raw.y, "crop.y", 0, 1), width: number(raw.width, "crop.width", Number.MIN_VALUE, 1), height: number(raw.height, "crop.height", Number.MIN_VALUE, 1) };
  if (rect.x + rect.width > 1.000000001 || rect.y + rect.height > 1.000000001) invalid("crop 越界");
  return rect;
}

export function parseLiveVisionRun(value: unknown): LiveVisionRun {
  let json: string | undefined;
  try { json = JSON.stringify(value); } catch { invalid("JSON 格式"); }
  if (!json || json.length > MAX_JSON_BYTES || new TextEncoder().encode(json).byteLength > MAX_JSON_BYTES) invalid("JSON 超过 20 MB");
  const raw = object(value, "run", ["schemaVersion", "kind", "pipelineVersion", "provenance", "id", "createdAt", "source", "profile", "model", "clock", "settings", "state", "endedAtEpochMs", "elapsedMs", "analyzedUntilMs", "stopReason", "observations", "candidates", "reviews", "gaps"]);
  if (raw.schemaVersion !== 1 || raw.kind !== "fpvhelper-live-vision" || raw.pipelineVersion !== "reference-motion-v1") invalid("实时记录类型或版本");
  const source = object(raw.source, "source", ["sourceId", "pilotChannelId", "pilotName", "streamId", "videoTrackId", "width", "height", "crop", "trainingSessionId"]);
  const profile = object(raw.profile, "profile", ["schemaVersion", "id", "revision", "name", "imageSha256", "rect", "createdAt"]);
  if (profile.schemaVersion !== 1) invalid("profile.schemaVersion");
  const model = object(raw.model, "model", ["id", "revision", "weightsSha256", "backend"]);
  const clock = object(raw.clock, "clock", ["kind", "timeOriginEpochMs", "startedAtPerformanceMs", "startedAtEpochMs", "physicalCaptureTimeKnown", "trainingSynchronized"]);
  if (clock.kind !== "host_presentation_estimate" || clock.physicalCaptureTimeKnown !== false || clock.trainingSynchronized !== false) invalid("时钟不能宣称曝光时间或同步");
  const startedAtPerformanceMs = number(clock.startedAtPerformanceMs, "clock.startedAtPerformanceMs");
  const settings = object(raw.settings, "settings", ["sampleFps", "similarityThreshold", "maxDurationMs"]);
  if (settings.sampleFps !== 2 || settings.maxDurationMs !== LIVE_VISION_MAX_DURATION_MS) invalid("实时采样设置");
  const elapsedMs = number(raw.elapsedMs, "elapsedMs", 0, LIVE_VISION_MAX_DURATION_MS);
  const analyzedUntilMs = number(raw.analyzedUntilMs, "analyzedUntilMs", 0, elapsedMs);
  const time = (value: unknown, field: string) => number(value, field, 0, elapsedMs);
  let previous = -1;
  const observations: LiveVisionObservation[] = array(raw.observations, "observations", 3601).map((value) => {
    const entry = object(value, "observation", ["timeMs", "hostObservedAtMs", "method", "callback", "inferenceMs"]);
    const timeMs = time(entry.timeMs, "observation.timeMs");
    const hostObservedAtMs = number(entry.hostObservedAtMs, "observation.hostObservedAtMs", startedAtPerformanceMs);
    if (timeMs <= previous || timeMs > analyzedUntilMs || Math.abs(hostObservedAtMs - startedAtPerformanceMs - timeMs) > 0.01) invalid("观察时间必须递增并对应主机时钟");
    previous = timeMs;
    const callback = entry.callback === null ? null : object(entry.callback, "callback", ["mediaTimeSeconds", "presentedFrames", "presentationTimeMs", "expectedDisplayTimeMs"]);
    const optionalNumber = (value: unknown, field: string) => value === null ? null : number(value, field);
    const method = choice(entry.method, "observation.method", ["video_frame_callback", "current_time_poll"]);
    if ((method === "current_time_poll") !== (callback === null)) invalid("视频回调元数据来源");
    return { timeMs, hostObservedAtMs, method, callback: callback ? {
      mediaTimeSeconds: optionalNumber(callback.mediaTimeSeconds, "callback.mediaTimeSeconds"),
      presentedFrames: callback.presentedFrames === null ? null : integer(callback.presentedFrames, "callback.presentedFrames"),
      presentationTimeMs: optionalNumber(callback.presentationTimeMs, "callback.presentationTimeMs"),
      expectedDisplayTimeMs: optionalNumber(callback.expectedDisplayTimeMs, "callback.expectedDisplayTimeMs"),
    } : null, inferenceMs: number(entry.inferenceMs, "observation.inferenceMs") };
  });
  if (observations.length && observations.at(-1)!.timeMs !== analyzedUntilMs) invalid("分析进度不对应最后观察");
  const eventTimes = new Map<string, number>();
  const candidates = array(raw.candidates, "candidates").map((value) => {
    const entry = object(value, "candidate", ["id", "timeMs", "startMs", "endMs", "similarity", "box", "reason"]);
    const id = identifier(entry.id, "candidate.id");
    const timeMs = time(entry.timeMs, "candidate.timeMs"), startMs = time(entry.startMs, "candidate.startMs"), endMs = time(entry.endMs, "candidate.endMs");
    if (eventTimes.has(id) || startMs > timeMs || timeMs > endMs || endMs > analyzedUntilMs || !observations.length) invalid("候选时间或 ID");
    eventTimes.set(id, timeMs);
    return { id, timeMs, startMs, endMs, similarity: number(entry.similarity, "candidate.similarity", -1, 1), box: validateLiveVisionRect(entry.box), reason: text(entry.reason, "candidate.reason") };
  });
  const reviewIds = new Set<string>();
  const reviews: VisionReview[] = array(raw.reviews, "reviews").map((value) => {
    const entry = object(value, "review", ["id", "eventId", "action", "timeMs", "reason", "createdAt"]);
    const id = identifier(entry.id, "review.id"), eventId = identifier(entry.eventId, "review.eventId");
    const action = choice(entry.action, "review.action", ["add", "confirm", "reject", "adjust"]);
    const timeMs = time(entry.timeMs, "review.timeMs");
    if (reviewIds.has(id) || (action === "add" ? eventTimes.has(eventId) : !eventTimes.has(eventId))) invalid("复核历史引用");
    if ((action === "confirm" || action === "reject") && eventTimes.get(eventId) !== timeMs) invalid("改时刻须显式 adjust");
    reviewIds.add(id); eventTimes.set(eventId, timeMs);
    return { id, eventId, action, timeMs, reason: text(entry.reason, "review.reason"), createdAt: date(entry.createdAt, "review.createdAt") };
  });
  const gaps = array(raw.gaps, "gaps").map((value) => {
    const entry = object(value, "gap", ["startMs", "endMs", "reason"]);
    const startMs = time(entry.startMs, "gap.startMs"), endMs = time(entry.endMs, "gap.endMs");
    if (endMs <= startMs) invalid("gap 时间顺序");
    return { startMs, endMs, reason: text(entry.reason, "gap.reason") };
  });
  const state = choice(raw.state, "state", ["starting", "monitoring", "stopped", "interrupted", "failed"]);
  const endedAtEpochMs = raw.endedAtEpochMs === null ? null : number(raw.endedAtEpochMs, "endedAtEpochMs");
  const stopReason = raw.stopReason === null ? null : text(raw.stopReason, "stopReason");
  if ((state === "starting" || state === "monitoring") && (endedAtEpochMs !== null || stopReason !== null)) invalid("运行中不能带结束声明");
  if (!["starting", "monitoring"].includes(state) && !stopReason) invalid("结束记录须说明原因");
  return {
    schemaVersion: 1, kind: "fpvhelper-live-vision", pipelineVersion: "reference-motion-v1", provenance: choice(raw.provenance, "provenance", ["local", "imported"]), id: identifier(raw.id, "id"), createdAt: date(raw.createdAt, "createdAt"),
    source: { sourceId: identifier(source.sourceId, "source.sourceId"), pilotChannelId: identifier(source.pilotChannelId, "source.pilotChannelId"), pilotName: text(source.pilotName, "source.pilotName", 120), streamId: identifier(source.streamId, "source.streamId"), videoTrackId: identifier(source.videoTrackId, "source.videoTrackId"), width: integer(source.width, "source.width", 1, 32768), height: integer(source.height, "source.height", 1, 32768), crop: validateLiveVisionRect(source.crop), trainingSessionId: source.trainingSessionId === null ? null : identifier(source.trainingSessionId, "source.trainingSessionId") },
    profile: { schemaVersion: 1, id: identifier(profile.id, "profile.id"), revision: integer(profile.revision, "profile.revision", 1), name: text(profile.name, "profile.name", 120), imageSha256: hash(profile.imageSha256, "profile.imageSha256"), rect: validateLiveVisionRect(profile.rect), createdAt: date(profile.createdAt, "profile.createdAt") },
    model: { id: text(model.id, "model.id", 200), revision: text(model.revision, "model.revision", 160), weightsSha256: hash(model.weightsSha256, "model.weightsSha256"), backend: text(model.backend, "model.backend", 80) },
    clock: { kind: "host_presentation_estimate", timeOriginEpochMs: number(clock.timeOriginEpochMs, "clock.timeOriginEpochMs"), startedAtPerformanceMs, startedAtEpochMs: number(clock.startedAtEpochMs, "clock.startedAtEpochMs"), physicalCaptureTimeKnown: false, trainingSynchronized: false },
    settings: { sampleFps: 2, similarityThreshold: number(settings.similarityThreshold, "settings.similarityThreshold", 0, 1), maxDurationMs: LIVE_VISION_MAX_DURATION_MS },
    state, endedAtEpochMs, elapsedMs, analyzedUntilMs, stopReason, observations, candidates, reviews, gaps,
  };
}

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("浏览器不支持实时视觉本地存储"));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    let settled = false;
    request.onupgradeneeded = () => request.result.createObjectStore("runs", { keyPath: "id" });
    request.onsuccess = () => { if (settled) { request.result.close(); return; } settled = true; request.result.onversionchange = () => request.result.close(); resolve(request.result); };
    request.onerror = () => { settled = true; reject(request.error ?? new Error("无法打开实时视觉存储")); };
    request.onblocked = () => { settled = true; reject(new Error("实时视觉存储被其他页面占用，请关闭旧页面重试")); };
  });
}

async function readRuns(id?: string): Promise<unknown> {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const tx = database.transaction("runs", "readonly");
      const request = id ? tx.objectStore("runs").get(id) : tx.objectStore("runs").getAll();
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = tx.onerror = () => reject(tx.error ?? request.error ?? new Error("实时视觉读取失败"));
    });
  } finally { database.close(); }
}

export async function getLiveVisionRun(id: string): Promise<LiveVisionRun | null> {
  const value = await readRuns(identifier(id, "id"));
  return value === undefined ? null : parseLiveVisionRun(value);
}
export async function listLiveVisionRuns(): Promise<LiveVisionRunSummary[]> {
  const values = await readRuns() as unknown[];
  return values.map(parseLiveVisionRun).map(({ id, createdAt, source, profile, state, elapsedMs }) => ({ id, createdAt, pilotName: source.pilotName, gateName: profile.name, state, elapsedMs })).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export async function saveLiveVisionRun(value: LiveVisionRun): Promise<void> {
  const run = parseLiveVisionRun(value);
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction("runs", "readwrite");
      const store = tx.objectStore("runs");
      let failure: unknown;
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(failure ?? tx.error ?? new Error("实时视觉保存事务已中止"));
      const read = store.get(run.id);
      read.onsuccess = () => {
        try {
          if (read.result !== undefined) {
            const existing = parseLiveVisionRun(read.result);
            const histories = ["reviews", "observations", "candidates", "gaps"] as const;
            const identity = (entry: LiveVisionRun) => JSON.stringify([entry.createdAt, entry.source, entry.profile, entry.clock, entry.model, entry.settings, entry.provenance]);
            if (identity(existing) !== identity(run) || existing.elapsedMs > run.elapsedMs || existing.analyzedUntilMs > run.analyzedUntilMs
              || (!["starting", "monitoring"].includes(existing.state) && existing.state !== run.state)
              || histories.some((key) => existing[key].length > run[key].length || existing[key].some((entry, index) => JSON.stringify(entry) !== JSON.stringify(run[key][index])))) {
              throw new Error("实时记录保存冲突：已有更新或不同的历史。请先导出本页 JSON，再重新载入最新记录；已有内容未被覆盖");
            }
          }
          store.put(run);
        } catch (error) { failure = error; tx.abort(); }
      };
    });
  } finally { database.close(); }
}

export function liveVisionLapsCsv(run: LiveVisionRun) {
  const cell = (value: string | number) => { const text = String(value); return `"${(/^[=+\-@\t\r]/.test(text) ? `'${text}` : text).replaceAll('"', '""')}"`; };
  const rows: Array<Array<string | number>> = [["live_run_id", "pilot", "gate", "source_id", "training_session_id", "clock", "synchronized", "lap", "start_ms", "end_ms", "duration_ms", "status", "reason"]];
  for (const lap of deriveVisionLaps(run)) rows.push([run.id, run.source.pilotName, run.profile.name, run.source.sourceId, run.source.trainingSessionId ?? "", run.clock.kind, "false", lap.number, lap.startMs, lap.endMs, lap.durationMs, lap.status, lap.reason ?? "人工复核的主机观察时间间隔；非正式赛事计时"]);
  return `\uFEFF${rows.map((row) => row.map(cell).join(",")).join("\r\n")}\r\n`;
}
export function liveVisionExportFilename(runId: string, format: "json" | "csv", exportId: string) {
  const safe = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
  return `fpv-live-vision-${safe(runId)}-${safe(exportId)}.${format}`;
}
