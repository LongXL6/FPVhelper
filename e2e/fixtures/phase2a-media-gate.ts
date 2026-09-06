/** Test-only device/file faults, installed before navigation. No application state or DOM writes. */
export function installPhase2AMediaGate() {
  if (location.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(location.hostname)) return;
  const mode = new URL(location.href).searchParams.get("mediaGate") ?? "normal";
  const events: Array<{ kind: string; filename?: string; atMs: number }> = [];
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const mark = (kind: string, filename?: string) => { if (events.length < 100) events.push({ kind, filename, atMs: performance.now() }); };
  const createWritable = FileSystemFileHandle.prototype.createWritable;
  FileSystemFileHandle.prototype.createWritable = async function (...args) {
    const stream = await createWritable.apply(this, args);
    if (!/\.(mp4|webm)$/.test(this.name)) return stream;
    const filename = this.name;
    mark("media-writable-created", filename);
    const originalClose = stream.close.bind(stream);
    stream.close = async () => {
      mark("media-close-entered", filename);
      if (mode === "before-close") await wait;
      await originalClose();
      mark("media-underlying-close-resolved", filename);
      if (mode === "after-close") await wait;
      if (mode === "reject-after-close") throw new Error("Synthetic media close acknowledgement failure");
      mark("media-close-returned", filename);
    };
    return stream;
  };
  Object.assign(window, { __phase2aMediaGate: { mode, snapshot: () => ({mode, events: [...events]}), release: () => {mark("gate-released"); release();} } });
}
