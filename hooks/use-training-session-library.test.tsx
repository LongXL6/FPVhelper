import { useEffect } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTrainingSessionDraft,
  finishTrainingSession,
  normalizeSessionNotes,
  type TrainingSession,
} from "../lib/training-session";
import { EMPTY_TELEMETRY, type LinkState, type SubscribeTelemetrySamples, type TelemetrySampleListener } from "../lib/telemetry";
import * as storeModule from "../lib/training-session-store";
import { toTrainingSessionSummary } from "../lib/training-session-index";
import * as exportModule from "../lib/training-session-export";
import * as exportFeedbackModule from "./training-session-export-feedback";
import * as workstationModule from "../lib/workstation-id";
import { useTrainingSession, type TrainingSessionExportResult } from "./use-training-session";
import type { LocalVideoRecordingReceipt } from "../lib/local-video-recording";

const WORKSTATION_ID = "10000000-0000-4000-8000-000000000001";
let controller: ReturnType<typeof useTrainingSession>;
let renderer: ReactTestRenderer | null = null;
let records: Map<string, TrainingSession>;
let store: storeModule.TrainingSessionStore;
let saveSession: ReturnType<typeof vi.fn<(session: TrainingSession) => Promise<void>>>;
let sampleListener: TelemetrySampleListener | null;
let subscribeSamples: SubscribeTelemetrySamples;
let finishCompanionRecording: (() => Promise<LocalVideoRecordingReceipt | null>) | undefined;
let linkState: LinkState;

function makeSession(id: string, startedAtEpochMs: number) {
  const draft = createTrainingSessionDraft({
    id,
    workstationId: WORKSTATION_ID,
    build: "0.2.0+test",
    athleteCode: "PILOT-07",
    source: "serial",
    startedAtEpochMs,
    startedMonotonicMs: 1_000,
  });
  return {
    ...finishTrainingSession(draft, startedAtEpochMs + 60_000, 61_000),
    notes: `${id} 原备注`,
    exportedAt: new Date(startedAtEpochMs + 70_000).toISOString(),
    exportCount: 3,
  };
}

function Harness() {
  const nextController = useTrainingSession({
    telemetry: EMPTY_TELEMETRY,
    source: "serial",
    connection: "live",
    linkState,
    athleteCode: "PILOT-07",
    autoExport: false,
    inputKey: "pilot-channel-1",
    subscribeSamples,
    finishCompanionRecording,
  });
  useEffect(() => { controller = nextController; }, [nextController]);
  return null;
}

beforeEach(async () => {
  finishCompanionRecording = undefined;
  linkState = "ok";
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const browser = Object.assign(new EventTarget(), {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
  });
  vi.stubGlobal("window", browser);
  records = new Map([
    ["older", makeSession("older", 1_700_000_000_000)],
    ["newer", makeSession("newer", 1_700_000_100_000)],
  ]);
  saveSession = vi.fn(async (session) => { records.set(session.id, session); });
  store = {
    getActiveDraft: vi.fn(async () => null),
    saveDraft: vi.fn(async (draft) => {
      if (records.has(draft.id)) throw new Error("训练记录已经结束，不能写回过期草稿");
    }),
    deleteDraft: vi.fn(async () => undefined),
    listSessions: vi.fn(async () => [...records.values()].sort((left, right) => right.startedAt.localeCompare(left.startedAt))),
    listSessionSummaries: vi.fn(async () => [...records.values()].sort((left, right) => right.startedAt.localeCompare(left.startedAt)).map(toTrainingSessionSummary)),
    getSession: vi.fn(async (id) => records.get(id) ?? null),
    countSessions: vi.fn(async () => records.size),
    countUnexportedValidSessions: vi.fn(async () => 0),
    getStorageIntegrity: vi.fn(async () => ({ readableDraftCount: 0, readableSessionCount: records.size, quarantinedDraftCount: 0, quarantinedSessionCount: 0 })),
    saveSession,
    completeSession: vi.fn(async (session) => { records.set(session.id, session); }),
    close: vi.fn(async () => undefined),
  };
  vi.spyOn(storeModule, "createTrainingSessionStore").mockReturnValue(store);
  vi.spyOn(exportModule, "getBrowserTrainingSessionSaveFilePicker").mockReturnValue(null);
  vi.spyOn(workstationModule, "getOrCreateBrowserWorkstationId").mockReturnValue(WORKSTATION_ID);
  sampleListener = null;
  subscribeSamples = (listener) => {
    sampleListener = listener;
    return () => { if (sampleListener === listener) sampleListener = null; };
  };
  await act(async () => { renderer = create(<Harness />); });
});

