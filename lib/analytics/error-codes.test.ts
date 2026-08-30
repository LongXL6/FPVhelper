import { describe, expect, it } from "vitest";
import {
  classifyMediaError,
  classifySerialError,
  classifyStorageError,
  classifyUnknownError,
} from "./error-codes";

function error(name: string, message: string) {
  return { name, message, stack: `STACK WITH PRIVATE DATA ${message}`, deviceLabel: "HDMI Capture 0123" };
}

describe("analytics error classification", () => {
  it("maps serial failures to stable codes and stages", () => {
    expect(classifySerialError(error("NotFoundError", "user cancelled /dev/cu.usbmodem"), "picker")).toMatchObject({
      domain: "serial", code: "serial_picker_cancelled", stage: "picker",
    });
    expect(classifySerialError(error("InvalidStateError", "port already open"), "open")).toMatchObject({
      code: "serial_port_busy", stage: "open",
    });
    expect(classifySerialError(error("TimeoutError", "first frame timeout"), "handshake")).toMatchObject({
      code: "serial_first_frame_timeout", stage: "handshake",
    });
    expect(classifySerialError(error("NetworkError", "USB serial disconnected"), "read")).toMatchObject({
      code: "serial_device_lost", stage: "read",
    });
  });

  it("maps video and storage errors without returning source text", () => {
    const video = classifyMediaError(error("NotReadableError", "OBS owns USB Capture Secret Label"));
    const storage = classifyStorageError(error("QuotaExceededError", "athlete-note-private"));
    expect(video).toMatchObject({ domain: "video", code: "video_device_busy", stage: "capture" });
    expect(storage).toMatchObject({ domain: "storage", code: "storage_quota_exceeded", stage: "storage_write" });
    expect(JSON.stringify({ video, storage })).not.toMatch(/Secret Label|athlete-note-private|STACK/);
  });

  it("uses a deidentified, stable fingerprint derived only from enums", () => {
    const first = classifyUnknownError(error("TypeError", "pilot Alice / port tty.usb-1"));
    const second = classifyUnknownError(error("RangeError", "pilot Bob / raw bytes 01ff"));
    expect(first).toEqual(second);
    expect(first.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(first)).not.toMatch(/Alice|Bob|tty|raw bytes|TypeError|RangeError/);
  });
});
