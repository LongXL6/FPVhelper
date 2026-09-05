import { describe, expect, it } from "vitest";
import {
  loadPreferredVideoDevice,
  localVideoCaptureSettings,
  persistPreferredVideoDevice,
  PREFERRED_VIDEO_DEVICE_STORAGE_KEY,
  selectAvailableVideoDevice,
} from "./video-capture";

describe("local video capture preferences", () => {
  it("loads and persists only the opaque device id", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    };

    persistPreferredVideoDevice(storage, "opaque-device-id");
    expect(values).toEqual(new Map([[PREFERRED_VIDEO_DEVICE_STORAGE_KEY, "opaque-device-id"]]));
    expect(loadPreferredVideoDevice(storage)).toBe("opaque-device-id");
    persistPreferredVideoDevice(storage, "");
    expect(loadPreferredVideoDevice(storage)).toBe("");
  });

  it("fails closed when storage is unavailable or contains an oversized value", () => {
    const blockedStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
    };
    expect(loadPreferredVideoDevice(blockedStorage)).toBe("");
    expect(loadPreferredVideoDevice({ getItem: () => "x".repeat(513) })).toBe("");
  });

  it("keeps a current device, then a saved preference, then the first available device", () => {
    expect(selectAvailableVideoDevice(["a", "b"], "b", "a")).toBe("b");
    expect(selectAvailableVideoDevice(["a", "b"], "missing", "b")).toBe("b");
    expect(selectAvailableVideoDevice(["a", "b"], "", "missing")).toBe("a");
    expect(selectAvailableVideoDevice([], "", "")).toBe("");
  });

  it("records only non-identifying local capture settings", () => {
    expect(
      localVideoCaptureSettings({
        width: 1920,
        height: 1080,
        frameRate: 60,
        aspectRatio: 16 / 9,
        deviceId: "must-not-leave-local-selection",
        groupId: "must-not-be-recorded",
      }),
    ).toEqual({ width: 1920, height: 1080, frameRate: 60, aspectRatio: 16 / 9 });
  });
});
