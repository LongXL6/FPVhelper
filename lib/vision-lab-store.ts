import type { VisionGateProfile, VisionLabSettings, VisionProfileSummary, VisionRect, VisionReview, VisionRunSummary, VisionTimingRun } from "./vision-lab-types";

const DATABASE_NAME = "fpvhelper-vision-lab";
const MAX_JSON_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_EVENTS = 5_000;
const MAX_REVIEWS = 5_000;
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];

function invalid(field: string): never { throw new Error(`视觉实验数据无效：${field}`); }
function object(value: unknown, field: string, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key))) invalid(field);
  return value as Record<string, unknown>;
}
function text(value: unknown, field: string, limit = 2000) {
  if (typeof value !== "string" || !value.trim() || value.length > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) invalid(field);
  return value;
}
function id(value: unknown, field: string) {
  const result = text(value, field, 160);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(result)) invalid(field);
  return result;
}
function number(value: unknown, field: string, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) invalid(field);
  return value;
}
function integer(value: unknown, field: string, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const result = number(value, field, min, max);
  if (!Number.isSafeInteger(result)) invalid(field);
  return result;
}
function hash(value: unknown, field: string) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) invalid(field);
  return value;
}
function date(value: unknown, field: string) {
  const result = text(value, field, 40);
  if (!Number.isFinite(Date.parse(result)) || new Date(result).toISOString() !== result) invalid(field);
  return result;
}
function choice<T extends string>(value: unknown, field: string, choices: readonly T[]): T {
  if (typeof value !== "string" || !choices.includes(value as T)) invalid(field);
  return value as T;
}
function array(value: unknown, field: string, limit: number): unknown[] {
  if (!Array.isArray(value) || value.length > limit) invalid(field);
  return value;
}
function assertJsonSize(value: unknown) {
  let serialized: string | undefined;
  try { serialized = JSON.stringify(value); } catch { invalid("JSON 无法序列化"); }
  if (!serialized || serialized.length > MAX_JSON_BYTES || new TextEncoder().encode(serialized).byteLength > MAX_JSON_BYTES) invalid("JSON 超过 20 MiB 或格式无效");
}
function parseJson(raw: string) {
  if (typeof raw !== "string" || raw.length > MAX_JSON_BYTES || new TextEncoder().encode(raw).byteLength > MAX_JSON_BYTES) invalid("JSON 超过 20 MiB");
  try { return JSON.parse(raw) as unknown; } catch { invalid("JSON 语法"); }
}

function rect(value: unknown, field: string): VisionRect {
  const raw = object(value, field, ["x", "y", "width", "height"]);
  const result = {
    x: number(raw.x, `${field}.x`, 0, 1), y: number(raw.y, `${field}.y`, 0, 1),
    width: number(raw.width, `${field}.width`, Number.MIN_VALUE, 1), height: number(raw.height, `${field}.height`, Number.MIN_VALUE, 1),
  };
  if (result.x + result.width > 1 + 1e-9 || result.y + result.height > 1 + 1e-9) invalid(`${field} 超出图像范围`);
  return result;
}

function profileMetadata(value: unknown, withImage = false): Omit<VisionGateProfile, "image"> {
  const raw = object(value, "profile", ["schemaVersion", "id", "revision", "name", "imageSha256", "rect", "createdAt", ...(withImage ? ["image"] : [])]);
  if (raw.schemaVersion !== 1) invalid("profile.schemaVersion");
  return {
    schemaVersion: 1, id: id(raw.id, "profile.id"), revision: integer(raw.revision, "profile.revision", 1),
    name: text(raw.name, "profile.name", 120), imageSha256: hash(raw.imageSha256, "profile.imageSha256"),
    rect: rect(raw.rect, "profile.rect"), createdAt: date(raw.createdAt, "profile.createdAt"),
  };
}

async function validateProfile(value: unknown): Promise<VisionGateProfile> {
  const metadata = profileMetadata(value, true);
  const image = (value as Record<string, unknown>).image;
  if (!(image instanceof Blob) || !IMAGE_TYPES.includes(image.type) || image.size === 0 || image.size > MAX_IMAGE_BYTES) invalid("参考图必须是 10 MiB 内的 PNG、JPEG 或 WebP");
  const bytes = new Uint8Array(await image.arrayBuffer());
  const signatureMatches = image.type === "image/png"
    ? bytes.slice(0, 8).join(",") === "137,80,78,71,13,10,26,10"
    : image.type === "image/jpeg"
      ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      : bytes.slice(0, 4).join(",") === "82,73,70,70" && bytes.slice(8, 12).join(",") === "87,69,66,80";
  if (!signatureMatches) invalid("参考图内容与格式不匹配");
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (digest !== metadata.imageSha256) invalid("参考图 SHA-256 不匹配");
  return { ...metadata, image };
}

