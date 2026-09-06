import { createServer, type IncomingMessage } from "node:http";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Script, createContext } from "node:vm";
import assert from "node:assert/strict";
import { installPhase2ACuaMedia } from "../e2e/fixtures/phase2a-cua-media.ts";
import { installMeasurementHardware } from "../e2e/fixtures/measurement-hardware.ts";
import { installPhase2AMediaGate } from "../e2e/fixtures/phase2a-media-gate.ts";

const upstream = "http://127.0.0.1:3138", origin = "http://127.0.0.1:3140";
const root = fileURLToPath(new URL("../", import.meta.url));
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const args = process.argv.slice(2);
if (args.some((arg, index) => arg !== "--self-test" && arg !== "--output" && args[index - 1] !== "--output") || args.filter((arg) => arg === "--output").length > 1) throw new Error("Use --self-test or --output <new ignored directory>");
const script = `(()=>{if(location.origin!==${JSON.stringify(origin)})return;(${installPhase2ACuaMedia.toString()})();(${installMeasurementHardware.toString()})({inputHz:100,detailed:false,maxFrames:30000,maxEvents:200000});(${installPhase2AMediaGate.toString()})();Object.defineProperty(window,"__phase2aCuaProxyReady",{value:true});})();`;
new Script(script);
function allowedPath(raw: string, method = "GET") {
  if (!["GET", "HEAD"].includes(method) || !raw.startsWith("/") || raw.startsWith("//") || raw.length > 2048 || /\\|\0|\.\.|%(?:2e|2f|5c|00|25)/i.test(raw.split("?")[0])) return false;
  const url = new URL(raw, upstream);
  if (url.origin !== upstream) return false;
  if (url.pathname === "/") return [...url.searchParams.keys()].every((key) => ["analytics", "mediaGate", "_rsc"].includes(key))
    && (!url.searchParams.has("analytics") || url.searchParams.get("analytics") === "off")
    && (!url.searchParams.has("mediaGate") || ["normal", "before-close", "after-close", "reject-after-close"].includes(url.searchParams.get("mediaGate")!));
  return ["/version.json", "/favicon.ico", "/icon.svg"].includes(url.pathname) || /^\/_next\/static\/[a-zA-Z0-9_./+-]+$/.test(url.pathname);
}
function injectHtml(html: string) {
  const head = /<head(?:\s[^>]*)?>/i.exec(html);
  if (!head || (html.search(/<script\b/i) >= 0 && html.search(/<script\b/i) < head.index + head[0].length)) throw new Error("Cannot install fixture before product scripts");
  const position = head.index + head[0].length;
  return html.slice(0, position) + `<script id="phase2a-cua-fixture">${script.replace(/<\/script/gi, "<\\/script")}</script>` + html.slice(position);
}

async function selfTest() {
  assert.equal(allowedPath("/?analytics=off&mediaGate=before-close"), true);
  assert.equal(allowedPath("/_next/static/chunks/app.js"), true);
  for (const path of ["http://example.com/", "//example.com/", "/api/events", "/etc/passwd", "/_next/static/%252e/file", "/?url=http://example.com", "/?analytics=on"]) assert.equal(allowedPath(path), false);
  assert.equal(allowedPath("/", "POST"), false);
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
  console.log(JSON.stringify({ selfTest: "passed", injectionSha256: hash(script), checks: ["fixed route/method allowlist", "injection before product scripts", "synthetic device/track/settings/stop", "no native getUserMedia", "one real-stream MSP fixture response", "test-only media close gate"], boundary: "Node VM mocks only; not IAB/canvas/MediaRecorder runtime validation" }));
}
if (args.includes("--self-test")) { await selfTest(); process.exit(0); }

const optionIndex = args.indexOf("--output");
const output = resolve(root, optionIndex >= 0 ? args[optionIndex + 1] ?? "" : `output/playwright/phase2a-cua-proxy-${Date.now()}`);
if (!output.startsWith(resolve(root, "output/playwright") + "/")) throw new Error("Use a new ignored output directory");
const buildId = (await readFile(resolve(root, ".next/BUILD_ID"), "utf8")).trim();
const upstreamControllers = new Set<AbortController>();
const files = ["scripts/phase2a-cua-proxy.mts", "e2e/fixtures/phase2a-cua-media.ts", "e2e/fixtures/measurement-hardware.ts", "e2e/fixtures/phase2a-media-gate.ts"];
const metadata: Record<string, unknown> = { purpose: "Phase2A IAB test-only loopback response injection", pid: process.pid, upstream, origin, buildId,
  checkoutHeadAtProxyStartup: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  upstreamSourceBinding: "BUILD_ID is read from the parent's existing server worktree; bind its served source via the parent's build receipt, not this proxy checkout HEAD.",
  sourceFiles: Object.fromEntries(await Promise.all(files.map(async (path) => [path, hash(await readFile(resolve(root, path)))]))),
  injectionSha256: hash(script), injectionOrder: ["canvas getUserMedia/enumerateDevices", "measurement-hardware", "phase2a-media-gate"],
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
    if (request.url === "/__phase2a/health" && request.method === "GET") { response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }); response.end(JSON.stringify({ ready: true, pid: process.pid, upstream, buildId, injectionSha256: hash(script) })); return; }
    if (!allowedPath(request.url ?? "", request.method)) {
      if (records.length < 200) records.push({ path: request.url?.split("?")[0], method: request.method, denied: true });
      await save(); response.writeHead(403); response.end("Test proxy path/method denied"); return;
    }
    const value = await upstreamResponse(request.url!);
    const isHtml = value.contentType.includes("text/html");
    const body = isHtml ? Buffer.from(injectHtml(value.body.toString())) : value.body;
    const headers: Record<string, string | number> = { "content-type": value.contentType, "content-length": body.length, "cache-control": "no-store", "x-phase2a-cua-proxy": "synthetic-fixtures", "permissions-policy": "camera=(), microphone=(), geolocation=()" };
    if (isHtml) headers["content-security-policy"] = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; worker-src 'self' blob:; font-src 'self' data:; object-src 'none'; base-uri 'self'; form-action 'none'";
    if (isHtml && records.length < 200) { records.push({ path: request.url, method: request.method, upstreamStatus: value.status, upstreamSha256: hash(value.body), injectedSha256: hash(body), injectionSha256: hash(script) }); await save(); }
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
console.log(JSON.stringify({ ready: true, pid: process.pid, url: origin + "/?analytics=off&mediaGate=before-close", health: origin + "/__phase2a/health", upstream, buildId, injectionSha256: hash(script), output, cleanup: `kill -TERM ${process.pid}`, lifetimeMs: 900000, browserValidation: "pending parent IAB UI test" }));
