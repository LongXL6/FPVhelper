import type { TrainingSessionDirectoryWritable } from "./training-session-export-directory";

const LOCAL_VIDEO_MIME_TYPES = [
  "video/mp4;codecs=avc1",
  "video/mp4",
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
] as const;

export function localVideoContainerForMimeType(mimeType: string): "mp4" | "webm" | null {
  if (/[\u0000-\u001f\u007f]/.test(mimeType)) return null;
  const mediaType = mimeType.split(";", 1)[0].trim().toLowerCase();
  if (mediaType === "video/mp4") return "mp4";
  if (mediaType === "video/webm") return "webm";
  return null;
}

export interface LocalVideoRecordingReceipt {
  filename: string;
  bytes: number;
  mimeType: string;
  startedAtEpochMs: number;
  finishedAtEpochMs: number;
}

export interface LocalVideoRecordingRuntime {
  done: Promise<LocalVideoRecordingReceipt>;
  stop(): Promise<LocalVideoRecordingReceipt>;
  fail(error: Error): Promise<LocalVideoRecordingReceipt>;
}

export type LocalMediaRecorderFactory = (
  stream: MediaStream,
  options: MediaRecorderOptions,
) => MediaRecorder;

function errorMessage(error: unknown) {
  return error instanceof Error && error.message ? error.message : "本地视频录制失败";
}

