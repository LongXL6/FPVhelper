import { useEffect } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLiveVision } from "../hooks/use-live-vision";
import type { LiveVisionController, LiveVisionOptions } from "../lib/live-vision-types";
import type { LiveVisionDiagnostics } from "../lib/live-vision-diagnostics";
import { createVisionCandidateTracker } from "../lib/vision-timing";
import { LiveGatePanel } from "./live-gate-panel";
import type { LiveGateSummaryData } from "./live-gate-summary";

vi.mock("../hooks/use-live-vision", () => ({ useLiveVision: vi.fn() }));

let renderer: ReactTestRenderer | null = null;
let live: LiveVisionController;
const mounted = vi.fn();
const unmounted = vi.fn();
const onProfileChange = vi.fn();
const initialOptions: LiveVisionOptions = {
  stream: null, sourceId: "source-1", pilotChannelId: "pilot-1", pilotName: "PILOT-A",
  crop: { x: 0, y: 0, width: 1, height: 1 }, profileId: null, trainingSessionId: null,
};
function diagnosticsFixture(): LiveVisionDiagnostics {
  const tracker = createVisionCandidateTracker({ sampleFps: 30, maxObservationGapMs: 1500, exitDelayMs: 150, idFactory: () => "candidate" });
  tracker.push(1000, []);
  return {
    runId: "run", backend: "wasm", fallbackReason: "测试设备不支持 WebGPU", targetFps: 30, threshold: 0.65,
    inputFps: 29.8, analysisFps: 3.2, inferenceP50Ms: 278, inferenceP95Ms: 310,
    counters: { presented: 80, analyzed: 8, busy: 64, throttled: 8, duplicate: 0, unreported: 0 },
    lastSample: { timeMs: 1000, captureMs: 1, roundTripMs: 280, inferenceMs: 278, preprocessMs: 2, modelMs: 270, matchingMs: 6,
      bestMatch: { box: { x: 0.2, y: 0.2, width: 0.3, height: 0.3 }, similarity: 0.43 }, acceptedMatches: 0, tracker: tracker.getDiagnostics() },
  };
}

function textOf(instance: ReactTestInstance): string {
  return instance.children.map((child) => typeof child === "string" ? child : textOf(child)).join("");
}

function button(label: string) {
  return renderer!.root.findAllByType("button").find((node) => textOf(node) === label)!;
}

function metric(label: string) {
  return textOf(renderer!.root.findAllByType("dt").find((node) => textOf(node) === label)!.parent!.findByType("dd"));
}

function reviewInput(label: string) {
  const editor = renderer!.root.findByProps({ "aria-label": "实时穿越复核" });
  return editor.findAllByType("label").find((node) => textOf(node).includes(label))!.findByType("input");
}

async function renderPanel(options: LiveVisionOptions = initialOptions, onSummaryChange?: (summary: LiveGateSummaryData) => void) {
  await act(async () => {
    const element = <LiveGatePanel {...options} onProfileChange={onProfileChange} onSummaryChange={onSummaryChange} />;
    if (renderer) renderer.update(element);
    else renderer = create(element);
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  live = {
    state: "idle", isActive: false, canStart: true, hasUnsavedChanges: false, backupAwaitingConfirmation: false, elapsedMs: 0,
    progress: { analyzedFrames: 0, inferenceMs: null, message: "等待开始" },
    diagnostics: null, attachDiagnosticCanvas: vi.fn(), exportDiagnostics: vi.fn(async () => undefined),
    error: null, notice: null, profile: null, profiles: [], run: null, events: [], laps: [], savedRuns: [],
    start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined),
    getCurrentTimeMs: vi.fn(() => 0),
    reviewEvent: vi.fn(async () => undefined), addEvent: vi.fn(async () => undefined),
    refreshProfiles: vi.fn(async () => undefined), saveReference: vi.fn(async () => "profile-new"),
    captureReference: vi.fn(async () => new Blob()), importProfile: vi.fn(async () => "profile-imported"),
    saveRun: vi.fn(async () => undefined), loadRun: vi.fn(async () => undefined),
    exportRun: vi.fn(async () => undefined), importRun: vi.fn(async () => undefined), acknowledgeBackup: vi.fn(),
  };
  vi.mocked(useLiveVision).mockImplementation(function useMockLiveVision() {
    useEffect(() => { mounted(); return () => { unmounted(); }; }, []);
    return live;
  });
});

afterEach(async () => {
  await act(async () => { renderer?.unmount(); });
  renderer = null;
  vi.unstubAllGlobals();
});

