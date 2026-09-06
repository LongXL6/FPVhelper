/** Test-only picker and fault controls; no business state, records or DOM changes. */
export function installPhase2ACuaDirectoryControls(options: { channelName: string; nonce: string; directoryNamespace: string; expiresAtEpochMs: number }) {
  if (location.origin !== "http://127.0.0.1:3140" || new URL(location.href).searchParams.get("directoryFixture") !== "phase2a-r1") return;
  if (!/^phase2a-directory-[a-f0-9]{32}$/.test(options.channelName) || !/^[a-f0-9]{64}$/.test(options.nonce)
    || !/^phase2a-r1-[a-f0-9]{32}$/.test(options.directoryNamespace) || !Number.isFinite(options.expiresAtEpochMs)
    || options.expiresAtEpochMs <= Date.now() || options.expiresAtEpochMs > Date.now() + 900000) throw new Error("Invalid or expired directory fixture scope");
  const scope = window as unknown as Window & {
    __phase2aMediaGate?: { release(): void; releaseJson(): void };
    __phase2aCuaDirectoryControls?: unknown;
  };
  if (scope.__phase2aCuaDirectoryControls) throw new Error("Directory fixture already installed");
  const gate = scope.__phase2aMediaGate;
  if (!gate || typeof gate.release !== "function" || typeof gate.releaseJson !== "function") throw new Error("Install the existing media/JSON gates first");
  const protocol = "phase2a-directory-control/v1", channel = new BroadcastChannel(options.channelName);
  const events: Array<{ kind: string; value: string; atMs: number }> = [];
  const released = new Set<string>(), handled = new Set<string>();
  let picks = 0, disposed = false;
  const mark = (kind: string, value: string) => { if (events.length < 64) events.push({ kind, value, atMs: performance.now() }); };
  Object.defineProperty(window, "showDirectoryPicker", { configurable: true, value: async () => {
    if (disposed || Date.now() >= options.expiresAtEpochMs) throw new DOMException("Test directory fixture expired", "AbortError");
    const name = ++picks === 1 ? "D1" : "D2";
    const root = await navigator.storage.getDirectory();
    const namespace = await root.getDirectoryHandle(options.directoryNamespace, { create: true });
    const directory = await namespace.getDirectoryHandle(name, { create: true });
    mark("directory-selected", name);
    return directory;
  } });
  channel.onmessage = (event: MessageEvent) => {
    const data = event.data;
    if (disposed || Date.now() >= options.expiresAtEpochMs || !data || data.protocol !== protocol || data.kind !== "command"
      || data.nonce !== options.nonce || !["release_media", "release_json"].includes(data.action)
      || typeof data.requestId !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(data.requestId) || handled.size >= 32) return;
    if (handled.has(data.requestId)) return;
    handled.add(data.requestId);
    if (!released.has(data.action)) {
      if (data.action === "release_media") gate.release();
      else gate.releaseJson();
      released.add(data.action); mark("fault-released", data.action);
    }
    channel.postMessage({ protocol, kind: "ack", nonce: options.nonce, action: data.action, requestId: data.requestId });
  };
  const dispose = () => { if (!disposed) { disposed = true; channel.close(); window.clearTimeout(expiry); } };
  const expiry = window.setTimeout(dispose, Math.max(1, options.expiresAtEpochMs - Date.now()));
  window.addEventListener("pagehide", dispose, { once: true });
  scope.__phase2aCuaDirectoryControls = { snapshot: () => ({ fixture: "phase2a-r1", directoryNamespace: options.directoryNamespace, picks, disposed, events: [...events] }) };
}
