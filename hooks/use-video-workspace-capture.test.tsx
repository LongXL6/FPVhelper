import { useEffect } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VideoSourceConfig } from "../lib/video-workspace";
import { useVideoWorkspaceCapture } from "./use-video-workspace-capture";

type VideoWorkspaceCaptureController = ReturnType<typeof useVideoWorkspaceCapture>;

const SOURCE_ONE: VideoSourceConfig = {
  id: "video-source-1",
  label: "视频输入 1",
  deviceId: "capture-card-1",
  layout: "full",
};
const SOURCE_TWO: VideoSourceConfig = {
  id: "video-source-2",
  label: "视频输入 2",
  deviceId: "capture-card-2",
  layout: "full",
};

class FakeVideoTrack extends EventTarget {
  stopped = false;

  constructor(readonly deviceId: string) {
    super();
  }

  getSettings(): MediaTrackSettings {
    return { deviceId: this.deviceId, width: 1920, height: 1080, frameRate: 60 };
  }

  stop() {
    this.stopped = true;
    this.dispatchEvent(new Event("ended"));
  }
}

class FakeMediaStream {
  constructor(readonly track: FakeVideoTrack) {}

  getTracks() {
    return [this.track];
  }

  getVideoTracks() {
    return [this.track];
  }
}

let controller: VideoWorkspaceCaptureController;
let renderer: ReactTestRenderer | null = null;
let sources: VideoSourceConfig[];
let createdStreams: FakeMediaStream[];
let getUserMedia: ReturnType<typeof vi.fn>;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");

function Harness() {
  const nextController = useVideoWorkspaceCapture(sources);
  useEffect(() => {
    controller = nextController;
  }, [nextController]);
  return null;
}

function fakeVideoElement() {
  return {
    srcObject: null,
    play: vi.fn(async () => undefined),
  } as unknown as HTMLVideoElement;
}

function requestedDeviceId(constraints: MediaStreamConstraints) {
  const video = constraints.video;
  if (!video || video === true) return "auto";
  const deviceId = video.deviceId;
  if (!deviceId || typeof deviceId !== "object" || Array.isArray(deviceId)) return "auto";
  return typeof deviceId.exact === "string" ? deviceId.exact : "auto";
}

function restoreGlobalProperty(name: "window" | "navigator", descriptor: PropertyDescriptor | undefined) {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else delete (globalThis as typeof globalThis & Record<string, unknown>)[name];
}

beforeEach(() => {
  vi.useFakeTimers();
  sources = [{ ...SOURCE_ONE }];
  createdStreams = [];
  getUserMedia = vi.fn(async (constraints: MediaStreamConstraints) => {
    const stream = new FakeMediaStream(new FakeVideoTrack(requestedDeviceId(constraints)));
    createdStreams.push(stream);
    return stream as unknown as MediaStream;
  });
  const mediaDevices = new EventTarget() as EventTarget & {
    enumerateDevices: () => Promise<MediaDeviceInfo[]>;
    getUserMedia: typeof getUserMedia;
  };
  mediaDevices.enumerateDevices = async () => ([
    { kind: "videoinput", deviceId: "capture-card-1", label: "Capture 1", groupId: "", toJSON: () => ({}) },
    { kind: "videoinput", deviceId: "capture-card-2", label: "Capture 2", groupId: "", toJSON: () => ({}) },
  ] as MediaDeviceInfo[]);
  mediaDevices.getUserMedia = getUserMedia;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      isSecureContext: true,
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    },
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { mediaDevices },
  });
});

afterEach(() => {
  if (renderer) {
    act(() => renderer?.unmount());
    renderer = null;
  }
  restoreGlobalProperty("window", originalWindow);
  restoreGlobalProperty("navigator", originalNavigator);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function renderHarness() {
  act(() => {
    renderer = create(<Harness />);
  });
}

describe("useVideoWorkspaceCapture", () => {
  it("opens a composite input once and attaches the same stream to four crop views", async () => {
    renderHarness();
    const elements = Array.from({ length: 4 }, () => fakeVideoElement());
    elements.forEach((element) => controller.registerVideoElement(SOURCE_ONE.id, element));

    await act(async () => controller.connectSource(SOURCE_ONE.id));

    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(controller.runtimes[SOURCE_ONE.id]).toMatchObject({ state: "live", error: null });
    expect(elements.every((element) => element.srcObject === createdStreams[0] as unknown as MediaProvider)).toBe(true);
    expect(elements.every((element) => vi.mocked(element.play).mock.calls.length === 1)).toBe(true);
    expect(controller.getSourceStream(SOURCE_ONE.id)).toBe(createdStreams[0]);
  });

  it("opens independent sources concurrently and keeps their streams separate", async () => {
    sources = [{ ...SOURCE_ONE }, { ...SOURCE_TWO }];
    renderHarness();
    const firstElement = fakeVideoElement();
    const secondElement = fakeVideoElement();
    controller.registerVideoElement(SOURCE_ONE.id, firstElement);
    controller.registerVideoElement(SOURCE_TWO.id, secondElement);

    await act(async () => controller.connectAll());

    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(controller.runtimes[SOURCE_ONE.id].state).toBe("live");
    expect(controller.runtimes[SOURCE_TWO.id].state).toBe("live");
    expect(controller.getSourceStream(SOURCE_ONE.id)).toBe(createdStreams[0]);
    expect(controller.getSourceStream(SOURCE_TWO.id)).toBe(createdStreams[1]);
    expect(firstElement.srcObject).toBe(createdStreams[0]);
    expect(secondElement.srcObject).toBe(createdStreams[1]);
    expect(firstElement.srcObject).not.toBe(secondElement.srcObject);
  });

  it("disconnects one source without stopping another source", async () => {
    sources = [{ ...SOURCE_ONE }, { ...SOURCE_TWO }];
    renderHarness();
    const firstElement = fakeVideoElement();
    const secondElement = fakeVideoElement();
    controller.registerVideoElement(SOURCE_ONE.id, firstElement);
    controller.registerVideoElement(SOURCE_TWO.id, secondElement);
    await act(async () => controller.connectAll());

    act(() => controller.disconnectSource(SOURCE_ONE.id));

    expect(createdStreams[0].track.stopped).toBe(true);
    expect(createdStreams[1].track.stopped).toBe(false);
    expect(firstElement.srcObject).toBeNull();
    expect(secondElement.srcObject).toBe(createdStreams[1]);
    expect(controller.runtimes[SOURCE_ONE.id].state).toBe("idle");
    expect(controller.runtimes[SOURCE_TWO.id].state).toBe("live");
    expect(controller.getSourceStream(SOURCE_ONE.id)).toBeNull();
    expect(controller.getSourceStream(SOURCE_TWO.id)).toBe(createdStreams[1]);
  });
});