function safeFilenameSegment(value: string) {
  return value.trim().replaceAll(/[\\/:*?"<>|\s]+/g, "-").replaceAll(/^-+|-+$/g, "").slice(0, 40) || "unknown-pilot";
}

function pad(value: number) {
  return value.toString().padStart(2, "0");
}

export function localVideoRecordingFilename({
  athleteCode,
  sessionId,
  startedAtEpochMs,
  cropped,
  mimeType = "video/webm",
}: {
  athleteCode: string;
  sessionId: string;
  startedAtEpochMs: number;
  cropped: boolean;
  mimeType?: string;
}) {
  const extension = localVideoContainerForMimeType(mimeType);
  if (!extension) throw new Error("不支持当前录像 MIME 类型");
  const startedAt = new Date(startedAtEpochMs);
  const timestamp = `${startedAt.getFullYear()}${pad(startedAt.getMonth() + 1)}${pad(startedAt.getDate())}-${pad(startedAt.getHours())}${pad(startedAt.getMinutes())}${pad(startedAt.getSeconds())}`;
  const shortId = sessionId.startsWith("session-") ? sessionId.slice(8, 16) : sessionId.slice(0, 8);
  return `fpv-video-${timestamp}-${safeFilenameSegment(athleteCode)}-${shortId}-${cropped ? "crop" : "full"}.${extension}`;
}

export function preferredLocalVideoMimeType(
  isTypeSupported: (mimeType: string) => boolean,
) {
  return LOCAL_VIDEO_MIME_TYPES.find((mimeType) => isTypeSupported(mimeType)) ?? null;
}

export function startLocalVideoRecording({
  stream,
  writable,
  filename,
  mimeType,
  createRecorder = (input, options) => new MediaRecorder(input, options),
  startedAtEpochMs = Date.now(),
  timesliceMs = 1_000,
  stopStreamTracksOnFinish = false,
}: {
  stream: MediaStream;
  writable: TrainingSessionDirectoryWritable;
  filename: string;
  mimeType: string;
  createRecorder?: LocalMediaRecorderFactory;
  startedAtEpochMs?: number;
  timesliceMs?: number;
  stopStreamTracksOnFinish?: boolean;
}): LocalVideoRecordingRuntime {
  let recorder: MediaRecorder;
  let bytes = 0;
  let writeError: Error | null = null;
  let finalized = false;
  let stopRequested = false;
  let writeChain = Promise.resolve();
  let resolveDone!: (receipt: LocalVideoRecordingReceipt) => void;
  let rejectDone!: (error: Error) => void;
  const done = new Promise<LocalVideoRecordingReceipt>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  const stopOwnedTracks = () => {
    if (stopStreamTracksOnFinish) stream.getTracks().forEach((track) => track.stop());
  };

  const closeAfterStartFailure = (error: unknown) => {
    stopOwnedTracks();
    void writable.close().catch(() => undefined);
    throw error;
  };

  try {
    const container = localVideoContainerForMimeType(mimeType);
    if (!container || !filename.toLowerCase().endsWith(`.${container}`)) {
      throw new Error("录像文件后缀与请求的编码格式不一致");
    }
    recorder = createRecorder(stream, { mimeType });
    if (recorder.mimeType && localVideoContainerForMimeType(recorder.mimeType) !== container) {
      throw new Error("浏览器实际录像格式与文件后缀不一致");
    }
  } catch (error) {
    return closeAfterStartFailure(error);
  }

  const cleanup = () => {
    recorder.removeEventListener("dataavailable", handleDataAvailable);
    recorder.removeEventListener("error", handleRecorderError);
    recorder.removeEventListener("stop", handleStop);
    stopOwnedTracks();
  };

  const finalize = async () => {
    if (finalized) return;
    finalized = true;
    await writeChain;
    if (!writeError && bytes === 0) {
      writeError = new Error("录像未产生任何视频数据；文件已关闭，但不算有效录像");
    }
    const actualMimeType = recorder.mimeType || mimeType;
    if (!writeError && localVideoContainerForMimeType(actualMimeType) !== localVideoContainerForMimeType(mimeType)) {
      writeError = new Error("浏览器实际录像格式发生变化；文件不算完整录像");
    }
    let closeError: Error | null = null;
    try {
      await writable.close();
    } catch (error) {
      closeError = new Error(errorMessage(error));
    }
    cleanup();
    const failure = writeError ?? closeError;
    if (failure) {
      rejectDone(failure);
      return;
    }
    resolveDone({
      filename,
      bytes,
      mimeType: actualMimeType,
      startedAtEpochMs,
      finishedAtEpochMs: Date.now(),
    });
  };

  function requestStop() {
    if (stopRequested) return;
    stopRequested = true;
    if (recorder.state === "inactive") {
      void finalize();
      return;
    }
    try {
      recorder.stop();
    } catch (error) {
      writeError ??= new Error(errorMessage(error));
      void finalize();
    }
  }

  function handleDataAvailable(event: BlobEvent) {
    if (!event.data || event.data.size === 0) return;
    const chunk = event.data;
    writeChain = writeChain.then(async () => {
      if (writeError) return;
      try {
        if (chunk.type && localVideoContainerForMimeType(chunk.type) !== localVideoContainerForMimeType(mimeType)) {
          throw new Error("录像分块格式与文件后缀不一致");
        }
        await writable.write(chunk);
        bytes += chunk.size;
      } catch (error) {
        writeError = new Error(errorMessage(error));
        requestStop();
      }
    });
  }

  function handleRecorderError(event: Event) {
    const recorderError = (event as Event & { error?: DOMException }).error;
    writeError ??= new Error(recorderError?.message || "浏览器视频编码器异常");
    requestStop();
  }

  function handleStop() {
    if (!stopRequested) {
      writeError ??= new Error("视频源在 Session 结束前中断；断线前片段已关闭，但不算完整录像");
    }
    void finalize();
  }

  recorder.addEventListener("dataavailable", handleDataAvailable);
  recorder.addEventListener("error", handleRecorderError);
  recorder.addEventListener("stop", handleStop);

  try {
    recorder.start(timesliceMs);
  } catch (error) {
    cleanup();
    void writable.close().catch(() => undefined);
    throw error;
  }

  return {
    done,
    stop() {
      requestStop();
      return done;
    },
    fail(error) {
      writeError ??= error;
      requestStop();
      return done;
    },
  };
}
