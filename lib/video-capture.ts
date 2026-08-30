export const PREFERRED_VIDEO_DEVICE_STORAGE_KEY = "fpvhelper.video.preferred-device.v1";

interface StorageReader {
  getItem(key: string): string | null;
}

interface StorageWriter {
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface LocalVideoCaptureSettings {
  width: number | null;
  height: number | null;
  frameRate: number | null;
  aspectRatio: number | null;
}

export function loadPreferredVideoDevice(storage: StorageReader | null) {
  if (!storage) return "";
  try {
    const deviceId = storage.getItem(PREFERRED_VIDEO_DEVICE_STORAGE_KEY) ?? "";
    return deviceId.length <= 512 ? deviceId : "";
  } catch {
    return "";
  }
}

export function persistPreferredVideoDevice(storage: StorageWriter | null, deviceId: string) {
  if (!storage) return;
  try {
    if (!deviceId || deviceId.length > 512) {
      storage.removeItem(PREFERRED_VIDEO_DEVICE_STORAGE_KEY);
      return;
    }
    storage.setItem(PREFERRED_VIDEO_DEVICE_STORAGE_KEY, deviceId);
  } catch {
    // Capture remains usable if private browsing blocks local storage.
  }
}

export function selectAvailableVideoDevice(
  availableDeviceIds: readonly string[],
  currentDeviceId: string,
  preferredDeviceId: string,
) {
  if (currentDeviceId && availableDeviceIds.includes(currentDeviceId)) return currentDeviceId;
  if (preferredDeviceId && availableDeviceIds.includes(preferredDeviceId)) return preferredDeviceId;
  return availableDeviceIds[0] ?? "";
}

export function localVideoCaptureSettings(settings: MediaTrackSettings): LocalVideoCaptureSettings {
  return {
    width: settings.width ?? null,
    height: settings.height ?? null,
    frameRate: settings.frameRate ?? null,
    aspectRatio: settings.aspectRatio ?? null,
  };
}
