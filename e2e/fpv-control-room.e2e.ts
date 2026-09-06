import type { Page, TestInfo } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { expect, readStoredTrainingRecords, test, type FakeSerialMetrics } from "./fixtures/fpv-hardware";

async function openInputSettings(page: Page) {
  await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "飞行工作台", exact: true }).click();
  const settings = page.locator(".video-setup-details");
  if (!await settings.evaluate((element) => (element as HTMLDetailsElement).open)) {
    await settings.locator("summary").click();
  }
}

async function expectSavedSession(page: Page, athleteCode: string) {
  await expect(page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "训练记录", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.locator(".session-detail-header")).toContainText(athleteCode);
  await expect(page.locator(".session-detail-header")).toContainText("已保存到本机");
}

async function expectStickInputs(page: Page, { roll, pitch, yaw, throttle }: { roll: number; pitch: number; yaw: number; throttle: number }) {
  const axis = (value: number) => value > 0 ? `+${value}` : String(value);
  const fields = page.locator(".telemetry-rail .stick-field");
  await expect(fields.nth(0)).toHaveAttribute("aria-label", `左摇杆 · GROUND_RC，YAW ${axis(yaw * 10)}，THR ${axis(throttle * 20 - 1000)}；归一化行程 −1000 至 +1000，中心 0`);
  await expect(fields.nth(1)).toHaveAttribute("aria-label", `右摇杆 · GROUND_RC，ROLL ${axis(roll * 10)}，PITCH ${axis(pitch * 10)}；归一化行程 −1000 至 +1000，中心 0`);
  await expect(page.locator(".gauge-grid--primary")).toContainText(`${throttle}%`);
}

async function videoCapabilities(page: Page) {
  return page.evaluate(() => [
    "video/mp4;codecs=avc1", "video/mp4", "video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm",
  ].map((mimeType) => ({ mimeType, supported: MediaRecorder.isTypeSupported(mimeType) })));
}

async function attachRecordedVideoEvidence(
  page: Page,
  testInfo: TestInfo,
  receipt: { filename: string; mimeType: string; bytes: number },
  capabilityMode: "native" | "webm-only",
) {
  const supportedTypes = await videoCapabilities(page);
  const mp4Supported = supportedTypes.some(({ mimeType, supported }) => mimeType.startsWith("video/mp4") && supported);
  const playback = await page.evaluate(async (filename) => {
    const root = await navigator.storage.getDirectory();
    const file = await (await root.getFileHandle(filename)).getFile();
    const header = Array.from(new Uint8Array(await file.slice(0, 12).arrayBuffer()));
    const fileDataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener("load", () => resolve(String(reader.result)), { once: true });
      reader.addEventListener("error", () => reject(reader.error), { once: true });
      reader.readAsDataURL(file);
    });
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.muted = true;
    video.preload = "auto";
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(() => reject(new Error("Recorded video did not decode")), 8_000);
        video.addEventListener("loadeddata", () => { window.clearTimeout(timer); resolve(); }, { once: true });
        video.addEventListener("error", () => { window.clearTimeout(timer); reject(new Error("Recorded video cannot play")); }, { once: true });
        video.src = url;
        video.load();
      });
      await video.play();
      return { header, width: video.videoWidth, height: video.videoHeight, readyState: video.readyState, bytes: file.size, fileDataUrl };
    } finally {
      video.pause();
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(url);
    }
  }, receipt.filename);
  const container = playback.header.slice(4, 8).join(",") === "102,116,121,112"
    ? "mp4"
    : playback.header.slice(0, 4).join(",") === "26,69,223,163" ? "webm" : "unknown";
  const evidencePath = testInfo.outputPath("recorded-video-evidence.json");
  const videoPath = testInfo.outputPath(`fake-training-video.${container}`);
  await mkdir(testInfo.outputDir, { recursive: true });
  await writeFile(evidencePath, JSON.stringify({
      capabilityMode,
      supportedTypes,
      expectedContainer: mp4Supported ? "mp4" : "webm",
      actualMimeType: receipt.mimeType,
      filename: receipt.filename,
      container,
      header: playback.header,
      playable: { width: playback.width, height: playback.height, readyState: playback.readyState },
      receiptBytes: receipt.bytes,
      fileBytes: playback.bytes,
    }, null, 2));
  await writeFile(videoPath, Buffer.from(playback.fileDataUrl.slice(playback.fileDataUrl.indexOf(",") + 1), "base64"));
  await testInfo.attach("recorded-video-evidence.json", {
    contentType: "application/json",
    path: evidencePath,
  });
  await testInfo.attach(`fake-training-video.${container}`, {
    contentType: receipt.mimeType,
    path: videoPath,
  });
  expect(receipt.mimeType).toMatch(mp4Supported ? /^video\/mp4(?:;|$)/ : /^video\/webm(?:;|$)/);
  expect(container).toBe(mp4Supported ? "mp4" : "webm");
  expect(receipt.filename).toMatch(mp4Supported ? /\.mp4$/ : /\.webm$/);
  expect(playback.width).toBeGreaterThan(0);
  expect(playback.height).toBeGreaterThan(0);
  expect(playback.readyState).toBeGreaterThanOrEqual(2);
  expect(playback.bytes).toBe(receipt.bytes);
  expect(playback.bytes).toBeGreaterThan(0);
}

interface StoredSession {
  schemaVersion: number;
  athleteCode: string | null;
  sampleCount: number;
  initialSource: string;
  dataSources: string[];
  interrupted: boolean;
  samples: Array<{
    source: string;
    channelsUs: number[];
    rc: {
      rollStickPercent: number;
      pitchStickPercent: number;
      yawStickPercent: number;
      throttleStickPercent: number;
      throttleUs: number;
    };
    groundBridge: {
      mspRssiPercent: number | null;
      voltage: number | null;
    };
  }>;
}