afterEach(async () => {
  await act(async () => { renderer?.unmount(); });
  renderer = null;
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("training library session actions", () => {
  it("keeps migration-limited history exportable while new recording stays disabled", async () => {
    await act(async () => renderer!.unmount());
    vi.mocked(store.getStorageIntegrity).mockResolvedValue({
      readableDraftCount: 0, readableSessionCount: records.size, quarantinedDraftCount: 0, quarantinedSessionCount: 0,
      migrationWarning: "存储升级空间不足，暂以只读方式打开旧记录。",
    });
    saveSession.mockRejectedValue(new DOMException("quota", "QuotaExceededError"));
    const write = vi.fn(async (_blob: Blob) => { void _blob; });
    const close = vi.fn(async () => undefined);
    vi.mocked(exportModule.getBrowserTrainingSessionSaveFilePicker).mockReturnValue(async () => ({ createWritable: async () => ({ write, close }) }));
    await act(async () => { renderer = create(<Harness />); });
    expect(controller.storageReady).toBe(true);
    expect(controller.storageIntegrity.migrationWarning).toContain("只读");
    expect(controller.allSessions).toHaveLength(2);
    expect(controller.canStart).toBe(false);
    let result: TrainingSessionExportResult | undefined;
    await act(async () => { result = await controller.exportSession("older"); });
    expect(close).toHaveBeenCalledOnce();
    expect(JSON.parse(await write.mock.calls[0][0].text())).toMatchObject({ id: "older" });
    expect(result).toMatchObject({ status: "confirmed", localStateSaved: false });
    expect(records.get("older")!.exportCount).toBe(3);
    expect(controller.allSessions).toHaveLength(2);
  });

  it("loads lightweight history and opens the picker before reading the selected full record", async () => {
    expect(store.listSessions).not.toHaveBeenCalled();
    expect(controller.allSessions[0]).not.toHaveProperty("samples");
    const order: string[] = [];
    vi.mocked(store.getSession).mockImplementation(async (id) => { order.push("read"); return records.get(id) ?? null; });
    vi.mocked(exportModule.getBrowserTrainingSessionSaveFilePicker).mockReturnValue(async () => {
      order.push("picker");
      throw new DOMException("cancelled", "AbortError");
    });
    await act(async () => { await controller.exportSession("older"); });
    expect(order).toEqual(["picker", "read"]);
  });

  it("freezes RC immediately and waits for video close before completing the matching session", async () => {
    let closeVideo!: (receipt: LocalVideoRecordingReceipt) => void;
    finishCompanionRecording = vi.fn(() => new Promise<LocalVideoRecordingReceipt>((resolve) => { closeVideo = resolve; }));
    await act(async () => renderer!.update(<Harness />));
    vi.spyOn(performance, "now").mockReturnValue(1_000);
    let sessionId: string | null = null;
    await act(async () => { sessionId = await controller.startRecording(); });
    act(() => sampleListener?.({ ...EMPTY_TELEMETRY, sequence: 1, monotonicTimestampMs: 1_010 }, "serial"));
    vi.mocked(performance.now).mockReturnValue(2_000);
    let stopped!: Promise<void>;
    await act(async () => { stopped = controller.stopRecording(); });
    expect(controller.isRecording).toBe(false);
    expect(controller.isFinishing).toBe(true);
    expect(controller.hasPendingSave).toBe(true);
    const closingDuringVideo = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(closingDuringVideo);
    expect(closingDuringVideo.defaultPrevented).toBe(true);
    expect(store.completeSession).not.toHaveBeenCalled();
    act(() => sampleListener?.({ ...EMPTY_TELEMETRY, sequence: 2, monotonicTimestampMs: 2_010 }, "serial"));
    expect(controller.sampleCount).toBe(1);
    await act(async () => {
      closeVideo({ filename: "recording.webm", mimeType: "video/webm", bytes: 300, startedAtEpochMs: Date.now() - 1000, finishedAtEpochMs: Date.now() });
      await stopped;
    });
    expect(records.get(sessionId!)?.video).toMatchObject({ recorded: true, synchronized: false, overlay: "sticks", filename: "recording.webm" });
    expect(controller.isFinishing).toBe(false);
    expect(controller.hasPendingSave).toBe(false);
    const closingAfterSave = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(closingAfterSave);
    expect(closingAfterSave.defaultPrevented).toBe(false);
  });

  it("coalesces slow one-second checkpoints and reports only confirmed samples", async () => {
    vi.useFakeTimers();
    Object.assign(window, { setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval });
    vi.spyOn(performance, "now").mockReturnValue(1_000);
    await act(async () => { await controller.startRecording(); });
    act(() => sampleListener?.({ ...EMPTY_TELEMETRY, sequence: 1, monotonicTimestampMs: 1_010 }, "serial"));
    let flush!: () => void;
    vi.mocked(store.saveDraft).mockImplementationOnce(() => new Promise((resolve) => { flush = resolve; }));
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(store.saveDraft).toHaveBeenCalledTimes(2);
    act(() => sampleListener?.({ ...EMPTY_TELEMETRY, sequence: 2, monotonicTimestampMs: 1_020 }, "serial"));
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(store.saveDraft).toHaveBeenCalledTimes(2);
    expect(controller.persistedSampleCount).toBe(0);
    await act(async () => { flush(); });
    expect(controller.persistedSampleCount).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(controller.persistedSampleCount).toBe(2);
  });

  it("retries a failed history refresh after completion without writing its closed draft again", async () => {
    vi.spyOn(performance, "now").mockReturnValue(1_000);
    let id: string | null = null;
    await act(async () => { id = await controller.startRecording(); });
    act(() => sampleListener?.({ ...EMPTY_TELEMETRY, sequence: 1, monotonicTimestampMs: 1_010 }, "serial"));
    vi.mocked(performance.now).mockReturnValue(2_000);
    vi.mocked(store.listSessionSummaries).mockRejectedValueOnce(new Error("history read failed"));
    await act(async () => controller.stopRecording());
    expect(records.get(id!)?.sampleCount).toBe(1);
    expect(controller.hasPendingSave).toBe(true);
    expect(controller.storageError).toContain("已写入本机");
    expect(controller.persistedSampleCount).toBe(1);
    const writesBeforeRetry = vi.mocked(store.saveDraft).mock.calls.length;
    await act(async () => controller.retryPendingSave());
    expect(store.saveDraft).toHaveBeenCalledTimes(writesBeforeRetry);
    expect(store.completeSession).toHaveBeenCalledOnce();
    expect(controller.hasPendingSave).toBe(false);
    expect(controller.storageError).toBeNull();
    expect(controller.canStart).toBe(true);
    expect(controller.lastSession?.id).toBe(id);
  });

  it("retries a stronger termination after completion and preserves the confirmed video receipt", async () => {
    const receipt: LocalVideoRecordingReceipt = {
      filename: "retained-recording.webm", mimeType: "video/webm", bytes: 700,
      startedAtEpochMs: Date.now() - 1000, finishedAtEpochMs: Date.now(),
    };
    finishCompanionRecording = vi.fn(async () => receipt);
    await act(async () => renderer!.update(<Harness />));
    vi.spyOn(performance, "now").mockReturnValue(1_000);
    let id: string | null = null;
    await act(async () => { id = await controller.startRecording(); });
    act(() => sampleListener?.({ ...EMPTY_TELEMETRY, sequence: 1, monotonicTimestampMs: 1_010 }, "serial"));
    vi.mocked(performance.now).mockReturnValue(2_000);
    vi.mocked(store.listSessionSummaries).mockRejectedValueOnce(new Error("history read failed"));
    await act(async () => controller.stopRecording());
    expect(records.get(id!)?.video).toMatchObject({ recorded: true, filename: receipt.filename, bytes: receipt.bytes });
    const writesBeforeRetry = vi.mocked(store.saveDraft).mock.calls.length;
    vi.mocked(store.completeSession).mockRejectedValueOnce(new Error("termination write failed"));
    linkState = "lost";
    await act(async () => renderer!.update(<Harness />));
    expect(controller.lastSession?.interruptionReason).toBe("rx_link_lost");
    expect(controller.hasPendingSave).toBe(true);
    expect(records.get(id!)?.interruptionReason).toBeNull();
    await act(async () => controller.retryPendingSave());
    expect(store.saveDraft).toHaveBeenCalledTimes(writesBeforeRetry);
    expect(store.completeSession).toHaveBeenCalledTimes(3);
    expect(records.get(id!)).toMatchObject({
      interrupted: true, interruptionReason: "rx_link_lost", sampleCount: 1,
      video: { recorded: true, synchronized: false, filename: receipt.filename, bytes: receipt.bytes, overlay: "sticks" },
    });
    expect(finishCompanionRecording).toHaveBeenCalledOnce();
    expect(controller.hasPendingSave).toBe(false);
    expect(controller.storageError).toBeNull();
  });

  it("ignores a stale marker callback and pagehide after stop before React commits", async () => {
    let finishVideo!: () => void;
    finishCompanionRecording = vi.fn(() => new Promise<null>((resolve) => { finishVideo = () => resolve(null); }));
    await act(async () => renderer!.update(<Harness />));
    vi.spyOn(performance, "now").mockReturnValue(1_000);
    await act(async () => { await controller.startRecording(); });
    const staleAddMarker = controller.addMarker;
    let stopping!: Promise<void>;
    await act(async () => {
      stopping = controller.stopRecording();
      await staleAddMarker("crash");
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(store.saveDraft).toHaveBeenCalledOnce();
    expect(controller.markerCount).toBe(0);
    expect(controller.lastSession?.markers).toEqual([]);
    expect(store.completeSession).not.toHaveBeenCalled();
    await act(async () => { finishVideo(); await stopping; });
    expect(store.saveDraft).toHaveBeenCalledTimes(2);
    expect(controller.lastSession?.markers).toEqual([]);
    expect(controller.storageError).toBeNull();
  });

  it("edits an older record with shared note normalization and preserves its full metadata", async () => {
    const before = records.get("older")!;
    const notes = `  第一行\r\n${"复".repeat(2_100)}  `;

    await act(async () => controller.updateSessionNotes("older", notes));

    expect(records.get("older")).toEqual({ ...before, notes: normalizeSessionNotes(notes) });
    expect(records.get("older")!.notes).toHaveLength(2_000);
    expect(records.get("newer")!.notes).toBe("newer 原备注");
    expect(controller.lastSession?.id).toBe("newer");
  });

  it("rejects a note save failure and allows the same draft to be retried", async () => {
    saveSession.mockRejectedValueOnce(new Error("disk full"));
    await act(async () => {
      await expect(controller.updateSessionNotes("older", "尚未保存的备注")).rejects.toThrow("disk full");
    });
    expect(records.get("older")!.notes).toBe("older 原备注");
    expect(controller.storageError).toContain("训练备注尚未保存");

    await act(async () => controller.updateSessionNotes("older", "尚未保存的备注"));
    expect(records.get("older")!.notes).toBe("尚未保存的备注");
    expect(controller.storageError).toBeNull();
  });

  it("keeps the legacy latest-note action targeted to the latest record", async () => {
    await act(async () => controller.updateLastSessionNotes("兼容旧入口"));
    expect(records.get("newer")!.notes).toBe("兼容旧入口");
    expect(records.get("older")!.notes).toBe("older 原备注");
  });

  it("includes unsaved notes in a fallback download without marking its file as confirmed", async () => {
    const requestDownload = vi.spyOn(exportFeedbackModule, "requestUnconfirmedTrainingSessionDownload").mockReturnValue({ notice: "已请求下载但未确认落盘", warning: null });
    let result: TrainingSessionExportResult | undefined;
    await act(async () => { result = await controller.exportSession("older", "  导出草稿  "); });

    expect(requestDownload).toHaveBeenCalledWith(expect.objectContaining({ id: "older", notes: "导出草稿", exportCount: 3 }));
    expect(result?.status).toBe("requested");
    expect(saveSession).not.toHaveBeenCalled();
    expect(controller.lastExport).toBeNull();
    expect(records.get("older")!.notes).toBe("older 原备注");
  });

  it("confirms the file and saves overridden notes only after its writable closes", async () => {
    let finishClose!: () => void;
    const close = new Promise<void>((resolve) => { finishClose = resolve; });
    let filePayload: TrainingSession | null = null;
    const write = vi.fn(async (blob: Blob) => { filePayload = JSON.parse(await blob.text()) as TrainingSession; });
    vi.mocked(exportModule.getBrowserTrainingSessionSaveFilePicker).mockReturnValue(async () => ({ createWritable: async () => ({ write, close: () => close }) }));
    let pending!: Promise<TrainingSessionExportResult>;
    await act(async () => { pending = controller.exportSession("older", "文件与备注一起保存"); });
    expect(write).toHaveBeenCalledOnce();
    expect(saveSession).not.toHaveBeenCalled();
    expect(controller.lastExport).toBeNull();

    let result: TrainingSessionExportResult | undefined;
    await act(async () => { finishClose(); result = await pending; });
    expect(filePayload).toMatchObject({ id: "older", notes: "文件与备注一起保存", exportCount: 4, workstationId: WORKSTATION_ID });
    expect(records.get("older")).toMatchObject({ notes: "文件与备注一起保存", exportCount: 4 });
    expect(result).toMatchObject({ status: "confirmed", localStateSaved: true });
  });

  it("does not confirm an export when file close fails", async () => {
    vi.mocked(exportModule.getBrowserTrainingSessionSaveFilePicker).mockReturnValue(async () => ({ createWritable: async () => ({ write: async () => undefined, close: async () => { throw new Error("close failed"); } }) }));
    let result: TrainingSessionExportResult | undefined;
    await act(async () => { result = await controller.exportSession("older", "仍需保留的草稿"); });
    expect(result?.status).toBe("failed");
    expect(controller.lastExport).toBeNull();
    expect(saveSession).not.toHaveBeenCalled();
    expect(records.get("older")!.exportCount).toBe(3);
  });

  it("prevents concurrent note edits or duplicate exports from overwriting an in-flight export", async () => {
    let finishClose!: () => void;
    const close = new Promise<void>((resolve) => { finishClose = resolve; });
    const picker = vi.fn(async () => ({ createWritable: async () => ({ write: async () => undefined, close: () => close }) }));
    vi.mocked(exportModule.getBrowserTrainingSessionSaveFilePicker).mockReturnValue(picker);
    let pending!: Promise<TrainingSessionExportResult>;
    await act(async () => { pending = controller.exportSession("older", "文件备注"); });
    await act(async () => {
      await expect(controller.updateSessionNotes("older", "覆盖备注")).rejects.toThrow("正在保存或导出");
      expect(await controller.exportSession("older")).toMatchObject({ status: "failed" });
    });
    expect(picker).toHaveBeenCalledOnce();
    await act(async () => { finishClose(); await pending; });
    expect(records.get("older")).toMatchObject({ notes: "文件备注", exportCount: 4 });
    await act(async () => controller.updateSessionNotes("older", "保存完成后可编辑"));
    expect(records.get("older")).toMatchObject({ notes: "保存完成后可编辑", exportCount: 4 });
  });

  it("blocks an export while notes are being saved without opening a stale file picker", async () => {
    let finishSave!: () => void;
    const saved = new Promise<void>((resolve) => { finishSave = resolve; });
    saveSession.mockImplementationOnce(async (session) => { await saved; records.set(session.id, session); });
    const picker = vi.fn(async () => ({ createWritable: async () => ({ write: async () => undefined, close: async () => undefined }) }));
    vi.mocked(exportModule.getBrowserTrainingSessionSaveFilePicker).mockReturnValue(picker);
    let pending!: Promise<void>;
    await act(async () => { pending = controller.updateSessionNotes("older", "正在写入的备注"); });
    await act(async () => { expect(await controller.exportSession("older")).toMatchObject({ status: "failed" }); });
    expect(picker).not.toHaveBeenCalled();
    await act(async () => { finishSave(); await pending; });
    expect(records.get("older")?.notes).toBe("正在写入的备注");
  });

  it("reports a cancelled picker without claiming that a download was requested", async () => {
    vi.mocked(exportModule.getBrowserTrainingSessionSaveFilePicker).mockReturnValue(async () => { throw new DOMException("cancelled", "AbortError"); });
    let result: TrainingSessionExportResult | undefined;
    await act(async () => { result = await controller.exportSession("older"); });
    expect(result?.status).toBe("cancelled");
    expect(controller.exportNotice).toBeNull();
    expect(saveSession).not.toHaveBeenCalled();
  });

  it("separates a confirmed file from a failed local metadata write", async () => {
    vi.mocked(exportModule.getBrowserTrainingSessionSaveFilePicker).mockReturnValue(async () => ({ createWritable: async () => ({ write: async () => undefined, close: async () => undefined }) }));
    saveSession.mockRejectedValueOnce(new Error("metadata write failed"));
    let result: TrainingSessionExportResult | undefined;
    await act(async () => { result = await controller.exportSession("older", "文件里已有备注"); });

    expect(result).toMatchObject({ status: "confirmed", localStateSaved: false });
    expect(controller.lastExport?.session.notes).toBe("文件里已有备注");
    expect(records.get("older")!.notes).toBe("older 原备注");
    expect(controller.exportWarning).toContain("导出状态未写入 IndexedDB");
  });

  it("records every subscribed RC frame even when React batches 100 frames into one render", async () => {
    vi.spyOn(performance, "now").mockReturnValue(1_000);
    await act(async () => { await controller.startRecording(); });
    expect(controller.isRecording).toBe(true);

    act(() => {
      for (let sequence = 1; sequence <= 100; sequence += 1) {
        sampleListener?.({ ...EMPTY_TELEMETRY, sequence, monotonicTimestampMs: 1_000 + sequence * 10 }, "serial");
      }
    });
    expect(controller.sampleCount).toBe(100);
    expect(controller.uniqueSampleCount).toBe(100);

    vi.mocked(performance.now).mockReturnValue(2_000);
    await act(async () => controller.stopRecording());
    expect(controller.lastSession?.samples.map((sample) => sample.sequence)).toEqual(Array.from({ length: 100 }, (_, index) => index + 1));
    expect(controller.lastSession?.estimatedRcSampleRateHz).toBe(100);
  });

  it("accepts frames immediately after starting resolves before React commits the recording state", async () => {
    vi.spyOn(performance, "now").mockReturnValue(1_000);
    await act(async () => {
      expect(await controller.startRecording()).toBeTruthy();
      for (let sequence = 1; sequence <= 100; sequence += 1) {
        sampleListener?.({ ...EMPTY_TELEMETRY, sequence, monotonicTimestampMs: 1_000 + sequence * 10 }, "serial");
      }
    });
    expect(controller.sampleCount).toBe(100);
    expect(controller.uniqueSampleCount).toBe(100);
  });

  it("counts unique sequences incrementally and starts the next record with an empty set", async () => {
    vi.spyOn(performance, "now").mockReturnValue(1_000);
    await act(async () => { await controller.startRecording(); });
    act(() => {
      for (const [index, sequence] of [1, 1, 2, 1].entries()) {
        sampleListener?.({ ...EMPTY_TELEMETRY, sequence, monotonicTimestampMs: 1_010 + index * 10 }, "serial");
      }
    });
    expect(controller.sampleCount).toBe(3);
    expect(controller.uniqueSampleCount).toBe(2);

    vi.mocked(performance.now).mockReturnValue(2_000);
    await act(async () => controller.stopRecording());
    await act(async () => {
      await controller.startRecording();
      sampleListener?.({ ...EMPTY_TELEMETRY, sequence: 1, monotonicTimestampMs: 2_010 }, "serial");
    });
    expect(controller.sampleCount).toBe(1);
    expect(controller.uniqueSampleCount).toBe(1);
  });
});