export async function serializeVisionProfile(profile: VisionGateProfile): Promise<string> {
  const valid = await validateProfile(profile);
  const bytes = new Uint8Array(await valid.image.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 16_384) binary += String.fromCharCode(...bytes.subarray(offset, offset + 16_384));
  return JSON.stringify({ ...valid, image: { mimeType: valid.image.type, base64: btoa(binary) } });
}

export async function parseVisionProfile(raw: string): Promise<VisionGateProfile> {
  const value = parseJson(raw);
  const metadata = profileMetadata(value, true);
  const image = object((value as Record<string, unknown>).image, "profile.image", ["mimeType", "base64"]);
  const mimeType = choice(image.mimeType, "profile.image.mimeType", IMAGE_TYPES);
  const encoded = image.base64;
  if (typeof encoded !== "string" || encoded.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) invalid("参考图 Base64");
  let binary: string;
  try { binary = atob(encoded); } catch { invalid("参考图 Base64"); }
  if (binary.length === 0 || binary.length > MAX_IMAGE_BYTES || btoa(binary) !== encoded) invalid("参考图 Base64 或大小");
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return validateProfile({ ...metadata, image: new Blob([bytes], { type: mimeType }) });
}

export function parseVisionRun(value: unknown): VisionTimingRun {
  assertJsonSize(value);
  const raw = object(value, "run", ["schemaVersion", "pipelineVersion", "timestampSource", "provenance", "id", "createdAt", "profile", "video", "settings", "model", "state", "analyzedUntilMs", "analyzedFrames", "candidates", "reviews", "gaps"]);
  if (raw.schemaVersion !== 1) invalid("run.schemaVersion");
  const rawVideo = object(raw.video, "video", ["name", "size", "lastModified", "sha256", "durationMs", "width", "height"]);
  const video = {
    name: text(rawVideo.name, "video.name", 512), size: integer(rawVideo.size, "video.size", 1, 20 * 1024 ** 3),
    lastModified: integer(rawVideo.lastModified, "video.lastModified"), sha256: hash(rawVideo.sha256, "video.sha256"),
    durationMs: number(rawVideo.durationMs, "video.durationMs", Number.MIN_VALUE, 12 * 60 * 60 * 1000),
    width: integer(rawVideo.width, "video.width", 1, 32_768), height: integer(rawVideo.height, "video.height", 1, 32_768),
  };
  const rawSettings = object(raw.settings, "settings", ["crop", "fromMs", "toMs", "sampleFps", "similarityThreshold"]);
  const fromMs = number(rawSettings.fromMs, "settings.fromMs", 0, video.durationMs);
  const toMs = number(rawSettings.toMs, "settings.toMs", 0, video.durationMs);
  if (fromMs >= toMs || toMs - fromMs > 180_000) invalid("分析时间范围须在 180 秒内");
  if (rawSettings.sampleFps !== 2 && rawSettings.sampleFps !== 5 && rawSettings.sampleFps !== 10) invalid("settings.sampleFps");
  const settings: VisionLabSettings = {
    crop: choice(rawSettings.crop, "settings.crop", ["full", "top-left", "top-right", "bottom-left", "bottom-right"]),
    fromMs, toMs, sampleFps: rawSettings.sampleFps, similarityThreshold: number(rawSettings.similarityThreshold, "settings.similarityThreshold", 0, 1),
  };
  const time = (input: unknown, field: string) => number(input, field, fromMs, toMs);
  const seenEvents = new Map<string, number>();
  const candidates = array(raw.candidates, "candidates", MAX_EVENTS).map((value) => {
    const candidate = object(value, "candidate", ["id", "timeMs", "startMs", "endMs", "similarity", "box", "reason"]);
    const eventId = id(candidate.id, "candidate.id");
    if (seenEvents.has(eventId)) invalid("候选事件 ID 重复");
    const startMs = time(candidate.startMs, "candidate.startMs");
    const timeMs = time(candidate.timeMs, "candidate.timeMs");
    const endMs = time(candidate.endMs, "candidate.endMs");
    if (startMs > timeMs || timeMs > endMs) invalid("候选事件时间顺序");
    seenEvents.set(eventId, timeMs);
    return { id: eventId, timeMs, startMs, endMs, similarity: number(candidate.similarity, "candidate.similarity", -1, 1), box: rect(candidate.box, "candidate.box"), reason: text(candidate.reason, "candidate.reason") };
  });
  const seenReviews = new Set<string>();
  const reviews: VisionReview[] = array(raw.reviews, "reviews", MAX_REVIEWS).map((value) => {
    const review = object(value, "review", ["id", "eventId", "action", "timeMs", "reason", "createdAt"]);
    const reviewId = id(review.id, "review.id");
    if (seenReviews.has(reviewId)) invalid("复核 ID 重复");
    seenReviews.add(reviewId);
    const eventId = id(review.eventId, "review.eventId");
    const action = choice(review.action, "review.action", ["confirm", "reject", "adjust", "add"]);
    if (action === "add" ? seenEvents.has(eventId) : !seenEvents.has(eventId)) invalid("复核事件引用");
    const timeMs = time(review.timeMs, "review.timeMs");
    if ((action === "confirm" || action === "reject") && timeMs !== seenEvents.get(eventId)) invalid("改时刻必须记录为 adjust");
    seenEvents.set(eventId, timeMs);
    return { id: reviewId, eventId, action, timeMs, reason: text(review.reason, "review.reason"), createdAt: date(review.createdAt, "review.createdAt") };
  });
  const gaps = array(raw.gaps, "gaps", MAX_EVENTS).map((value) => {
    const gap = object(value, "gap", ["startMs", "endMs", "reason"]);
    const startMs = time(gap.startMs, "gap.startMs");
    const endMs = time(gap.endMs, "gap.endMs");
    if (endMs <= startMs) invalid("缺口时间范围");
    return { startMs, endMs, reason: text(gap.reason, "gap.reason") };
  });
  const model = object(raw.model, "model", ["id", "revision", "weightsSha256", "backend"]);
  const state = choice(raw.state, "run.state", ["analyzing", "complete", "cancelled", "failed"]);
  const analyzedUntilMs = time(raw.analyzedUntilMs, "analyzedUntilMs");
  const analyzedFrames = integer(raw.analyzedFrames, "analyzedFrames", 0, Math.min(1800, Math.ceil((toMs - fromMs) * settings.sampleFps / 1000)));
  if (state === "complete" && (analyzedFrames === 0 || analyzedUntilMs !== toMs)) invalid("complete 缺少分析进度");
  if (analyzedFrames === 0 && candidates.length) invalid("候选事件缺少分析帧");
  if (candidates.some((candidate) => candidate.endMs > analyzedUntilMs)) invalid("候选事件超出已分析范围");
  return {
    schemaVersion: 1, pipelineVersion: choice(raw.pipelineVersion, "pipelineVersion", ["reference-motion-v1"]),
    timestampSource: choice(raw.timestampSource, "timestampSource", ["video_seek_position"]),
    provenance: choice(raw.provenance, "provenance", ["local", "imported"]), id: id(raw.id, "run.id"), createdAt: date(raw.createdAt, "run.createdAt"),
    profile: profileMetadata(raw.profile), video, settings,
    model: { id: text(model.id, "model.id", 200), revision: text(model.revision, "model.revision", 160), weightsSha256: hash(model.weightsSha256, "model.weightsSha256"), backend: text(model.backend, "model.backend", 80) },
    state, analyzedUntilMs, analyzedFrames, candidates, reviews, gaps,
  };
}

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("浏览器不支持视觉实验本地存储"));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    let settled = false;
    request.addEventListener("upgradeneeded", () => {
      for (const name of ["profiles", "runs"]) if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name, { keyPath: "id" });
    });
    request.addEventListener("success", () => {
      const database = request.result;
      if (settled) { database.close(); return; }
      settled = true;
      database.addEventListener("versionchange", () => database.close());
      resolve(database);
    });
    request.addEventListener("error", () => { settled = true; reject(request.error ?? new Error("无法打开视觉实验本地存储")); });
    request.addEventListener("blocked", () => { settled = true; reject(new Error("视觉实验数据库升级被其他页面阻止")); });
  });
}

