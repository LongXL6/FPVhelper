import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getVisionProfile, getVisionRun, listVisionProfiles, listVisionRuns, parseVisionProfile, parseVisionRun, saveVisionProfile, saveVisionRun, serializeVisionProfile } from "./vision-lab-store";
import type { VisionGateProfile, VisionReview, VisionTimingRun } from "./vision-lab-types";

const CREATED_AT = "2026-09-05T00:00:00.000Z";
const RECT = { x: 0, y: 0, width: 1, height: 1 };
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ioAAAAASUVORK5CYII=";

async function profile(): Promise<VisionGateProfile> {
  const bytes = Uint8Array.from(atob(PNG), (character) => character.charCodeAt(0));
  const imageSha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return { schemaVersion: 1, id: "profile-1", revision: 1, name: "测试起终门", image: new Blob([bytes], { type: "image/png" }), imageSha256, rect: { ...RECT }, createdAt: CREATED_AT };
}

function run(): VisionTimingRun {
  return {
    schemaVersion: 1, pipelineVersion: "reference-motion-v1", timestampSource: "video_seek_position", provenance: "local", id: "run-1", createdAt: CREATED_AT,
    profile: { schemaVersion: 1, id: "profile-1", revision: 1, name: "测试起终门", imageSha256: "a".repeat(64), rect: { ...RECT }, createdAt: CREATED_AT },
    video: { name: "fixture.mp4", size: 123, lastModified: 0, sha256: "b".repeat(64), durationMs: 10_000, width: 1920, height: 1080 },
    settings: { crop: "full", fromMs: 0, toMs: 10_000, sampleFps: 2, similarityThreshold: 0.6 },
    model: { id: "fixture-model", revision: "revision-1", weightsSha256: "c".repeat(64), backend: "wasm" },
    state: "complete", analyzedUntilMs: 10_000, analyzedFrames: 20,
    candidates: [{ id: "candidate-1", timeMs: 1000, startMs: 900, endMs: 1100, similarity: 0.8, box: { ...RECT }, reason: "参考目标候选" }],
    reviews: [], gaps: [],
  };
}

function review(overrides: Partial<VisionReview> = {}): VisionReview {
  return { id: "review-1", eventId: "candidate-1", action: "confirm", timeMs: 1000, reason: "人工逐帧确认", createdAt: CREATED_AT, ...overrides };
}

function requestValue<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });
}

function transactionDone(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("abort", () => reject(transaction.error));
    transaction.addEventListener("error", () => reject(transaction.error));
  });
}

beforeEach(() => vi.stubGlobal("indexedDB", new IDBFactory()));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("vision reference profile import", () => {
  it("round trips the actual image bytes, hash and normalized rectangle", async () => {
    const original = await profile();
    const serialized = await serializeVisionProfile(original);
    expect(JSON.parse(serialized).image).toEqual({ mimeType: "image/png", base64: PNG });
    const imported = await parseVisionProfile(serialized);
    expect(imported).toEqual(original);
    expect(await imported.image.arrayBuffer()).toEqual(await original.image.arrayBuffer());
  });

  it("rejects changed image bytes even when the declared type remains valid", async () => {
    const serialized = JSON.parse(await serializeVisionProfile(await profile()));
    serialized.imageSha256 = "0".repeat(64);
    await expect(parseVisionProfile(JSON.stringify(serialized))).rejects.toThrow("SHA-256");
  });

  it.each([
    ["unsupported type", (value: Record<string, unknown>) => { value.image = { mimeType: "image/svg+xml", base64: PNG }; }],
    ["mismatched signature", (value: Record<string, unknown>) => { value.image = { mimeType: "image/jpeg", base64: PNG }; }],
    ["malformed base64", (value: Record<string, unknown>) => { value.image = { mimeType: "image/png", base64: "%%%=" }; }],
    ["out of bounds rectangle", (value: Record<string, unknown>) => { value.rect = { ...RECT, x: 0.5 }; }],
    ["unknown field", (value: Record<string, unknown>) => { value.verified = true; }],
    ["future schema", (value: Record<string, unknown>) => { value.schemaVersion = 2; }],
  ])("rejects %s", async (_, change) => {
    const value = JSON.parse(await serializeVisionProfile(await profile())) as Record<string, unknown>;
    change(value);
    await expect(parseVisionProfile(JSON.stringify(value))).rejects.toThrow("视觉实验数据无效");
  });

  it("rejects a reference over 10 MiB before reading its bytes", async () => {
    const original = await profile();
    const image = new Blob([new Uint8Array(10 * 1024 * 1024 + 1)], { type: "image/png" });
    const read = vi.spyOn(image, "arrayBuffer");
    await expect(serializeVisionProfile({ ...original, image })).rejects.toThrow("10 MiB");
    expect(read).not.toHaveBeenCalled();
  });

  it("rejects an oversized JSON input and invalid syntax", async () => {
    await expect(parseVisionProfile(" ".repeat(20 * 1024 * 1024 + 1))).rejects.toThrow("20 MiB");
    await expect(parseVisionProfile("{")).rejects.toThrow("JSON 语法");
  });
});