test.describe("default video and OSD recording entry", () => {
  test.use({ seedDataOnlyPreference: false });

  test("requires video and directory, preserves data-only choice, and records from the visible setup", async ({ page }, testInfo) => {
    await page.goto("/");
    const mode = page.getByRole("combobox", { name: "录制内容", exact: true });
    const setup = page.getByRole("region", { name: "录制准备", exact: true });
    const recordButton = page.getByRole("button", { name: "● 开始记录", exact: true });
    await expect(mode).toHaveValue("video");
    const capabilities = await videoCapabilities(page);
    const mp4Supported = capabilities.some(({ mimeType, supported }) => mimeType.startsWith("video/mp4") && supported);
    await expect(setup).toContainText(mp4Supported ? "保存 MP4 视频" : "当前浏览器不支持 MP4 录制，将保存 WebM 视频");
    await expect(setup.getByRole("button")).toHaveCount(3);
    await expect(page.getByTestId("local-video-recording-status")).toContainText("待准备");
    expect(await page.evaluate(() => window.__fpvFakeSerial.requestPortCalls)).toBe(0);

    await mode.selectOption("data");
    await page.reload();
    await expect(mode).toHaveValue("data");
    await expect(setup).toContainText("本次仅保存原始打杆数据");
    await setup.getByRole("button", { name: /连接当前选手/ }).click();
    await expect(page.getByRole("textbox", { name: "当前训练选手代号" })).toHaveValue("BF-PILOT-01");
    await expect(recordButton).toBeEnabled();

    await mode.selectOption("video");
    await expect(recordButton).toBeDisabled();
    await setup.getByRole("button", { name: /打开当前输入/ }).click();
    await expect(setup.getByRole("button", { name: /视频画面/ })).toHaveAttribute("data-ready", "true");
    await expect(recordButton).toBeDisabled();
    await expect(setup).toContainText("先选择并授权本地保存文件夹");
    await page.evaluate(() => {
      Object.defineProperty(window, "showDirectoryPicker", {
        configurable: true,
        value: async () => navigator.storage.getDirectory(),
      });
    });
    await setup.getByRole("button", { name: /选择保存目录/ }).click();
    await expect(setup.getByRole("button", { name: /保存文件夹/ })).toHaveAttribute("data-ready", "true");
    await expect(recordButton).toBeEnabled();
    await recordButton.click();
    await expect(mode).toBeDisabled();
    await expect(page.getByTestId("local-video-recording-status")).toContainText("REC");
    await page.waitForTimeout(800);
    await page.getByRole("button", { name: "■ 结束记录", exact: true }).click();
    await expectSavedSession(page, "BF-PILOT-01");
    const saved = await readStoredTrainingRecords(page);
    expect(saved.sessions).toHaveLength(1);
    expect(saved.sessions[0].athleteCode).toBe("BF-PILOT-01");
    expect(saved.sessions[0].video).toMatchObject({ recorded: true, overlay: "sticks" });
    const exports = await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const result: Array<{ name: string; bytes: number }> = [];
      for await (const [name, handle] of root.entries()) {
        if (handle.kind === "file") result.push({ name, bytes: (await (handle as FileSystemFileHandle).getFile()).size });
      }
      return result;
    });
    const video = saved.sessions[0].video;
    if (!video.recorded) throw new Error("Missing confirmed automatic-name video receipt");
    const extension = video.mimeType.startsWith("video/mp4") ? "mp4" : "webm";
    expect(video.filename).toMatch(new RegExp(`-BF-PILOT-01-.*\\.${extension}$`));
    expect(exports).toContainEqual({ name: video.filename, bytes: video.bytes });
    expect(exports.some((file) => file.name.endsWith(".json") && file.bytes > 0)).toBe(true);
    await attachRecordedVideoEvidence(page, testInfo, video, "native");
  });

  test("records a playable WebM and explains the fallback when only WebM encoding is available", async ({ page }, testInfo) => {
    await page.addInitScript(() => {
      const nativeIsTypeSupported = MediaRecorder.isTypeSupported.bind(MediaRecorder);
      Object.defineProperty(MediaRecorder, "isTypeSupported", {
        configurable: true,
        value: (mimeType: string) => mimeType.startsWith("video/webm") && nativeIsTypeSupported(mimeType),
      });
      Object.defineProperty(window, "showDirectoryPicker", {
        configurable: true,
        value: async () => navigator.storage.getDirectory(),
      });
    });
    await page.goto("/");
    const setup = page.getByRole("region", { name: "录制准备", exact: true });
    await expect(page.getByRole("combobox", { name: "录制内容", exact: true })).toHaveValue("video");
    await expect(setup).toContainText("当前浏览器不支持 MP4 录制，将保存 WebM 视频");
    await setup.getByRole("button", { name: /连接当前选手/ }).click();
    await expect(page.getByRole("textbox", { name: "当前训练选手代号" })).toHaveValue("BF-PILOT-01");
    await setup.getByRole("button", { name: /打开当前输入/ }).click();
    await setup.getByRole("button", { name: /选择保存目录/ }).click();
    const recordButton = page.getByRole("button", { name: "● 开始记录", exact: true });
    await expect(recordButton).toBeEnabled();
    await recordButton.click();
    await expect(page.getByTestId("local-video-recording-status")).toContainText("REC");
    await page.waitForTimeout(800);
    await page.getByRole("button", { name: "■ 结束记录", exact: true }).click();
    await expectSavedSession(page, "BF-PILOT-01");
    const saved = await readStoredTrainingRecords(page);
    expect(saved.sessions).toHaveLength(1);
    const video = saved.sessions[0].video;
    if (!video.recorded) throw new Error("Missing confirmed WebM fallback receipt");
    expect(video.mimeType).toMatch(/^video\/webm(?:;|$)/);
    await attachRecordedVideoEvidence(page, testInfo, video, "webm-only");
  });
});

test("onboarding closes even when its local preference cannot be saved", async ({ page, context }) => {
  await context.addInitScript(() => {
    window.localStorage.removeItem("fpvhelper.onboarding.v1");
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === "fpvhelper.onboarding.v1") throw new DOMException("Storage blocked", "SecurityError");
      return setItem.call(this, key, value);
    };
  });

  await page.goto("/");
  const dialog = page.getByRole("dialog", { name: "首次使用检查" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "已了解" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator(".onboarding-storage-warning--outside")).toContainText(
    "本次可以关闭清单，但下次仍会显示",
  );
});

