import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
import type { TrainingSession } from "./training-session";
import {
  createTrainingSessionDirectoryStore,
  getTrainingSessionDirectoryPermission,
  requestTrainingSessionDirectoryPermission,
  saveTrainingSessionToDirectory,
  type TrainingSessionDirectoryHandle,
} from "./training-session-export-directory";

const SESSION = {
  schemaVersion: 2,
  id: "session-directory-test",
  athleteCode: "PILOT-02",
  startedAt: "2026-08-31T00:00:00.000Z",
  initialSource: "ground_rc",
  exportedAt: "2026-08-31T00:01:01.000Z",
  exportCount: 1,
} as TrainingSession;

describe("training session export directory", () => {
  it("persists, reloads, and clears a directory handle locally", async () => {
    const factory = new IDBFactory();
    const store = createTrainingSessionDirectoryStore(factory, "directory-handle-round-trip");
    const handle = { kind: "directory", name: "FPV Sessions" } as TrainingSessionDirectoryHandle;

    await store.save(handle);
    await expect(store.load()).resolves.toEqual(handle);
    await store.clear();
    await expect(store.load()).resolves.toBeNull();
    await store.close();
  });

  it("queries permission without prompting during background work", async () => {
    const queryPermission = vi.fn(async () => "prompt" as const);
    const handle = { queryPermission } as unknown as TrainingSessionDirectoryHandle;

    await expect(getTrainingSessionDirectoryPermission(handle)).resolves.toBe("prompt");
    expect(queryPermission).toHaveBeenCalledWith({ mode: "readwrite" });
  });

  it("requests permission only after an explicit prompt state", async () => {
    const requestPermission = vi.fn(async () => "granted" as const);
    const handle = {
      queryPermission: async () => "prompt" as const,
      requestPermission,
    } as unknown as TrainingSessionDirectoryHandle;

    await expect(requestTrainingSessionDirectoryPermission(handle)).resolves.toBe(true);
    expect(requestPermission).toHaveBeenCalledWith({ mode: "readwrite" });
  });

  it("fails closed when the stored handle cannot expose permission", async () => {
    const handle = {} as TrainingSessionDirectoryHandle;

    await expect(getTrainingSessionDirectoryPermission(handle)).resolves.toBe("denied");
    await expect(requestTrainingSessionDirectoryPermission(handle)).resolves.toBe(false);
  });

  it("reports success only after writing and closing the directory file", async () => {
    const calls: string[] = [];
    const getFileHandle = vi.fn(async () => ({
      createWritable: async () => ({
        write: async (data: Blob) => { calls.push(`write:${data.type}`); },
        close: async () => { calls.push("close"); },
      }),
    }));
    const handle = { kind: "directory", name: "FPV Sessions", getFileHandle } as TrainingSessionDirectoryHandle;

    const bytes = await saveTrainingSessionToDirectory(SESSION, handle);

    expect(bytes).toBeGreaterThan(0);
    expect(calls).toEqual(["write:application/json", "close"]);
    expect(getFileHandle).toHaveBeenCalledWith(expect.stringContaining("PILOT-02"), { create: true });
  });

  it("does not confirm a directory export when closing fails", async () => {
    const handle = {
      kind: "directory",
      name: "FPV Sessions",
      getFileHandle: async () => ({
        createWritable: async () => ({
          write: async () => undefined,
          close: async () => { throw new Error("disk full"); },
        }),
      }),
    } as TrainingSessionDirectoryHandle;

    await expect(saveTrainingSessionToDirectory(SESSION, handle)).rejects.toThrow("disk full");
  });
});
