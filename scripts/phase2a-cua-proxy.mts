import { createServer, type IncomingMessage } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Script, createContext } from "node:vm";
import assert from "node:assert/strict";
import { installPhase2ACuaMedia } from "../e2e/fixtures/phase2a-cua-media.ts";
import { installMeasurementHardware } from "../e2e/fixtures/measurement-hardware.ts";
import { installPhase2AMediaGate } from "../e2e/fixtures/phase2a-media-gate.ts";
import { installPhase2ACuaDirectoryControls } from "../e2e/fixtures/phase2a-cua-directory-controls.ts";

const upstream = "http://127.0.0.1:3138", origin = "http://127.0.0.1:3140";
const root = fileURLToPath(new URL("../", import.meta.url));
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const args = process.argv.slice(2);
if (args.some((arg, index) => arg !== "--self-test" && arg !== "--output" && args[index - 1] !== "--output") || args.filter((arg) => arg === "--output").length > 1) throw new Error("Use --self-test or --output <new ignored directory>");
const script = `(()=>{if(location.origin!==${JSON.stringify(origin)})return;(${installPhase2ACuaMedia.toString()})();(${installMeasurementHardware.toString()})({inputHz:100,detailed:false,maxFrames:30000,maxEvents:200000});(${installPhase2AMediaGate.toString()})();Object.defineProperty(window,"__phase2aCuaProxyReady",{value:true});})();`;
new Script(script);
const directoryOptions = { channelName: `phase2a-directory-${randomBytes(16).toString("hex")}`, nonce: randomBytes(32).toString("hex"), directoryNamespace: `phase2a-r1-${randomBytes(16).toString("hex")}`, expiresAtEpochMs: Date.now() + 900000 };
const directoryScript = script + `\n(${installPhase2ACuaDirectoryControls.toString()})(${JSON.stringify(directoryOptions)});`;
new Script(directoryScript);
function scriptForPath(path: string) { return new URL(path, origin).searchParams.get("directoryFixture") === "phase2a-r1" ? directoryScript : script; }
function controlsPath(path: string, method = "GET") { return path === "/__phase2a/controls" && ["GET", "HEAD"].includes(method); }
const controlScript = `(()=>{const settings=${JSON.stringify(directoryOptions)},protocol="phase2a-directory-control/v1",channel=new BroadcastChannel(settings.channelName),pending=new Set(),status=document.getElementById("control-status");
for(const action of ["release_media","release_json"]){document.getElementById(action).addEventListener("click",()=>{if(Date.now()>=settings.expiresAtEpochMs){status.textContent="This proxy control session expired.";return;}if(pending.size>=32){status.textContent="Test control request limit reached.";return;}const requestId=crypto.randomUUID();pending.add(requestId);channel.postMessage({protocol,kind:"command",nonce:settings.nonce,action,requestId});status.textContent="Release requested; waiting for test fixture acknowledgement.";});}
channel.onmessage=event=>{const data=event.data;if(data&&data.protocol===protocol&&data.kind==="ack"&&data.nonce===settings.nonce&&pending.delete(data.requestId)){status.textContent=(data.action==="release_media"?"Media":"JSON")+" fault release acknowledged. Check the product page for the actual result.";}};addEventListener("pagehide",()=>channel.close(),{once:true});})();`;
const controlsHtml = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Phase2A Fault Controls</title><style>body{font:18px system-ui;margin:48px;max-width:760px}button{font:inherit;padding:14px;margin:8px 12px 8px 0}p{line-height:1.6}</style></head><body><h1>Phase2A 测试故障控制</h1><p>此页只释放当前代理的测试闸门，不加载产品、不获取工作站锁，也不访问文件。请回产品页用正常按钮操作和检查实际结果。</p><button type="button" id="release_media">释放媒体闸门</button><button type="button" id="release_json">释放 JSON 闸门</button><p id="control-status" role="status">Ready for the current proxy's optional directory fixture.</p><script>${controlScript.replace(/<\/script/gi, "<\\/script")}</script></body></html>`;
new Script(controlScript);
function allowedPath(raw: string, method = "GET") {
  if (!["GET", "HEAD"].includes(method) || !raw.startsWith("/") || raw.startsWith("//") || raw.length > 2048 || /\\|\0|\.\.|%(?:2e|2f|5c|00|25)/i.test(raw.split("?")[0])) return false;
  const url = new URL(raw, upstream);
  if (url.origin !== upstream) return false;
  if (url.pathname === "/") return [...url.searchParams.keys()].every((key) => ["analytics", "mediaGate", "_rsc", "directoryFixture", "jsonGate"].includes(key))
    && (!url.searchParams.has("analytics") || url.searchParams.get("analytics") === "off")
    && (!url.searchParams.has("mediaGate") || ["normal", "before-close", "after-close", "reject-after-close"].includes(url.searchParams.get("mediaGate")!))
    && url.searchParams.getAll("directoryFixture").length <= 1 && url.searchParams.getAll("jsonGate").length <= 1
    && (!url.searchParams.has("directoryFixture") || url.searchParams.get("directoryFixture") === "phase2a-r1")
    && (!url.searchParams.has("jsonGate") || (url.searchParams.get("directoryFixture") === "phase2a-r1" && url.searchParams.get("jsonGate") === "first"));
  return ["/version.json", "/favicon.ico", "/icon.svg"].includes(url.pathname) || /^\/_next\/static\/[a-zA-Z0-9_./+-]+$/.test(url.pathname);
}
function injectHtml(html: string, path = "/") {
  const head = /<head(?:\s[^>]*)?>/i.exec(html);
  if (!head || (html.search(/<script\b/i) >= 0 && html.search(/<script\b/i) < head.index + head[0].length)) throw new Error("Cannot install fixture before product scripts");
  const position = head.index + head[0].length;
  return html.slice(0, position) + `<script id="phase2a-cua-fixture">${scriptForPath(path).replace(/<\/script/gi, "<\\/script")}</script>` + html.slice(position);
}

