import { readFile } from "node:fs/promises";
import type { LiveVisionRun } from "../lib/live-vision-types";
import type { TrainingSession } from "../lib/training-session";
import { VISION_MODEL_MANIFEST, type VisionModelRequest, type VisionModelResponse } from "../lib/vision-model";
import { expect, readStoredTrainingRecords, test } from "./fixtures/fpv-hardware";

test("live gate review shares the video-and-OSD recording stream and preserves both saved session associations", async ({ page }, info) => {
  // MediaRecorder, video composition, OPFS and IndexedDB are real; only model responses are deterministic.
  // The synthetic proposals are not evidence of model accuracy or physical gate timing.
  await page.addInitScript((manifest) => {
    localStorage.setItem("fpvhelper.training-preferences.v1", JSON.stringify({
      autoExport: false, recordPilotVideo: true, showStickOverlays: true, stickOverlayMode: "trail",
    }));
    if (!("showDirectoryPicker" in window)) {
      Object.defineProperty(window, "showDirectoryPicker", { configurable: true, value: async () => navigator.storage.getDirectory() });
    }
    const metrics = { workers: 0, analyzedFrames: 0, getUserMediaCalls: 0, propose: false, proposalFrames: 0 };
    (window as Window & { __liveVisionE2e?: typeof metrics }).__liveVisionE2e = metrics;
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      metrics.getUserMediaCalls += 1;
      return getUserMedia(constraints);
    };
    class FakeVisionWorker extends EventTarget {
      terminated = false;
      constructor() { super(); metrics.workers += 1; }
      postMessage(request: VisionModelRequest) {
        if (this.terminated) return;
        let response: VisionModelResponse;
        const context = { requestId: request.requestId, context: request.context };
        if (request.type === "load") response = { ...context, type: "ready", manifest };
        else if (request.type === "reference") {
          response = { ...context, type: "reference", width: request.image.width, height: request.image.height };
          request.image.close();
        } else {
          metrics.analyzedFrames += 1;
          const width = metrics.propose ? [0.15, 0.25, 0.4][metrics.proposalFrames++] : undefined;
          response = { ...context, type: "result", result: {
            frameTimeMs: request.frameTimeMs, modelId: manifest.id, modelRevision: manifest.revision, inferenceMs: 1,
            diagnostics: { preprocessMs: .1, modelMs: .6, matchingMs: .3, bestMatch: { similarity: width ? .8 : .4, box: { x: .2, y: .2, width: .3, height: .3 } } },
            candidates: width ? [{ box: { x: 0.2, y: 0.2, width, height: width }, similarity: 0.8 }] : [],
          } };
          request.image.close();
        }
        queueMicrotask(() => { if (!this.terminated) this.dispatchEvent(new MessageEvent("message", { data: response })); });
      }
      terminate() { this.terminated = true; }
    }
    window.Worker = FakeVisionWorker as unknown as typeof Worker;
  }, VISION_MODEL_MANIFEST);
  const remoteRequests: string[] = [];
  await page.route("https://**/*", (route) => { remoteRequests.push(route.request().url()); return route.abort(); });
  await page.goto("/");
  await page.evaluate(async () => {
    const directory = await navigator.storage.getDirectory();
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("fpvhelper-training-export", 1);
      request.addEventListener("upgradeneeded", () => {
        if (!request.result.objectStoreNames.contains("settings")) request.result.createObjectStore("settings");
      });
      request.addEventListener("success", () => {
        const transaction = request.result.transaction("settings", "readwrite");
        transaction.objectStore("settings").put(directory, "training-session-directory");
        transaction.addEventListener("complete", () => { request.result.close(); resolve(); });
        transaction.addEventListener("error", () => reject(transaction.error));
        transaction.addEventListener("abort", () => reject(transaction.error));
      });
      request.addEventListener("error", () => reject(request.error));
    });
  });
  await page.reload();
  await expect(page.getByRole("combobox", { name: "录制内容", exact: true })).toHaveValue("video");
  await expect(page.getByRole("button", { name: "保存文件夹 已授权", exact: true })).toBeVisible();
  const panel = page.getByRole("region", { name: "实时过门计时", exact: true });
  await expect(panel.getByRole("button", { name: "开始过门计时", exact: true })).toBeDisabled();
  await page.getByRole("textbox", { name: "当前训练选手代号", exact: true }).fill("VISION-LIVE");
  await page.getByRole("button", { name: "打开画面", exact: true }).click();
  await expect(page.getByText("1/1 路 UVC 在线")).toBeVisible();

  await panel.locator("summary").filter({ hasText: "配置新的计时门" }).click();
  await panel.getByRole("button", { name: "截取当前取景", exact: true }).click();
  await expect(panel.getByRole("img", { name: "本机计时门参考照片", exact: true })).toBeVisible();
  await panel.getByRole("textbox", { name: "计时门名称", exact: true }).fill("合成直播测试门");
  await panel.getByRole("button", { name: "保存并绑定计时门", exact: true }).click();
  const profile = panel.getByRole("combobox", { name: "当前选手计时门", exact: true });
  await expect(profile).not.toHaveValue("");
  const profileId = await profile.inputValue();
  expect(await page.evaluate(() => {
    const workspace = JSON.parse(localStorage.getItem("fpvhelper.video-workspace.v2")!);
    return workspace.pilotChannels.find((channel: { id: string }) => channel.id === workspace.activePilotChannelId).gateProfileId;
  })).toBe(profileId);

  await page.getByRole("button", { name: "连接桥接飞控" }).click();
  await expect(page.locator(".status-chip")).toContainText("数据桥在线");
  await page.getByRole("button", { name: "● 开始记录", exact: true }).click();
  await expect(page.getByRole("heading", { name: "正在记录 VISION-LIVE", exact: true })).toBeVisible();
  await expect(page.getByTestId("local-video-recording-status")).toContainText("REC");
  await panel.getByRole("button", { name: "开始过门计时", exact: true }).click();
  await expect(panel).toHaveAttribute("data-state", "monitoring");
  const compact = page.getByRole("region", { name: "视频旁过门计时", exact: true });
  await expect(compact).toHaveAttribute("data-state", "monitoring");
  await expect(compact).toContainText("合成直播测试门");
  await expect(compact.getByRole("link", { name: "配置与复核实时过门计时", exact: true })).toHaveAttribute("href", "#live-gate-panel");
  const manualReason = panel.getByRole("textbox", { name: "现场人工确认理由", exact: true });
  await manualReason.fill("合成流程：现场确认起点");
  await panel.getByRole("button", { name: "人工确认一次穿越", exact: true }).click();
  await expect(panel.getByRole("status")).toContainText("人工复核已保存在本机");

  await page.evaluate(() => { (window as Window & { __liveVisionE2e?: { propose: boolean } }).__liveVisionE2e!.propose = true; (document.activeElement as HTMLElement)?.blur(); });
  await page.keyboard.press("Escape");
  await expect(page.locator(".status-chip")).toContainText("数据桥在线");
  await expect(page.getByTestId("local-video-recording-status")).toContainText("REC");
  await expect(panel.getByTestId("live-analysis-fps")).not.toHaveText("—");
  await expect(panel.locator('canvas[aria-label="最近分析画面"]')).toHaveJSProperty("width", 448);
  await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "训练记录", exact: true }).click();
  await expect(page.locator('[aria-label="实时过门计时"]')).toHaveAttribute("data-state", "monitoring");
  await expect.poll(() => page.evaluate(() => (window as Window & { __liveVisionE2e?: { analyzedFrames: number } }).__liveVisionE2e!.analyzedFrames)).toBeGreaterThanOrEqual(5);
  await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "飞行工作台", exact: true }).click();
  await expect(panel.getByRole("button", { name: "待确认 1", exact: true })).toBeVisible();
  await manualReason.fill("合成流程：现场确认终点");
  await panel.getByRole("button", { name: "人工确认一次穿越", exact: true }).click();
  const results = panel.getByRole("region", { name: "实时圈速与记录", exact: true });
  await expect(results.getByRole("row").filter({ hasText: "区间内还有待复核候选" })).toHaveCount(1);
  const review = panel.locator('[aria-label="实时穿越复核"]');
  await review.getByRole("textbox", { name: "复核理由（必填）", exact: true }).fill("合成模型候选，仅用于测试，人工排除");
  await review.getByRole("button", { name: "排除候选", exact: true }).click();
  await expect(panel.getByRole("button", { name: "待确认 0", exact: true })).toBeVisible();
  await expect(results.getByRole("row")).toHaveCount(2);
  await expect(results).not.toContainText("区间内还有待复核候选");

  await panel.getByRole("button", { name: "停止过门计时", exact: true }).click();
  await expect(panel).toHaveAttribute("data-state", "stopped");
  await expect(compact).toHaveAttribute("data-state", "stopped");
  await expect(compact).toContainText("最近记录 · VISION-LIVE");
  await expect(panel.getByRole("status")).toContainText("已保存在本机");
  await expect(page.getByText("1/1 路 UVC 在线")).toBeVisible();
  await expect(page.getByRole("heading", { name: "正在记录 VISION-LIVE", exact: true })).toBeVisible();
  await expect(page.getByTestId("local-video-recording-status")).toContainText("REC");
  await expect.poll(async () => {
    const { drafts } = await readStoredTrainingRecords(page);
    return drafts.length === 1 ? drafts[0].samples.length : 0;
  }, { message: "Wait for recorded RC samples before stopping the shared recording" }).toBeGreaterThan(100);
  await page.getByRole("button", { name: "■ 结束记录", exact: true }).click();
  await expect(page.getByTestId("local-video-recording-status")).toContainText("SAVED");
  await expect(page.locator(".session-detail-header")).toContainText("已保存到本机");
  await expect(page.getByRole("status").filter({ hasText: "导出提示" })).toContainText("写入与关闭已完成");
  const training = await readStoredTrainingRecords(page);
  expect(training.sessions).toHaveLength(1);
  expect(training.sessions[0].samples.length).toBeGreaterThan(100);
  const receipt = training.sessions[0].video;
  expect(receipt).toMatchObject({ recorded: true, synchronized: false, overlay: "sticks" });
  if (!receipt.recorded) throw new Error("Missing completed video-and-OSD recording receipt");
  expect(receipt.bytes).toBeGreaterThan(0);
  const savedFiles = await page.evaluate(async (filename) => {
    const directory = await navigator.storage.getDirectory();
    const file = await (await directory.getFileHandle(filename)).getFile();
    const header = Array.from(new Uint8Array(await file.slice(0, 12).arrayBuffer()));
    const videoNames: string[] = [];
    const sessions: TrainingSession[] = [];
    for await (const [name, handle] of directory.entries()) {
      if (handle.kind !== "file") continue;
      if (/\.(mp4|webm)$/.test(name)) videoNames.push(name);
      if (name.endsWith(".json")) sessions.push(JSON.parse(await (await (handle as FileSystemFileHandle).getFile()).text()) as TrainingSession);
    }
    return { bytes: file.size, header, videoNames, sessions };
  }, receipt.filename);
  expect(savedFiles.videoNames).toEqual([receipt.filename]);
  expect(savedFiles.bytes).toBe(receipt.bytes);
  expect(receipt.filename).toMatch(receipt.mimeType.startsWith("video/mp4") ? /\.mp4$/ : /\.webm$/);
  expect(receipt.mimeType.startsWith("video/mp4") ? savedFiles.header.slice(4, 8) : savedFiles.header.slice(0, 4))
    .toEqual(receipt.mimeType.startsWith("video/mp4") ? [102, 116, 121, 112] : [26, 69, 223, 163]);
  expect(savedFiles.sessions).toHaveLength(1);
  expect(savedFiles.sessions[0].id).toBe(training.sessions[0].id);
  expect(savedFiles.sessions[0].video).toEqual(receipt);
  expect(savedFiles.sessions[0].samples).toEqual(training.sessions[0].samples);
  await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "飞行工作台", exact: true }).click();
  await expect(panel).toHaveAttribute("data-state", "stopped");

  const downloadPromise = page.waitForEvent("download");
  await results.getByRole("button", { name: "JSON", exact: true }).click();
  const download = await downloadPromise;
  const path = info.outputPath("synthetic-live-run.json");
  await download.saveAs(path);
  expect(await download.failure()).toBeNull();
  const run = JSON.parse(await readFile(path, "utf8")) as LiveVisionRun;
  expect(run).toMatchObject({ kind: "fpvhelper-live-vision", state: "stopped", source: { pilotName: "VISION-LIVE", trainingSessionId: training.sessions[0].id, crop: { x: 0, y: 0, width: 1, height: 1 } }, clock: { kind: "host_presentation_estimate", physicalCaptureTimeKnown: false, trainingSynchronized: false }, profile: { id: profileId }, settings: { sampleFps: 30, maxObservationGapMs: 1500, exitDelayMs: 150 } });
  expect(run.observations.length).toBeGreaterThanOrEqual(5);
  expect(run.pipelineVersion).toBe("reference-motion-v2");
  expect(run.observations.every((observation) => observation.diagnostics?.bestMatch)).toBe(true);
  const diagnosticDownload = page.waitForEvent("download");
  await panel.getByRole("button", { name: "导出本机诊断 JSON", exact: true }).click();
  const diagnostic = await diagnosticDownload;
  const diagnosticPath = info.outputPath("synthetic-live-diagnostics.json");
  await diagnostic.saveAs(diagnosticPath);
  const diagnosticReport = JSON.parse(await readFile(diagnosticPath, "utf8"));
  expect(diagnosticReport.imageDataIncluded).toBe(false);
  expect(diagnosticReport.samples.length).toBeLessThanOrEqual(120);
  expect(diagnosticReport.diagnostics.counters.analyzed).toBe(run.observations.length);
  expect(run.candidates).toHaveLength(1);
  expect(run.reviews.map((entry) => entry.action)).toEqual(["add", "add", "reject"]);
  expect(run.reviews[1].timeMs).toBeGreaterThan(run.reviews[0].timeMs);
  expect(run.elapsedMs).toBeGreaterThanOrEqual(run.reviews[1].timeMs);
  expect(await page.evaluate(() => (window as Window & { __liveVisionE2e?: { workers: number; getUserMediaCalls: number } }).__liveVisionE2e)).toMatchObject({ workers: 1, getUserMediaCalls: 1 });
  expect(remoteRequests).toEqual([]);

  await page.reload();
  await panel.getByRole("combobox", { name: "恢复实时计时记录", exact: true }).selectOption(run.id);
  await expect(panel).toHaveAttribute("data-state", "stopped");
  await expect(panel.getByRole("button", { name: "全部 3", exact: true })).toBeVisible();
  await expect(results).toContainText("已关联训练记录，未校准同步");
});
