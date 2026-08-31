import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initializeAnalytics, trackAnalytics } from "../lib/analytics/client";
import AppError from "./error";

vi.mock("../lib/analytics/client", () => ({
  initializeAnalytics: vi.fn(),
  trackAnalytics: vi.fn(),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  vi.clearAllMocks();
});

describe("AppError", () => {
  it("executes its reporting effect without exposing message, stack, or digest", async () => {
    const privateError = Object.assign(
      new Error("pilot Alice /dev/cu.usb-private raw bytes 01ff"),
      { digest: "private-server-digest" },
    );
    privateError.stack = "private stack with athlete note";
    const retry = vi.fn();
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = create(<AppError error={privateError} retry={retry} />);
    });
    const reportCalls = JSON.stringify(vi.mocked(trackAnalytics).mock.calls);
    const root = renderer.root;

    expect(initializeAnalytics).toHaveBeenCalledOnce();
    expect(trackAnalytics).toHaveBeenCalledWith("js_error", {
      code: "unexpected_exception",
      stage: "runtime",
      fingerprint: expect.any(String),
    });
    expect(reportCalls).not.toMatch(/Alice|usb-private|raw bytes|private-server-digest|athlete note/);
    expect(root.findByType("h1").children.join("")).toBe("页面暂时无法继续");
    root.findByType("button").props.onClick();
    expect(retry).toHaveBeenCalledOnce();

    await act(async () => {
      renderer.unmount();
    });
  });
});