async function selfTest() {
  assert.equal(allowedPath("/?analytics=off&mediaGate=before-close"), true);
  assert.equal(allowedPath("/_next/static/chunks/app.js"), true);
  for (const path of ["http://example.com/", "//example.com/", "/api/events", "/etc/passwd", "/_next/static/%252e/file", "/?url=http://example.com", "/?analytics=on"]) assert.equal(allowedPath(path), false);
  assert.equal(allowedPath("/", "POST"), false);
  const directoryPath = "/?analytics=off&mediaGate=after-close&jsonGate=first&directoryFixture=phase2a-r1";
  assert.equal(allowedPath(directoryPath), true);
  for (const path of ["/?directoryFixture=other", "/?jsonGate=first", "/?directoryFixture=phase2a-r1&jsonGate=other", "/?directoryFixture=phase2a-r1&directoryFixture=other"]) assert.equal(allowedPath(path), false);
  assert.equal(controlsPath("/__phase2a/controls"), true); assert.equal(controlsPath("/__phase2a/controls", "HEAD"), true);
  assert.equal(controlsPath("/__phase2a/controls", "POST"), false); assert.equal(controlsPath("/__phase2a/controls?url=bad"), false);
  assert.equal(scriptForPath("/?analytics=off&mediaGate=after-close"), script);
  assert.ok(scriptForPath(directoryPath).startsWith(script));
  assert.equal((controlsHtml.match(/<button /g) ?? []).length, 2); assert.equal(controlsHtml.includes("/_next/"), false);
  assert.equal(controlScript.includes("__phase2aMediaGate"), false);
  const html = injectHtml('<html><head><script src="app.js"></script></head><body></body></html>');
  assert.ok(html.indexOf('id="phase2a-cua-fixture"') < html.indexOf('src="app.js"'));
  let timerId = 0, realMediaRequests = 0, nativeCloses = 0;
  const intervals = new Map<number, unknown>(), timeouts = new Map<number, unknown>();
  class TestTrack extends EventTarget { kind = "video"; readyState = "live"; stop() { this.readyState = "ended"; } getSettings() { return {}; } }
  class TestHandle { name = "synthetic.mp4"; async createWritable() { return { close: async () => { nativeCloses += 1; } }; } }
  const sandbox = createContext({ location: { protocol: "http:", hostname: "127.0.0.1", port: "3140", origin, href: origin + "/?mediaGate=before-close" },
    navigator: { mediaDevices: { getUserMedia: async () => { realMediaRequests += 1; throw new Error("Real device path called"); } }, storage: { getDirectory: async () => ({}) } },
    document: { createElement: (tag: string) => { assert.equal(tag, "canvas"); return { width: 0, height: 0, getContext: () => ({ fillRect() {}, fillText() {} }), captureStream: () => { const track = new TestTrack(); return { getVideoTracks: () => [track], getTracks: () => [track] }; } }; } },
    setInterval: (fn: unknown) => { intervals.set(++timerId, fn); return timerId; }, clearInterval: (id: number) => intervals.delete(id),
    setTimeout: (fn: unknown) => { timeouts.set(++timerId, fn); return timerId; }, clearTimeout: (id: number) => timeouts.delete(id),
    addEventListener() {}, EventTarget, DOMException, URL, performance, ReadableStream, WritableStream, TextEncoder, Uint8Array, DataView, FileSystemFileHandle: TestHandle });
  sandbox.window = sandbox;
  new Script(script).runInContext(sandbox);
  const deviceList = await sandbox.navigator.mediaDevices.enumerateDevices();
  assert.equal(deviceList[0].deviceId, "phase2a-cua-synthetic-video");
  const stream = await sandbox.navigator.mediaDevices.getUserMedia({ video: true, audio: false });
  const track = stream.getVideoTracks()[0];
  assert.equal(track.getSettings().width, 1920); assert.equal(track.getSettings().frameRate, 30); assert.equal(track.readyState, "live");
  track.stop(); assert.equal(track.readyState, "ended"); assert.equal(intervals.size, 0); assert.equal(timeouts.size, 0); assert.equal(realMediaRequests, 0);
  const port = await sandbox.navigator.serial.requestPort(); await port.open({ baudRate: 115200 });
  const reader = port.readable.getReader(), writer = port.writable.getWriter();
  await writer.write(Uint8Array.of(36, 77, 60, 0, 105, 105));
  const frame = await reader.read(); assert.equal(frame.value[4], 105); assert.equal(sandbox.__fpvMeasurementHardware.snapshot().frames.length, 1);
  writer.releaseLock(); await reader.cancel(); reader.releaseLock(); await port.close();
  const writable = await new TestHandle().createWritable(); const closing = writable.close(); await Promise.resolve();
  assert.equal(nativeCloses, 0); sandbox.__phase2aMediaGate.release(); await closing; assert.equal(nativeCloses, 1);
  class TestChannel {
    static peers = new Map<string, Set<TestChannel>>();
    onmessage: ((event: { data: unknown }) => void) | null = null;
    constructor(readonly name: string) { const peers = TestChannel.peers.get(name) ?? new Set<TestChannel>(); peers.add(this); TestChannel.peers.set(name, peers); }
    postMessage(data: unknown) { for (const peer of TestChannel.peers.get(this.name) ?? []) if (peer !== this) queueMicrotask(() => peer.onmessage?.({ data })); }
    close() { TestChannel.peers.get(this.name)?.delete(this); this.onmessage = null; }
  }
  const d1 = { name: "D1", kind: "directory" }, d2 = { name: "D2", kind: "directory" }, directoryNames: string[] = [], pageHide: Array<() => void> = [];
  let mediaReleases = 0, jsonReleases = 0;
  const directorySandbox = createContext({ location: { origin, href: origin + directoryPath }, URL, DOMException, performance, BroadcastChannel: TestChannel,
    navigator: { storage: { getDirectory: async () => ({ getDirectoryHandle: async (namespace: string) => { assert.equal(namespace, directoryOptions.directoryNamespace); return { getDirectoryHandle: async (name: string) => { directoryNames.push(name); return name === "D1" ? d1 : d2; } }; } }) } },
    __phase2aMediaGate: { release: () => { mediaReleases++; }, releaseJson: () => { jsonReleases++; } },
    setTimeout: sandbox.setTimeout, clearTimeout: sandbox.clearTimeout, addEventListener: (_kind: string, callback: () => void) => pageHide.push(callback) });
  directorySandbox.window = directorySandbox;
  new Script(`(${installPhase2ACuaDirectoryControls.toString()})(${JSON.stringify(directoryOptions)});`).runInContext(directorySandbox);
  assert.equal(await directorySandbox.showDirectoryPicker(), d1); assert.equal(await directorySandbox.showDirectoryPicker(), d2); assert.equal(await directorySandbox.showDirectoryPicker(), d2);
  assert.deepEqual(directoryNames, ["D1", "D2", "D2"]);
  const wrongNonce = new TestChannel(directoryOptions.channelName), wrongChannel = new TestChannel(directoryOptions.channelName + "-old");
  wrongNonce.postMessage({ protocol: "phase2a-directory-control/v1", kind: "command", nonce: "wrong", action: "release_media", requestId: "wrong-nonce" });
  wrongChannel.postMessage({ protocol: "phase2a-directory-control/v1", kind: "command", nonce: directoryOptions.nonce, action: "release_media", requestId: "wrong-channel" });
  await new Promise((done) => setTimeout(done, 0)); assert.equal(mediaReleases, 0); assert.equal(jsonReleases, 0);
  const clicks = new Map<string, () => void>(), status = { textContent: "" }; let requestNumber = 0;
  const controlsSandbox = createContext({ BroadcastChannel: TestChannel, crypto: { randomUUID: () => `test-request-${++requestNumber}` },
    document: { getElementById: (id: string) => id === "control-status" ? status : { addEventListener: (_kind: string, callback: () => void) => clicks.set(id, callback) } }, addEventListener() {} });
  new Script(controlScript).runInContext(controlsSandbox);
  clicks.get("release_media")!(); await new Promise((done) => setTimeout(done, 0));
  assert.equal(mediaReleases, 1); assert.ok(status.textContent.startsWith("Media fault release acknowledged"));
  clicks.get("release_json")!(); await new Promise((done) => setTimeout(done, 0));
  assert.equal(jsonReleases, 1); assert.ok(status.textContent.startsWith("JSON fault release acknowledged"));
  clicks.get("release_media")!(); await new Promise((done) => setTimeout(done, 0)); assert.equal(mediaReleases, 1);
  pageHide.forEach((callback) => callback()); assert.equal(timeouts.size, 0); wrongNonce.close(); wrongChannel.close();
  console.log(JSON.stringify({ selfTest: "passed", injectionSha256: hash(script), checks: ["fixed route/method allowlist", "default injection unchanged", "optional directory/query and control page HTTP response shape", "injection before product scripts", "synthetic device/track/settings/stop", "no native getUserMedia", "one real-stream MSP fixture response", "test-only media close gate", "D1 then D2 native-handle passthrough contract with VM mocks", "nonce/channel rejection and control button acknowledgements", "idempotent gate release and channel cleanup"], boundary: "Node VM/HTTP-response generation only; no proxy started and no live IAB/OPFS/browser validation" }));
}
if (args.includes("--self-test")) { await selfTest(); process.exit(0); }

