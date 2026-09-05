import { useState, type ComponentProps } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionLibrary } from "./session-library";
import {
  appendTrainingSessionSample,
  createTrainingSessionDraft,
  finishTrainingSession,
  type TrainingSession,
} from "../lib/training-session";
import { toTrainingSessionSummary } from "../lib/training-session-index";
import { EMPTY_TELEMETRY } from "../lib/telemetry";

type LibraryProps = ComponentProps<typeof SessionLibrary>;
const START = 1_700_000_000_000;
let renderer: ReactTestRenderer | null = null;

function createSession(id: string, elapsedDays: number, throttle = 20) {
  const draft = createTrainingSessionDraft({
    id,
    workstationId: "10000000-0000-4000-8000-000000000001",
    build: "0.2.0+test",
    athleteCode: `PILOT-${id.toUpperCase()}`,
    source: "serial",
    startedAtEpochMs: START + elapsedDays * 86_400_000,
    startedMonotonicMs: 1_000,
  });
  for (let sequence = 1; sequence <= 3; sequence += 1) {
    appendTrainingSessionSample(draft, {
      ...EMPTY_TELEMETRY,
      sequence,
      monotonicTimestampMs: 1_000 + sequence * 10,
      throttleStickPercent: throttle,
      rcChannelsUs: [1500, 1500, 1500, 1000 + throttle * 10],
    }, "serial");
  }
  return {
    ...finishTrainingSession(draft, START + elapsedDays * 86_400_000 + 60_000, 61_000),
    notes: `${id} 原备注`,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

function content(node: ReactTestInstance): string {
  return node.children.map((child) => typeof child === "string" ? child : content(child)).join("");
}

function statuses() {
  return renderer!.root.findAllByProps({ role: "status" }).map(content).join(" ");
}

function selectAthlete(athleteCode: string) {
  const row = renderer!.root.findAllByType("button").find((button) => (
    typeof button.props.className === "string" && button.props.className.includes("session-list-item")
      && content(button).includes(athleteCode)
  ));
  if (!row) throw new Error(`Missing session row: ${athleteCode}`);
  row.props.onClick();
}

function propsFor(sessions: TrainingSession[], loadSession: LibraryProps["loadSession"]): LibraryProps {
  return {
    sessions: sessions.map(toTrainingSessionSummary),
    loadSession,
    selectedSessionId: sessions[0]?.id ?? null,
    onSelectSession: vi.fn(),
    onExport: vi.fn<LibraryProps["onExport"]>(async () => ({ status: "requested", message: "已请求下载", localStateSaved: true })),
    onUpdateNotes: vi.fn(async () => undefined),
    onGoToLive: vi.fn(),
    isRecording: false,
    storageState: "ready",
    saveState: "saved",
  };
}

function Harness({ initialProps }: { initialProps: LibraryProps }) {
  const [selectedId, setSelectedId] = useState(initialProps.selectedSessionId);
  return <SessionLibrary {...initialProps} selectedSessionId={selectedId} onSelectSession={(id) => {
    initialProps.onSelectSession(id);
    setSelectedId(id);
  }} />;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", Object.assign(new EventTarget(), {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  }));
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("training library detail loading", () => {
  it("renders the first-visit empty library without requesting absent detail", async () => {
    const loadSession = vi.fn<LibraryProps["loadSession"]>();
    await act(async () => { renderer = create(<Harness initialProps={propsFor([], loadSession)} />); });
    expect(content(renderer!.root)).toContain("从第一段训练开始");
    expect(loadSession).not.toHaveBeenCalled();
  });

  it("renders sample-free summaries and loads only the selected record's raw samples", async () => {
    const older = createSession("older", 0);
    const newer = createSession("newer", 1);
    const reading = deferred<TrainingSession | null>();
    const loadSession = vi.fn<LibraryProps["loadSession"]>(() => reading.promise);
    const props = propsFor([newer, older], loadSession);
    expect(props.sessions.every((session) => !Object.hasOwn(session, "samples"))).toBe(true);
    await act(async () => { renderer = create(<Harness initialProps={props} />); });
    expect(loadSession.mock.calls).toEqual([[newer.id]]);
    expect(content(renderer!.root.findByProps({ id: "session-detail-title" }))).toContain("PILOT-NEWER");
    expect(renderer!.root.findAllByProps({ className: "session-metrics" }).map(content).join()).toContain("遥控样本3");
    expect(statuses()).toContain("正在读取这次训练的原始样本");
    expect(renderer!.root.findAllByType("polyline")).toHaveLength(0);
    await act(async () => reading.resolve(newer));
    expect(renderer!.root.findAllByType("polyline")).toHaveLength(1);
    expect(loadSession.mock.calls).toEqual([[newer.id]]);
  });

  it("ignores a late detail response after the selection has changed", async () => {
    const older = createSession("older", 0, 10);
    const newer = createSession("newer", 1, 80);
    const oldRequest = deferred<TrainingSession | null>();
    const newRequest = deferred<TrainingSession | null>();
    const loadSession = vi.fn<LibraryProps["loadSession"]>((id) => id === older.id ? oldRequest.promise : newRequest.promise);
    const props = propsFor([older, newer], loadSession);
    await act(async () => { renderer = create(<Harness initialProps={props} />); });
    await act(async () => selectAthlete("PILOT-NEWER"));
    expect(loadSession.mock.calls).toEqual([[older.id], [newer.id]]);
    await act(async () => newRequest.resolve(newer));
    const newPoints = renderer!.root.findByType("polyline").props.points as string;
    expect(newPoints).toContain(",56.00");
    await act(async () => oldRequest.resolve(older));
    expect(content(renderer!.root.findByProps({ id: "session-detail-title" }))).toContain("PILOT-NEWER");
    expect(renderer!.root.findByType("polyline").props.points).toBe(newPoints);
    expect(statuses()).not.toContain("正在读取");
  });

  it("keeps independent unsaved note drafts when moving between records", async () => {
    const older = createSession("older", 0);
    const newer = createSession("newer", 1);
    const records = new Map([[older.id, older], [newer.id, newer]]);
    const loadSession = vi.fn<LibraryProps["loadSession"]>(async (id) => records.get(id) ?? null);
    const props = propsFor([newer, older], loadSession);
    await act(async () => { renderer = create(<Harness initialProps={props} />); });
    await act(async () => renderer!.root.findByProps({ id: "session-review-notes" }).props.onChange({ target: { value: "新记录还未保存的观察" } }));
    expect(statuses()).toContain("有尚未保存的修改");
    await act(async () => selectAthlete("PILOT-OLDER"));
    expect(renderer!.root.findByProps({ id: "session-review-notes" }).props.value).toBe("older 原备注");
    await act(async () => renderer!.root.findByProps({ id: "session-review-notes" }).props.onChange({ target: { value: "旧记录还未保存的观察" } }));
    await act(async () => selectAthlete("PILOT-NEWER"));
    expect(renderer!.root.findByProps({ id: "session-review-notes" }).props.value).toBe("新记录还未保存的观察");
    await act(async () => selectAthlete("PILOT-OLDER"));
    expect(renderer!.root.findByProps({ id: "session-review-notes" }).props.value).toBe("旧记录还未保存的观察");
    expect(props.onUpdateNotes).not.toHaveBeenCalled();
    const leaving = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(leaving);
    expect(leaving.defaultPrevented).toBe(true);
  });

  it("breaks the plotted curve across a capture gap and source change", async () => {
    const base = createSession("gaps", 0);
    const session = { ...base, samples: [
      base.samples[0], base.samples[1],
      { ...base.samples[2], elapsedMs: 120 },
      { ...base.samples[2], elapsedMs: 130 },
      { ...base.samples[2], elapsedMs: 140, source: "demo" as const },
      { ...base.samples[2], elapsedMs: 150, source: "demo" as const },
    ] };
    const props = propsFor([session], async () => session);
    await act(async () => { renderer = create(<Harness initialProps={props} />); });
    const lines = renderer!.root.findAllByType("polyline");
    expect(lines).toHaveLength(3);
    expect(lines.map((line) => line.props.points.split(" ").length)).toEqual([2, 2, 2]);
  });

  it("keeps isolated samples visible as points instead of inventing connecting lines", async () => {
    const base = createSession("isolated", 0);
    const session = { ...base, samples: base.samples.map((sample, index) => ({ ...sample, elapsedMs: index * 200 })) };
    await act(async () => { renderer = create(<Harness initialProps={propsFor([session], async () => session)} />); });
    expect(renderer!.root.findAllByType("polyline")).toHaveLength(0);
    expect(renderer!.root.findAllByType("circle")).toHaveLength(3);
  });

  it("can retry a failed sample read without leaving the selected record", async () => {
    const session = createSession("retry", 0);
    const loadSession = vi.fn<LibraryProps["loadSession"]>()
      .mockRejectedValueOnce(new Error("读取暂时失败"))
      .mockResolvedValueOnce(session);
    await act(async () => { renderer = create(<Harness initialProps={propsFor([session], loadSession)} />); });
    const retry = renderer!.root.findAllByType("button").find((button) => content(button) === "重新读取样本")!;
    await act(async () => retry.props.onClick());
    expect(loadSession.mock.calls).toEqual([[session.id], [session.id]]);
    expect(renderer!.root.findAllByType("polyline")).toHaveLength(1);
    expect(statuses()).not.toContain("读取暂时失败");
  });

  it.each(["missing", "rejected"] as const)("shows %s samples as a read error while keeping the summary visible", async (failure) => {
    const session = createSession("unreadable", 0);
    const loadSession = vi.fn<LibraryProps["loadSession"]>(async () => {
      if (failure === "rejected") throw new Error("样本块校验失败，请从归档恢复");
      return null;
    });
    const props = propsFor([session], loadSession);
    await act(async () => { renderer = create(<Harness initialProps={props} />); });
    expect(content(renderer!.root.findByProps({ id: "session-detail-title" }))).toContain("PILOT-UNREADABLE");
    expect(renderer!.root.findAllByType("polyline")).toHaveLength(0);
    expect(statuses()).toContain(failure === "missing" ? "样本无法完整读取" : "样本块校验失败");
    expect(statuses()).not.toContain("还没有可绘制的遥控样本");
    expect(statuses()).not.toContain("正在读取");
    expect(content(renderer!.root)).not.toContain("从第一段训练开始");
  });
});
