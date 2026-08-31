import {
  serializeTrainingSession,
  trainingSessionFilename,
  type TrainingSession,
} from "./training-session";

interface TrainingSessionWritableFile {
  write(data: Blob): Promise<void>;
  close(): Promise<void>;
}

interface TrainingSessionFileHandle {
  createWritable(): Promise<TrainingSessionWritableFile>;
}

export type TrainingSessionSaveFilePicker = (options: {
  suggestedName: string;
  types: Array<{
    description: string;
    accept: Record<string, string[]>;
  }>;
}) => Promise<TrainingSessionFileHandle>;

export function createTrainingSessionBlob(session: TrainingSession) {
  return new Blob([serializeTrainingSession(session)], { type: "application/json" });
}

export function getBrowserTrainingSessionSaveFilePicker(): TrainingSessionSaveFilePicker | null {
  if (typeof window === "undefined") return null;
  const picker = (window as Window & { showSaveFilePicker?: TrainingSessionSaveFilePicker }).showSaveFilePicker;
  return picker ? picker.bind(window) : null;
}

export async function saveTrainingSessionWithPicker(
  session: TrainingSession,
  picker: TrainingSessionSaveFilePicker,
) {
  const blob = createTrainingSessionBlob(session);
  const handle = await picker({
    suggestedName: trainingSessionFilename(session),
    types: [{
      description: "FPVHelper 训练记录",
      accept: { "application/json": [".json"] },
    }],
  });
  const writable = await handle.createWritable();
  await writable.write(blob);
  await writable.close();
  return blob.size;
}

export function beginUnconfirmedTrainingSessionDownload(session: TrainingSession) {
  const blob = createTrainingSessionBlob(session);
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = trainingSessionFilename(session);
    document.body.append(link);
    link.click();
    link.remove();
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  return blob.size;
}
