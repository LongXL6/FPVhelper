"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { LiveVisionController, LiveVisionObservation, LiveVisionOptions, LiveVisionRun } from "@/lib/live-vision-types";
import { LIVE_VISION_MAX_DURATION_MS, LIVE_VISION_SAMPLE_FPS, LIVE_VISION_MAX_OBSERVATION_GAP_MS, LIVE_VISION_EXIT_DELAY_MS, LIVE_VISION_MAX_JSON_BYTES } from "@/lib/live-vision-types";
import { getLiveVisionRun, listLiveVisionRuns, liveVisionExportFilename, liveVisionLapsCsv, parseLiveVisionRun, saveLiveVisionRun, validateLiveVisionRect } from "@/lib/live-vision-store";
import { getVisionProfile, listVisionProfiles, parseVisionProfile, saveVisionProfile } from "@/lib/vision-lab-store";
import { downloadVisionText, hashVisionFile, visionCanvasBlob, visionFrameCanvas } from "@/lib/vision-lab-media";
import { createVisionModelClient } from "@/lib/vision-model-client";
import { createLiveVisionDiagnostics } from "@/lib/live-vision-diagnostics";
import { createVisionCandidateTracker, deriveVisionLaps, resolveVisionEvents } from "@/lib/vision-timing";
import type { VisionGateProfile } from "@/lib/vision-lab-types";

const FRAME_STALL_MS = 2500;
const CHECKPOINT_MS = 5000;
const DISPLAY_MS = 250;
const messageOf = (error: unknown) => error instanceof Error ? error.message : "实时视觉操作失败";
const newId = () => crypto.randomUUID();
const finiteOrNull = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const identityOf = (input: LiveVisionOptions) => JSON.stringify([input.sourceId, input.pilotChannelId, input.pilotName, input.crop.x, input.crop.y, input.crop.width, input.crop.height, input.profileId, input.trainingSessionId ?? null, input.similarityThreshold ?? 0.65, input.sampleFps ?? LIVE_VISION_SAMPLE_FPS]);

function releaseBorrowedVideo(video: HTMLVideoElement) {
  video.pause();
  video.srcObject = null;
  video.removeAttribute("src");
  video.load();
}

async function openBorrowedVideo(stream: MediaStream, signal: AbortSignal) {
  if (signal.aborted) throw new DOMException("操作已取消", "AbortError");
  const video = document.createElement("video");
  video.muted = true; video.playsInline = true; video.autoplay = true;
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true; clearTimeout(timeout);
        video.removeEventListener("loadeddata", ready); video.removeEventListener("error", failed); signal.removeEventListener("abort", aborted);
        if (error) reject(error); else resolve();
      };
      const ready = () => { if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) finish(); };
      const failed = () => finish(new Error("当前视频流没有可读取的画面"));
      const aborted = () => finish(new DOMException("操作已取消", "AbortError"));
      const timeout = setTimeout(() => finish(new Error("等待当前视频流超时，请先确认视频已接入")), 6000);
      video.addEventListener("loadeddata", ready); video.addEventListener("error", failed); signal.addEventListener("abort", aborted, { once: true });
      video.srcObject = stream;
      void video.play().then(ready).catch(failed);
      if (signal.aborted) aborted();
    });
    return video;
  } catch (error) { releaseBorrowedVideo(video); throw error; }
}

interface ActiveRun {
  id: string;
  token: number;
  identity: string;
  stream: MediaStream;
  abort: AbortController;
  video: HTMLVideoElement | null;
  client: ReturnType<typeof createVisionModelClient> | null;
  tracker: ReturnType<typeof createVisionCandidateTracker>;
  phase: "loading" | "monitoring";
  processing: boolean;
  lastInferenceAt: number;
  lastFreshAt: number;
  lastPresentedFrames: number | null;
  lastMediaTime: number | null;
  startedAt: number;
  diagnostics: ReturnType<typeof createLiveVisionDiagnostics> | null;
  lastCheckpointAt: number;
  checkpointPending: boolean;
  cleanups: Array<() => void>;
}

