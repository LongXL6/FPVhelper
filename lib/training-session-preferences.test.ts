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
  it("enables video with stick overlays by default for a new browser", () => {
    expect(loadTrainingSessionPreferences(memoryStorage())).toEqual({
      preferences: {
        autoExport: false,
        recordPilotVideo: true,
        showStickOverlays: true,
        stickOverlayMode: "trail",
        stickOverlayOpacity: 1,
      },
      error: null,
    });
  });

  it.each([true, false])("preserves an explicit video choice of %s after saving and reloading", (recordPilotVideo) => {
    const storage = memoryStorage();
    const preferences = { stickOverlayOpacity: 0.5, autoExport: true, recordPilotVideo, showStickOverlays: false, stickOverlayMode: "simple" as const };

    expect(saveTrainingSessionPreferences(storage, preferences)).toBeNull();
    const reloadedStorage = memoryStorage(storage.getItem(TRAINING_SESSION_PREFERENCES_KEY));
    expect(loadTrainingSessionPreferences(reloadedStorage)).toEqual({ preferences, error: null });
  });

  it("enables video for an older record without changing its other preferences", () => {
    const storage = memoryStorage(JSON.stringify({ autoExport: true, showStickOverlays: false, stickOverlayMode: "simple" }));
    const migrated = loadTrainingSessionPreferences(storage);

    expect(migrated).toEqual({
      preferences: { autoExport: true, recordPilotVideo: true, showStickOverlays: false, stickOverlayMode: "simple", stickOverlayOpacity: 1 },
      error: null,
    });
    expect(saveTrainingSessionPreferences(storage, migrated.preferences)).toBeNull();
    const reloadedStorage = memoryStorage(storage.getItem(TRAINING_SESSION_PREFERENCES_KEY));
    expect(loadTrainingSessionPreferences(reloadedStorage)).toEqual(migrated);
  });

  it("keeps an existing explicit data-only choice when loading older preferences", () => {
    const preferences = { autoExport: false, recordPilotVideo: false, showStickOverlays: true, stickOverlayMode: "trail" };

    expect(loadTrainingSessionPreferences(memoryStorage(JSON.stringify(preferences)))).toEqual({ preferences: { ...preferences, stickOverlayOpacity: 1 }, error: null });
  });

  it("falls back explicitly when stored preferences are malformed", () => {
    const storage = memoryStorage(JSON.stringify({ autoExport: "yes", showStickOverlays: true, stickOverlayMode: "simple" }));

    expect(loadTrainingSessionPreferences(storage)).toEqual({
      preferences: DEFAULT_TRAINING_SESSION_PREFERENCES,
      error: "本机偏好格式无效，已恢复默认设置",
    });
  });

  it.each(["false", null, 0])("reports an invalid video preference %s instead of treating it as a legacy omission", (recordPilotVideo) => {
    const storage = memoryStorage(JSON.stringify({ ...DEFAULT_TRAINING_SESSION_PREFERENCES, recordPilotVideo }));

    expect(loadTrainingSessionPreferences(storage)).toEqual({
      preferences: DEFAULT_TRAINING_SESSION_PREFERENCES,
      error: "本机偏好格式无效，已恢复默认设置",
    });
  });

  it("reports invalid JSON while falling back to the video-enabled defaults", () => {
    const result = loadTrainingSessionPreferences(memoryStorage("{"));

    expect(result.preferences).toEqual(DEFAULT_TRAINING_SESSION_PREFERENCES);
    expect(result.preferences.recordPilotVideo).toBe(true);
    expect(result.error).toBeTruthy();
  });

  it("surfaces storage read failures while using the video-enabled defaults", () => {
    const storage = {
      getItem: () => { throw new Error("storage blocked"); },
      setItem: () => undefined,
    };

    expect(loadTrainingSessionPreferences(storage)).toEqual({
      preferences: DEFAULT_TRAINING_SESSION_PREFERENCES,
      error: "storage blocked",
    });
  });

  it.each([[0.1, 0.25], [2, 1], ["bad", 1], [null, 1]])("normalizes opacity %s without losing the video preference", (stored, expected) => {
    const preferences = { ...DEFAULT_TRAINING_SESSION_PREFERENCES, recordPilotVideo: false, stickOverlayOpacity: stored };
    const loaded = loadTrainingSessionPreferences(memoryStorage(JSON.stringify(preferences)));
    expect(loaded.preferences.stickOverlayOpacity).toBe(expected);
    expect(loaded.preferences.recordPilotVideo).toBe(false);
  });

  it("surfaces storage write failures instead of silently dropping a change", () => {
    const storage = {
      getItem: () => null,
      setItem: () => { throw new Error("quota blocked"); },
    };

    expect(saveTrainingSessionPreferences(storage, DEFAULT_TRAINING_SESSION_PREFERENCES)).toBe("quota blocked");
  });
});
