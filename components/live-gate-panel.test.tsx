import { useEffect } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLiveVision } from "../hooks/use-live-vision";
import type { LiveVisionController, LiveVisionOptions } from "../lib/live-vision-types";
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

function textOf(instance: ReactTestInstance): string {
  return instance.children.map((child) => typeof child === "string" ? child : textOf(child)).join("");
}

function button(label: string) {
  return renderer!.root.findAllByType("button").find((node) => textOf(node) === label)!;
}

function metric(label: string) {
  return textOf(renderer!.root.findAllByType("dt").find((node) => textOf(node) === label)!.parent!.findByType("dd"));
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
