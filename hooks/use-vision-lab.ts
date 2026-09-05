"use client";

import { useEffect, useRef, useState } from "react";
import type { VisionGateProfile, VisionLabController, VisionLabSettings, VisionRect, VisionTimingRun } from "@/lib/vision-lab-types";
import { getVisionProfile, getVisionRun, listVisionProfiles, listVisionRuns, parseVisionProfile, parseVisionRun, saveVisionProfile, saveVisionRun, serializeVisionProfile } from "@/lib/vision-lab-store";
import { downloadVisionText, hashVisionFile, openVisionVideo, releaseVisionVideo, seekVisionVideo, visionCanvasBlob, visionFrameCanvas } from "@/lib/vision-lab-media";
import { createVisionCandidateTracker, deriveVisionLaps, resolveVisionEvents, validateVisionRange, VISION_DEFAULT_SETTINGS, visionCropRect, visionExportFilename, visionLapsCsv } from "@/lib/vision-timing";
import { createVisionModelClient } from "@/lib/vision-model-client";
import { VISION_MODEL_MANIFEST } from "@/lib/vision-model";

const FULL_RECT: VisionRect = { x: 0, y: 0, width: 1, height: 1 };
const messageOf = (error: unknown) => error instanceof Error ? error.message : "本地操作失败，请重试";
const id = () => crypto.randomUUID();