const optionIndex = args.indexOf("--output");
const output = resolve(root, optionIndex >= 0 ? args[optionIndex + 1] ?? "" : `output/playwright/phase2a-cua-proxy-${Date.now()}`);
if (!output.startsWith(resolve(root, "output/playwright") + "/")) throw new Error("Use a new ignored output directory");
const buildId = (await readFile(resolve(root, ".next/BUILD_ID"), "utf8")).trim();
const upstreamControllers = new Set<AbortController>();
const files = ["scripts/phase2a-cua-proxy.mts", "e2e/fixtures/phase2a-cua-media.ts", "e2e/fixtures/measurement-hardware.ts", "e2e/fixtures/phase2a-media-gate.ts", "e2e/fixtures/phase2a-cua-directory-controls.ts"];
const metadata: Record<string, unknown> = { purpose: "Phase2A IAB test-only loopback response injection", pid: process.pid, upstream, origin, buildId,
  checkoutHeadAtProxyStartup: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  upstreamSourceBinding: "BUILD_ID is read from the parent's existing server worktree; bind its served source via the parent's build receipt, not this proxy checkout HEAD.",
  sourceFiles: Object.fromEntries(await Promise.all(files.map(async (path) => [path, hash(await readFile(resolve(root, path)))]))),
  injectionSha256: hash(script), injectionOrder: ["canvas getUserMedia/enumerateDevices", "measurement-hardware", "phase2a-media-gate"],
  optionalDirectoryFixture: { query: "directoryFixture=phase2a-r1", injectionSha256: hash(directoryScript), installedAfterExistingBootstrap: true, controlsPath: "/__phase2a/controls", controlsHtmlSha256: hash(controlsHtml), nonceSha256: hash(directoryOptions.nonce), channelNameSha256: hash(directoryOptions.channelName), directoryNamespace: directoryOptions.directoryNamespace, expiresAtEpochMs: directoryOptions.expiresAtEpochMs, targets: ["D1", "D2"], actions: ["release_media", "release_json"], boundary: "Real OPFS subdirectories; no record seeding/deletion or business actions. Control page only releases existing test faults." },
  syntheticMedia: { width: 1920, height: 1080, frameRate: 30, maxLiveStreams: 4, maxLifetimeMs: 900000 },
  boundary: "HTML is modified by this test proxy and is not the canonical unmodified build response. Real MediaRecorder/compositor/IDB/OPFS remain; no business DOM/state/session injection. No browser acceptance yet.",
  startedAtUtc: new Date().toISOString(), requests: [], shutdown: null };
