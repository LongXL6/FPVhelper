import { createSHA256 } from "hash-wasm";
import type { VisionRect } from "./vision-lab-types";

function checkAbort(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("操作已取消", "AbortError");
}

export async function hashVisionFile(blob: Blob, onProgress?: (fraction: number) => void, signal?: AbortSignal) {
  const hash = await createSHA256();
  hash.init();
  const chunkSize = 4 * 1024 * 1024;
  for (let offset = 0; offset < blob.size; offset += chunkSize) {
    checkAbort(signal);
    hash.update(new Uint8Array(await blob.slice(offset, offset + chunkSize).arrayBuffer()));
    onProgress?.(Math.min(1, (offset + chunkSize) / blob.size));
  }
  checkAbort(signal);
  return hash.digest("hex");
}

export async function openVisionVideo(url: string, signal?: AbortSignal): Promise<HTMLVideoElement> {
  const video = document.createElement("video");
  video.preload = "auto";
  video.muted = true;
  video.playsInline = true;
  try {
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeout);
        video.removeEventListener("loadeddata", ready);
        video.removeEventListener("durationchange", ready);
        video.removeEventListener("error", failed);
        signal?.removeEventListener("abort", aborted);
      };
      const settle = (error?: Error) => { cleanup(); if (error) reject(error); else resolve(); };
      const ready = () => {
        if (Number.isFinite(video.duration) && video.duration > 0 && video.readyState >= 2 && video.videoWidth > 0) settle();
        else if (video.duration === Infinity && video.readyState >= 2) video.currentTime = 1e10;
      };
      const failed = () => settle(new Error("这段录像无法解码，请使用浏览器可播放的 MP4 或 WebM"));
      const aborted = () => settle(new DOMException("操作已取消", "AbortError"));
      const timeout = setTimeout(() => settle(new Error("无法读取录像时长；请检查文件是否完整，或转为有完整时长信息的 MP4")), 12_000);
      video.addEventListener("loadeddata", ready);
      video.addEventListener("durationchange", ready);
      video.addEventListener("error", failed);
      signal?.addEventListener("abort", aborted, { once: true });
      video.src = url;
      video.load();
      if (signal?.aborted) aborted();
    });
    return video;
  } catch (error) {
    releaseVisionVideo(video);
    throw error;
  }
}

export function releaseVisionVideo(video: HTMLVideoElement) {
  video.pause();
  video.removeAttribute("src");
  video.load();
}

export async function seekVisionVideo(video: HTMLVideoElement, timeMs: number, signal?: AbortSignal) {
  checkAbort(signal);
  const seconds = Math.min(Math.max(0, timeMs / 1000), Math.max(0, video.duration - 0.001));
  if (!video.seeking && Math.abs(video.currentTime - seconds) < 0.0005 && video.readyState >= 2) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      video.removeEventListener("seeked", ready);
      video.removeEventListener("error", failed);
      signal?.removeEventListener("abort", aborted);
    };
    const settle = (error?: Error) => { cleanup(); if (error) reject(error); else resolve(); };
    const ready = () => video.readyState >= 2 ? settle() : settle(new Error("定位后没有可读取的视频帧"));
    const failed = () => settle(new Error("录像在该位置解码失败"));
    const aborted = () => settle(new DOMException("分析已取消", "AbortError"));
    const timeout = setTimeout(() => settle(new Error("视频帧定位超时")), 8000);
    video.addEventListener("seeked", ready, { once: true });
    video.addEventListener("error", failed, { once: true });
    signal?.addEventListener("abort", aborted, { once: true });
    video.currentTime = seconds;
    if (signal?.aborted) aborted();
  });
}

export function visionFrameCanvas(source: HTMLVideoElement | ImageBitmap, rect: VisionRect, maxDimension = 1280) {
  const width = source instanceof HTMLVideoElement ? source.videoWidth : source.width;
  const height = source instanceof HTMLVideoElement ? source.videoHeight : source.height;
  if (width <= 0 || height <= 0) throw new Error("没有可读取的画面");
  const canvas = document.createElement("canvas");
  const scale = Math.min(1, maxDimension / Math.max(width * rect.width, height * rect.height));
  canvas.width = Math.max(1, Math.round(width * rect.width * scale));
  canvas.height = Math.max(1, Math.round(height * rect.height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法创建本地图像画布");
  context.drawImage(source, width * rect.x, height * rect.y, width * rect.width, height * rect.height, 0, 0, canvas.width, canvas.height);
  return canvas;
}

export function visionCanvasBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("无法保存参考图")), "image/png"));
}

export function downloadVisionText(text: string, filename: string, mimeType: string) {
  const url = URL.createObjectURL(new Blob([text], { type: mimeType }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  try { anchor.click(); } finally {
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}