export function useVisionLab(): VisionLabController {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [video, setVideo] = useState<VisionLabController["video"]>(null);
  const [profile, setProfile] = useState<VisionGateProfile | null>(null);
  const [referenceUrl, setReferenceUrl] = useState<string | null>(null);
  const [gateName, setGateNameState] = useState("我的计时门");
  const [settings, setSettings] = useState<VisionLabSettings>({ ...VISION_DEFAULT_SETTINGS });
  const [run, setRun] = useState<VisionTimingRun | null>(null);
  const [profiles, setProfiles] = useState<VisionLabController["profiles"]>([]);
  const [savedRuns, setSavedRuns] = useState<VisionLabController["savedRuns"]>([]);
  const [status, setStatus] = useState<VisionLabController["status"]>("idle");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState({ completed: 0, total: 0, timeMs: 0, message: "等待导入照片与录像" });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const generation = useRef(0);
  const mounted = useRef(true);
  const busyRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const clientRef = useRef<ReturnType<typeof createVisionModelClient> | null>(null);
  const runRef = useRef<VisionTimingRun | null>(null);
  const urls = useRef({ video: "", reference: "" });
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const mutationRef = useRef(false);

  const refreshLibrary = async () => {
    const [nextProfiles, nextRuns] = await Promise.all([listVisionProfiles(), listVisionRuns()]);
    if (mounted.current) { setProfiles(nextProfiles); setSavedRuns(nextRuns); }
  };
  const publishRun = (next: VisionTimingRun | null) => {
    runRef.current = next;
    if (mounted.current) setRun(next);
  };
  const persistRun = async (snapshot: VisionTimingRun) => {
    const task = saveQueue.current.catch(() => undefined).then(() => saveVisionRun(snapshot));
    saveQueue.current = task;
    await task;
    if (mounted.current) {
      const nextRuns = await listVisionRuns();
      if (mounted.current) setSavedRuns(nextRuns);
    }
  };
  const applyProfile = (next: VisionGateProfile) => {
    if (urls.current.reference) URL.revokeObjectURL(urls.current.reference);
    const url = URL.createObjectURL(next.image);
    urls.current.reference = url;
    setProfile(next); setReferenceUrl(url); setGateNameState(next.name);
  };

  useEffect(() => {
    mounted.current = true;
    const resourceUrls = urls.current;
    let active = true;
    void Promise.all([listVisionProfiles(), listVisionRuns()]).then(([p, r]) => {
      if (active) { setProfiles(p); setSavedRuns(r); }
    }).catch((e: unknown) => { if (active) setError(`本地档案读取失败：${messageOf(e)}`); });
    return () => {
      active = false; mounted.current = false; generation.current += 1;
      abortRef.current?.abort(); clientRef.current?.dispose();
      Object.values(resourceUrls).forEach((url) => { if (url) URL.revokeObjectURL(url); });
    };
  }, []);

  useEffect(() => {
    if (!busy) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [busy]);

  async function guarded(task: () => Promise<void>) {
    if (busyRef.current || mutationRef.current) return;
    mutationRef.current = true;
    setError(null); setNotice(null);
    try { await task(); } catch (e) { if (mounted.current) setError(messageOf(e)); }
    finally { mutationRef.current = false; }
  }

  async function importVideo(file: File) {
    if (busyRef.current || mutationRef.current) return;
    const token = ++generation.current;
    const abort = new AbortController(); abortRef.current = abort;
    busyRef.current = true; setBusy(true); setStatus("loading"); setError(null); setNotice(null);
    let url = "";
    let decoder: HTMLVideoElement | null = null;
    try {
      if (!file.size || file.size > 20 * 1024 ** 3) throw new Error("请选择不超过 20 GB 的完整录像");
      url = URL.createObjectURL(file);
      decoder = await openVisionVideo(url, abort.signal);
      const metadata = { durationMs: decoder.duration * 1000, width: decoder.videoWidth, height: decoder.videoHeight };
      if (metadata.durationMs > 12 * 3600_000) throw new Error("单个录像请控制在 12 小时以内");
      const sha256 = await hashVisionFile(file, (fraction) => {
        if (token === generation.current) setProgress({ completed: 0, total: 0, timeMs: 0, message: `本地核对录像身份 ${Math.round(fraction * 100)}%` });
      }, abort.signal);
      if (token !== generation.current) return;
      if (urls.current.video) URL.revokeObjectURL(urls.current.video);
      urls.current.video = url;
      const nextVideo = { name: file.name, size: file.size, lastModified: file.lastModified, sha256, ...metadata, url };
      setVideo(nextVideo); url = "";
      const current = runRef.current;
      if (current && current.video.sha256 === sha256) {
        setSettings(current.settings);
        setNotice("已通过完整文件 SHA-256 核对，录像与当前分析记录一致");
      } else {
        publishRun(null);
        setSettings((previous) => ({ ...previous, fromMs: 0, toMs: Math.min(30_000, metadata.durationMs) }));
        setNotice("录像仅在本机读取；尚未下载模型或上传素材");
      }
      setStatus("idle");
    } catch (e) {
      if (token === generation.current) { setError(messageOf(e)); setStatus("error"); }
    } finally {
      if (decoder) releaseVisionVideo(decoder);
      if (url) URL.revokeObjectURL(url);
      if (token === generation.current) { busyRef.current = false; setBusy(false); abortRef.current = null; }
    }
  }

  async function acceptReference(blob: Blob) {
    if (!blob.size || blob.size > 10 * 1024 ** 2 || !["image/png", "image/jpeg", "image/webp"].includes(blob.type)) throw new Error("参考图请使用 10 MB 以内的 PNG、JPEG 或 WebP");
    const bitmap = await createImageBitmap(blob);
    try {
      if (bitmap.width < 16 || bitmap.height < 16 || bitmap.width * bitmap.height > 40_000_000) throw new Error("参考图尺寸不适合分析，请使用清晰且不超过 4000 万像素的图片");
    } finally { bitmap.close(); }
    const next: VisionGateProfile = { schemaVersion: 1, id: id(), revision: 1, name: gateName.trim() || "我的计时门", image: blob, imageSha256: await hashVisionFile(blob), rect: { ...FULL_RECT }, createdAt: new Date().toISOString() };
    applyProfile(next);
    setNotice("请在照片上框出目标门，尽量减少无关背景；参考图仅保存在本机");
  }

  async function currentProfile() {
    if (!profile) throw new Error("请先导入参考照片或从录像选门");
    if (!gateName.trim()) throw new Error("请填写计时门名称");
    return { ...profile, name: gateName.trim() };
  }

  function cancel() {
    if (!busyRef.current) return;
    const token = ++generation.current;
    abortRef.current?.abort(); clientRef.current?.dispose();
    abortRef.current = null; clientRef.current = null;
    busyRef.current = false; setBusy(false); setStatus("cancelled");
    const current = runRef.current;
    if (current?.state === "analyzing") {
      const remaining = current.analyzedUntilMs < current.settings.toMs ? [{ startMs: current.analyzedUntilMs, endMs: current.settings.toMs, reason: "分析已取消，剩余区间未处理" }] : [];
      const cancelled: VisionTimingRun = { ...current, state: "cancelled", gaps: [...current.gaps, ...remaining] };
      publishRun(cancelled);
      void persistRun(cancelled).then(() => { if (mounted.current && token === generation.current) setNotice("已取消；已分析部分和候选保存在本机"); }).catch((e: unknown) => { if (mounted.current && token === generation.current) setError(`取消后的结果尚未保存：${messageOf(e)}；可重试保存或导出`); });
    } else setNotice("操作已取消");
  }

  async function analyze() {
    if (busyRef.current || mutationRef.current || !video || !profile) return;
    const token = ++generation.current;
    const controller = new AbortController(); abortRef.current = controller;
    busyRef.current = true; setBusy(true); setStatus("loading"); setError(null); setNotice(null);
    let decoder: HTMLVideoElement | null = null;
    let client: ReturnType<typeof createVisionModelClient> | null = null;
    let analysis: VisionTimingRun | null = null;
    try {
      validateVisionRange(settings, video.durationMs);
      const chosenProfile = await currentProfile();
      await saveVisionProfile(chosenProfile);
      if (token !== generation.current) return;
      await refreshLibrary();
      const { image, ...profileMetadata } = chosenProfile;
      const { url, ...videoMetadata } = video;
      analysis = {
        schemaVersion: 1, pipelineVersion: "reference-motion-v1", timestampSource: "video_seek_position", provenance: "local", id: id(), createdAt: new Date().toISOString(), profile: profileMetadata,
        video: videoMetadata, settings: { ...settings }, model: { id: VISION_MODEL_MANIFEST.id, revision: VISION_MODEL_MANIFEST.revision, weightsSha256: VISION_MODEL_MANIFEST.weightsSha256, backend: VISION_MODEL_MANIFEST.backend },
        state: "analyzing", analyzedUntilMs: settings.fromMs, analyzedFrames: 0, candidates: [], reviews: [], gaps: [],
      };
      if (token !== generation.current) return;
      publishRun(analysis); await persistRun(analysis);
      if (token !== generation.current) return;
      const total = Math.ceil((settings.toMs - settings.fromMs) * settings.sampleFps / 1000);
      setProgress({ completed: 0, total, timeMs: settings.fromMs, message: "加载本地模型；首次会获取模型与运行库，素材不上传" });
      client = createVisionModelClient({ context: { runId: analysis.id, generation: token }, onProgress: (update) => {
        if (token === generation.current) setProgress((previous) => ({ ...previous, message: `准备模型 ${update.file ?? ""}${Number.isFinite(update.progress) ? ` · ${Math.round(update.progress!)}%` : ""}` }));
      } });
      clientRef.current = client;
      await client.load();
      if (token !== generation.current) return;
      const sourceImage = await createImageBitmap(image);
      let referenceCanvas: HTMLCanvasElement;
      try { referenceCanvas = visionFrameCanvas(sourceImage, chosenProfile.rect); } finally { sourceImage.close(); }
      await client.setReference(await createImageBitmap(referenceCanvas));
      referenceCanvas.width = 0; referenceCanvas.height = 0;
      decoder = await openVisionVideo(url, controller.signal);
      const tracker = createVisionCandidateTracker({ sampleFps: settings.sampleFps, idFactory: id });
      const rect = visionCropRect(settings.crop);
      if (token !== generation.current) return;
      setStatus("analyzing");
      for (let index = 0; index < total; index += 1) {
        if (token !== generation.current || controller.signal.aborted) return;
        const timeMs = settings.fromMs + index * 1000 / settings.sampleFps;
        await seekVisionVideo(decoder, timeMs, controller.signal);
        const canvas = visionFrameCanvas(decoder, rect);
        const bitmap = await createImageBitmap(canvas);
        canvas.width = 0; canvas.height = 0;
        const result = await client.analyze(bitmap, timeMs, settings.similarityThreshold);
        if (token !== generation.current) return;
        const found = tracker.push(result.frameTimeMs, result.candidates);
        analysis = { ...analysis, analyzedFrames: index + 1, analyzedUntilMs: timeMs, candidates: [...analysis.candidates, ...found] };
        publishRun(analysis);
        setProgress({ completed: index + 1, total, timeMs, message: `本地分析 ${index + 1}/${total} · 此帧推理 ${Math.round(result.inferenceMs)} ms` });
        if ((index + 1) % 20 === 0) await persistRun(analysis);
      }
      if (token !== generation.current || controller.signal.aborted) return;
      analysis = { ...analysis, state: "complete", analyzedUntilMs: settings.toMs, candidates: [...analysis.candidates, ...tracker.finish()] };
      publishRun(analysis); await persistRun(analysis);
      if (token === generation.current) {
        setStatus("complete");
        setNotice(`已保存分析结果：${analysis.candidates.length} 个待复核片段。首次确认过门只建立起点，两个确认事件才形成一圈。`);
      }
    } catch (e) {
      if (token !== generation.current) return;
      if (analysis) {
        const remaining = analysis.analyzedUntilMs < settings.toMs ? [{ startMs: analysis.analyzedUntilMs, endMs: settings.toMs, reason: "分析中断，尚未处理" }] : [];
        const failed: VisionTimingRun = { ...analysis, state: "failed", gaps: [...analysis.gaps, ...remaining] };
        publishRun(failed);
        try { await persistRun(failed); } catch { /* Keep the unsaved run available for retry and download. */ }
      }
      if (token !== generation.current) return;
      setError(messageOf(e)); setStatus("error");
    } finally {
      if (decoder) releaseVisionVideo(decoder);
      client?.dispose();
      if (token === generation.current) { clientRef.current = null; abortRef.current = null; busyRef.current = false; setBusy(false); }
    }
  }

  const saveCurrentRun = async () => {
    if (!runRef.current) throw new Error("还没有分析记录");
    await persistRun(runRef.current); setNotice("分析记录和修正历史已保存在本机");
  };
  const applyReview = async (eventId: string, action: "confirm" | "reject" | "adjust" | "add", timeMs: number, reason: string) => {
    const current = runRef.current;
    if (!current) throw new Error("请先分析一段录像，再复核或补记过门时刻");
    if (!video || video.sha256 !== current.video.sha256) throw new Error("请先重新选择与此记录匹配的原录像，再进行复核");
    if (settings.crop !== current.settings.crop) throw new Error("请将画面区域恢复为此记录的裁切范围，再进行复核");
    if (!reason.trim()) throw new Error("请填写复核理由");
    const next = parseVisionRun({ ...current, reviews: [...current.reviews, { id: id(), eventId, action, timeMs, reason: reason.trim(), createdAt: new Date().toISOString() }] });
    publishRun(next); await persistRun(next); setNotice("复核已保存，相关圈速已重新计算；原始候选保持不变");
  };
  async function restoreRun(next: VisionTimingRun) {
    const restored = next.state === "analyzing" ? { ...next, state: "cancelled" as const, gaps: [...next.gaps, ...(next.analyzedUntilMs < next.settings.toMs ? [{ startMs: next.analyzedUntilMs, endMs: next.settings.toMs, reason: "页面关闭后恢复，剩余区间未分析" }] : [])] } : next;
    publishRun(restored); setSettings(restored.settings); setGateNameState(restored.profile.name);
    if (urls.current.reference) URL.revokeObjectURL(urls.current.reference);
    urls.current.reference = ""; setReferenceUrl(null); setProfile(null);
    const savedProfile = await getVisionProfile(restored.profile.id);
    if (savedProfile && savedProfile.imageSha256 === restored.profile.imageSha256) applyProfile({ ...restored.profile, image: savedProfile.image });
    setStatus(restored.state === "complete" ? "complete" : "cancelled");
    setNotice(`${restored.provenance === "imported" ? "导入记录未经本机重新分析。" : "已恢复本地分析记录。"}${video?.sha256 === restored.video.sha256 ? "已匹配当前录像。" : `请重新选择原录像 ${restored.video.name}；完整文件哈希匹配后才能复核。`}`);
  }

  return {
    videoRef, video, reference: profile && referenceUrl ? { url: referenceUrl, rect: profile.rect } : null,
    gateName, setGateName: (name) => { if (!busyRef.current) { setGateNameState(name.slice(0, 120)); setProfile((current) => current ? { ...current, revision: current.revision + 1 } : null); } },
    setReferenceRect: (rect) => {
      if (busyRef.current || !Object.values(rect).every(Number.isFinite) || rect.width < 0.01 || rect.height < 0.01 || rect.x < 0 || rect.y < 0 || rect.x + rect.width > 1.000001 || rect.y + rect.height > 1.000001) return;
      setProfile((current) => current ? { ...current, rect: { ...rect }, revision: current.revision + 1 } : null);
    },
    settings, updateSettings: (patch) => { if (!busyRef.current) setSettings((current) => ({ ...current, ...patch })); },
    importVideo, importReference: (file) => guarded(() => acceptReference(file)),
    captureReference: () => guarded(async () => { if (!videoRef.current || videoRef.current.readyState < 2) throw new Error("请先在录像中定位到清晰的门画面"); await acceptReference(await visionCanvasBlob(visionFrameCanvas(videoRef.current, visionCropRect(settings.crop)))); }),
    status, busy, progress, canAnalyze: Boolean(video && profile && !busy), analyze, cancel, error, notice, run,
    events: run ? resolveVisionEvents(run) : [], laps: run ? deriveVisionLaps(run) : [],
    reviewEvent: (eventId, action, timeMs, reason) => guarded(() => applyReview(eventId, action, timeMs, reason)),
    addEvent: (timeMs, reason) => guarded(() => applyReview(id(), "add", timeMs, reason)),
    profiles, savedRuns,
    saveProfile: () => guarded(async () => { await saveVisionProfile(await currentProfile()); await refreshLibrary(); setNotice("计时门照片和选区已保存在本机，下次可直接载入"); }),
    loadProfile: (profileId) => guarded(async () => { const saved = await getVisionProfile(profileId); if (!saved) throw new Error("未找到计时门档案"); applyProfile(saved); setNotice("已载入本地计时门档案"); }),
    exportProfile: () => guarded(async () => { const current = await currentProfile(); downloadVisionText(await serializeVisionProfile(current), `fpv-gate-${current.id}-v${current.revision}-${id()}.json`, "application/json"); setNotice("已发起门档案下载，请在浏览器中确认文件；重复导出使用不同文件名"); }),
    importProfile: (file) => guarded(async () => {
      if (file.size > 20 * 1024 ** 2) throw new Error("门档案 JSON 不能超过 20 MB");
      const imported = await parseVisionProfile(await file.text());
      const existing = await getVisionProfile(imported.id);
      const saved = existing ? { ...imported, id: id(), revision: 1 } : imported;
      await saveVisionProfile(saved); applyProfile(saved); await refreshLibrary(); setNotice("门档案已导入本机；已有同名档案会保留为独立副本");
    }),
    saveRun: () => guarded(saveCurrentRun),
    loadRun: (runId) => guarded(async () => { const saved = await getVisionRun(runId); if (!saved) throw new Error("未找到分析记录"); await restoreRun(saved); }),
    exportRun: (format) => guarded(async () => {
      const current = runRef.current; if (!current) throw new Error("还没有可导出的分析记录");
      const filename = visionExportFilename(current.id, current.reviews.length + 1, format, id());
      downloadVisionText(format === "json" ? JSON.stringify(current, null, 2) : visionLapsCsv(current), filename, format === "json" ? "application/json" : "text/csv;charset=utf-8");
      setNotice(`已发起下载：${filename}。请在浏览器中确认；原始录像和旧导出不会被本应用改写。`);
    }),
    importRun: (file) => guarded(async () => {
      if (file.size > 20 * 1024 ** 2) throw new Error("分析 JSON 不能超过 20 MB");
      const imported = parseVisionRun(JSON.parse(await file.text()));
      const existing = await getVisionRun(imported.id);
      const next = { ...imported, id: existing ? id() : imported.id, provenance: "imported" as const };
      await persistRun(next); await restoreRun(next);
    }),
  };
}