test("four-up workspace keeps each pilot channel and crop selection local", async ({ page }) => {
  await page.goto("/");
  const onboarding = page.getByRole("dialog", { name: "首次使用检查" });
  if (await onboarding.isVisible()) await onboarding.getByRole("button", { name: "已了解" }).click();
  await openInputSettings(page);

  await page.getByRole("button", { name: "输入布局：四分屏" }).click();
  const firstPilot = page.locator(".video-viewport-tabs").getByRole("button", { name: "位置 1" });
  const secondPilot = page.locator(".video-viewport-tabs").getByRole("button", { name: "位置 2" });
  await expect(secondPilot).toBeVisible();
  await firstPilot.click();
  await page.getByRole("region", { name: "选手 1 画面绑定" })
    .getByRole("button", { name: "选手取景：完整画面" })
    .click();
  await secondPilot.click();
  await page.getByRole("textbox", { name: "当前训练选手代号" }).fill("PILOT-02");
  const secondBinding = page.getByRole("region", { name: "PILOT-02 画面绑定" });
  await secondBinding.getByRole("slider", { name: "裁切画面宽度" }).fill("40");
  await secondBinding.getByRole("slider", { name: "裁切画面高度" }).fill("40");
  await secondBinding.getByRole("slider", { name: "裁切左边界" }).fill("55");
  await secondBinding.getByRole("slider", { name: "裁切上边界" }).fill("5");

  const cropCanvases = page.locator("canvas.video-feed--cropped");
  const allSourceVideos = page.locator(".video-viewport video");
  await expect(cropCanvases).toHaveCount(3);
  await expect(page.locator('[data-pilot-channel-id="video-source-1-pilot-1"] canvas')).toHaveCount(0);
  await expect(page.locator('[data-pilot-channel-id="video-source-1-pilot-2"] canvas')).toHaveCount(1);
  await expect(allSourceVideos).toHaveCount(4);

  await page.getByRole("button", { name: "打开画面" }).click();
  await expect(page.getByText("1/1 路 UVC 在线")).toBeVisible();
  await expect.poll(() => allSourceVideos.evaluateAll((videos) => {
    const streams = videos.map((video) => (video as HTMLVideoElement).srcObject);
    return streams.length === 4
      && streams.every((stream) => stream instanceof MediaStream && stream === streams[0]);
  })).toBe(true);
  await expect.poll(async () => {
    const secondViewport = page.locator('[data-pilot-channel-id="video-source-1-pilot-2"]');
    const sourceSize = await secondViewport.locator("video").evaluate((element) => {
      const video = element as HTMLVideoElement;
      return { width: video.videoWidth, height: video.videoHeight };
    });
    const canvasSize = await secondViewport.locator("canvas").evaluate((element) => {
      const canvas = element as HTMLCanvasElement;
      return { width: canvas.width, height: canvas.height };
    });
    return {
      sourceReady: sourceSize.width > 0 && sourceSize.height > 0,
      exactCropWidth: canvasSize.width === Math.round(sourceSize.width * 0.4),
      exactCropHeight: canvasSize.height === Math.round(sourceSize.height * 0.4),
    };
  }).toEqual({ sourceReady: true, exactCropWidth: true, exactCropHeight: true });

  await page.reload();
  await openInputSettings(page);
  await expect(page.locator(".video-viewport-tabs").getByRole("button", { name: "PILOT-02" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("textbox", { name: "当前训练选手代号" })).toHaveValue("PILOT-02");
  const restoredSecondBinding = page.getByRole("region", { name: "PILOT-02 画面绑定" });
  await expect(restoredSecondBinding.getByRole("slider", { name: "裁切左边界" })).toHaveValue("55");
  await expect(restoredSecondBinding.getByRole("slider", { name: "裁切上边界" })).toHaveValue("5");
  await expect(restoredSecondBinding.getByRole("slider", { name: "裁切画面宽度" })).toHaveValue("40");
  await expect(restoredSecondBinding.getByRole("slider", { name: "裁切画面高度" })).toHaveValue("40");
  await page.locator(".video-viewport-tabs").getByRole("button", { name: "位置 1" }).click();
  await expect(page.getByRole("region", { name: "选手 1 画面绑定" })
    .getByRole("button", { name: "选手取景：完整画面" })).toHaveAttribute("aria-pressed", "true");
});

test("pilot video binding switches between full input and a persisted custom crop", async ({ page }) => {
  await page.goto("/");
  const onboarding = page.getByRole("dialog", { name: "首次使用检查" });
  if (await onboarding.isVisible()) await onboarding.getByRole("button", { name: "已了解" }).click();
  await openInputSettings(page);

  const binding = page.getByRole("region", { name: "选手 1 画面绑定" });
  await expect(binding.getByRole("button", { name: "选手取景：完整画面" })).toHaveAttribute("aria-pressed", "true");
  await binding.getByRole("button", { name: "选手取景：裁切区域" }).click();

  await binding.getByRole("slider", { name: "裁切画面宽度" }).fill("70");
  await binding.getByRole("slider", { name: "裁切画面高度" }).fill("60");
  await binding.getByRole("slider", { name: "裁切左边界" }).fill("10");
  await binding.getByRole("slider", { name: "裁切上边界" }).fill("15");
  const cropSelection = binding.getByRole("group", { name: /裁切选框/ });
  await cropSelection.press("ArrowRight");
  await expect(binding.getByRole("slider", { name: "裁切左边界" })).toHaveValue("11");
  await cropSelection.press("ArrowLeft");
  await expect(binding.getByRole("slider", { name: "裁切左边界" })).toHaveValue("10");
  const cropBounds = await cropSelection.boundingBox();
  expect(cropBounds).not.toBeNull();
  await page.mouse.move(cropBounds!.x + cropBounds!.width / 2, cropBounds!.y + cropBounds!.height / 2);
  await page.mouse.down();
  await page.mouse.move(cropBounds!.x + cropBounds!.width / 2 + 12, cropBounds!.y + cropBounds!.height / 2 + 8);
  await page.mouse.up();
  await expect.poll(async () => Number(await binding.getByRole("slider", { name: "裁切左边界" }).inputValue())).toBeGreaterThan(10);
  await binding.getByRole("slider", { name: "裁切左边界" }).fill("10");
  await binding.getByRole("slider", { name: "裁切上边界" }).fill("15");

  await page.getByRole("button", { name: "打开画面" }).click();
  await expect(page.getByText("1/1 路 UVC 在线")).toBeVisible();

  const cropEditor = binding.locator(".crop-editor");
  const cropPreview = binding.locator('video[aria-label="裁切输入预览"]');
  await expect.poll(async () => {
    const sourceRatio = await cropPreview.evaluate((element) => {
      const video = element as HTMLVideoElement;
      return video.videoHeight > 0 ? video.videoWidth / video.videoHeight : 0;
    });
    const editorBounds = await cropEditor.boundingBox();
    if (!editorBounds || sourceRatio <= 0) return Number.POSITIVE_INFINITY;
    return Math.abs((editorBounds.width / editorBounds.height) - sourceRatio);
  }).toBeLessThan(0.02);

  const croppedCanvas = page.locator("canvas.video-feed--cropped");
  const cropSourceVideo = page.locator("video.video-feed-source");
  await expect(croppedCanvas).toHaveCount(1);
  await expect(cropSourceVideo).toHaveCount(1);
  await expect.poll(async () => {
    const video = await cropSourceVideo.evaluate((element) => {
      const source = element as HTMLVideoElement;
      return {
        width: source.videoWidth,
        height: source.videoHeight,
        hasStream: source.srcObject instanceof MediaStream,
      };
    });
    const canvas = await croppedCanvas.evaluate((element) => {
      const output = element as HTMLCanvasElement;
      return {
        width: output.width,
        height: output.height,
        objectFit: getComputedStyle(output).objectFit,
      };
    });
    return {
      sourceReady: video.width > 0 && video.height > 0,
      exactCropWidth: canvas.width === Math.round(video.width * 0.7),
      exactCropHeight: canvas.height === Math.round(video.height * 0.6),
      objectFit: canvas.objectFit,
      hasStream: video.hasStream,
    };
  }).toEqual({
    sourceReady: true,
    exactCropWidth: true,
    exactCropHeight: true,
    objectFit: "contain",
    hasStream: true,
  });

  await page.reload();
  await openInputSettings(page);
  const restoredBinding = page.getByRole("region", { name: "选手 1 画面绑定" });
  await expect(restoredBinding.getByRole("button", { name: "选手取景：裁切区域" })).toHaveAttribute("aria-pressed", "true");
  await expect(restoredBinding.getByRole("slider", { name: "裁切左边界" })).toHaveValue("10");
  await expect(restoredBinding.getByRole("slider", { name: "裁切上边界" })).toHaveValue("15");
  await expect(restoredBinding.getByRole("slider", { name: "裁切画面宽度" })).toHaveValue("70");
  await expect(restoredBinding.getByRole("slider", { name: "裁切画面高度" })).toHaveValue("60");

  await restoredBinding.getByRole("button", { name: "选手取景：完整画面" }).click();
  await expect(page.locator("canvas.video-feed--cropped")).toHaveCount(0);
});

test("independent video inputs open together and keep one active telemetry viewport", async ({ page }) => {
  await page.goto("/");
  await openInputSettings(page);
  await page.getByRole("button", { name: "+ 独立输入" }).click();

  await page.getByRole("textbox", { name: "输入名称" }).fill("练习区接收机");
  await page.getByRole("combobox", { name: "画面输入" }).selectOption("video-source-1");
  await page.getByRole("textbox", { name: "输入名称" }).fill("主赛道接收机");
  await page.getByRole("combobox", { name: "画面输入" }).selectOption("video-source-2");
  await expect(page.getByRole("textbox", { name: "输入名称" })).toHaveValue("练习区接收机");
  await expect(page.locator(".video-source-tab").filter({ hasText: "主赛道接收机" })).toBeVisible();
  await expect(page.locator(".video-source-tab").filter({ hasText: "练习区接收机" })).toHaveClass(/is-active/);

  const viewports = page.locator(".video-viewport");
  await expect(viewports).toHaveCount(2);
  await page.getByRole("button", { name: "打开全部" }).click();
  await expect(page.getByText("2/2 路 UVC 在线")).toBeVisible();
  await expect.poll(() => viewports.locator("video").evaluateAll((videos) => {
    const streams = videos.map((video) => (video as HTMLVideoElement).srcObject);
    return streams.length === 2
      && streams.every((stream) => stream instanceof MediaStream)
      && streams[0] !== streams[1];
  })).toBe(true);

  await expect(page.locator(".video-viewport.is-active")).toHaveAttribute("data-source-id", "video-source-2");
  await expect(page.locator(".video-viewport .video-stick-overlay--orange")).toHaveCount(1);
  await expect(page.locator(".video-viewport .video-stick-overlay--blue")).toHaveCount(1);
  await page.locator('.video-viewport[data-source-id="video-source-1"] .video-viewport-select').click();
  await expect(page.locator(".video-viewport.is-active")).toHaveAttribute("data-source-id", "video-source-1");
  await expect(page.locator(".video-viewport.is-active .video-stick-overlay--orange")).toHaveCount(1);
  await expect(page.locator(".video-viewport.is-active .video-stick-overlay--blue")).toHaveCount(1);

  await page.getByRole("button", { name: "断开画面", exact: true }).click();
  await expect(page.getByText("1/2 路 UVC 在线")).toBeVisible();
  await expect(page.locator('.video-viewport[data-source-id="video-source-1"]')).not.toHaveClass(/is-live/);
  await expect(page.locator('.video-viewport[data-source-id="video-source-2"]')).toHaveClass(/is-live/);
});

test("active pilot full and cropped video record to the authorized local folder", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(async () => {
    window.localStorage.setItem("fpvhelper.training-preferences.v1", JSON.stringify({
      autoExport: false,
      recordPilotVideo: true,
      showStickOverlays: true,
      stickOverlayMode: "trail",
    }));
    const root = await navigator.storage.getDirectory();
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("fpvhelper-training-export", 1);
      request.addEventListener("upgradeneeded", () => {
        if (!request.result.objectStoreNames.contains("settings")) request.result.createObjectStore("settings");
      });
      request.addEventListener("success", () => {
        const transaction = request.result.transaction("settings", "readwrite");
        transaction.objectStore("settings").put(root, "training-session-directory");
        transaction.addEventListener("complete", () => {
          request.result.close();
          resolve();
        });
        transaction.addEventListener("error", () => reject(transaction.error));
      });
      request.addEventListener("error", () => reject(request.error));
    });
  });
  await page.addInitScript(() => {
    window.localStorage.setItem("fpvhelper.training-preferences.v1", JSON.stringify({
      autoExport: false,
      recordPilotVideo: true,
      showStickOverlays: true,
      stickOverlayMode: "trail",
    }));
    if (!("showDirectoryPicker" in window)) {
      Object.defineProperty(window, "showDirectoryPicker", {
        configurable: true,
        value: async () => navigator.storage.getDirectory(),
      });
    }
  });
  await page.reload();

  await page.locator(".recording-options > summary").click();
  await expect(page.getByRole("combobox", { name: "录制内容", exact: true })).toHaveValue("video");
  await expect(page.getByText(/本地保存目录：/)).toBeVisible();
  await page.getByRole("button", { name: "打开画面" }).click();
  await expect(page.getByText("1/1 路 UVC 在线")).toBeVisible();
  await page.getByRole("button", { name: "连接桥接飞控" }).click();
  await expect(page.locator(".status-chip")).toContainText("数据桥在线");
  await page.getByRole("textbox", { name: "当前训练选手代号" }).fill("VIDEO-01");

  const recordButton = page.getByRole("button", { name: "● 开始记录" });
  await expect(recordButton).toBeEnabled();
  await recordButton.click();
  await expect(page.getByTestId("local-video-recording-status")).toContainText("REC");
  await page.waitForTimeout(1_200);
  await page.getByRole("button", { name: "■ 结束记录" }).click();
  await expect(page.getByTestId("local-video-recording-status")).toContainText("SAVED");

  await expectSavedSession(page, "VIDEO-01");
  await openInputSettings(page);
  const binding = page.getByRole("region", { name: "VIDEO-01 画面绑定" });
  await binding.getByRole("button", { name: "选手取景：裁切区域" }).click();
  await binding.getByRole("slider", { name: "裁切画面宽度" }).fill("50");
  await binding.getByRole("slider", { name: "裁切画面高度" }).fill("50");
  await expect.poll(() => page.locator("canvas.video-feed--cropped").evaluate((canvas) => ({
    width: (canvas as HTMLCanvasElement).width,
    height: (canvas as HTMLCanvasElement).height,
  }))).toMatchObject({ width: 960, height: 540 });
  await recordButton.click();
  await expect(page.getByTestId("local-video-recording-status")).toContainText("REC");
  await page.waitForTimeout(1_200);
  await page.getByRole("button", { name: "■ 结束记录" }).click();
  await expect(page.getByTestId("local-video-recording-status")).toContainText("SAVED");

  await expectSavedSession(page, "VIDEO-01");
  // Media file close and the later metadata/export transactions are separate confirmations.
  await expect.poll(async () => (await readStoredTrainingRecords(page)).sessions.filter(
    (session) => session.video.recorded && session.exportCount === 1,
  ).length).toBe(2);
  const recordings = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const files: Array<{ name: string; size: number }> = [];
    for await (const [name, handle] of root.entries()) {
      if (handle.kind !== "file" || !/\.(mp4|webm)$/.test(name)) continue;
      const file = await (handle as FileSystemFileHandle).getFile();
      files.push({ name, size: file.size });
    }
    return files;
  });
  expect(recordings).toHaveLength(2);
  expect(recordings.some((recording) => /-VIDEO-01-.*-full\.(mp4|webm)$/.test(recording.name))).toBe(true);
  expect(recordings.some((recording) => /-VIDEO-01-.*-crop\.(mp4|webm)$/.test(recording.name))).toBe(true);
  expect(recordings.every((recording) => recording.size > 0)).toBe(true);
  const saved = await readStoredTrainingRecords(page);
  expect(saved.sessions).toHaveLength(2);
  const exportedSessions = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const exported = [];
    for await (const [name, handle] of root.entries()) {
      if (handle.kind !== "file" || !name.endsWith(".json")) continue;
      exported.push(JSON.parse(await (await (handle as FileSystemFileHandle).getFile()).text()));
    }
    return exported;
  });
  expect(exportedSessions).toHaveLength(2);
  for (const session of saved.sessions) {
    expect(session.video).toMatchObject({ recorded: true, synchronized: false, overlay: "sticks" });
    if (!session.video.recorded) throw new Error(`Missing confirmed video receipt for ${session.id}`);
    expect(session.video.filename).toMatch(session.video.mimeType.startsWith("video/mp4") ? /\.mp4$/ : /\.webm$/);
    expect(recordings).toContainEqual({ name: session.video.filename, size: session.video.bytes });
    const exported = exportedSessions.find((candidate) => candidate.id === session.id);
    expect(exported?.video).toEqual(session.video);
    expect(exported?.samples).toHaveLength(session.sampleCount);
  }
  await openInputSettings(page);

  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const probe = await root.getFileHandle("close-probe.tmp", { create: true });
    const probeStream = await probe.createWritable();
    const prototype = Object.getPrototypeOf(probeStream) as { close: () => Promise<void> };
    const close = prototype.close;
    await close.call(probeStream);
    await root.removeEntry("close-probe.tmp");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    (window as Window & { __releaseDelayedVideoClose?: () => void }).__releaseDelayedVideoClose = release;
    prototype.close = async function () {
      await gate;
      return close.call(this);
    };
  });
  await recordButton.click();
  await expect(page.getByTestId("local-video-recording-status")).toContainText("REC");
  await page.locator("video.video-feed-source").evaluate((video) => {
    const track = ((video as HTMLVideoElement).srcObject as MediaStream).getVideoTracks()[0];
    track?.stop();
    track?.dispatchEvent(new Event("ended"));
  });
  await expect(page.getByTestId("local-video-recording-status")).toContainText("FINALIZING");
  await expect(page.getByRole("heading", { name: "正在记录 VIDEO-01" })).toBeVisible();
  const stopButton = page.getByRole("button", { name: "■ 结束记录" });
  await expect(stopButton).toBeEnabled();
  await stopButton.click();
  await expect(page.getByRole("button", { name: "等待视频完成…" })).toBeDisabled();
  await expect(page.getByTestId("local-video-recording-status")).toContainText("FINALIZING");
  // RC terminal confirmation is now independent of the still-open media stream.
  await expect.poll(async () => (await readStoredTrainingRecords(page)).sessions.length).toBe(3);
  expect((await readStoredTrainingRecords(page)).sessions.filter((session) => !session.video.recorded)).toHaveLength(1);
  await page.evaluate(() => {
    (window as Window & { __releaseDelayedVideoClose?: () => void }).__releaseDelayedVideoClose?.();
  });
  await expect(page.getByTestId("local-video-recording-status")).toContainText("VIDEO ERROR");
  await expect(page.getByTestId("local-video-recording-status")).toContainText(/视频.*(?:中断|断开)/);
  await expectSavedSession(page, "VIDEO-01");
  const afterFailure = (await readStoredTrainingRecords(page)).sessions;
  expect(afterFailure).toHaveLength(3);
  expect(afterFailure.filter((session) => !session.video.recorded)).toHaveLength(1);
});

