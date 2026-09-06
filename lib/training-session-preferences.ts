export type StickOverlayPreferenceMode = "trail" | "simple";

export interface TrainingSessionPreferences {
  autoExport: boolean;
  recordPilotVideo: boolean;
  videoOnly?: boolean;
  showStickOverlays: boolean;
  stickOverlayMode: StickOverlayPreferenceMode;
}

interface PreferenceStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

export const TRAINING_SESSION_PREFERENCES_KEY = "fpvhelper.training-preferences.v1";
export const DEFAULT_TRAINING_SESSION_PREFERENCES: TrainingSessionPreferences = {
  autoExport: false,
  recordPilotVideo: true,
  videoOnly: false,
  showStickOverlays: true,
  stickOverlayMode: "trail",
};

function preferenceErrorMessage(error: unknown) {
  return error instanceof Error && error.message ? error.message : "浏览器拒绝访问本机偏好存储";
}

function isPreferenceRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function loadTrainingSessionPreferences(storage: PreferenceStorage): {
  preferences: TrainingSessionPreferences;
  error: string | null;
} {
  try {
    const stored = storage.getItem(TRAINING_SESSION_PREFERENCES_KEY);
    if (stored === null) return { preferences: DEFAULT_TRAINING_SESSION_PREFERENCES, error: null };
    const parsed: unknown = JSON.parse(stored);
    if (
      !isPreferenceRecord(parsed) ||
      typeof parsed.autoExport !== "boolean" ||
      ("recordPilotVideo" in parsed && typeof parsed.recordPilotVideo !== "boolean") ||
      ("videoOnly" in parsed && typeof parsed.videoOnly !== "boolean") ||
      typeof parsed.showStickOverlays !== "boolean" ||
      (parsed.stickOverlayMode !== "trail" && parsed.stickOverlayMode !== "simple")
    ) {
      return { preferences: DEFAULT_TRAINING_SESSION_PREFERENCES, error: "本机偏好格式无效，已恢复默认设置" };
    }
    return {
      preferences: {
        autoExport: parsed.autoExport,
        recordPilotVideo: typeof parsed.recordPilotVideo === "boolean"
          ? parsed.recordPilotVideo
          : DEFAULT_TRAINING_SESSION_PREFERENCES.recordPilotVideo,
        videoOnly: parsed.recordPilotVideo !== false && parsed.videoOnly === true,
        showStickOverlays: parsed.showStickOverlays,
        stickOverlayMode: parsed.stickOverlayMode,
      },
      error: null,
    };
  } catch (error) {
    return { preferences: DEFAULT_TRAINING_SESSION_PREFERENCES, error: preferenceErrorMessage(error) };
  }
}

export function saveTrainingSessionPreferences(
  storage: PreferenceStorage,
  preferences: TrainingSessionPreferences,
) {
  try {
    if (preferences.videoOnly !== undefined && typeof preferences.videoOnly !== "boolean") {
      return "本机偏好格式无效，已恢复默认设置";
    }
    storage.setItem(TRAINING_SESSION_PREFERENCES_KEY, JSON.stringify({
      ...preferences,
      videoOnly: preferences.recordPilotVideo !== false && preferences.videoOnly === true,
    }));
    return null;
  } catch (error) {
    return preferenceErrorMessage(error);
  }
}