describe("vision run import validation", () => {
  it("keeps raw candidates separate from append-only manual reviews", () => {
    const original = run();
    original.reviews = [
      review({ action: "adjust", timeMs: 1200, reason: "校准为门平面通过帧" }),
      review({ id: "review-2", timeMs: 1200 }),
      review({ id: "review-3", eventId: "manual-1", action: "add", timeMs: 3000, reason: "补记漏检" }),
      review({ id: "review-4", eventId: "manual-1", action: "adjust", timeMs: 3100 }),
      review({ id: "review-5", eventId: "manual-1", timeMs: 3100 }),
    ];
    const parsed = parseVisionRun(original);
    expect(parsed).toEqual(original);
    expect(parsed.candidates[0].timeMs).toBe(1000);
    expect(parsed.candidates[0]).not.toHaveProperty("status");
    original.candidates[0].timeMs = 999;
    expect(parsed.candidates[0].timeMs).toBe(1000);
  });

  it("preserves imported provenance and incomplete state without promoting them", () => {
    const original = run();
    original.provenance = "imported";
    original.state = "cancelled";
    original.analyzedUntilMs = 1500;
    original.analyzedFrames = 3;
    expect(parseVisionRun(original)).toMatchObject({ provenance: "imported", state: "cancelled", analyzedUntilMs: 1500 });
  });

  it.each([
    ["unknown schema", (value: VisionTimingRun) => { Object.assign(value, { schemaVersion: 2 }); }],
    ["missing pipeline", (value: VisionTimingRun) => { Reflect.deleteProperty(value, "pipelineVersion"); }],
    ["missing timestamp source", (value: VisionTimingRun) => { Reflect.deleteProperty(value, "timestampSource"); }],
    ["unsupported precise frame timestamp claim", (value: VisionTimingRun) => { Object.assign(value, { timestampSource: "frame_pts" }); }],
    ["missing provenance", (value: VisionTimingRun) => { Reflect.deleteProperty(value, "provenance"); }],
    ["injected laps", (value: VisionTimingRun) => { Object.assign(value, { laps: [{ status: "verified" }] }); }],
    ["injected candidate approval", (value: VisionTimingRun) => { Object.assign(value.candidates[0], { status: "confirmed" }); }],
    ["nonfinite time", (value: VisionTimingRun) => { value.candidates[0].timeMs = NaN; }],
    ["nonfinite box", (value: VisionTimingRun) => { value.candidates[0].box.width = Infinity; }],
    ["zero width", (value: VisionTimingRun) => { value.candidates[0].box.width = 0; }],
    ["box outside frame", (value: VisionTimingRun) => { value.candidates[0].box.x = 0.1; }],
    ["event outside interval", (value: VisionTimingRun) => { value.candidates[0].startMs = -1; }],
    ["event temporal order", (value: VisionTimingRun) => { value.candidates[0].startMs = 1001; }],
    ["duplicate candidate ID", (value: VisionTimingRun) => { value.candidates.push({ ...value.candidates[0] }); }],
    ["duplicate review ID", (value: VisionTimingRun) => { value.reviews = [review(), review()]; }],
    ["missing review event", (value: VisionTimingRun) => { value.reviews = [review({ eventId: "missing" })]; }],
    ["manual add collision", (value: VisionTimingRun) => { value.reviews = [review({ action: "add" })]; }],
    ["hidden timestamp correction", (value: VisionTimingRun) => { value.reviews = [review({ timeMs: 1200 })]; }],
    ["manual event outside interval", (value: VisionTimingRun) => { value.reviews = [review({ eventId: "manual-1", action: "add", timeMs: 10_001 })]; }],
    ["missing correction reason", (value: VisionTimingRun) => { value.reviews = [review({ reason: " " })]; }],
    ["complete without frames", (value: VisionTimingRun) => { value.analyzedFrames = 0; }],
    ["complete before interval end", (value: VisionTimingRun) => { value.analyzedUntilMs = 9999; }],
    ["candidate ahead of progress", (value: VisionTimingRun) => { value.state = "cancelled"; value.analyzedUntilMs = 1000; }],
    ["too many frames for sampling rate", (value: VisionTimingRun) => { value.analyzedFrames = 21; }],
    ["unknown sample rate", (value: VisionTimingRun) => { Object.assign(value.settings, { sampleFps: 30 }); }],
    ["similarity threshold out of bounds", (value: VisionTimingRun) => { value.settings.similarityThreshold = 1.01; }],
    ["segment longer than 180 seconds", (value: VisionTimingRun) => { value.video.durationMs = 200_000; value.settings.toMs = 180_001; }],
    ["video longer than 12 hours", (value: VisionTimingRun) => { value.video.durationMs = 12 * 60 * 60 * 1000 + 1; }],
    ["video larger than 20 GiB", (value: VisionTimingRun) => { value.video.size = 20 * 1024 ** 3 + 1; }],
    ["invalid image hash", (value: VisionTimingRun) => { value.profile.imageSha256 = "unverified"; }],
    ["invalid model hash", (value: VisionTimingRun) => { value.model.weightsSha256 = "unverified"; }],
    ["invalid gap", (value: VisionTimingRun) => { value.gaps = [{ startMs: 1000, endMs: 999, reason: "解码中断" }]; }],
  ])("rejects %s", (_, change) => {
    const value = run();
    change(value);
    expect(() => parseVisionRun(value)).toThrow("视觉实验数据无效");
  });

  it("bounds candidate and review counts independently", () => {
    const value = run();
    value.candidates = Array.from({ length: 5001 }, (_, index) => ({ ...value.candidates[0], id: `candidate-${index}` }));
    expect(() => parseVisionRun(value)).toThrow("candidates");
    value.candidates = run().candidates;
    value.reviews = Array.from({ length: 5001 }, (_, index) => review({ id: `review-${index}` }));
    expect(() => parseVisionRun(value)).toThrow("reviews");
  });

  it("bounds UTF-8 JSON size rather than just character count", () => {
    const value = { ...run(), extra: "门".repeat(7 * 1024 * 1024) };
    expect(() => parseVisionRun(value)).toThrow("20 MiB");
  });
});

