import { describe, expect, it, vi } from "vitest";
import {
  classifyWorkstationShortcut,
  createRecordHoldController,
  createWakeLockCoordinator,
  createWorkstationTabLease,
  isWorkstationInteractiveTarget,
  loadWorkstationSingleKeyShortcuts,
  saveWorkstationSingleKeyShortcuts,
  workstationTabStartBlockReason,
} from "./workstation-runtime";

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("workstation runtime", () => {
  it("holds the exclusive tab lease until released", async () => {
    const states: string[] = [];
    let callbackFinished = false;
    const lockManager = {
      request: vi.fn(async (_name, _options, callback) => {
        await callback({ name: "held" });
        callbackFinished = true;
      }),
    };

    const release = createWorkstationTabLease(lockManager, (state) => states.push(state));
    await flushMicrotasks();
    expect(states).toEqual(["primary"]);
    expect(callbackFinished).toBe(false);

    release();
    await flushMicrotasks();
    expect(callbackFinished).toBe(true);
  });

  it("blocks a second tab when the exclusive lock is unavailable", async () => {
    const states: string[] = [];
    const lockManager = {
      request: vi.fn(async (_name, _options, callback) => callback(null)),
    };

    createWorkstationTabLease(lockManager, (state) => states.push(state));
    await flushMicrotasks();
    expect(states).toEqual(["blocked"]);
    expect(workstationTabStartBlockReason("blocked")).toContain("另一标签页");
  });

  it("fails closed when the browser lock request rejects", async () => {
    const states: string[] = [];
    const lockManager = {
      request: vi.fn(async () => { throw new Error("locks denied"); }),
    };

    createWorkstationTabLease(lockManager, (state) => states.push(state));
    await flushMicrotasks();
    expect(states).toEqual(["unsupported"]);
    expect(workstationTabStartBlockReason("unsupported")).toContain("记录、串口和视频连接已停用");
  });

  it("keeps Space and Escape available while single-character shortcuts default off", () => {
    const base = { repeat: false, modified: false, interactive: false, singleKeyEnabled: false };
    expect(classifyWorkstationShortcut({ ...base, key: " ", code: "Space" })).toBe("record_hold");
    expect(classifyWorkstationShortcut({ ...base, key: "Escape", code: "Escape" })).toBe("cancel_connection");
    expect(classifyWorkstationShortcut({ ...base, key: "M", code: "KeyM" })).toBeNull();
    expect(classifyWorkstationShortcut({ ...base, key: "M", code: "KeyM", singleKeyEnabled: true })).toBe("add_marker");
    expect(classifyWorkstationShortcut({ ...base, key: "e", code: "KeyE", modified: true, singleKeyEnabled: true })).toBeNull();
    expect(classifyWorkstationShortcut({ ...base, key: "f", code: "KeyF", interactive: true, singleKeyEnabled: true })).toBeNull();
  });

  it("treats buttons, links, role buttons, form fields and editable content as interactive", () => {
    const seenSelectors: string[] = [];
    const target = {
      closest: (selector: string) => {
        seenSelectors.push(selector);
        return {};
      },
    } as unknown as EventTarget;

    expect(isWorkstationInteractiveTarget(target)).toBe(true);
    expect(seenSelectors[0]).toContain("button");
    expect(seenSelectors[0]).toContain("a[href]");
    expect(seenSelectors[0]).toContain("[role=\"button\"]");
    expect(seenSelectors[0]).toContain("input");
    expect(seenSelectors[0]).toContain("select");
    expect(seenSelectors[0]).toContain("textarea");
    expect(seenSelectors[0]).toContain("contenteditable");
  });

  it("persists the opt-in for single-character shortcuts and defaults to disabled", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };

    expect(loadWorkstationSingleKeyShortcuts(storage)).toBe(false);
    expect(saveWorkstationSingleKeyShortcuts(storage, true)).toBeNull();
    expect(loadWorkstationSingleKeyShortcuts(storage)).toBe(true);
    expect(saveWorkstationSingleKeyShortcuts(storage, false)).toBeNull();
    expect(loadWorkstationSingleKeyShortcuts(storage)).toBe(false);
  });

  it("cancels a pending Space hold when the key is released or the environment becomes unsafe", () => {
    let scheduled: (() => void) | null = null;
    let safe = true;
    const triggered = vi.fn();
    const cancelled = vi.fn();
    const controller = createRecordHoldController({
      delayMs: 700,
      schedule: (callback) => {
        scheduled = callback;
        return 1;
      },
      clearScheduled: vi.fn(),
      canTrigger: () => safe,
      onTrigger: triggered,
      onCancel: cancelled,
    });

    expect(controller.press()).toBe(true);
    controller.release();
    const releasedCallback = scheduled as unknown as () => void;
    releasedCallback();
    expect(triggered).not.toHaveBeenCalled();
    expect(cancelled).toHaveBeenCalledWith("released");

    controller.press();
    controller.cancel();
    const blurredCallback = scheduled as unknown as () => void;
    blurredCallback();
    expect(triggered).not.toHaveBeenCalled();
    expect(cancelled).toHaveBeenLastCalledWith("environment");

    controller.press();
    safe = false;
    const hiddenCallback = scheduled as unknown as () => void;
    hiddenCallback();
    expect(triggered).not.toHaveBeenCalled();
    expect(cancelled).toHaveBeenCalledWith("environment");
  });

  it("serializes wake acquisition and releases every sentinel that resolves stale", async () => {
    let visible = true;
    let resolveFirst!: (sentinel: { release: () => Promise<void>; addEventListener: () => void }) => void;
    let resolveSecond!: (sentinel: { release: () => Promise<void>; addEventListener: () => void }) => void;
    const firstRequest = new Promise<{ release: () => Promise<void>; addEventListener: () => void }>((resolve) => {
      resolveFirst = resolve;
    });
    const secondRequest = new Promise<{ release: () => Promise<void>; addEventListener: () => void }>((resolve) => {
      resolveSecond = resolve;
    });
    const request = vi.fn()
      .mockReturnValueOnce(firstRequest)
      .mockReturnValueOnce(secondRequest);
    const states: string[] = [];
    const firstRelease = vi.fn(async () => undefined);
    const secondRelease = vi.fn(async () => undefined);
    const coordinator = createWakeLockCoordinator({
      request,
      isVisible: () => visible,
      onState: (state) => states.push(state),
    });

    const firstAcquire = coordinator.acquire();
    void coordinator.acquire();
    expect(request).toHaveBeenCalledTimes(1);

    visible = false;
    coordinator.visibilityChanged();
    resolveFirst({ release: firstRelease, addEventListener: vi.fn() });
    await firstAcquire;
    expect(firstRelease).toHaveBeenCalledTimes(1);
    expect(states).not.toContain("active");

    visible = true;
    coordinator.visibilityChanged();
    expect(request).toHaveBeenCalledTimes(2);
    resolveSecond({ release: secondRelease, addEventListener: vi.fn() });
    await flushMicrotasks();
    expect(states.at(-1)).toBe("active");

    coordinator.dispose();
    await flushMicrotasks();
    expect(secondRelease).toHaveBeenCalledTimes(1);
  });
});