async function transaction<T>(name: "profiles" | "runs", mode: IDBTransactionMode, requestForStore: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const database = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = database.transaction(name, mode);
      let result: T;
      let requestError: DOMException | null = null;
      tx.addEventListener("complete", () => resolve(result));
      tx.addEventListener("abort", () => reject(tx.error ?? requestError ?? new Error("视觉实验存储事务已中止")));
      tx.addEventListener("error", () => reject(tx.error ?? requestError ?? new Error("视觉实验存储写入失败")));
      try {
        const request = requestForStore(tx.objectStore(name));
        request.addEventListener("success", () => { result = request.result; });
        request.addEventListener("error", () => { requestError = request.error; });
      } catch (error) {
        tx.abort();
        reject(error);
      }
    });
  } finally { database.close(); }
}

export async function listVisionProfiles(): Promise<VisionProfileSummary[]> {
  const values: unknown[] = await transaction("profiles", "readonly", (store) => store.getAll());
  const profiles = await Promise.all(values.map(validateProfile));
  return profiles.map(({ id, name, revision, createdAt }) => ({ id, name, revision, createdAt })).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}
export async function getVisionProfile(profileId: string): Promise<VisionGateProfile | null> {
  const value: unknown = await transaction("profiles", "readonly", (store) => store.get(id(profileId, "profile.id")));
  return value === undefined ? null : validateProfile(value);
}
export async function saveVisionProfile(profile: VisionGateProfile): Promise<void> {
  const valid = await validateProfile(profile);
  await transaction("profiles", "readwrite", (store) => store.put(valid));
}
export async function listVisionRuns(): Promise<VisionRunSummary[]> {
  const values: unknown[] = await transaction("runs", "readonly", (store) => store.getAll());
  return values.map(parseVisionRun).map(({ id, profile, video, createdAt, state }) => ({ id, gateName: profile.name, videoName: video.name, createdAt, state })).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}