test("a delayed video file open cannot start after its Training Session has ended", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("fpvhelper.training-preferences.v1", JSON.stringify({
      autoExport: false,
      recordPilotVideo: true,
      showStickOverlays: true,
      stickOverlayMode: "trail",
    }));
    if (!("showDirectoryPicker" in window)) {
      Object.defineProperty(window, "showDirectoryPicker", {
        configurable: true,
        value: async () => navigator.storage.getDirectory(),
      });
    }
  });
  await page.goto("/");
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("fpvhelper-training-export", 1);
      request.addEventListener("upgradeneeded", () => {
        if (!request.result.objectStoreNames.contains("settings")) request.result.createObjectStore("settings");
      });
      request.addEventListener("success", () => {
        const transaction = request.result.transaction("settings", "readwrite");
        transaction.objectStore("settings").put(root, "training-session-directory");
        transaction.addEventListener("complete", () => {
          request.result.close();
          resolve();
        });
        transaction.addEventListener("error", () => reject(transaction.error));
      });
      request.addEventListener("error", () => reject(request.error));
    });
  });
  await page.reload();
  await page.getByRole("button", { name: "打开画面" }).click();
  await expect(page.getByText("1/1 路 UVC 在线")).toBeVisible();
  await page.getByRole("button", { name: "连接桥接飞控" }).click();
  await expect(page.locator(".status-chip")).toContainText("数据桥在线");
  await page.getByRole("textbox", { name: "当前训练选手代号" }).fill("RACE-01");

  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const prototype = Object.getPrototypeOf(root) as {
      getFileHandle: FileSystemDirectoryHandle["getFileHandle"];
    };
    const getFileHandle = prototype.getFileHandle;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    (window as Window & { __releaseDelayedVideoFile?: () => void }).__releaseDelayedVideoFile = release;
    const media = window as Window & { __videoRecorderStartCalls?: number; __videoFileOpenPending?: boolean };
    media.__videoRecorderStartCalls = 0;
    const recorderStart = MediaRecorder.prototype.start;
    MediaRecorder.prototype.start = function (...args) {
      media.__videoRecorderStartCalls! += 1;
      return recorderStart.apply(this, args);
    };
    prototype.getFileHandle = async function (...args) {
      if (/\.(mp4|webm)$/.test(args[0])) {
        media.__videoFileOpenPending = true;
        await gate;
      }
      return getFileHandle.apply(this, args);
    };
  });

  await page.getByRole("button", { name: "● 开始记录" }).click();
  await expect(page.getByRole("heading", { name: "正在记录 RACE-01" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as Window & { __videoFileOpenPending?: boolean }).__videoFileOpenPending)).toBe(true);
  await page.getByRole("button", { name: "■ 结束记录" }).click();
  await expect(page.getByRole("button", { name: "保存记录…", exact: true })).toBeVisible();
  await page.evaluate(() => {
    (window as Window & { __releaseDelayedVideoFile?: () => void }).__releaseDelayedVideoFile?.();
  });
  await expectSavedSession(page, "RACE-01");
  await expect.poll(() => page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const files: Array<{ name: string; size: number }> = [];
    for await (const [name, handle] of root.entries()) {
      if (/\.(mp4|webm)$/.test(name) && handle.kind === "file") files.push({ name, size: (await (handle as FileSystemFileHandle).getFile()).size });
    }
    return files;
  })).toHaveLength(1);
  expect(await page.evaluate(() => (window as Window & { __videoRecorderStartCalls?: number }).__videoRecorderStartCalls)).toBe(0);
  const stopped = (await readStoredTrainingRecords(page)).sessions;
  expect(stopped).toHaveLength(1);
  expect(stopped[0].video.recorded).toBe(false);
  await expect(page.getByTestId("local-video-recording-status")).not.toContainText("SAVED");
});

