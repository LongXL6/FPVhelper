import { useEffect } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDvrRecording } from "./use-dvr-recording";
import { startStickVideoCompositor, type StickVideoCompositor } from "../lib/stick-video-compositor";
import type { TrainingSessionDirectoryHandle, TrainingSessionDirectoryWritable } from "../lib/training-session-export-directory";

vi.mock("../lib/stick-video-compositor", () => ({ startStickVideoCompositor: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function file() {
  return { write: vi.fn(async (): Promise<void> => undefined), close: vi.fn(async (): Promise<void> => undefined), abort: vi.fn(async (): Promise<void> => undefined) };
}
function mediaStream() {
  const stop = vi.fn();
  return { stream: { getTracks: () => [{ stop }], getVideoTracks: () => [{ stop, readyState: "live" }] } as unknown as MediaStream, stop };
}
function compositor() {
  const owned = mediaStream();
  return { stream: owned.stream, width: 640, height: 360, dispose: vi.fn(() => owned.stop()) } satisfies StickVideoCompositor;
}
class Recorder extends EventTarget {
  static instances: Recorder[] = [];
  static rejectStart = false;
  state: RecordingState = "inactive";
  readonly mimeType: string;
  constructor(readonly stream: MediaStream, options: MediaRecorderOptions) { super(); this.mimeType = options.mimeType!; Recorder.instances.push(this); }
  start() { if (Recorder.rejectStart) throw new Error("encoder startup failed"); this.state = "recording"; }
  stop = vi.fn(() => {
    if (this.state === "inactive") return;
    this.state = "inactive";
    const chunk = new Event("dataavailable"); Object.defineProperty(chunk, "data", { value: new Blob(["frame"], { type: this.mimeType }) });
    this.dispatchEvent(chunk); queueMicrotask(() => this.dispatchEvent(new Event("stop")));
  });
  fail() { const event = new Event("error"); Object.defineProperty(event, "error", { value: new DOMException("encoder failed") }); this.dispatchEvent(event); }
}

let controller: ReturnType<typeof useDvrRecording>;
let renderer: ReactTestRenderer | null = null;
let source: ReturnType<typeof mediaStream>;
let composites: ReturnType<typeof compositor>[];
let databaseOpen: ReturnType<typeof vi.fn>;
let browserWindow: EventTarget & { setInterval: typeof window.setInterval; clearInterval: typeof window.clearInterval; showDirectoryPicker?: ReturnType<typeof vi.fn> };
function Harness() { const current = useDvrRecording(); useEffect(() => { controller = current; }, [current]); return null; }
async function mount() { await act(async () => { renderer = create(<Harness />); }); }
async function flush() { for (let index = 0; index < 10; index++) await Promise.resolve(); }
function options(writable = file()) {
  return { sourceStream: source.stream, frameRate: 30, athleteCode: "", mimeType: "video/mp4;codecs=avc1", createWritable: vi.fn(async () => writable) };
}
function directory(name: string, writable = file()) {
  const permission = vi.fn(async () => "granted" as const), getFileHandle = vi.fn(async () => ({ createWritable: async () => writable }));
  return { handle: { kind: "directory", name, queryPermission: permission, getFileHandle } as TrainingSessionDirectoryHandle, permission, getFileHandle, writable };
}

beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  browserWindow = Object.assign(new EventTarget(), { setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval }) as typeof browserWindow;
  vi.stubGlobal("window", browserWindow); vi.stubGlobal("MediaRecorder", Recorder);
  databaseOpen = vi.fn(() => { throw new Error("DVR must not open IndexedDB"); }); vi.stubGlobal("indexedDB", { open: databaseOpen });
  Recorder.instances = []; Recorder.rejectStart = false; source = mediaStream(); composites = [];
  vi.mocked(startStickVideoCompositor).mockReset().mockImplementation(async () => { const value = compositor(); composites.push(value); return value; });
});
afterEach(async () => {
  if (renderer) await act(async () => { renderer!.unmount(); await flush(); });
  renderer = null; vi.unstubAllGlobals(); vi.useRealTimers();
});

describe("independent DVR recording", () => {
  it("records without a pilot/RC/IDB, keeps the source live and shares concurrent stop", async () => {
    await mount(); const destination = file(), close = deferred<void>(); destination.close.mockImplementation(() => close.promise);
    const input = { ...options(destination), crop: { xPercent: 0, yPercent: 0, widthPercent: 50, heightPercent: 50 } };
    await act(async () => { expect(await controller.start(input)).toBe(true); });
    expect(controller.isRecording).toBe(true); expect(controller.filename).toMatch(/-DVR-[a-f0-9]{8}-crop\.mp4$/);
    expect(vi.mocked(startStickVideoCompositor).mock.calls[0][0]).toMatchObject({ sourceStream: source.stream, drawOverlay: false, crop: input.crop });
    expect(Recorder.instances[0].stream).toBe(composites[0].stream);
    let first!: ReturnType<typeof controller.stop>, second!: ReturnType<typeof controller.stop>;
    await act(async () => { first = controller.stop(); second = controller.stop(); await flush(); });
    expect(first).toBe(second); expect(controller.isStopping).toBe(true); expect(controller.isBusy()).toBe(true);
    expect(composites[0].dispose).not.toHaveBeenCalled();
    await act(async () => { close.resolve(); expect(await first).toMatchObject({ bytes: 5, mimeType: "video/mp4;codecs=avc1" }); });
    expect(controller.state).toBe("saved"); expect(controller.isBusy()).toBe(false); expect(destination.close).toHaveBeenCalledTimes(1);
    expect(composites[0].dispose).toHaveBeenCalledTimes(1); expect(source.stop).not.toHaveBeenCalled(); expect(databaseOpen).not.toHaveBeenCalled();
  });

  it("aborts a starting attempt and closes a late writable without starting an encoder", async () => {
    await mount(); const opening = deferred<TrainingSessionDirectoryWritable>(), destination = file();
    const input = { ...options(), createWritable: vi.fn(() => opening.promise) };
    let starting!: Promise<boolean>, stopping!: ReturnType<typeof controller.stop>;
    await act(async () => { starting = controller.start(input); await flush(); });
    expect(controller.isStarting).toBe(true);
    await act(async () => { expect(await controller.start(input)).toBe(false); stopping = controller.stop(); await flush(); });
    expect(vi.mocked(startStickVideoCompositor).mock.calls[0][0].signal?.aborted).toBe(true);
    expect(controller.isBusy()).toBe(true); expect(Recorder.instances).toHaveLength(0);
    await act(async () => { opening.resolve(destination); expect(await starting).toBe(false); expect(await stopping).toBeNull(); });
    expect(destination.abort).toHaveBeenCalledTimes(1); expect(destination.close).not.toHaveBeenCalled();
    expect(Recorder.instances).toHaveLength(0); expect(controller.state).toBe("idle"); expect(controller.isBusy()).toBe(false); expect(source.stop).not.toHaveBeenCalled();
  });

  it("disposes a late compositor after cancellation without opening a file", async () => {
    await mount(); const setup = deferred<StickVideoCompositor>(), late = compositor(), input = options();
    vi.mocked(startStickVideoCompositor).mockReturnValueOnce(setup.promise);
    let starting!: Promise<boolean>, stopping!: ReturnType<typeof controller.stop>;
    await act(async () => { starting = controller.start(input); stopping = controller.stop(); });
    await act(async () => { setup.resolve(late); expect(await starting).toBe(false); await stopping; });
    expect(input.createWritable).not.toHaveBeenCalled(); expect(late.dispose).toHaveBeenCalledTimes(1); expect(Recorder.instances).toHaveLength(0);
  });

  it("does not close a failed encoder's writable twice", async () => {
    await mount(); Recorder.rejectStart = true; const destination = file();
    await act(async () => { expect(await controller.start(options(destination))).toBe(false); });
    expect(controller.state).toBe("error"); expect(controller.error).toBe("encoder startup failed");
    expect(destination.close).toHaveBeenCalledTimes(1); expect(destination.abort).not.toHaveBeenCalled();
    expect(composites[0].dispose).toHaveBeenCalledTimes(1); expect(source.stop).not.toHaveBeenCalled(); expect(controller.isBusy()).toBe(false);
  });

  it("releases owned resources on an asynchronous encoder error", async () => {
    await mount(); const destination = file();
    await act(async () => { await controller.start(options(destination)); });
    await act(async () => { Recorder.instances[0].fail(); await flush(); });
    expect(controller.state).toBe("error"); expect(controller.receipt).toBeNull(); expect(controller.isBusy()).toBe(false);
    expect(destination.close).toHaveBeenCalledTimes(1); expect(composites[0].dispose).toHaveBeenCalledTimes(1); expect(source.stop).not.toHaveBeenCalled();
  });

  it("ignores an old attempt's error after the next recording starts", async () => {
    await mount(); await act(async () => { await controller.start(options()); });
    const oldError = vi.mocked(startStickVideoCompositor).mock.calls[0][0].onError!;
    await act(async () => { await controller.stop(); await controller.start(options()); });
    await act(async () => { oldError(new Error("late old source error")); await flush(); });
    expect(controller.isRecording).toBe(true); expect(controller.error).toBeNull(); expect(Recorder.instances[1].stop).not.toHaveBeenCalled();
    expect(composites[1].dispose).not.toHaveBeenCalled();
  });

  it("protects beforeunload during setup and cleans a late file after unmount", async () => {
    await mount(); const opening = deferred<TrainingSessionDirectoryWritable>(), destination = file(); let starting!: Promise<boolean>;
    await act(async () => { starting = controller.start({ ...options(), createWritable: () => opening.promise }); await flush(); });
    const event = new Event("beforeunload", { cancelable: true }); browserWindow.dispatchEvent(event); expect(event.defaultPrevented).toBe(true);
    await act(async () => { renderer!.unmount(); renderer = null; });
    await act(async () => { opening.resolve(destination); expect(await starting).toBe(false); });
    expect(destination.abort).toHaveBeenCalledTimes(1); expect(Recorder.instances).toHaveLength(0); expect(source.stop).not.toHaveBeenCalled();
    const later = new Event("beforeunload", { cancelable: true }); browserWindow.dispatchEvent(later); expect(later.defaultPrevented).toBe(false);
  });
});

describe("DVR page-local directory", () => {
  it("uses only the selected memory handle; cancel preserves it and remount forgets it", async () => {
    await mount(); const chosen = directory("DVR folder"); browserWindow.showDirectoryPicker = vi.fn(async () => chosen.handle);
    await act(async () => { expect(await controller.chooseDirectory()).toBe(true); });
    expect(controller.directoryName).toBe("DVR folder"); expect(controller.hasDirectory).toBe(true);
    await act(async () => { expect(await controller.createWritable("dvr.mp4")).toBe(chosen.writable); });
    expect(chosen.getFileHandle).toHaveBeenCalledWith("dvr.mp4", { create: true });
    browserWindow.showDirectoryPicker.mockRejectedValueOnce(new DOMException("cancel", "AbortError"));
    await act(async () => { expect(await controller.chooseDirectory()).toBe(false); });
    expect(controller.directoryName).toBe("DVR folder"); expect(controller.directoryError).toBeNull(); expect(databaseOpen).not.toHaveBeenCalled();
    await act(async () => { renderer!.unmount(); renderer = null; }); await mount();
    expect(controller.hasDirectory).toBe(false); expect(controller.directoryName).toBeNull();
  });

  it("blocks directory replacement while recording and reports unsupported pickers", async () => {
    await mount();
    await act(async () => { expect(await controller.chooseDirectory()).toBe(false); });
    expect(controller.directoryError).toContain("不支持选择");
    const picker = vi.fn(async () => directory("D1").handle); browserWindow.showDirectoryPicker = picker;
    await act(async () => { await controller.start(options()); expect(await controller.chooseDirectory()).toBe(false); });
    expect(picker).not.toHaveBeenCalled();
  });

  it("checks write permission before opening the chosen memory directory", async () => {
    await mount(); const chosen = directory("D1"); browserWindow.showDirectoryPicker = vi.fn(async () => chosen.handle);
    await act(async () => { await controller.chooseDirectory(); });
    chosen.handle.queryPermission = async () => "denied";
    await act(async () => { await expect(controller.createWritable("file.mp4")).rejects.toThrow("没有写入权限"); });
    expect(chosen.getFileHandle).not.toHaveBeenCalled(); expect(controller.directoryError).toContain("没有写入权限");
  });
});