export async function getVisionRun(runId: string): Promise<VisionTimingRun | null> {
  const value: unknown = await transaction("runs", "readonly", (store) => store.get(id(runId, "run.id")));
  return value === undefined ? null : parseVisionRun(value);
}
export async function saveVisionRun(run: VisionTimingRun): Promise<void> {
  const valid = parseVisionRun(run);
  let writeError: unknown;
  try {
    await transaction("runs", "readwrite", (store) => {
      const read: IDBRequest<unknown> = store.get(valid.id);
      read.addEventListener("success", () => {
        try {
          if (read.result !== undefined) {
            const current = parseVisionRun(read.result);
            const fixedFields = ["schemaVersion", "pipelineVersion", "timestampSource", "provenance", "id", "createdAt", "profile", "video", "settings", "model"] as const;
            if (fixedFields.some((field) => JSON.stringify(current[field]) !== JSON.stringify(valid[field]))
              || current.analyzedFrames > valid.analyzedFrames || current.analyzedUntilMs > valid.analyzedUntilMs
              || (current.state !== "analyzing" && current.state !== valid.state)
              || current.candidates.length > valid.candidates.length
              || current.candidates.some((entry, index) => JSON.stringify(entry) !== JSON.stringify(valid.candidates[index]))
              || current.gaps.length > valid.gaps.length
              || current.gaps.some((entry, index) => JSON.stringify(entry) !== JSON.stringify(valid.gaps[index]))) {
              throw new Error("分析记录保存冲突：本机已有更新或不同的分析历史。请先导出当前 JSON，再重新载入最新记录后继续；已有记录未被覆盖");
            }
            if (current.reviews.length > valid.reviews.length || current.reviews.some((entry, index) => JSON.stringify(entry) !== JSON.stringify(valid.reviews[index]))) {
              throw new Error("复核记录保存冲突：本机已有更新或不同的复核历史。请先导出当前 JSON，再重新载入最新记录后继续；已有记录未被覆盖");
            }
          }
          // The read and put share one transaction, preserving observation and review history across tabs.
          store.put(valid);
        } catch (error) {
          writeError = error;
          store.transaction.abort();
        }
      });
      return read;
    });
  } catch (error) {
    throw writeError ?? error;
  }
}
