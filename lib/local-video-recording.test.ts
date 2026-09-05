import { describe, expect, it, vi } from "vitest";
import {
  localVideoContainerForMimeType,
  localVideoRecordingFilename,
  preferredLocalVideoMimeType,
  startLocalVideoRecording,
} from "./local-video-recording";

class FakeMediaRecorder extends EventTarget {
  state: RecordingState = "inactive";
  mimeType = "";
  start = vi.fn((timesliceMs?: number) => {
    void timesliceMs;
    this.state = "recording";
  });
  stop = vi.fn(() => {
    this.state = "inactive";
    queueMicrotask(() => this.dispatchEvent(new Event("stop")));
  });

  emitChunk(data: Blob) {
    const event = new Event("dataavailable") as BlobEvent;
    Object.defineProperty(event, "data", { value: data });
    this.dispatchEvent(event);
  }

  endUnexpectedly() {
    this.state = "inactive";
    this.dispatchEvent(new Event("stop"));
  }
}

function fakeStream() {
  const stop = vi.fn();
  return {
    stream: { getTracks: () => [{ stop }] } as unknown as MediaStream,
    stop,
  };
}

describe("local video recording", () => {
  it("prefers supported MP4 and uses WebM only when MP4 is unsupported", () => {
    expect(preferredLocalVideoMimeType(() => true)).toBe("video/mp4;codecs=avc1");
    expect(preferredLocalVideoMimeType((mimeType) => mimeType === "video/mp4")).toBe("video/mp4");
    expect(preferredLocalVideoMimeType((mimeType) => mimeType.includes("vp8"))).toBe("video/webm;codecs=vp8");
    expect(preferredLocalVideoMimeType(() => false)).toBeNull();
  });

  it("derives the container from MIME including browser-supplied codec parameters", () => {
    expect(localVideoContainerForMimeType('video/mp4; codecs="avc1.424028"')).toBe("mp4");
    expect(localVideoContainerForMimeType("video/webm;codecs=vp9")).toBe("webm");
    expect(localVideoContainerForMimeType("video/quicktime")).toBeNull();
    expect(localVideoContainerForMimeType("video/mp4\n")).toBeNull();
  });

  it("builds a local filename that links the pilot, Session and selected view", () => {
    const filename = localVideoRecordingFilename({
      athleteCode: " PILOT / 07 ",
      sessionId: "session-abcdef123456",
      startedAtEpochMs: new Date(2026, 7, 31, 12, 34, 56).getTime(),
      cropped: true,
    });

    expect(filename).toMatch(/^fpv-video-20260831-123456-PILOT-07-abcdef12-crop\.webm$/);
    expect(localVideoRecordingFilename({
      athleteCode: "PILOT-07", sessionId: "session-abcdef123456",
      startedAtEpochMs: 100, cropped: false, mimeType: "video/mp4;codecs=avc1",
    })).toMatch(/-full\.mp4$/);
  });

  it("writes each MediaRecorder chunk in order and confirms only after close", async () => {
    const calls: string[] = [];
    const recorder = new FakeMediaRecorder();
    const writable = {
      write: vi.fn(async (chunk: Blob) => { calls.push(`write:${await chunk.text()}`); }),
      close: vi.fn(async () => { calls.push("close"); }),
    };
    const { stream, stop } = fakeStream();
    const runtime = startLocalVideoRecording({
      stream,
      writable,
      filename: "pilot.webm",
      mimeType: "video/webm;codecs=vp8",
      startedAtEpochMs: 100,
      createRecorder: () => recorder as unknown as MediaRecorder,
    });

    recorder.emitChunk(new Blob(["one"]));
    recorder.emitChunk(new Blob(["two"]));
    const receipt = await runtime.stop();

    expect(recorder.start).toHaveBeenCalledWith(1_000);
    expect(calls).toEqual(["write:one", "write:two", "close"]);
    expect(receipt).toMatchObject({ filename: "pilot.webm", bytes: 6, mimeType: "video/webm;codecs=vp8" });
    expect(stop).not.toHaveBeenCalled();
  });

  it("stops an owned crop stream only after its final file is closed", async () => {
    const calls: string[] = [];
    const recorder = new FakeMediaRecorder();
    const { stream, stop } = fakeStream();
    stop.mockImplementation(() => calls.push("track-stop"));
    const runtime = startLocalVideoRecording({
      stream,
      writable: {
        write: async () => undefined,
        close: async () => { calls.push("close"); },
      },
      filename: "crop.webm",
      mimeType: "video/webm",
      stopStreamTracksOnFinish: true,
      createRecorder: () => recorder as unknown as MediaRecorder,
    });

    recorder.emitChunk(new Blob(["crop"]));
    await runtime.stop();

    expect(calls).toEqual(["close", "track-stop"]);
  });

  it("records MP4 bytes and reports the recorder's actual codec only after file close", async () => {
    const recorder = new FakeMediaRecorder();
    recorder.mimeType = 'video/mp4;codecs="avc1.424028"';
    let finishClose!: () => void;
    const close = new Promise<void>((resolve) => { finishClose = resolve; });
    const write = vi.fn(async () => undefined);
    const createRecorder = vi.fn(() => recorder as unknown as MediaRecorder);
    const runtime = startLocalVideoRecording({
      stream: fakeStream().stream,
      writable: { write, close: () => close },
      filename: "pilot.mp4", mimeType: "video/mp4", createRecorder,
    });
    recorder.emitChunk(new Blob(["mp4 frames"], { type: "video/mp4" }));
    const confirmed = vi.fn();
    const result = runtime.stop().then((receipt) => { confirmed(receipt); return receipt; });
    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
    expect(confirmed).not.toHaveBeenCalled();
    finishClose();
    expect(await result).toMatchObject({ filename: "pilot.mp4", mimeType: recorder.mimeType, bytes: 10 });
    expect(createRecorder).toHaveBeenCalledWith(expect.anything(), { mimeType: "video/mp4" });
  });

  it("rejects mismatched filename containers before starting an encoder", () => {
    const createRecorder = vi.fn(() => new FakeMediaRecorder() as unknown as MediaRecorder);
    const close = vi.fn(async () => undefined);
    const { stream, stop } = fakeStream();
    expect(() => startLocalVideoRecording({
      stream, writable: { write: async () => undefined, close },
      filename: "renamed.mp4", mimeType: "video/webm", stopStreamTracksOnFinish: true, createRecorder,
    })).toThrow("后缀");
    expect(createRecorder).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("does not silently retry another format when the MP4 encoder refuses to start", () => {
    const recorder = new FakeMediaRecorder();
    recorder.mimeType = "video/mp4";
    recorder.start.mockImplementation(() => { throw new DOMException("encoder unavailable", "NotSupportedError"); });
    const createRecorder = vi.fn(() => recorder as unknown as MediaRecorder);
    const close = vi.fn(async () => undefined);
    expect(() => startLocalVideoRecording({
      stream: fakeStream().stream, writable: { write: async () => undefined, close },
      filename: "pilot.mp4", mimeType: "video/mp4", createRecorder,
    })).toThrow("encoder unavailable");
    expect(createRecorder).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("rejects a browser producing another container instead of confirming a renamed file", async () => {
    const recorder = new FakeMediaRecorder();
    recorder.mimeType = "video/mp4";
    const write = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const runtime = startLocalVideoRecording({
      stream: fakeStream().stream, writable: { write, close },
      filename: "pilot.mp4", mimeType: "video/mp4",
      createRecorder: () => recorder as unknown as MediaRecorder,
    });
    recorder.emitChunk(new Blob(["webm bytes"], { type: "video/webm" }));
    await expect(runtime.done).rejects.toThrow("分块格式");
    expect(write).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("rejects the recording receipt when a chunk cannot be written", async () => {
    const recorder = new FakeMediaRecorder();
    const close = vi.fn(async () => undefined);
    const runtime = startLocalVideoRecording({
      stream: fakeStream().stream,
      writable: {
        write: async () => { throw new Error("disk full"); },
        close,
      },
      filename: "pilot.webm",
      mimeType: "video/webm",
      createRecorder: () => recorder as unknown as MediaRecorder,
    });

    recorder.emitChunk(new Blob(["lost"]));

    await expect(runtime.done).rejects.toThrow("disk full");
    expect(recorder.stop).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("does not confirm a recording when closing the file fails", async () => {
    const recorder = new FakeMediaRecorder();
    const runtime = startLocalVideoRecording({
      stream: fakeStream().stream,
      writable: {
        write: async () => undefined,
        close: async () => { throw new Error("close failed"); },
      },
      filename: "pilot.webm",
      mimeType: "video/webm",
      createRecorder: () => recorder as unknown as MediaRecorder,
    });

    recorder.emitChunk(new Blob(["frame"]));
    await expect(runtime.stop()).rejects.toThrow("close failed");
  });

  it("closes but rejects a zero-byte recording", async () => {
    const recorder = new FakeMediaRecorder();
    const close = vi.fn(async () => undefined);
    const runtime = startLocalVideoRecording({
      stream: fakeStream().stream,
      writable: { write: async () => undefined, close },
      filename: "empty.webm",
      mimeType: "video/webm",
      createRecorder: () => recorder as unknown as MediaRecorder,
    });

    await expect(runtime.stop()).rejects.toThrow("未产生任何视频数据");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("closes but does not confirm a file when the video source ends before the Session", async () => {
    const recorder = new FakeMediaRecorder();
    const close = vi.fn(async () => undefined);
    const runtime = startLocalVideoRecording({
      stream: fakeStream().stream,
      writable: { write: async () => undefined, close },
      filename: "partial.webm",
      mimeType: "video/webm",
      createRecorder: () => recorder as unknown as MediaRecorder,
    });

    recorder.endUnexpectedly();

    await expect(runtime.done).rejects.toThrow("Session 结束前中断");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("supports an explicit failed stop for a crop stream whose source video froze", async () => {
    const recorder = new FakeMediaRecorder();
    const close = vi.fn(async () => undefined);
    const { stream, stop } = fakeStream();
    const runtime = startLocalVideoRecording({
      stream,
      writable: { write: async () => undefined, close },
      filename: "crop-partial.webm",
      mimeType: "video/webm",
      stopStreamTracksOnFinish: true,
      createRecorder: () => recorder as unknown as MediaRecorder,
    });
    recorder.emitChunk(new Blob(["partial"]));

    await expect(runtime.fail(new Error("HDMI source lost"))).rejects.toThrow("HDMI source lost");
    expect(close).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