test("two pilot bridges keep MSP_RC streams and Sessions isolated", async ({ page }) => {
  await page.route("**/api/events", (route) => route.abort("blockedbyclient"));
  await page.goto("/");
  await openInputSettings(page);
  await page.getByRole("button", { name: "+ 独立输入" }).click();

  const firstViewport = page.locator('.video-viewport[data-source-id="video-source-1"]');
  const secondViewport = page.locator('.video-viewport[data-source-id="video-source-2"]');
  await page.getByRole("textbox", { name: "当前训练选手代号" }).fill("PILOT-02");
  await firstViewport.locator(".video-viewport-select").click();
  await page.getByRole("textbox", { name: "当前训练选手代号" }).fill("PILOT-01");

  await firstViewport.getByRole("button", { name: "连接 PILOT-01 桥接飞控" }).click();
  await expect(firstViewport.locator(".pilot-viewport-telemetry")).toHaveAttribute("data-telemetry-source", "serial");
  await expect(firstViewport.locator(".pilot-viewport-telemetry")).toHaveAttribute("data-telemetry-connection", "live");

  await secondViewport.getByRole("button", { name: "连接 PILOT-02 桥接飞控" }).click();
  await expect(secondViewport.locator(".pilot-viewport-telemetry")).toHaveAttribute("data-telemetry-source", "serial");
  await expect(secondViewport.locator(".pilot-viewport-telemetry")).toHaveAttribute("data-telemetry-connection", "live");
  const commandsBeforeRateWindow = await page.evaluate(() => (
    window.__fpvFakeSerialPorts.slice(0, 2).map((port) => port.requestedCommands.length)
  ));
  await page.waitForTimeout(300);
  const commandsInRateWindow = await page.evaluate((commandOffsets) => (
    window.__fpvFakeSerialPorts.slice(0, 2).map((port, index) => (
      port.requestedCommands.slice(commandOffsets[index])
    ))
  ), commandsBeforeRateWindow);
  for (const commands of commandsInRateWindow) {
    const rcCount = commands.filter((command) => command === 105).length;
    const statusExCount = commands.filter((command) => command === 150).length;
    const analogCount = commands.filter((command) => command === 110).length;
    expect(rcCount).toBeGreaterThanOrEqual(15);
    expect(rcCount).toBeLessThanOrEqual(40);
    expect(statusExCount).toBeGreaterThanOrEqual(1);
    expect(statusExCount).toBeLessThanOrEqual(5);
    expect(analogCount).toBeLessThanOrEqual(1);
  }
  await expect(page.locator(".video-viewport.is-active")).toHaveAttribute("data-source-id", "video-source-2");
  await expectStickInputs(page, { roll: -20, pitch: 20, yaw: -10, throttle: 75 });
  await expect(firstViewport.locator(".pilot-mini-telemetry")).toContainText("THR 25%");

  await firstViewport.locator(".video-viewport-select").click();
  await expectStickInputs(page, { roll: 20, pitch: -20, yaw: 10, throttle: 25 });

  const recordButton = page.getByRole("button", { name: "● 开始记录" });
  await expect(recordButton).toBeEnabled();
  await recordButton.click();
  await expect(page.getByRole("heading", { name: "正在记录 PILOT-01" })).toBeVisible();
  await expect(secondViewport.locator(".video-viewport-select")).toBeDisabled();
  const uniqueSampleCount = page.locator(".session-stats span").filter({ hasText: "独立样本" }).locator("b");
  await expect.poll(async () => Number((await uniqueSampleCount.textContent()) ?? "0")).toBeGreaterThanOrEqual(3);
  await page.getByRole("button", { name: "■ 结束记录" }).click();
  await expectSavedSession(page, "PILOT-01");
  await openInputSettings(page);

  await secondViewport.locator(".video-viewport-select").click();
  await expect(recordButton).toBeEnabled();
  await recordButton.click();
  await expect(page.getByRole("heading", { name: "正在记录 PILOT-02" })).toBeVisible();
  await expect.poll(async () => Number((await uniqueSampleCount.textContent()) ?? "0")).toBeGreaterThanOrEqual(3);
  await page.getByRole("button", { name: "■ 结束记录" }).click();
  await expectSavedSession(page, "PILOT-02");
  await expect(page.locator(".session-list-item")).toHaveCount(2);

  const { sessions } = await readStoredTrainingRecords(page);
  const pilotOne = sessions.find((session) => session.athleteCode === "PILOT-01");
  const pilotTwo = sessions.find((session) => session.athleteCode === "PILOT-02");
  expect(pilotOne?.samples[0]?.channelsUs.slice(0, 4)).toEqual([1_600, 1_400, 1_550, 1_250]);
  expect(pilotTwo?.samples[0]?.channelsUs.slice(0, 4)).toEqual([1_400, 1_600, 1_450, 1_750]);

  await openInputSettings(page);
  const secondResponsesBefore = await page.evaluate(() => window.__fpvFakeSerialPorts[1].rcResponses);
  await page.evaluate(() => window.__fpvFakeSerialControl.disconnectPort(0));
  await expect(firstViewport.locator(".pilot-viewport-telemetry")).toHaveAttribute("data-telemetry-connection", "error");
  await expect(secondViewport.locator(".pilot-viewport-telemetry")).toHaveAttribute("data-telemetry-connection", "live");
  await expect.poll(() => page.evaluate(() => window.__fpvFakeSerialPorts[1].rcResponses)).toBeGreaterThan(secondResponsesBefore);
  expect(await page.evaluate(() => window.__fpvFakeSerialPorts[1].closeCalls)).toBe(0);
});

