import { describe, expect, it, vi } from "vitest";
import { dashboardEscapeAction } from "./flight-dashboard";
import type { ConnectionState } from "../lib/telemetry";
import { classifyWorkstationShortcut } from "../lib/workstation-runtime";

function context(overrides: Partial<Parameters<typeof dashboardEscapeAction>[1]> = {}) {
  return {
    document: { fullscreenElement: null, querySelector: vi.fn(() => null) } as Pick<Document, "fullscreenElement" | "querySelector">,
    coachMode: false,
    controlsLocked: false,
    connection: "connecting" as ConnectionState,
    ...overrides,
  };
}

function escape(overrides: Partial<Parameters<typeof dashboardEscapeAction>[0]> = {}) {
  return { defaultPrevented: false, isComposing: false, target: null, ...overrides };
}

describe("dashboard Escape actions", () => {
  it.each(["live", "stale", "error", "demo"] as const)("does not disconnect an established or inactive %s connection", (connection) => {
    expect(dashboardEscapeAction(escape(), context({ connection }))).toBeNull();
  });

  it("keeps background Escape available to cancel only an unlocked pending connection", () => {
    expect(dashboardEscapeAction(escape(), context())).toBe("cancel_pending_connection");
    expect(dashboardEscapeAction(escape(), context({ controlsLocked: true }))).toBeNull();
  });

  it("exits page coach mode without cancelling a connection, including while recording", () => {
    expect(dashboardEscapeAction(escape(), context({ coachMode: true }))).toBe("exit_coach");
    expect(dashboardEscapeAction(escape(), context({ coachMode: true, controlsLocked: true, connection: "live" }))).toBe("exit_coach");
  });

  it.each(["input", "textarea", "select", "[contenteditable]", "button", "summary"])("leaves Escape on %s to the focused control", (kind) => {
    const target = { closest: vi.fn((selector: string) => selector.includes(kind) ? {} : null) } as unknown as EventTarget;
    expect(dashboardEscapeAction(escape({ target }), context())).toBeNull();
    expect(dashboardEscapeAction(escape({ target }), context({ coachMode: true }))).toBeNull();
  });

  it.each([{ defaultPrevented: true }, { isComposing: true }])("does not consume an already handled or composing Escape: %j", (flags) => {
    expect(dashboardEscapeAction(escape(flags), context())).toBeNull();
    expect(dashboardEscapeAction(escape(flags), context({ coachMode: true }))).toBeNull();
  });

  it("leaves native fullscreen Escape to the browser", () => {
    const active = context({ coachMode: true, document: { fullscreenElement: {} as Element, querySelector: vi.fn(() => null) } as Pick<Document, "fullscreenElement" | "querySelector"> });
    expect(dashboardEscapeAction(escape(), active)).toBeNull();
  });

  it.each(['dialog[open]', '[role="dialog"][aria-modal="true"]', ":popover-open"])("does not cancel a pending connection while %s owns Escape", (selector) => {
    const active = context();
    vi.mocked(active.document.querySelector).mockImplementation((query) => query.includes(selector) ? {} as Element : null);
    expect(dashboardEscapeAction(escape(), active)).toBeNull();
  });

  it("leaves popup content Escape alone even before its own handler cancels the event", () => {
    const target = { closest: vi.fn((selector: string) => selector.includes('[role="menu"]') ? {} : null) } as unknown as EventTarget;
    expect(dashboardEscapeAction(escape({ target }), context())).toBeNull();
  });

  it("retains pending cancellation on browsers without the native popover selector", () => {
    const active = context();
    vi.mocked(active.document.querySelector).mockImplementation((selector) => {
      if (selector === ":popover-open") throw new DOMException("Unsupported selector", "SyntaxError");
      return null;
    });
    expect(dashboardEscapeAction(escape(), active)).toBe("cancel_pending_connection");
  });

  it("keeps modified/repeated Escape and ordinary typing outside the global shortcut path", () => {
    const input = { key: "Escape", code: "Escape", repeat: false, modified: false, interactive: false, singleKeyEnabled: false };
    expect(classifyWorkstationShortcut({ ...input, repeat: true })).toBeNull();
    expect(classifyWorkstationShortcut({ ...input, modified: true })).toBeNull();
    expect(classifyWorkstationShortcut({ ...input, key: "m", code: "KeyM", interactive: true, singleKeyEnabled: true })).toBeNull();
    expect(classifyWorkstationShortcut({ ...input, key: " ", code: "Space" })).toBe("record_hold");
  });
});
