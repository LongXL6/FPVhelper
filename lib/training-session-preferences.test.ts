import { describe, expect, it } from "vitest";
import {
  DEFAULT_TRAINING_SESSION_PREFERENCES,
  loadTrainingSessionPreferences,
  saveTrainingSessionPreferences,
  TRAINING_SESSION_PREFERENCES_KEY,
} from "./training-session-preferences";

function memoryStorage(initial: string | null = null) {
  let value = initial;
  return {
    getItem: (key: string) => key === TRAINING_SESSION_PREFERENCES_KEY ? value : null,
    setItem: (key: string, nextValue: string) => {
      if (key === TRAINING_SESSION_PREFERENCES_KEY) value = nextValue;
    },
  };
}

describe("local training and overlay preferences", () => {
  it("persists automatic export, overlay visibility and overlay mode together", () => {
    const storage = memoryStorage();
    const preferences = { autoExport: true, showStickOverlays: false, stickOverlayMode: "simple" as const };

    expect(saveTrainingSessionPreferences(storage, preferences)).toBeNull();
    expect(loadTrainingSessionPreferences(storage)).toEqual({ preferences, error: null });
  });

  it("falls back explicitly when stored preferences are malformed", () => {
    const storage = memoryStorage(JSON.stringify({ autoExport: "yes", showStickOverlays: true, stickOverlayMode: "simple" }));

    expect(loadTrainingSessionPreferences(storage)).toEqual({
      preferences: DEFAULT_TRAINING_SESSION_PREFERENCES,
      error: "本机偏好格式无效，已恢复默认设置",
    });
  });

  it("surfaces storage write failures instead of silently dropping a change", () => {
    const storage = {
      getItem: () => null,
      setItem: () => { throw new Error("quota blocked"); },
    };

    expect(saveTrainingSessionPreferences(storage, DEFAULT_TRAINING_SESSION_PREFERENCES)).toBe("quota blocked");
  });
});