test("fake media and read-only MSP bridge persist a local training session", async ({ page }) => {
  const analyticsRequests: Array<{ method: string; url: string }> = [];
  await page.route("**/api/events", async (route) => {
    const request = route.request();
    analyticsRequests.push({ method: request.method(), url: request.url() });
    await route.abort("blockedbyclient");
  });

  await page.goto("/");

  await expect(page.getByRole("heading", { name: /^飞行工作台/ })).toBeVisible();
  await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "工作站设置", exact: true }).click();
  await expect(page.getByRole("heading", { name: "本机统计 · 关闭" })).toBeVisible();
  await expect(page.getByText("当前域名仅用于内部验证，不采集统计事件。")).toBeVisible();
  await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "飞行工作台", exact: true }).click();

  await page.getByRole("button", { name: "打开画面" }).click();
  await expect(page.getByText(/HDMI 画面在线/)).toBeVisible();
  await expect.poll(() => page.locator(".video-viewport video").evaluate((video) => {
    const element = video as HTMLVideoElement;
    return element.srcObject instanceof MediaStream && element.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
  })).toBe(true);

  const recordButton = page.getByRole("button", { name: "● 开始记录" });
  await expect(recordButton).toBeDisabled();

  await page.getByRole("button", { name: "连接桥接飞控" }).click();
  await expect(page.locator(".status-chip")).toContainText("数据桥在线");
  await expect(page.locator(".source-badge")).toHaveText("GROUND_RC");
  await expectStickInputs(page, { roll: 20, pitch: -20, yaw: 10, throttle: 25 });
  await expect(page.locator(".gauge-grid--primary")).toContainText("1250 μs · GROUND_RC / MSP_RC");

  await page.getByText("采集桥诊断", { exact: true }).click();
  await expect(page.locator(".bridge-card")).toContainText("地面桥电压：5.0 V");
  await expect(page.getByText("遥控链路：遥控链路正常。Bridge FC 在线不等于遥控器在线。")).toBeVisible();
  await expect(page.locator(".bridge-card .card-heading")).toContainText("RX OK");
  await expect(page.getByText(/解析质量：良好 · 有效帧/)).toBeVisible();
  await expect(page.getByText(/地面桥 RSSI|legacy RSSI/)).toHaveCount(0);

  await expect.poll(() => page.evaluate(() => (
    [...new Set(window.__fpvFakeSerial.requestedCommands)].sort((left, right) => left - right)
  ))).toEqual([1, 105, 110, 150, 0x3006]);
  await expect.poll(() => page.evaluate(() => window.__fpvFakeSerial)).toMatchObject({
    requestPortCalls: 1,
    openCalls: 1,
    lastBaudRate: 115_200,
    protocolErrors: [],
  });
  await expect(page.evaluate(() => window.__fpvFakeSerialControl.attemptClose())).resolves.toBe("InvalidStateError");
  await expect.poll(() => page.evaluate(() => window.__fpvFakeSerial)).toMatchObject({
    closeAttempts: 1,
    closeCalls: 0,
    closeRejectedWhileLocked: 1,
  });

  await page.getByRole("textbox", { name: "当前训练选手代号" }).fill("E2E-07");
  await expect(recordButton).toBeEnabled();
  await expect(recordButton).toHaveAttribute("title", "已满足开始条件");
  await recordButton.click();
  await expect(page.getByRole("button", { name: "■ 结束记录" })).toBeEnabled();
  await expect(page.getByRole("heading", { name: "正在记录 E2E-07" })).toBeVisible();

  const uniqueSampleCount = page.locator(".session-stats span").filter({ hasText: "独立样本" }).locator("b");
  await expect.poll(async () => Number((await uniqueSampleCount.textContent()) ?? "0")).toBeGreaterThanOrEqual(3);

  await page.getByRole("button", { name: "■ 结束记录" }).click();
  await expectSavedSession(page, "E2E-07");
  await expect(page.getByRole("article", { name: /E2E-07/ })).toBeVisible();
  await expect(page.locator(".session-list-item")).toHaveCount(1);

  const stored = await readStoredTrainingRecords(page) as { drafts: unknown[]; sessions: StoredSession[] };

  expect(stored.drafts).toEqual([]);
  expect(stored.sessions).toHaveLength(1);
  const completedSession = stored.sessions[0];
  expect(completedSession).toMatchObject({
    schemaVersion: 2,
    athleteCode: "E2E-07",
    initialSource: "ground_rc",
    dataSources: ["ground_rc"],
    interrupted: false,
  });
  expect(completedSession.sampleCount).toBeGreaterThanOrEqual(3);
  expect(completedSession.samples).toHaveLength(completedSession.sampleCount);
  expect(completedSession.samples.at(-1)).toMatchObject({
    source: "ground_rc",
    channelsUs: [1_600, 1_400, 1_550, 1_250, 1_000, 1_000, 1_000, 1_000],
    rc: {
      rollStickPercent: 20,
      pitchStickPercent: -20,
      yawStickPercent: 10,
      throttleStickPercent: 25,
      throttleUs: 1_250,
    },
    groundBridge: {
      voltage: 5,
    },
  });
  expect(completedSession.samples.at(-1)?.groundBridge.mspRssiPercent).toBeCloseTo((900 / 1_023) * 100, 5);

  await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "飞行工作台", exact: true }).click();
  await page.evaluate(() => window.__fpvFakeSerialControl.holdNextWrite());
  await expect.poll(() => page.evaluate(() => ({
    pendingReads: window.__fpvFakeSerial.pendingReads,
    pendingWrites: window.__fpvFakeSerial.pendingWrites,
  }))).toEqual({ pendingReads: 1, pendingWrites: 1 });

  await page.getByRole("button", { name: "返回演示" }).click();
  await expect(page.locator(".status-chip")).toContainText("演示数据");
  await expect.poll(() => page.evaluate(() => window.__fpvFakeSerial)).toMatchObject({
    closeAttempts: 2,
    closeCalls: 1,
    closeRejectedWhileLocked: 1,
    cancelCalls: 1,
    abortCalls: 1,
    readerReleaseCalls: 1,
    writerReleaseCalls: 1,
    pendingReads: 0,
    maxPendingReads: 1,
    pendingWrites: 0,
    maxPendingWrites: 1,
    cancelledPendingRead: true,
    abortedPendingWrite: true,
    protocolErrors: [],
  } satisfies Partial<FakeSerialMetrics>);

  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  await page.waitForTimeout(250);
  expect(analyticsRequests).toEqual([]);
});
