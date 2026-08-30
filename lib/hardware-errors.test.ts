import { describe, expect, it } from "vitest";
import {
  classifySerialError,
  classifyVideoCaptureError,
  selectPreviouslyAuthorizedPort,
  serialDisconnectDecision,
  serialPreflightIssue,
  videoPreflightIssue,
} from "./hardware-errors";

describe("hardware issue classification", () => {
  it("keeps a cancelled serial chooser in demo semantics", () => {
    expect(classifySerialError({ name: "NotFoundError" }, "picker").code).toBe(
      "serial_picker_cancelled",
    );
    expect(classifySerialError({ name: "NotFoundError" }, "read").code).toBe(
      "serial_device_disconnected",
    );
  });

  it("classifies permission, busy, and unsupported serial failures without raw messages", () => {
    expect(classifySerialError({ name: "NotAllowedError" }, "picker").code).toBe(
      "serial_permission_denied",
    );
    expect(classifySerialError({ name: "InvalidStateError" }, "open").code).toBe(
      "serial_port_busy",
    );
    expect(serialPreflightIssue({ secureContext: true, serialSupported: false })?.code).toBe(
      "serial_unsupported",
    );
  });

  it("only reuses the exact previously authorized port object", () => {
    const known = { id: "known" };
    const lookalike = { id: "known" };
    expect(selectPreviouslyAuthorizedPort([known], known)).toBe(known);
    expect(selectPreviouslyAuthorizedPort([lookalike], known)).toBeNull();
    expect(selectPreviouslyAuthorizedPort([known], null)).toBeNull();
  });

  it("only treats a disconnect for the active port as unexpected", () => {
    const active = {};
    expect(serialDisconnectDecision(active, active)).toBe("unexpected_disconnect");
    expect(serialDisconnectDecision(active, {})).toBe("ignore");
    expect(serialDisconnectDecision(null, active)).toBe("ignore");
  });

  it("classifies video permissions, busy devices, and missing devices", () => {
    expect(classifyVideoCaptureError({ name: "NotAllowedError" }).code).toBe(
      "video_permission_denied",
    );
    expect(classifyVideoCaptureError({ name: "NotReadableError" }).code).toBe(
      "video_device_busy",
    );
    expect(classifyVideoCaptureError({ name: "NotFoundError" }).code).toBe(
      "video_device_not_found",
    );
  });

  it("checks secure-context requirements before browser capabilities", () => {
    expect(videoPreflightIssue({ secureContext: false, mediaSupported: false })?.code).toBe(
      "video_insecure_context",
    );
    expect(serialPreflightIssue({ secureContext: false, serialSupported: false })?.code).toBe(
      "serial_insecure_context",
    );
  });
});
