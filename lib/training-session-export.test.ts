import { describe, expect, it, vi } from "vitest";
import { saveTrainingSessionWithPicker, type TrainingSessionSaveFilePicker } from "./training-session-export";
import type { TrainingSession } from "./training-session";

const SESSION = {
  schemaVersion: 2,
  id: "session-export-test",
  athleteCode: "PILOT-01",
  startedAt: "2026-08-31T00:00:00.000Z",
  initialSource: "ground_rc",
  exportedAt: "2026-08-31T00:01:01.000Z",
  exportCount: 1,
} as TrainingSession;

describe("confirmed training session file export", () => {
  it("reports success only after the browser file writer closes", async () => {
    const calls: string[] = [];
    const picker = vi.fn(async () => ({
      createWritable: async () => ({
        write: async (data: Blob) => { calls.push(`write:${data.type}`); },
        close: async () => { calls.push("close"); },
      }),
    })) as TrainingSessionSaveFilePicker;

    const bytes = await saveTrainingSessionWithPicker(SESSION, picker);

    expect(bytes).toBeGreaterThan(0);
    expect(calls).toEqual(["write:application/json", "close"]);
    expect(picker).toHaveBeenCalledWith(expect.objectContaining({
      suggestedName: expect.stringContaining("PILOT-01"),
    }));
  });

  it("does not report a confirmed export when closing the file fails", async () => {
    const picker = vi.fn(async () => ({
      createWritable: async () => ({
        write: async () => undefined,
        close: async () => { throw new Error("disk full"); },
      }),
    })) as TrainingSessionSaveFilePicker;

    await expect(saveTrainingSessionWithPicker(SESSION, picker)).rejects.toThrow("disk full");
  });
});
