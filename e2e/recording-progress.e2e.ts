import { mkdir, writeFile } from "node:fs/promises";
import type { TrainingSession } from "../lib/training-session";
import { expect, readStoredTrainingRecords, test } from "./fixtures/fpv-hardware";

test.use({ seedDataOnlyPreference: false });

test("records every input while publishing paired DOM progress on a bounded cadence and exact final values", async ({ page }, info) => {
  const attachJson = async (name: string, value: unknown) => {
    const path = info.outputPath(name);
    await mkdir(info.outputDir, { recursive: true });
    await writeFile(path, JSON.stringify(value, null, 2));
    await info.attach(name, { contentType: "application/json", path });
  };
  // Separate UI functionality/freshness observation, not a formal A/B or video-FPS measurement.
  // Serial/video input is synthetic; MediaRecorder, composition, OPFS and IndexedDB remain real.
  const directoryName = "recording-progress-ui";
  await page.addInitScript((name) => {
    Object.defineProperty(window, "showDirectoryPicker", { configurable: true, value: async () => (
      (await navigator.storage.getDirectory()).getDirectoryHandle(name, { create: true })
    ) });
  }, directoryName);
  const unexpectedRequests: Array<{ url: string; method: string }> = [];
  const origin = new URL(String(info.project.use.baseURL)).origin;
  await page.route("**/*", (route) => {
    const request = route.request(), url = new URL(request.url());
    if (["http:", "https:"].includes(url.protocol) && (url.origin !== origin || !["GET", "HEAD"].includes(request.method()))) {
      unexpectedRequests.push({ url: `${url.origin}${url.pathname}`, method: request.method() });
      return route.abort();
    }
    return route.continue();
  });
  await page.goto("/?analytics=off");
  await page.getByRole("textbox", { name: "当前训练选手代号", exact: true }).fill("PROGRESS-UI");
  await expect(page.getByRole("combobox", { name: "录制内容", exact: true })).toHaveValue("video");
  const setup = page.getByRole("region", { name: "录制准备", exact: true });
  await setup.getByRole("button", { name: /连接当前选手/ }).click();
  await setup.getByRole("button", { name: /打开当前输入/ }).click();
  await setup.getByRole("button", { name: /选择保存目录/ }).click();
  await expect(page.getByRole("button", { name: "● 开始记录", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "● 开始记录", exact: true }).click();
  await expect(page.getByRole("heading", { name: "正在记录 PROGRESS-UI", exact: true })).toBeVisible();
  await expect(page.getByTestId("local-video-recording-status")).toContainText("REC");

  const observation = await page.locator(".session-card").evaluate(async (card) => {
    const rows: Array<{ timeMs: number; sampleCount: number; uniqueSampleCount: number; generatedRcResponses: number }> = [];
    let overflow = 0;
    const capture = () => {
      const total = card.querySelector(".session-note p[role=status]")?.textContent?.match(/已采集\s+([\d,\u00a0\u202f]+)\s*帧/);
      const unique = [...card.querySelectorAll(".session-stats > span")].find((element) => element.textContent?.startsWith("独立样本"))?.querySelector("b")?.textContent;
      if (!total || !unique) throw new Error("Live total/unique progress DOM is unavailable");
      const sampleCount = Number(total[1].replace(/\D/g, "")), uniqueSampleCount = Number(unique.replace(/\D/g, ""));
      const previous = rows.at(-1);
      if (previous?.sampleCount === sampleCount && previous.uniqueSampleCount === uniqueSampleCount) return;
      if (rows.length >= 1000) { overflow++; return; }
      rows.push({ timeMs: performance.now(), sampleCount, uniqueSampleCount, generatedRcResponses: window.__fpvFakeSerial.rcResponses });
    };
    const startedAtMs = performance.now(), responsesAtStart = window.__fpvFakeSerial.rcResponses;
    let observerError: string | null = null;
    const observer = new MutationObserver(() => {
      try { capture(); } catch (error) { observerError = error instanceof Error ? error.message : String(error); }
    });
    capture();
    observer.observe(card, { childList: true, characterData: true, subtree: true });
    try {
      // A declared real-clock observation window; no fake clock or minimum hardware-rate assumption.
      await new Promise((resolve) => window.setTimeout(resolve, 2200));
      capture();
      return { startedAtMs, endedAtMs: performance.now(), responsesAtStart, responsesAtEnd: window.__fpvFakeSerial.rcResponses,
        rows, overflow, observerError, timeOriginEpochMs: performance.timeOrigin };
    } finally { observer.disconnect(); }
  });
  await attachJson("recording-progress-dom-observation.json", {
    ...observation, purpose: "Independent DOM count-publication functionality and freshness check; not formal A/B, RF throughput, or painted/video FPS",
    nominalProgressIntervalMs: 250, source: "existing synthetic serial/video fixture", counts: "Only changed total/unique pairs; elapsed and persisted-only mutations are excluded",
  });

  // Stop normally before asserting cadence, so a failing observation still exercises file finalization.
  await page.getByRole("button", { name: "■ 结束记录", exact: true }).click();
  await expect(page.getByTestId("local-video-recording-status")).toContainText("SAVED");
  await expect(page.locator(".session-detail-header")).toContainText("已保存到本机");
  const stored = await readStoredTrainingRecords(page);
  expect(stored.drafts).toHaveLength(0);
  expect(stored.sessions).toHaveLength(1);
  const session = stored.sessions[0];
  const uniqueCount = new Set(session.samples.map((sample) => sample.sequence)).size;
  const finalTotal = page.getByText("遥控样本", { exact: true }).locator("..").locator("dd");
  await expect(finalTotal).toBeVisible();
  const totalShown = Number((await finalTotal.textContent())!.replace(/\D/g, ""));
  await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "飞行工作台", exact: true }).click();
  const finalUnique = page.locator(".session-stats > span").filter({ hasText: "独立样本" }).locator("b");
  await expect(finalUnique).toBeVisible();
  const uniqueShown = Number((await finalUnique.textContent())!.replace(/\D/g, ""));

  const receipt = session.video;
  expect(receipt).toMatchObject({ recorded: true, synchronized: false, receiptEvidence: "write_and_close_resolved", overlay: "sticks" });
  if (!receipt.recorded) throw new Error("No completed local video receipt");
  const files = await page.evaluate(async ({ directoryName, filename }) => {
    const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle(directoryName);
    const file = await (await directory.getFileHandle(filename)).getFile();
    const header = [...new Uint8Array(await file.slice(0, 12).arrayBuffer())];
    const json: TrainingSession[] = [];
    for await (const [name, handle] of directory.entries()) if (handle.kind === "file" && name.endsWith(".json")) {
      json.push(JSON.parse(await (await (handle as FileSystemFileHandle).getFile()).text()) as TrainingSession);
    }
    return { bytes: file.size, header, json,
      mp4Supported: ["video/mp4;codecs=avc1", "video/mp4"].some((type) => MediaRecorder.isTypeSupported(type)) };
  }, { directoryName, filename: receipt.filename });
  const container = files.header.slice(4, 8).join() === "102,116,121,112" ? "mp4"
    : files.header.slice(0, 4).join() === "26,69,223,163" ? "webm" : "unknown";
  await attachJson("recording-progress-final-values.json", {
    sessionId: session.id, totalShown, uniqueShown, persistedSampleCount: session.sampleCount, storedSamples: session.samples.length,
    receipt, fileBytes: files.bytes, container, header: files.header, mp4Supported: files.mp4Supported,
    jsonSessionIds: files.json.map((entry) => entry.id), unexpectedRequests,
  });

  const durationMs = observation.endedAtMs - observation.startedAtMs;
  const publications = observation.rows.slice(1);
  const increases = publications.map((row, index) => row.sampleCount - observation.rows[index].sampleCount);
  expect(observation.observerError).toBeNull();
  expect(observation.overflow).toBe(0);
  expect(durationMs).toBeGreaterThanOrEqual(2000);
  expect(publications.length).toBeGreaterThanOrEqual(2);
  // Allow boundary alignment and scheduler delay; this is an upper bound, not an exact 4 Hz deadline.
  expect(publications.length).toBeLessThanOrEqual(Math.ceil(durationMs / 250) + 2);
  expect(increases.some((increase) => increase > 1)).toBe(true);
  expect(observation.rows.every((row) => row.sampleCount === row.uniqueSampleCount)).toBe(true);
  expect(increases.every((increase) => increase > 0)).toBe(true);
  expect(totalShown).toBe(session.samples.length);
  expect(uniqueShown).toBe(uniqueCount);
  expect(session.sampleCount).toBe(session.samples.length);
  expect(session.samples.length).toBeGreaterThanOrEqual(observation.responsesAtEnd - observation.responsesAtStart);
  expect(session.samples.every((sample, index) => sample.source === "ground_rc"
    && (index === 0 || (sample.sequence === session.samples[index - 1].sequence + 1 && sample.elapsedMs > session.samples[index - 1].elapsedMs)))).toBe(true);
  const expectedChannels = await page.evaluate(() => window.__fpvFakeSerialPorts[0].rcChannelsUs);
  expect(session.samples.every((sample) => JSON.stringify(sample.channelsUs) === JSON.stringify(expectedChannels))).toBe(true);
  expect(files.bytes).toBe(receipt.bytes);
  expect(files.bytes).toBeGreaterThan(0);
  expect(container).toBe(files.mp4Supported ? "mp4" : "webm");
  expect(receipt.filename).toMatch(files.mp4Supported ? /\.mp4$/ : /\.webm$/);
  expect(receipt.mimeType).toMatch(files.mp4Supported ? /^video\/mp4(?:;|$)/ : /^video\/webm(?:;|$)/);
  expect(files.json).toHaveLength(1);
  expect(files.json[0].id).toBe(session.id);
  expect(files.json[0].samples).toEqual(session.samples);
  expect(files.json[0].video).toEqual(receipt);
  expect(unexpectedRequests).toEqual([]);
  expect(await page.evaluate(() => window.__fpvFakeSerial.protocolErrors)).toEqual([]);
});
