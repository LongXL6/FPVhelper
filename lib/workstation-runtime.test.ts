import { describe, expect, it, vi } from "vitest";
import {
  classifyWorkstationShortcut,
  createWorkstationTabLease,
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

  it("recognizes only unmodified shortcuts outside form controls", () => {
    expect(classifyWorkstationShortcut({ key: " ", code: "Space", repeat: false, modified: false, typing: false })).toBe("record_hold");
    expect(classifyWorkstationShortcut({ key: "M", code: "KeyM", repeat: false, modified: false, typing: false })).toBe("add_marker");
    expect(classifyWorkstationShortcut({ key: "e", code: "KeyE", repeat: false, modified: true, typing: false })).toBeNull();
    expect(classifyWorkstationShortcut({ key: "f", code: "KeyF", repeat: false, modified: false, typing: true })).toBeNull();
  });
});
