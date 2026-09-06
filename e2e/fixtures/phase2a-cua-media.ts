/** Test-only canvas device. Self-contained for serialization before product scripts. */
export function installPhase2ACuaMedia() {
  if (location.protocol !== "http:" || location.hostname !== "127.0.0.1" || location.port !== "3140") return;
  const scope = window as unknown as Window & { __phase2aCuaMedia?: unknown };
  if (scope.__phase2aCuaMedia) throw new Error("Synthetic media already installed");
  const deviceId = "phase2a-cua-synthetic-video", groupId = "phase2a-cua-synthetic-group";
  const width = 1920, height = 1080, frameRate = 30, lifetimeMs = 15 * 60 * 1000;
  const active = new Map<number, { stream: MediaStream; stop: () => void; snapshot: () => unknown }>();
  const finished: unknown[] = [];
  let requests = 0, nextId = 0;
  const media = navigator.mediaDevices ?? new EventTarget() as MediaDevices;
  const descriptor = { deviceId, groupId, kind: "videoinput" as const, label: "PHASE2A Synthetic Canvas Video" };
  const enumerateDevices = async () => [{ ...descriptor, toJSON: () => ({ ...descriptor }) }];
  const getUserMedia = async (constraints: MediaStreamConstraints): Promise<MediaStream> => {
    requests += 1;
    if (!constraints?.video || constraints.audio) throw new DOMException("Only synthetic video with audio:false is available", "NotSupportedError");
    const requested = typeof constraints.video === "object" ? constraints.video.deviceId : undefined;
    const exact = typeof requested === "string" || Array.isArray(requested) ? requested : requested?.exact;
    if (exact && !(Array.isArray(exact) ? exact : [exact]).includes(deviceId)) throw new DOMException("Unknown synthetic device", "NotFoundError");
    if (active.size >= 4) throw new DOMException("Synthetic stream limit reached", "QuotaExceededError");
    const canvas = document.createElement("canvas");
    canvas.width = width; canvas.height = height;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context || typeof canvas.captureStream !== "function") throw new DOMException("Canvas CaptureStream is unavailable", "NotSupportedError");
    const id = ++nextId;
    let frames = 0, disposed = false;
    const timers: { interval?: number; deadline?: number } = {};
    const draw = () => {
      if (disposed) return;
      context.fillStyle = "#172331"; context.fillRect(0, 0, width, height);
      context.fillStyle = "#3a768b"; context.fillRect((frames * 12) % (width - 160), height / 2, 160, 100);
      context.fillStyle = "#e6edf3"; context.font = "48px monospace";
      context.fillText("SYNTHETIC VIDEO · PHASE2A", 64, 96);
      context.fillText(`Frame ${frames++}`, 64, 160);
    };
    draw();
    const stream = canvas.captureStream(frameRate);
    const tracks = stream.getVideoTracks();
    if (!tracks.length || !tracks.every((track) => track.readyState === "live")) {
      stream.getTracks().forEach((track) => track.stop());
      throw new DOMException("Canvas did not produce a live video track", "NotSupportedError");
    }
    const snapshot = () => ({ id, width, height, frameRate, frames, disposed, tracks: tracks.map((track) => ({ kind: track.kind, readyState: track.readyState })) });
    const retire = () => {
      if (disposed || tracks.some((track) => track.readyState === "live")) return;
      disposed = true;
      if (timers.interval !== undefined) window.clearInterval(timers.interval);
      if (timers.deadline !== undefined) window.clearTimeout(timers.deadline);
      active.delete(id);
      if (finished.length < 64) finished.push(snapshot());
    };
    for (const track of tracks) {
      const nativeStop = track.stop.bind(track), nativeSettings = track.getSettings.bind(track);
      Object.defineProperty(track, "getSettings", { configurable: true, value: () => ({ ...nativeSettings(), deviceId, groupId, width, height, frameRate, aspectRatio: width / height }) });
      // MediaStreamTrack.stop() does not dispatch ended; retain that native behavior.
      Object.defineProperty(track, "stop", { configurable: true, value: () => { nativeStop(); retire(); } });
      track.addEventListener("ended", retire, { once: true });
    }
    const stop = () => tracks.forEach((track) => track.stop());
    active.set(id, { stream, stop, snapshot });
    timers.interval = window.setInterval(draw, 1000 / frameRate);
    timers.deadline = window.setTimeout(stop, lifetimeMs);
    draw();
    return stream;
  };
  Object.defineProperty(media, "getUserMedia", { configurable: true, writable: true, value: getUserMedia });
  Object.defineProperty(media, "enumerateDevices", { configurable: true, writable: true, value: enumerateDevices });
  if (!navigator.mediaDevices) Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: media });
  const stopAll = () => [...active.values()].forEach((record) => record.stop());
  window.addEventListener("pagehide", stopAll, { once: true });
  scope.__phase2aCuaMedia = { snapshot: () => ({ synthetic: true, requests, device: descriptor, active: [...active.values()].map((record) => record.snapshot()), finished: [...finished] }), stopAll };
}