export function useLiveVision(options: LiveVisionOptions): LiveVisionController {
  const [state, setState] = useState<LiveVisionController["state"]>("idle");
  const [run, setRun] = useState<LiveVisionRun | null>(null);
  const [profile, setProfile] = useState<VisionGateProfile | null>(null);
  const [profiles, setProfiles] = useState<LiveVisionController["profiles"]>([]);
  const [savedRuns, setSavedRuns] = useState<LiveVisionController["savedRuns"]>([]);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [progress, setProgress] = useState<LiveVisionController["progress"]>({ analyzedFrames: 0, inferenceMs: null, message: "选择计时门后可开始，模型候选须人工复核" });
  const [diagnostics, setDiagnostics] = useState<LiveVisionController["diagnostics"]>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [protectedSnapshot, setProtectedSnapshot] = useState<LiveVisionRun | null>(null);
  const [savedSnapshot, setSavedSnapshot] = useState<LiveVisionRun | null>(null);
  const [exportedSnapshot, setExportedSnapshot] = useState<LiveVisionRun | null>(null);
  const mounted = useRef(true);
  const diagnosticsRef = useRef<ReturnType<typeof createLiveVisionDiagnostics> | null>(null);
  const diagnosticCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const lastPublishedAt = useRef(-Infinity);
  const attachDiagnosticCanvas = useCallback((canvas: HTMLCanvasElement | null) => { diagnosticCanvasRef.current = canvas; }, []);
  const generation = useRef(0);
  const optionsRef = useRef(options);
  const activeRef = useRef<ActiveRun | null>(null);
  const runRef = useRef<LiveVisionRun | null>(null);
  const profileRef = useRef<VisionGateProfile | null>(null);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const mutationRef = useRef(false);
  const transientAbort = useRef<AbortController | null>(null);
  const protectedRef = useRef<LiveVisionRun | null>(null);
  const exportedRef = useRef<LiveVisionRun | null>(null);

  const publish = useCallback((next: LiveVisionRun, immediate = true) => {
    runRef.current = next;
    if (mounted.current && (immediate || performance.now() - lastPublishedAt.current >= DISPLAY_MS)) {
      lastPublishedAt.current = performance.now();
      setRun(next); setElapsedMs(next.elapsedMs);
      const collector = diagnosticsRef.current;
      if (collector) setDiagnostics(collector.snapshot(performance.now()));
    }
  }, []);
  const refreshRuns = useCallback(async () => {
    const values = await listLiveVisionRuns();
    if (mounted.current) setSavedRuns(values);
  }, []);
  const persist = useCallback(async (snapshot: LiveVisionRun, refresh = false) => {
    const task = saveQueue.current.catch(() => undefined).then(() => saveLiveVisionRun(snapshot));
    saveQueue.current = task;
    await task;
    if (runRef.current === snapshot) { protectedRef.current = snapshot; if (mounted.current) { setProtectedSnapshot(snapshot); setSavedSnapshot(snapshot); } }
    if (refresh && mounted.current) await refreshRuns();
  }, [refreshRuns]);
  const getCurrentTimeMs = useCallback(() => {
    const current = runRef.current;
    if (!current) return activeRef.current ? Math.min(LIVE_VISION_MAX_DURATION_MS, performance.now() - activeRef.current.startedAt) : 0;
    return activeRef.current?.id === current.id
      ? Math.min(LIVE_VISION_MAX_DURATION_MS, Math.max(current.elapsedMs, performance.now() - current.clock.startedAtPerformanceMs))
      : current.elapsedMs;
  }, []);
  const dispose = useCallback((runtime: ActiveRun) => {
    runtime.abort.abort(); runtime.client?.dispose();
    runtime.cleanups.splice(0).forEach((cleanup) => cleanup());
    if (runtime.video) { releaseBorrowedVideo(runtime.video); runtime.video = null; }
  }, []);

  const finish = useCallback(async (outcome: "stopped" | "interrupted" | "failed", reason: string) => {
    const runtime = activeRef.current;
    if (!runtime) return;
    const elapsed = getCurrentTimeMs();
    activeRef.current = null;
    const token = ++generation.current;
    dispose(runtime);
    if (mounted.current) { setState(outcome === "failed" ? "error" : outcome); if (outcome === "failed") setError(reason); }
    const current = runRef.current;
    if (!current || current.id !== runtime.id) {
      if (mounted.current) { setElapsedMs(elapsed); setProgress({ analyzedFrames: 0, inferenceMs: null, message: `${reason}；模型准备未完成，没有分析记录` }); }
      return;
    }
    const tail = elapsed > current.analyzedUntilMs ? [{ startMs: current.analyzedUntilMs, endMs: elapsed, reason }] : [];
    const stopped: LiveVisionRun = { ...current, state: outcome, endedAtEpochMs: Date.now(), elapsedMs: elapsed, stopReason: reason, candidates: [...current.candidates, ...runtime.tracker.finish()], gaps: [...current.gaps, ...tail] };
    publish(stopped);
    if (mounted.current) setProgress({ analyzedFrames: stopped.observations.length, inferenceMs: stopped.observations.at(-1)?.inferenceMs ?? null, message: reason });
    try {
      await persist(stopped, true);
      if (mounted.current && token === generation.current && runRef.current === stopped) setNotice(`${reason}。本轮候选和复核历史已保存在本机；不会自动恢复`);
    } catch (failure) {
      if (mounted.current && token === generation.current) setError(`${reason}；实时记录尚未保存：${messageOf(failure)}。本页结果仍可重试保存或导出`);
      throw failure;
    }
  }, [dispose, getCurrentTimeMs, persist, publish]);
  const interrupt = useCallback((reason: string) => { void finish("interrupted", reason).catch(() => undefined); }, [finish]);

  const refreshProfiles = useCallback(async () => {
    const values = await listVisionProfiles();
    if (mounted.current) setProfiles(values);
  }, []);
  useEffect(() => {
    mounted.current = true;
    void Promise.all([refreshProfiles(), refreshRuns()]).catch((failure: unknown) => { if (mounted.current) setError(messageOf(failure)); });
    return () => {
      mounted.current = false;
      transientAbort.current?.abort();
      void finish("interrupted", "实时监看页面已关闭，后续画面未分析").catch(() => undefined);
      generation.current += 1;
    };
  }, [finish, refreshProfiles, refreshRuns]);
  const needsLeaveWarning = state === "loading" || state === "monitoring" || Boolean(run && protectedSnapshot !== run);
  useEffect(() => {
    if (!needsLeaveWarning) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [needsLeaveWarning]);

  const identity = identityOf(options);
  useEffect(() => {
    const previous = optionsRef.current;
    if (previous.stream !== options.stream || identityOf(previous) !== identity) transientAbort.current?.abort();
    optionsRef.current = options;
    const runtime = activeRef.current;
    if (options.active === false) {
      transientAbort.current?.abort();
      if (runtime) interrupt("已离开实时过门实验，后续画面未分析");
      return;
    }
    if (runtime && (runtime.stream !== options.stream || runtime.identity !== identity)) interrupt("视频来源、选手、裁切、计时门或训练记录发生变化");
  }, [identity, interrupt, options]);
  useEffect(() => {
    let valid = true;
    profileRef.current = null;
    void (options.profileId ? getVisionProfile(options.profileId) : Promise.resolve(null)).then((value) => {
      if (valid && mounted.current) { profileRef.current = value; setProfile(value); }
    }).catch((failure: unknown) => { if (valid && mounted.current) { setProfile(null); setError(messageOf(failure)); } });
    return () => { valid = false; };
  }, [options.profileId]);

  const processFrame = useCallback(async (runtime: ActiveRun, observedAt: number, callback: LiveVisionObservation["callback"]) => {
    const current = runRef.current;
    if (!current || current.id !== runtime.id || runtime.phase !== "monitoring" || !runtime.video || !runtime.client) return;
    if (runtime.processing) { runtime.diagnostics?.increment("busy"); return; }
    if (observedAt - runtime.lastInferenceAt < 1000 / current.settings.sampleFps) { runtime.diagnostics?.increment("throttled"); return; }
    runtime.processing = true; runtime.lastInferenceAt = observedAt;
    let canvas: HTMLCanvasElement | null = null;
    try {
      const timeMs = observedAt - current.clock.startedAtPerformanceMs;
      if (timeMs > LIVE_VISION_MAX_DURATION_MS) { await finish("stopped", "本轮已达 30 分钟上限，请明确开始下一轮"); return; }
      // The model consumes 224 pixels; avoid transferring full capture-card frames on every inference.
      canvas = visionFrameCanvas(runtime.video, current.source.crop, 448);
      const bitmap = await createImageBitmap(canvas);
      if (activeRef.current !== runtime) { bitmap.close(); return; }
      const captureMs = performance.now() - observedAt;
      const result = await runtime.client.analyze(bitmap, timeMs, current.settings.similarityThreshold);
      if (activeRef.current !== runtime || runtime.token !== generation.current) return;
      if (result.frameTimeMs !== timeMs || result.modelId !== current.model.id || result.modelRevision !== current.model.revision || !Number.isFinite(result.inferenceMs)) throw new Error("模型返回了不匹配的实时观察");
      const latest = runRef.current!;
      const candidates = runtime.tracker.push(timeMs, result.candidates);
      const metrics = {
        captureMs, roundTripMs: performance.now() - observedAt, preprocessMs: result.diagnostics?.preprocessMs ?? null,
        modelMs: result.diagnostics?.modelMs ?? null, matchingMs: result.diagnostics?.matchingMs ?? null,
        bestMatch: result.diagnostics?.bestMatch ?? null, acceptedMatches: result.candidates.length,
      };
      runtime.diagnostics?.complete({ ...metrics, timeMs, inferenceMs: result.inferenceMs, tracker: runtime.tracker.getDiagnostics() }, performance.now());
      const delayed = latest.observations.length > 0 && timeMs - latest.analyzedUntilMs >= LIVE_VISION_MAX_OBSERVATION_GAP_MS;
      const next: LiveVisionRun = {
        ...latest, elapsedMs: Math.max(timeMs, getCurrentTimeMs()), analyzedUntilMs: timeMs,
        observations: [...latest.observations, { timeMs, hostObservedAtMs: observedAt, method: callback ? "video_frame_callback" : "current_time_poll", callback, inferenceMs: result.inferenceMs, diagnostics: metrics }],
        candidates: [...latest.candidates, ...candidates],
        gaps: delayed ? [...latest.gaps, { startMs: latest.analyzedUntilMs, endMs: timeMs, reason: "本机推理未及时覆盖这一观察区间" }] : latest.gaps,
      };
      const displayDue = performance.now() - lastPublishedAt.current >= DISPLAY_MS || next.observations.length === 1 || candidates.length > 0;
      publish(next, displayDue);
      if (mounted.current && displayDue) {
        setProgress({ analyzedFrames: next.observations.length, inferenceMs: result.inferenceMs, message: "本地实时观察；相似目标只进入待复核列表" });
        const preview = diagnosticCanvasRef.current;
        const context = preview?.getContext("2d");
        if (preview && context) {
          preview.width = canvas.width; preview.height = canvas.height;
          context.drawImage(canvas, 0, 0);
          const match = metrics.bestMatch;
          if (match) {
            context.strokeStyle = match.similarity >= current.settings.similarityThreshold ? "#4ade80" : "#fbbf24";
            context.lineWidth = 2;
            context.strokeRect(match.box.x * preview.width, match.box.y * preview.height, match.box.width * preview.width, match.box.height * preview.height);
          }
        }
      }
      if (!runtime.checkpointPending && performance.now() - runtime.lastCheckpointAt >= CHECKPOINT_MS) {
        runtime.lastCheckpointAt = performance.now(); runtime.checkpointPending = true;
        void persist(next).catch((failure: unknown) => {
          if (activeRef.current === runtime) void finish("failed", messageOf(failure)).catch(() => undefined);
        }).finally(() => { runtime.checkpointPending = false; });
      }
    } catch (failure) {
      if (activeRef.current === runtime && runtime.token === generation.current) await finish("failed", messageOf(failure)).catch(() => undefined);
    } finally {
      if (canvas) { canvas.width = 0; canvas.height = 0; }
      runtime.processing = false;
    }
  }, [finish, getCurrentTimeMs, persist, publish]);

  const watchFrames = useCallback((runtime: ActiveRun) => {
    const video = runtime.video!;
    const observe = (metadata: VideoFrameCallbackMetadata | null) => {
      if (activeRef.current !== runtime || runtime.abort.signal.aborted) return;
      const now = performance.now();
      const presentedFrames = metadata ? finiteOrNull(metadata.presentedFrames) : null;
      const mediaTime = metadata ? finiteOrNull(metadata.mediaTime) : finiteOrNull(video.currentTime);
      if (metadata && presentedFrames !== null && runtime.lastPresentedFrames !== null && presentedFrames <= runtime.lastPresentedFrames) {
        runtime.diagnostics?.increment("duplicate");
        if (presentedFrames < runtime.lastPresentedFrames) interrupt("视频帧序号回退，来源连续性无法确认");
        return;
      }
      if (!metadata && mediaTime === runtime.lastMediaTime) { runtime.diagnostics?.increment("duplicate"); return; }
      if (mediaTime !== null && runtime.lastMediaTime !== null && mediaTime + 0.001 < runtime.lastMediaTime) { interrupt("视频时钟回退，来源连续性无法确认"); return; }
      const current = runRef.current;
      if (runtime.phase === "monitoring" && metadata && presentedFrames !== null && runtime.lastPresentedFrames !== null && presentedFrames > runtime.lastPresentedFrames + 1 && current?.id === runtime.id) {
        runtime.diagnostics?.increment("unreported", presentedFrames - runtime.lastPresentedFrames - 1);
        if (current.gaps.length >= 4990) { interrupt("视频缺口过多，本轮已停止，请检查采集稳定性"); return; }
        const startMs = Math.max(0, runtime.lastFreshAt - current.clock.startedAtPerformanceMs);
        const endMs = Math.min(LIVE_VISION_MAX_DURATION_MS, now - current.clock.startedAtPerformanceMs);
        if (endMs > startMs) publish({ ...current, elapsedMs: Math.max(current.elapsedMs, endMs), gaps: [...current.gaps, { startMs, endMs, reason: "浏览器未连续报告视频呈现帧" }] }, false);
      }
      runtime.diagnostics?.observe(now);
      runtime.lastFreshAt = now; runtime.lastPresentedFrames = presentedFrames; runtime.lastMediaTime = mediaTime;
      if (video.videoWidth !== current?.source.width || video.videoHeight !== current?.source.height) { interrupt("视频尺寸改变，原裁切与来源快照已失效"); return; }
      const callback = metadata ? { mediaTimeSeconds: mediaTime, presentedFrames, presentationTimeMs: finiteOrNull(metadata.presentationTime), expectedDisplayTimeMs: finiteOrNull(metadata.expectedDisplayTime) } : null;
      void processFrame(runtime, now, callback);
    };
    if (typeof video.requestVideoFrameCallback === "function") {
      let callbackId: number;
      const next: VideoFrameRequestCallback = (_now, metadata) => {
        if (activeRef.current !== runtime) return;
        callbackId = video.requestVideoFrameCallback(next);
        observe(metadata);
      };
      callbackId = video.requestVideoFrameCallback(next);
      runtime.cleanups.push(() => video.cancelVideoFrameCallback(callbackId));
    } else {
      const timer = setInterval(() => observe(null), 1000 / LIVE_VISION_SAMPLE_FPS);
      runtime.cleanups.push(() => clearInterval(timer));
    }
    const watchdog = setInterval(() => {
      if (activeRef.current !== runtime) return;
      if (performance.now() - runtime.lastFreshAt > FRAME_STALL_MS) { interrupt("超过 2.5 秒没有新视频帧，实时观察已中断"); return; }
      const elapsed = getCurrentTimeMs();
      if (mounted.current) { setElapsedMs(elapsed); if (runtime.diagnostics) setDiagnostics(runtime.diagnostics.snapshot(performance.now())); }
      if (elapsed >= LIVE_VISION_MAX_DURATION_MS) void finish("stopped", "本轮已达 30 分钟上限，请明确开始下一轮").catch(() => undefined);
    }, 500);
    runtime.cleanups.push(() => clearInterval(watchdog));
  }, [finish, getCurrentTimeMs, interrupt, processFrame, publish]);

  const start = useCallback(async () => {
    if (activeRef.current || mutationRef.current) throw new Error("请先结束当前实时分析或保存操作");
    if (runRef.current && protectedRef.current !== runRef.current) throw new Error("当前实时记录尚未保存，请先重试保存或导出 JSON 并确认下载，再开始新一轮");
    const input = optionsRef.current;
    if (input.active === false) throw new Error("请打开实时过门实验后再开始识别");
    const selected = profileRef.current;
    const stream = input.stream;
    const track = stream?.getVideoTracks()[0];
    if (!stream || !track || track.readyState !== "live" || !input.sourceId || !input.pilotChannelId || !input.pilotName.trim() || !selected || selected.id !== input.profileId) throw new Error("请先接入视频、选择选手和计时门");
    if (document.visibilityState === "hidden") throw new Error("请保持实时监看页面可见后再开始");
    const crop = validateLiveVisionRect(input.crop);
    const threshold = input.similarityThreshold ?? 0.65;
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error("相似度阈值无效");
    const sampleFps = input.sampleFps ?? LIVE_VISION_SAMPLE_FPS;
    if (!Number.isInteger(sampleFps) || sampleFps < 1 || sampleFps > 30) throw new Error("分析目标须在 1–30 FPS 之间");
    const runtime: ActiveRun = { id: newId(), token: ++generation.current, identity: identityOf(input), stream, abort: new AbortController(), video: null, client: null, tracker: createVisionCandidateTracker({ sampleFps, idFactory: newId, maxObservationGapMs: LIVE_VISION_MAX_OBSERVATION_GAP_MS, exitDelayMs: LIVE_VISION_EXIT_DELAY_MS }), phase: "loading", processing: false, lastInferenceAt: -Infinity, lastFreshAt: performance.now(), lastPresentedFrames: null, lastMediaTime: null, startedAt: performance.now(), diagnostics: null, lastCheckpointAt: performance.now(), checkpointPending: false, cleanups: [] };
    activeRef.current = runtime;
    runRef.current = null; setRun(null); diagnosticsRef.current = null; setDiagnostics(null);
    lastPublishedAt.current = -Infinity;
    const preview = diagnosticCanvasRef.current;
    if (preview) { preview.width = 0; preview.height = 0; }
    setProgress({ analyzedFrames: 0, inferenceMs: null, message: "正在选择本地 GPU / CPU 引擎；准备期间尚未分析画面" });
    setState("loading"); setError(null); setNotice(null); setElapsedMs(0);
    const visibility = () => { if (document.visibilityState === "hidden") interrupt("页面转入后台，后续画面无法连续观察"); };
    const ended = () => interrupt("视频源已断开或停止提供画面");
    track.addEventListener("ended", ended); track.addEventListener("mute", ended); stream.addEventListener("inactive", ended); stream.addEventListener("addtrack", ended); stream.addEventListener("removetrack", ended); document.addEventListener("visibilitychange", visibility);
    runtime.cleanups.push(() => { track.removeEventListener("ended", ended); track.removeEventListener("mute", ended); stream.removeEventListener("inactive", ended); stream.removeEventListener("addtrack", ended); stream.removeEventListener("removetrack", ended); document.removeEventListener("visibilitychange", visibility); });
    try {
      const video = await openBorrowedVideo(stream, runtime.abort.signal);
      if (activeRef.current !== runtime) { releaseBorrowedVideo(video); return; }
      runtime.video = video;
      const { image, ...metadata } = selected;
      const started = runtime.startedAt;
      const startedAtEpochMs = Date.now() - (performance.now() - started);
      let lastProgressAt = -Infinity;
      runtime.client = createVisionModelClient({ context: { runId: runtime.id, generation: runtime.token }, onProgress: (update) => {
        if (activeRef.current !== runtime || performance.now() - lastProgressAt < 250) return;
        lastProgressAt = performance.now();
        setProgress({ analyzedFrames: 0, inferenceMs: null, message: `加载本地模型 ${update.file ?? ""}${Number.isFinite(update.progress) ? ` · ${Math.round(update.progress!)}%` : ""}` });
      } });
      const manifest = await runtime.client.load({ devicePreference: "auto" });
      if (activeRef.current !== runtime) return;
      runtime.diagnostics = createLiveVisionDiagnostics({ runId: runtime.id, backend: manifest.backend, fallbackReason: manifest.fallbackReason ?? null, targetFps: sampleFps, threshold });
      diagnosticsRef.current = runtime.diagnostics;
      const initial: LiveVisionRun = {
        schemaVersion: 1, kind: "fpvhelper-live-vision", pipelineVersion: "reference-motion-v2", provenance: "local", id: runtime.id, createdAt: new Date().toISOString(),
        source: { sourceId: input.sourceId, pilotChannelId: input.pilotChannelId, pilotName: input.pilotName.trim(), streamId: stream.id, videoTrackId: track.id, width: video.videoWidth, height: video.videoHeight, crop: { ...crop }, trainingSessionId: input.trainingSessionId ?? null },
        profile: { ...metadata, rect: { ...metadata.rect } }, model: { id: manifest.id, revision: manifest.revision, weightsSha256: manifest.weightsSha256, backend: manifest.backend },
        clock: { kind: "host_presentation_estimate", timeOriginEpochMs: performance.timeOrigin, startedAtPerformanceMs: started, startedAtEpochMs, physicalCaptureTimeKnown: false, trainingSynchronized: false },
        settings: { sampleFps, similarityThreshold: threshold, maxDurationMs: LIVE_VISION_MAX_DURATION_MS, maxObservationGapMs: LIVE_VISION_MAX_OBSERVATION_GAP_MS, exitDelayMs: LIVE_VISION_EXIT_DELAY_MS }, state: "starting", endedAtEpochMs: null, elapsedMs: 0, analyzedUntilMs: 0, stopReason: null, observations: [], candidates: [], reviews: [], gaps: [],
      };
      publish(initial); runtime.lastFreshAt = performance.now(); watchFrames(runtime);
      await persist(initial, true);
      if (activeRef.current !== runtime) return;
      const bitmap = await createImageBitmap(image);
      let canvas: HTMLCanvasElement | null = null;
      try {
        canvas = visionFrameCanvas(bitmap, metadata.rect);
        await runtime.client.setReference(await createImageBitmap(canvas));
      } finally { bitmap.close(); if (canvas) { canvas.width = 0; canvas.height = 0; } }
      if (activeRef.current !== runtime) return;
      const elapsed = getCurrentTimeMs();
      const latest = runRef.current!;
      publish({ ...latest, state: "monitoring", elapsedMs: elapsed, gaps: elapsed > 0 ? [...latest.gaps, { startMs: 0, endMs: elapsed, reason: "模型与参考图准备期间未进行实时分析" }] : latest.gaps });
      runtime.phase = "monitoring"; runtime.lastCheckpointAt = performance.now();
      setState("monitoring"); setProgress({ analyzedFrames: 0, inferenceMs: null, message: `目标上限 ${sampleFps} FPS，按本机速度处理新画面；候选须人工复核` });
    } catch (failure) {
      if (activeRef.current !== runtime || runtime.token !== generation.current) return;
      await finish("failed", messageOf(failure)).catch(() => undefined);
      throw failure;
    }
  }, [finish, getCurrentTimeMs, interrupt, persist, publish, watchFrames]);

  const operation = useCallback(async <T,>(task: () => Promise<T>) => {
    if (mutationRef.current) throw new Error("上一项实时记录操作尚未完成");
    mutationRef.current = true;
    if (mounted.current) { setError(null); setNotice(null); }
    try { return await task(); }
    catch (failure) { if (mounted.current) setError(messageOf(failure)); throw failure; }
    finally { mutationRef.current = false; }
  }, []);
  const requireIdle = () => { if (activeRef.current) throw new Error("请先停止实时分析，再切换或导入记录"); };
  const requireProtected = () => { if (runRef.current && protectedRef.current !== runRef.current) throw new Error("当前实时记录尚未保存，请先重试保存或导出 JSON 并确认下载，再恢复其他记录"); };
  const review = (eventId: string, action: "add" | "confirm" | "reject" | "adjust", timeMs: number, reason: string) => operation(async () => {
    const current = runRef.current;
    if (!current || activeRef.current?.phase === "loading") throw new Error("请等待模型准备完成后再人工复核");
    const next = parseLiveVisionRun({ ...current, elapsedMs: getCurrentTimeMs(), reviews: [...current.reviews, { id: newId(), eventId, action, timeMs, reason: reason.trim(), createdAt: new Date().toISOString() }] });
    publish(next); await persist(next, true);
    if (mounted.current) setNotice("人工复核已保存在本机，原始候选仍然保留");
  });
  const restore = async (saved: LiveVisionRun) => {
    const restored: LiveVisionRun = ["starting", "monitoring"].includes(saved.state) ? {
      ...saved, state: "interrupted", stopReason: "上次页面退出，之后画面与结束时刻未知；不会自动恢复",
      gaps: saved.elapsedMs > saved.analyzedUntilMs ? [...saved.gaps, { startMs: saved.analyzedUntilMs, endMs: saved.elapsedMs, reason: "恢复检查点中尚未分析的已知尾段" }] : saved.gaps,
    } : saved;
    diagnosticsRef.current = null; setDiagnostics(null);
    const preview = diagnosticCanvasRef.current;
    if (preview) { preview.width = 0; preview.height = 0; }
    publish(restored);
    if (restored === saved) { protectedRef.current = restored; setProtectedSnapshot(restored); setSavedSnapshot(restored); }
    setState(restored.state === "failed" ? "error" : restored.state === "interrupted" ? "interrupted" : "stopped");
    setProgress({ analyzedFrames: restored.observations.length, inferenceMs: restored.observations.at(-1)?.inferenceMs ?? null, message: "已恢复历史记录；主机观察时间不代表物理穿门时刻" });
    setNotice(`${restored.provenance === "imported" ? "导入记录未经本机重新观察。" : "已恢复本机实时记录。"} ${restored.stopReason ?? ""}`);
  };

  return {
    state, isActive: state === "loading" || state === "monitoring", hasUnsavedChanges: Boolean(run && savedSnapshot !== run), backupAwaitingConfirmation: Boolean(run && exportedSnapshot === run && protectedSnapshot !== run), canStart: options.active !== false && !["loading", "monitoring"].includes(state) && (!run || protectedSnapshot === run) && Boolean(options.stream?.getVideoTracks()[0]?.readyState === "live" && options.sourceId && options.pilotChannelId && options.pilotName.trim() && profile?.id === options.profileId), elapsedMs, progress, diagnostics, attachDiagnosticCanvas, error, notice, profile, profiles, run,
    events: run ? resolveVisionEvents(run) : [], laps: run ? deriveVisionLaps(run) : [], savedRuns, start, stop: () => finish("stopped", "用户停止了实时分析"), getCurrentTimeMs,
    exportDiagnostics: () => operation(async () => {
      const collector = diagnosticsRef.current;
      if (!collector) throw new Error("当前没有本轮诊断；历史 JSON 的 observations 保留逐帧指标");
      const value = collector.export(performance.now());
      downloadVisionText(JSON.stringify(value), `fpv-vision-diagnostics-${value.diagnostics.runId}-${newId()}.json`, "application/json");
      if (mounted.current) setNotice("已发起本机诊断下载，包含最近 120 次分析与累计计数，不包含图像；完整逐帧指标在本轮 JSON 中");
    }),
    acknowledgeBackup: () => {
      requireIdle(); const current = runRef.current;
      if (!current || exportedRef.current !== current) throw new Error("请先导出当前 JSON，并确认浏览器已完成下载");
      protectedRef.current = current; setProtectedSnapshot(current); setNotice("已收到你对 JSON 下载完成的确认，可以切换记录；本机数据库保存状态未改变");
    },
    reviewEvent: (eventId, action, timeMs, reason) => review(eventId, action, timeMs, reason), addEvent: (timeMs, reason) => review(newId(), "add", timeMs, reason), refreshProfiles,
    saveReference: (input) => operation(async () => {
      requireIdle();
      if (!input.image.size || input.image.size > 10 * 1024 ** 2 || !["image/png", "image/jpeg", "image/webp"].includes(input.image.type)) throw new Error("请选择 10 MB 内的 PNG、JPEG 或 WebP 参考图");
      const bitmap = await createImageBitmap(input.image);
      try { if (bitmap.width < 16 || bitmap.height < 16 || bitmap.width * bitmap.height > 40_000_000) throw new Error("参考图尺寸无效或超过 4000 万像素"); } finally { bitmap.close(); }
      const saved: VisionGateProfile = { schemaVersion: 1, id: newId(), revision: 1, name: input.name.trim(), image: input.image, imageSha256: await hashVisionFile(input.image), rect: validateLiveVisionRect(input.rect), createdAt: new Date().toISOString() };
      await saveVisionProfile(saved); await refreshProfiles(); return saved.id;
    }),
    captureReference: () => operation(async () => {
      requireIdle();
      const input = optionsRef.current;
      if (!input.stream?.getVideoTracks().some((track) => track.readyState === "live")) throw new Error("请先接入当前视频来源");
      const abort = new AbortController(); transientAbort.current = abort;
      const video = await openBorrowedVideo(input.stream, abort.signal);
      let canvas: HTMLCanvasElement | null = null;
      try { canvas = visionFrameCanvas(video, validateLiveVisionRect(input.crop)); const blob = await visionCanvasBlob(canvas); if (abort.signal.aborted) throw new DOMException("视频来源已改变，未使用旧画面", "AbortError"); return blob; }
      finally { releaseBorrowedVideo(video); if (canvas) { canvas.width = 0; canvas.height = 0; } if (transientAbort.current === abort) transientAbort.current = null; }
    }),
    importProfile: (file) => operation(async () => {
      requireIdle(); if (file.size > 20 * 1024 ** 2) throw new Error("门档案 JSON 不能超过 20 MB");
      const imported = await parseVisionProfile(await file.text());
      const saved = { ...imported, id: newId(), revision: 1 };
      await saveVisionProfile(saved); await refreshProfiles(); return saved.id;
    }),
    saveRun: () => operation(async () => { if (!runRef.current) throw new Error("没有可保存的实时记录"); await persist(runRef.current, true); if (mounted.current) setNotice("实时候选与复核历史已保存在本机"); }),
    loadRun: (id) => operation(async () => { requireIdle(); requireProtected(); const saved = await getLiveVisionRun(id); if (!saved) throw new Error("未找到实时记录"); await restore(saved); }),
    exportRun: (format) => operation(async () => {
      const current = runRef.current; if (!current) throw new Error("没有可导出的实时记录");
      const filename = liveVisionExportFilename(current.id, format, newId());
      downloadVisionText(format === "json" ? JSON.stringify(current) : liveVisionLapsCsv(current), filename, format === "json" ? "application/json" : "text/csv;charset=utf-8");
      if (format === "json" && runRef.current === current) { exportedRef.current = current; if (mounted.current) setExportedSnapshot(current); }
      if (mounted.current) setNotice(`已发起下载：${filename}。请在浏览器确认；时间来自主机观察估计，未与训练录像同步`);
    }),
    importRun: (file) => operation(async () => {
      requireIdle(); requireProtected(); if (file.size > LIVE_VISION_MAX_JSON_BYTES) throw new Error("实时记录 JSON 不能超过 64 MB");
      const imported = parseLiveVisionRun(JSON.parse(await file.text()));
      const next = { ...imported, id: newId(), provenance: "imported" as const };
      await persist(next, true); await restore(next);
    }),
  };
}