describe("live gate panel interaction boundaries", () => {
  it("changes only the requested analysis ceiling before a run and locks it during monitoring", async () => {
    await renderPanel();
    expect(vi.mocked(useLiveVision).mock.calls.at(-1)?.[0].sampleFps).toBe(30);
    const selector = () => renderer!.root.findByProps({ "aria-label": "实时分析上限" });
    await act(async () => { selector().props.onChange({ target: { value: "15" } }); });
    expect(vi.mocked(useLiveVision).mock.calls.at(-1)?.[0].sampleFps).toBe(15);
    live = { ...live, state: "monitoring", isActive: true };
    await renderPanel({ ...initialOptions, crop: { ...initialOptions.crop } });
    expect(selector().props.disabled).toBe(true);
    await act(async () => { selector().props.onChange({ target: { value: "30" } }); });
    expect(vi.mocked(useLiveVision).mock.calls.at(-1)?.[0].sampleFps).toBe(15);
  });

  it("shows actual throughput, a below-threshold score and the analyzer canvas independently of the target", async () => {
    live = { ...live, diagnostics: diagnosticsFixture(), state: "monitoring", isActive: true };
    await renderPanel();
    expect(textOf(renderer!.root.findByProps({ "data-testid": "live-input-fps" }))).toBe("29.8");
    expect(textOf(renderer!.root.findByProps({ "data-testid": "live-analysis-fps" }))).toBe("3.2");
    expect(textOf(renderer!.root.findByProps({ "data-testid": "live-best-similarity" }))).toBe("0.430");
    expect(textOf(renderer!.root.findByProps({ "data-testid": "live-matching-status" }))).toContain("低于阈值");
    const canvas = {} as HTMLCanvasElement;
    renderer!.root.findByProps({ "aria-label": "最近分析画面" }).props.ref(canvas);
    expect(live.attachDiagnosticCanvas).toHaveBeenLastCalledWith(canvas);
    expect(textOf(renderer!.root)).toContain("后端回退：测试设备不支持 WebGPU");
    expect(textOf(renderer!.root)).not.toContain("43%");
    await act(async () => { button("导出本机诊断 JSON").props.onClick(); });
    expect(live.exportDiagnostics).toHaveBeenCalledOnce();
    expect(live.stop).not.toHaveBeenCalled();
  });

  it("explains an insufficient track instead of equating zero crossings with zero matching", async () => {
    const tracker = createVisionCandidateTracker({ sampleFps: 30, maxObservationGapMs: 1500, exitDelayMs: 150, idFactory: () => "candidate" });
    tracker.push(0, [{ box: { x: 0, y: 0, width: 0.2, height: 0.2 }, similarity: 0.8 }]);
    tracker.push(278, [{ box: { x: 0, y: 0, width: 0.4, height: 0.4 }, similarity: 0.8 }]);
    tracker.push(556, []);
    const diagnostics = diagnosticsFixture();
    diagnostics.lastSample = { ...diagnostics.lastSample!, timeMs: 556, tracker: tracker.getDiagnostics() };
    live = { ...live, diagnostics };
    await renderPanel();
    expect(textOf(renderer!.root.findByProps({ "data-testid": "live-matching-status" }))).toContain("匹配帧数不足");
    expect(metric("匹配 / 分析帧")).toBe("2 / 3");
    expect(metric("待确认穿越")).toBe("0");
  });

  it("leaves unavailable diagnostics blank and does not enable an empty export", async () => {
    await renderPanel();
    expect(textOf(renderer!.root.findByProps({ "data-testid": "live-analysis-fps" }))).toBe("—");
    expect(textOf(renderer!.root.findByProps({ "data-testid": "live-best-similarity" }))).toBe("—");
    expect(button("导出本机诊断 JSON").props.disabled).toBe(true);
  });

  it("can cancel model preparation while the start promise is still pending", async () => {
    let finishStart!: () => void;
    const pendingStart = new Promise<void>((resolve) => { finishStart = resolve; });
    vi.mocked(live.start).mockImplementation(() => pendingStart);
    await renderPanel();
    await act(async () => { button("开始过门计时").props.onClick(); });
    expect(live.start).toHaveBeenCalledOnce();
    live = { ...live, state: "loading", isActive: true, canStart: false };
    await renderPanel({ ...initialOptions, crop: { ...initialOptions.crop } });
    expect(button("取消准备").props.disabled).toBe(false);
    await act(async () => { button("取消准备").props.onClick(); });
    expect(live.stop).toHaveBeenCalledOnce();
    await act(async () => { finishStart(); await pendingStart; });
  });

  it("requires a manual reason and records the actual click-time getter rather than the displayed timer", async () => {
    live = { ...live, state: "monitoring", isActive: true, canStart: false, elapsedMs: 1000 };
    vi.mocked(live.getCurrentTimeMs).mockReturnValue(1487.625);
    await renderPanel();
    const label = renderer!.root.findAllByType("label").find((node) => textOf(node).includes("现场人工确认理由"))!;
    expect(button("人工确认一次穿越").props.disabled).toBe(true);
    await act(async () => { label.findByType("input").props.onChange({ target: { value: "   " } }); });
    expect(button("人工确认一次穿越").props.disabled).toBe(true);
    expect(live.addEvent).not.toHaveBeenCalled();
    expect(live.getCurrentTimeMs).not.toHaveBeenCalled();
    await act(async () => { label.findByType("input").props.onChange({ target: { value: "  现场确认正向穿越  " } }); });
    expect(button("人工确认一次穿越").props.disabled).toBe(false);
    await act(async () => { button("人工确认一次穿越").props.onClick(); });
    expect(live.getCurrentTimeMs).toHaveBeenCalledOnce();
    expect(live.addEvent).toHaveBeenCalledExactlyOnceWith(1487.625, "现场确认正向穿越");
  });

  it("keeps pending model events and incomplete laps out of reviewed timing metrics", async () => {
    live = {
      ...live, state: "monitoring", isActive: true, canStart: false, elapsedMs: 5000,
      events: [1000, 4000].map((timeMs, index) => ({
        id: `candidate-${index}`, timeMs, startMs: timeMs - 100, endMs: timeMs + 100,
        status: "pending", origin: "model", similarity: 0.8, reason: "模型相似目标，待人工确认",
      })),
      laps: [{ id: "incomplete-lap", number: 1, startMs: 1000, endMs: 4000, durationMs: 3000, status: "incomplete", reason: "存在待复核事件" }],
    };
    await renderPanel();
    expect(metric("已复核圈数")).toBe("0");
    expect(metric("最快已复核")).toBe("—");
    expect(metric("上一已复核圈")).toBe("—");
    expect(metric("待确认穿越")).toBe("2");
    expect(textOf(renderer!.root.findByProps({ "data-testid": "live-gate-lap-clock" }))).toBe("—");
    expect(button("确认穿越").props.disabled).toBe(true);
    expect(live.reviewEvent).not.toHaveBeenCalled();
  });

  it.each([342.5, 1000.5])("preserves untouched half-millisecond event %s when confirming or rejecting", async (timeMs) => {
    live = { ...live, state: "stopped", elapsedMs: 5000, events: [{
      id: "candidate", timeMs, startMs: timeMs - 100, endMs: timeMs + 100,
      status: "pending", origin: "model", similarity: 0.8, reason: "模型候选",
    }] };
    await renderPanel();
    expect(reviewInput("穿越时刻").props.value).toBe((timeMs / 1000).toFixed(3));
    expect(button("确认穿越").props.disabled).toBe(true);
    await act(async () => { reviewInput("复核理由").props.onChange({ target: { value: "  人工查看原录像  " } }); });
    expect(button("改时刻并确认").props.disabled).toBe(true);
    for (const [label, action] of [["确认穿越", "confirm"], ["排除候选", "reject"]] as const) {
      expect(button(label).props.disabled).toBe(false);
      await act(async () => { button(label).props.onClick(); });
      expect(live.reviewEvent).toHaveBeenLastCalledWith("candidate", action, timeMs, "人工查看原录像");
    }
  });

  it("validates actual time edits and restores the original event when its displayed value is restored", async () => {
    live = { ...live, state: "stopped", elapsedMs: 5000, events: [{
      id: "candidate", timeMs: 1000.5, startMs: 900, endMs: 1100,
      status: "pending", origin: "model", similarity: 0.8, reason: "模型候选",
    }] };
    await renderPanel();
    await act(async () => { reviewInput("复核理由").props.onChange({ target: { value: "校准穿越时刻" } }); });
    await act(async () => { reviewInput("穿越时刻").props.onChange({ target: { value: "1.250" } }); });
    expect(button("确认穿越").props.disabled).toBe(true);
    expect(button("排除候选").props.disabled).toBe(true);
    expect(button("改时刻并确认").props.disabled).toBe(false);
    await act(async () => { button("改时刻并确认").props.onClick(); });
    expect(live.reviewEvent).toHaveBeenLastCalledWith("candidate", "adjust", 1250, "校准穿越时刻");
    for (const value of ["", "-1", "6", "NaN"]) {
      await act(async () => { reviewInput("穿越时刻").props.onChange({ target: { value } }); });
      for (const label of ["确认穿越", "排除候选", "改时刻并确认"]) expect(button(label).props.disabled).toBe(true);
    }
    await act(async () => { reviewInput("穿越时刻").props.onChange({ target: { value: "1.0000" } }); });
    expect(button("改时刻并确认").props.disabled).toBe(true);
    expect(button("确认穿越").props.disabled).toBe(false);
    await act(async () => { button("确认穿越").props.onClick(); });
    expect(live.reviewEvent).toHaveBeenLastCalledWith("candidate", "confirm", 1000.5, "校准穿越时刻");
    await act(async () => { reviewInput("复核理由").props.onChange({ target: { value: "  " } }); });
    expect(button("确认穿越").props.disabled).toBe(true);
    expect(button("排除候选").props.disabled).toBe(true);
  });

  it("keeps an untouched final event valid when its displayed milliseconds round past the run end", async () => {
    live = { ...live, state: "stopped", elapsedMs: 342.5, events: [{
      id: "final-candidate", timeMs: 342.5, startMs: 200, endMs: 342.5,
      status: "pending", origin: "model", similarity: 0.8, reason: "模型候选",
    }] };
    await renderPanel();
    expect(reviewInput("穿越时刻").props.value).toBe("0.343");
    await act(async () => { reviewInput("复核理由").props.onChange({ target: { value: "复核最后一帧" } }); });
    expect(button("确认穿越").props.disabled).toBe(false);
    await act(async () => { button("确认穿越").props.onClick(); });
    expect(live.reviewEvent).toHaveBeenLastCalledWith("final-candidate", "confirm", 342.5, "复核最后一帧");
  });

  it("passes a changed source and pilot to the same mounted engine hook", async () => {
    await renderPanel();
    expect(mounted).toHaveBeenCalledOnce();
    const next = { ...initialOptions, sourceId: "source-2", pilotChannelId: "pilot-2", pilotName: "PILOT-B", crop: { x: 0.5, y: 0, width: 0.5, height: 0.5 } };
    await renderPanel(next);
    expect(vi.mocked(useLiveVision).mock.calls.at(-1)?.[0]).toMatchObject(next);
    expect(mounted).toHaveBeenCalledOnce();
    expect(unmounted).not.toHaveBeenCalled();
    await act(async () => { renderer?.unmount(); });
    renderer = null;
    expect(unmounted).toHaveBeenCalledOnce();
  });

  it("requires an explicit confirmation before treating a requested JSON download as a backup", async () => {
    live = { ...live, state: "stopped", hasUnsavedChanges: true, backupAwaitingConfirmation: true, canStart: false };
    await renderPanel();
    expect(button("开始过门计时").props.disabled).toBe(true);
    expect(live.acknowledgeBackup).not.toHaveBeenCalled();
    await act(async () => { button("我已确认 JSON 下载完成，允许切换记录").props.onClick(); });
    expect(live.acknowledgeBackup).toHaveBeenCalledOnce();
  });

  it("updates the video summary only when its displayed timing or results change", async () => {
    const publishSummary = vi.fn();
    live = { ...live, state: "monitoring", isActive: true, elapsedMs: 1000, events: [{
      id: "manual-start", timeMs: 200, startMs: 200, endMs: 200,
      status: "confirmed", origin: "manual", similarity: null, reason: "现场确认",
    }] };
    await renderPanel(initialOptions, publishSummary);
    expect(publishSummary).toHaveBeenCalledOnce();
    expect(publishSummary.mock.calls[0][0]).toMatchObject({ state: "monitoring", lapElapsedMs: 800, pendingCount: 0 });
    live = { ...live, progress: { ...live.progress, analyzedFrames: 8 } };
    await renderPanel({ ...initialOptions, crop: { ...initialOptions.crop } }, publishSummary);
    expect(publishSummary).toHaveBeenCalledOnce();
    live = { ...live, elapsedMs: 1500 };
    await renderPanel({ ...initialOptions, crop: { ...initialOptions.crop } }, publishSummary);
    expect(publishSummary).toHaveBeenCalledTimes(2);
    expect(publishSummary.mock.calls[1][0]).toMatchObject({ lapElapsedMs: 1300 });
  });
});
