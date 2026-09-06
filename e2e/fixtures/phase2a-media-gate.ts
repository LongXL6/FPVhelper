/** Test-only device/file faults, installed before navigation. No application state or DOM writes. */
export function installPhase2AMediaGate() {
  if (location.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(location.hostname)) return;
  const mode = new URL(location.href).searchParams.get("mediaGate") ?? "normal";
  const events: Array<{ kind: string; filename?: string; atMs: number }> = [];
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  let releaseJson!: () => void;
  const jsonWait = new Promise<void>((resolve) => { releaseJson = resolve; });
  let jsonFiles = 0;
  const mark = (kind: string, filename?: string) => { if (events.length < 100) events.push({ kind, filename, atMs: performance.now() }); };
  const createWritable = FileSystemFileHandle.prototype.createWritable;
  FileSystemFileHandle.prototype.createWritable = async function (...args) {
    const stream = await createWritable.apply(this, args);
    if (this.name.endsWith(".json") && new URL(location.href).searchParams.get("jsonGate") === "first") {
      const filename = this.name, close = stream.close.bind(stream);
      mark("json-writable-created", filename);
      if (jsonFiles++ === 0) stream.close = async () => { mark("json-close-entered", filename); await jsonWait; await close(); mark("json-close-returned", filename); };
    }
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
  const faults = new URL(location.href).searchParams;
  if (faults.get("rcFault") === "once" || faults.get("associationFault") === "once") {
    const put = IDBObjectStore.prototype.put;
    let rcFailed = false, associationFailed = false;
    IDBObjectStore.prototype.put = function (value, key) {
      if (this.name === "sessionIndex" && value?.status === "ready") {
        const state = value?.metadata?.finalization?.media?.state;
        if (state === "pending" && faults.get("rcFault") === "once" && !rcFailed) {
          rcFailed = true; mark("rc-final-transaction-fault"); throw new DOMException("Synthetic RC final transaction failure", "QuotaExceededError");
        }
        if (state === "recorded" && faults.get("associationFault") === "once" && !associationFailed) {
          associationFailed = true; mark("media-association-transaction-fault"); throw new DOMException("Synthetic media association failure", "QuotaExceededError");
        }
      }
      return put.call(this, value, key);
    };
  }
  Object.assign(window, { __phase2aMediaGate: { mode, snapshot: () => ({mode, events: [...events]}), release: () => {mark("gate-released"); release();}, releaseJson: () => {mark("json-gate-released"); releaseJson();} } });
}
