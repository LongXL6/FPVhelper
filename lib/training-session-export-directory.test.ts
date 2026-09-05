import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { trainingSessionFilename, type TrainingSession } from "./training-session";
import {
  createTrainingSessionDirectoryStore,
  createTrainingSessionDirectoryWritable,
  getTrainingSessionDirectoryPermission,
  requestTrainingSessionDirectoryPermission,
  runTrainingSessionDirectoryAction,
  saveTrainingSessionToDirectory,
  closeTrainingSessionDirectoryStoreSafely,
  type TrainingSessionDirectoryHandle,
  type TrainingSessionDirectoryWritable,
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

function createEmptyDirectory(writable: TrainingSessionDirectoryWritable) {
  const getFileHandle = vi.fn(async (_name: string, options: { create: boolean }) => {
    if (!options.create) throw new DOMException("Missing", "NotFoundError");
    return { createWritable: async () => writable };
  });
  return { kind: "directory" as const, name: "FPV Sessions", getFileHandle };
}

function createMemoryDirectory(beforeClose?: (filename: string) => Promise<void>) {
  const files = new Map<string, Blob>();
  const directories = new Set<string>();
  const createWritable = vi.fn(async (filename: string) => {
    let pending = files.get(filename)!;
    return {
      write: async (data: Blob) => { pending = data; },
      close: async () => {
        await beforeClose?.(filename);
        files.set(filename, pending);
      },
    };
  });
  const getFileHandle = vi.fn(async (filename: string, options: { create: boolean }) => {
    if (directories.has(filename)) throw new DOMException("Directory exists", "TypeMismatchError");
    if (!files.has(filename)) {
      if (!options.create) throw new DOMException("Missing", "NotFoundError");
      files.set(filename, new Blob());
    }
    return { createWritable: () => createWritable(filename) };
  });
  return {
    files,
    directories,
    createWritable,
    handle: { kind: "directory" as const, name: "FPV Sessions", getFileHandle },
  };
}

afterEach(() => { vi.unstubAllGlobals(); });

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

  it("retries opening the directory store after an open rejection", async () => {
    const open = vi.fn(() => {
      const request = new EventTarget() as IDBOpenDBRequest;
      Object.defineProperty(request, "error", { value: new Error("open failed") });
      queueMicrotask(() => request.dispatchEvent(new Event("error")));
      return request;
    });
    const store = createTrainingSessionDirectoryStore({ open } as unknown as IDBFactory, "retry-open");

    await expect(store.load()).rejects.toThrow("open failed");
    await expect(store.load()).rejects.toThrow("open failed");
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("rejects a blocked open and closes a database that succeeds too late", async () => {
    const close = vi.fn();
    const open = vi.fn(() => {
      const request = new EventTarget() as IDBOpenDBRequest;
      Object.defineProperty(request, "result", { value: { close } });
      queueMicrotask(() => {
        request.dispatchEvent(new Event("blocked"));
        request.dispatchEvent(new Event("success"));
      });
      return request;
    });
    const store = createTrainingSessionDirectoryStore({ open } as unknown as IDBFactory, "blocked-open");

    await expect(store.load()).rejects.toThrow("数据库升级被其他页面阻止");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("contains a rejected close during StrictMode-style cleanup", async () => {
    const store = {
      load: async () => null,
      save: async () => undefined,
      clear: async () => undefined,
      close: async () => { throw new Error("close failed"); },
    };

    await expect(closeTrainingSessionDirectoryStoreSafely(store)).resolves.toBe(false);
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

  it("always opens the picker when replacing an already-authorized folder", async () => {
    const existingQueryPermission = vi.fn(async () => "granted" as const);
    const existingHandle = {
      kind: "directory",
      name: "Old Folder",
      queryPermission: existingQueryPermission,
    } as unknown as TrainingSessionDirectoryHandle;
    const replacementHandle = {
      kind: "directory",
      name: "New Folder",
      queryPermission: async () => "granted" as const,
    } as unknown as TrainingSessionDirectoryHandle;
    const picker = vi.fn(async () => replacementHandle);

    await expect(runTrainingSessionDirectoryAction({
      action: "replace",
      existingHandle,
      picker,
    })).resolves.toEqual({ handle: replacementHandle, granted: true });
    expect(picker).toHaveBeenCalledTimes(1);
    expect(existingQueryPermission).not.toHaveBeenCalled();
  });

  it("fails closed when the stored handle cannot expose permission", async () => {
    const handle = {} as TrainingSessionDirectoryHandle;

    await expect(getTrainingSessionDirectoryPermission(handle)).resolves.toBe("denied");
    await expect(requestTrainingSessionDirectoryPermission(handle)).resolves.toBe(false);
  });

  it("reports success only after writing and closing the directory file", async () => {
    const calls: string[] = [];
    const handle = createEmptyDirectory({
      write: async (data: Blob) => { calls.push(`write:${data.type}`); },
      close: async () => { calls.push("close"); },
    });

    const result = await saveTrainingSessionToDirectory(SESSION, handle);

    expect(result.bytes).toBeGreaterThan(0);
    expect(result.filename).toBe(trainingSessionFilename(SESSION));
    expect(calls).toEqual(["write:application/json", "close"]);
    expect(handle.getFileHandle).toHaveBeenNthCalledWith(1, result.filename, { create: false });
    expect(handle.getFileHandle).toHaveBeenNthCalledWith(2, result.filename, { create: true });
  });

  it("preserves every previous JSON when the same session is exported again", async () => {
    const directory = createMemoryDirectory();
    const first = await saveTrainingSessionToDirectory(SESSION, directory.handle);
    const original = await directory.files.get(first.filename)!.text();
    const second = await saveTrainingSessionToDirectory({ ...SESSION, exportCount: 2 }, directory.handle);
    const secondContents = await directory.files.get(second.filename)!.text();
    const third = await saveTrainingSessionToDirectory({ ...SESSION, exportCount: 3 }, directory.handle);

    expect(second.filename).toBe(first.filename.replace(/\.json$/, "-v2.json"));
    expect(third.filename).toBe(first.filename.replace(/\.json$/, "-v3.json"));
    expect(directory.files.size).toBe(3);
    expect(await directory.files.get(first.filename)!.text()).toBe(original);
    expect(await directory.files.get(second.filename)!.text()).toBe(secondContents);
    expect(JSON.parse(original).exportCount).toBe(1);
    expect(JSON.parse(secondContents).exportCount).toBe(2);
    expect(JSON.parse(await directory.files.get(third.filename)!.text()).exportCount).toBe(3);
    expect(directory.createWritable.mock.calls.map(([filename]) => filename)).toEqual([
      first.filename, second.filename, third.filename,
    ]);
  });

  it("holds the page queue until close completes before another export can probe", async () => {
    vi.stubGlobal("navigator", {});
    let releaseClose!: () => void;
    const closing = new Promise<void>((resolve) => { releaseClose = resolve; });
    const directory = createMemoryDirectory(() => closing);
    const onFirstSaved = vi.fn();
    const first = saveTrainingSessionToDirectory(SESSION, directory.handle).then((result) => {
      onFirstSaved();
      return result;
    });
    await vi.waitFor(() => expect(directory.createWritable).toHaveBeenCalledOnce());
    const probeCount = directory.handle.getFileHandle.mock.calls.length;
    const second = saveTrainingSessionToDirectory(SESSION, directory.handle);
    await Promise.resolve();

    expect(onFirstSaved).not.toHaveBeenCalled();
    expect(directory.handle.getFileHandle).toHaveBeenCalledTimes(probeCount);
    releaseClose();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.filename).not.toBe(secondResult.filename);
    expect(directory.files.size).toBe(2);
  });

  it("skips names occupied by directories and existing version files", async () => {
    const directory = createMemoryDirectory();
    const baseFilename = trainingSessionFilename(SESSION);
    directory.directories.add(baseFilename);
    const secondFilename = baseFilename.replace(/\.json$/, "-v2.json");
    const previous = new Blob(["original file"]);
    directory.files.set(secondFilename, previous);

    const result = await saveTrainingSessionToDirectory(SESSION, directory.handle);

    expect(result.filename).toBe(baseFilename.replace(/\.json$/, "-v3.json"));
    expect(directory.files.get(secondFilename)).toBe(previous);
    expect(directory.createWritable).toHaveBeenCalledExactlyOnceWith(result.filename);
  });

  it.each(["NotAllowedError", "SecurityError", "UnknownError"])(
    "does not create or overwrite when probing fails with %s",
    async (name) => {
      const failure = new DOMException("Cannot inspect directory", name);
      const getFileHandle = vi.fn(async () => { throw failure; });
      const handle = { kind: "directory" as const, name: "FPV Sessions", getFileHandle };

      await expect(saveTrainingSessionToDirectory(SESSION, handle)).rejects.toBe(failure);
      expect(getFileHandle).toHaveBeenCalledExactlyOnceWith(trainingSessionFilename(SESSION), { create: false });
    },
  );

  it("stops after a bounded scan without opening any occupied file for writing", async () => {
    const createWritable = vi.fn();
    const getFileHandle = vi.fn<TrainingSessionDirectoryHandle["getFileHandle"]>(async () => ({ createWritable }));
    const handle = { kind: "directory" as const, name: "Full Folder", getFileHandle };

    await expect(saveTrainingSessionToDirectory(SESSION, handle)).rejects.toThrow("导出版本已达 1000 个");
    expect(getFileHandle).toHaveBeenCalledTimes(1_000);
    expect(getFileHandle.mock.calls.every(([, options]) => options.create === false)).toBe(true);
    expect(createWritable).not.toHaveBeenCalled();
  });

  it("waits for a shared exclusive Web Lock before probing and holds it through close", async () => {
    let releaseOtherTab!: () => void;
    const otherTabLock = new Promise<void>((resolve) => { releaseOtherTab = resolve; });
    let releaseClose!: () => void;
    const closing = new Promise<void>((resolve) => { releaseClose = resolve; });
    const released = vi.fn();
    const request = vi.fn(async (_name: string, _options: { mode: string }, callback: () => Promise<unknown>) => {
      await otherTabLock;
      try { return await callback(); } finally { released(); }
    });
    vi.stubGlobal("navigator", { locks: { request } });
    const directory = createMemoryDirectory(() => closing);
    const pending = saveTrainingSessionToDirectory(SESSION, directory.handle);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    expect(request).toHaveBeenCalledWith("fpvhelper-training-json-export", { mode: "exclusive" }, expect.any(Function));
    expect(directory.handle.getFileHandle).not.toHaveBeenCalled();

    // A different tab finishes its export while we wait for the same origin lock.
    const original = new Blob(["other tab export"]);
    directory.files.set(trainingSessionFilename(SESSION), original);
    releaseOtherTab();
    await vi.waitFor(() => expect(directory.createWritable).toHaveBeenCalledOnce());
    expect(released).not.toHaveBeenCalled();
    releaseClose();
    const result = await pending;
    expect(result.filename).toBe(trainingSessionFilename(SESSION).replace(/\.json$/, "-v2.json"));
    expect(directory.files.get(trainingSessionFilename(SESSION))).toBe(original);
    expect(released).toHaveBeenCalledOnce();
  });

  it("does not fall back to an unlocked export if Web Lock acquisition fails", async () => {
    const failure = new Error("lock unavailable");
    vi.stubGlobal("navigator", { locks: { request: vi.fn(async () => { throw failure; }) } });
    const directory = createMemoryDirectory();

    await expect(saveTrainingSessionToDirectory(SESSION, directory.handle)).rejects.toBe(failure);
    expect(directory.handle.getFileHandle).not.toHaveBeenCalled();
  });

  it("opens a reusable writable for a generated local video filename", async () => {
    const writable = { write: vi.fn(async () => undefined), close: vi.fn(async () => undefined) };
    const getFileHandle = vi.fn(async () => ({ createWritable: async () => writable }));
    const handle = { kind: "directory", name: "FPV Sessions", getFileHandle } as TrainingSessionDirectoryHandle;

    await expect(createTrainingSessionDirectoryWritable(handle, "fpv-video-test.webm")).resolves.toBe(writable);
    expect(getFileHandle).toHaveBeenCalledWith("fpv-video-test.webm", { create: true });
    await expect(createTrainingSessionDirectoryWritable(handle, "../escape.webm")).rejects.toThrow("本地文件名无效");
  });

  it("does not confirm a directory export when closing fails", async () => {
    const abort = vi.fn(async () => undefined);
    const handle = createEmptyDirectory({
      write: async () => undefined,
      close: async () => { throw new Error("disk full"); },
      abort,
    });

    await expect(saveTrainingSessionToDirectory(SESSION, handle)).rejects.toThrow("disk full");
    expect(abort).toHaveBeenCalledOnce();
  });

  it("aborts a failed write without closing partial output and allows the next export", async () => {
    const failure = new Error("write failed");
    const close = vi.fn(async () => undefined);
    const abort = vi.fn(async () => { throw new Error("abort failed"); });
    const handle = createEmptyDirectory({
      write: async () => { throw failure; },
      close,
      abort,
    });

    await expect(saveTrainingSessionToDirectory(SESSION, handle)).rejects.toBe(failure);
    expect(abort).toHaveBeenCalledExactlyOnceWith(failure);
    expect(close).not.toHaveBeenCalled();
    const directory = createMemoryDirectory();
    await expect(saveTrainingSessionToDirectory(SESSION, directory.handle)).resolves.toMatchObject({
      filename: trainingSessionFilename(SESSION),
    });
  });

  it("preserves a write failure when the writable has no abort method", async () => {
    const close = vi.fn(async () => undefined);
    const handle = createEmptyDirectory({
      write: async () => { throw new Error("write failed"); },
      close,
    });

    await expect(saveTrainingSessionToDirectory(SESSION, handle)).rejects.toThrow("write failed");
    expect(close).not.toHaveBeenCalled();
  });
});