const records: Array<Record<string, unknown>> = []; metadata.requests = records;
async function upstreamResponse(path: string) {
  const controller = new AbortController(); upstreamControllers.add(controller);
  const deadline = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(upstream + path, { redirect: "manual", signal: controller.signal, headers: { "accept-encoding": "identity" } });
    const chunks: Buffer[] = []; let size = 0;
    if (response.body) {
      for await (const chunk of response.body) { size += chunk.length; if (size > 16 * 1024 * 1024) { controller.abort(); throw new Error("Upstream response exceeds 16 MiB cap"); } chunks.push(Buffer.from(chunk)); }
    }
    return { status: response.status, contentType: response.headers.get("content-type") ?? "application/octet-stream", body: Buffer.concat(chunks) };
  } finally { clearTimeout(deadline); upstreamControllers.delete(controller); }
}
const canonical = await upstreamResponse("/?analytics=off");
if (canonical.status !== 200 || !canonical.contentType.includes("text/html")) throw new Error("Confirmed upstream is not serving the expected HTML");
const startupInjected = injectHtml(canonical.body.toString());
metadata.startupResponse = { canonicalBytes: canonical.body.length, canonicalSha256: hash(canonical.body), injectedBytes: Buffer.byteLength(startupInjected), injectedSha256: hash(startupInjected) };
await mkdir(output, { recursive: false });
await writeFile(resolve(output, "injected-fixtures.js"), script);
let writes = Promise.resolve();
const save = () => { writes = writes.then(() => writeFile(resolve(output, "proxy-receipt.json"), JSON.stringify(metadata, null, 2) + "\n")); return writes; };
await save();
function localRequest(request: IncomingMessage) { return ["127.0.0.1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress ?? "") && request.headers.host === "127.0.0.1:3140"; }
const server = createServer(async (request, response) => {
  try {
    if (!localRequest(request)) { response.writeHead(403); response.end("Loopback host only"); return; }
    if (controlsPath(request.url ?? "", request.method)) {
      const body = Buffer.from(controlsHtml);
      if (records.length < 200) records.push({ path: "/__phase2a/controls", method: request.method, testControlPage: true, responseSha256: hash(body) });
      await save(); response.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": body.length, "cache-control": "no-store", "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'", "permissions-policy": "camera=(), microphone=(), geolocation=()" });
      response.end(request.method === "HEAD" ? undefined : body); return;
    }
    if (request.url === "/__phase2a/health" && request.method === "GET") { response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }); response.end(JSON.stringify({ ready: true, pid: process.pid, upstream, buildId, injectionSha256: hash(script) })); return; }
    if (!allowedPath(request.url ?? "", request.method)) {
      if (records.length < 200) records.push({ path: request.url?.split("?")[0], method: request.method, denied: true });
      await save(); response.writeHead(403); response.end("Test proxy path/method denied"); return;
    }
    const value = await upstreamResponse(request.url!);
    const isHtml = value.contentType.includes("text/html");
    const body = isHtml ? Buffer.from(injectHtml(value.body.toString(), request.url!)) : value.body;
    const headers: Record<string, string | number> = { "content-type": value.contentType, "content-length": body.length, "cache-control": "no-store", "x-phase2a-cua-proxy": "synthetic-fixtures", "permissions-policy": "camera=(), microphone=(), geolocation=()" };
    if (isHtml) headers["content-security-policy"] = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; worker-src 'self' blob:; font-src 'self' data:; object-src 'none'; base-uri 'self'; form-action 'none'";
    if (isHtml && records.length < 200) { records.push({ path: request.url, method: request.method, upstreamStatus: value.status, upstreamSha256: hash(value.body), injectedSha256: hash(body), injectionSha256: hash(scriptForPath(request.url!)) }); await save(); }
    response.writeHead(value.status, headers); response.end(request.method === "HEAD" ? undefined : body);
  } catch (error) { response.writeHead(502, { "content-type": "text/plain" }); response.end("Owned test proxy request failed"); if (records.length < 200) records.push({ error: String(error) }); await save(); }
});
server.headersTimeout = 10000; server.requestTimeout = 15000;
server.on("connect", (_request, socket) => socket.destroy()); server.on("upgrade", (_request, socket) => socket.destroy());
await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(3140, "127.0.0.1", done); });
let closing = false;
async function shutdown(reason: string) {
  if (closing) return; closing = true; clearTimeout(lifetime);
  upstreamControllers.forEach((controller) => controller.abort());
  server.close(); server.closeAllConnections();
  metadata.shutdown = { reason, atUtc: new Date().toISOString(), upstreamStopped: false }; await save();
}
const lifetime = setTimeout(() => void shutdown("15-minute owned proxy deadline"), 900000);
process.once("SIGTERM", () => void shutdown("SIGTERM")); process.once("SIGINT", () => void shutdown("SIGINT"));
console.log(JSON.stringify({ ready: true, pid: process.pid, url: origin + "/?analytics=off&mediaGate=before-close", directoryUrl: origin + "/?analytics=off&mediaGate=after-close&jsonGate=first&directoryFixture=phase2a-r1", controlsUrl: origin + "/__phase2a/controls", health: origin + "/__phase2a/health", upstream, buildId, injectionSha256: hash(script), directoryInjectionSha256: hash(directoryScript), output, cleanup: `kill -TERM ${process.pid}`, lifetimeMs: 900000, browserValidation: "pending parent IAB UI test" }));