describe("independent vision lab IndexedDB storage", () => {
  it("allows equal review snapshots and appends without changing earlier history", async () => {
    const original = run();
    await saveVisionRun(original);
    const confirmed = { ...original, reviews: [review()] };
    await saveVisionRun(confirmed);
    await saveVisionRun(structuredClone(confirmed));
    const adjusted = { ...confirmed, reviews: [...confirmed.reviews, review({ id: "review-2", action: "adjust", timeMs: 1200 })] };
    await saveVisionRun(adjusted);
    expect(await getVisionRun(original.id)).toEqual(adjusted);
  });

  it("rejects shortened or changed persisted review histories and leaves local snapshots exportable", async () => {
    const persisted = { ...run(), reviews: [review(), review({ id: "review-2", action: "reject" })] };
    await saveVisionRun(persisted);
    const stale = { ...persisted, reviews: persisted.reviews.slice(0, 1) };
    const divergent = { ...persisted, reviews: persisted.reviews.map((entry, index) => index === 0 ? { ...entry, reason: "另一页改写了先前理由" } : entry) };
    for (const snapshot of [stale, divergent, { ...persisted, reviews: [] }]) {
      const before = JSON.stringify(snapshot);
      await expect(saveVisionRun(snapshot)).rejects.toThrow(/冲突.*导出.*重新载入/);
      expect(JSON.stringify(snapshot)).toBe(before);
      expect(await getVisionRun(persisted.id)).toEqual(persisted);
    }
  });

  it("atomically accepts one of two concurrent divergent appends without losing the winning review", async () => {
    const original = { ...run(), reviews: [review()] };
    await saveVisionRun(original);
    const first = { ...original, reviews: [...original.reviews, review({ id: "tab-a-review", action: "adjust", timeMs: 1100, reason: "标签页 A 校准" })] };
    const second = { ...original, reviews: [...original.reviews, review({ id: "tab-b-review", action: "reject", reason: "标签页 B 排除" })] };
    const outcomes = await Promise.allSettled([saveVisionRun(first), saveVisionRun(second)]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason.message).toMatch(/冲突.*导出.*重新载入/);
    const winner = outcomes[0].status === "fulfilled" ? first : second;
    expect(await getVisionRun(original.id)).toEqual(winner);
    await saveVisionRun({ ...winner, reviews: [...winner.reviews, review({ id: "after-reload", action: "adjust", timeMs: 1300 })] });
    expect((await getVisionRun(original.id))?.reviews.map((entry) => entry.id)).toEqual([...winner.reviews.map((entry) => entry.id), "after-reload"]);
  });

  it("persists profiles and runs in separate stores and returns concise newest-first summaries", async () => {
    const originalProfile = await profile();
    const originalRun = run();
    await saveVisionProfile(originalProfile);
    await saveVisionRun(originalRun);
    await saveVisionRun({ ...originalRun, id: "run-2", createdAt: "2026-09-06T00:00:00.000Z" });
    expect(await getVisionProfile(originalProfile.id)).toEqual(originalProfile);
    expect(await getVisionRun(originalRun.id)).toEqual(originalRun);
    expect(await listVisionProfiles()).toEqual([{ id: "profile-1", name: "测试起终门", revision: 1, createdAt: CREATED_AT }]);
    expect(await listVisionRuns()).toEqual([
      { id: "run-2", gateName: "测试起终门", videoName: "fixture.mp4", state: "complete", createdAt: "2026-09-06T00:00:00.000Z" },
      { id: "run-1", gateName: "测试起终门", videoName: "fixture.mp4", state: "complete", createdAt: CREATED_AT },
    ]);
    expect(await getVisionProfile("missing")).toBeNull();
    expect(await getVisionRun("missing")).toBeNull();
    const database = await requestValue(indexedDB.open("fpvhelper-vision-lab"));
    expect(database.version).toBe(1);
    expect(Array.from(database.objectStoreNames)).toEqual(["profiles", "runs"]);
    database.close();
  });

  it("does not resolve a write on request success before the transaction commits", async () => {
    const originalPut = IDBObjectStore.prototype.put;
    let saveResolved = false;
    let observedRequestSuccess = false;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args) {
      const request = originalPut.apply(this, args);
      request.addEventListener("success", () => { observedRequestSuccess = true; expect(saveResolved).toBe(false); });
      return request;
    });
    await saveVisionRun(run()).then(() => { saveResolved = true; });
    expect(observedRequestSuccess).toBe(true);
    expect(saveResolved).toBe(true);
  });

  it("rejects an aborted transaction even after the put request succeeded", async () => {
    const originalPut = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args) {
      const request = originalPut.apply(this, args);
      request.addEventListener("success", () => this.transaction.abort());
      return request;
    });
    await expect(saveVisionRun(run())).rejects.toThrow("中止");
    expect(await getVisionRun("run-1")).toBeNull();
  });

  it("reports corrupt stored runs without silently rewriting or discarding them", async () => {
    await listVisionRuns();
    const database = await requestValue(indexedDB.open("fpvhelper-vision-lab"));
    const corrupt = { ...run(), analyzedUntilMs: -1 };
    const write = database.transaction("runs", "readwrite");
    write.objectStore("runs").put(corrupt);
    await transactionDone(write);
    await expect(getVisionRun("run-1")).rejects.toThrow("视觉实验数据无效");
    await expect(listVisionRuns()).rejects.toThrow("视觉实验数据无效");
    const read = database.transaction("runs", "readonly");
    expect(await requestValue(read.objectStore("runs").get("run-1"))).toEqual(corrupt);
    await transactionDone(read);
    database.close();
  });

  it("reports a corrupt stored image hash on both single reads and listing", async () => {
    await listVisionProfiles();
    const database = await requestValue(indexedDB.open("fpvhelper-vision-lab"));
    const corrupt = { ...await profile(), imageSha256: "0".repeat(64) };
    const write = database.transaction("profiles", "readwrite");
    write.objectStore("profiles").put(corrupt);
    await transactionDone(write);
    await expect(getVisionProfile("profile-1")).rejects.toThrow("SHA-256");
    await expect(listVisionProfiles()).rejects.toThrow("SHA-256");
    database.close();
  });

  it("fails explicitly when IndexedDB is unavailable", async () => {
    vi.stubGlobal("indexedDB", undefined);
    await expect(listVisionRuns()).rejects.toThrow("不支持");
    await expect(saveVisionRun(run())).rejects.toThrow("不支持");
  });
});
