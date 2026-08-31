import { expect, test, type FakeSerialMetrics } from "./fixtures/fpv-hardware";

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

  await page.getByRole("button", { name: "输入布局：四分屏" }).click();
  const firstPilot = page.locator(".video-viewport-tabs").getByRole("button", { name: "选手 1" });
  const secondPilot = page.locator(".video-viewport-tabs").getByRole("button", { name: "选手 2" });
  await expect(secondPilot).toBeVisible();
  await firstPilot.click();
  await page.getByRole("region", { name: "选手 1 画面绑定" })
    .getByRole("button", { name: "选手取景：完整画面" })
    .click();
  await secondPilot.click();
  await page.getByRole("textbox", { name: "选手代号" }).fill("PILOT-02");
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
  await expect(page.locator(".video-viewport-tabs").getByRole("button", { name: "PILOT-02" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("textbox", { name: "选手代号" })).toHaveValue("PILOT-02");
  const restoredSecondBinding = page.getByRole("region", { name: "PILOT-02 画面绑定" });
  await expect(restoredSecondBinding.getByRole("slider", { name: "裁切左边界" })).toHaveValue("55");
  await expect(restoredSecondBinding.getByRole("slider", { name: "裁切上边界" })).toHaveValue("5");
  await expect(restoredSecondBinding.getByRole("slider", { name: "裁切画面宽度" })).toHaveValue("40");
  await expect(restoredSecondBinding.getByRole("slider", { name: "裁切画面高度" })).toHaveValue("40");
  await page.locator(".video-viewport-tabs").getByRole("button", { name: "选手 1" }).click();
  await expect(page.getByRole("region", { name: "选手 1 画面绑定" })
    .getByRole("button", { name: "选手取景：完整画面" })).toHaveAttribute("aria-pressed", "true");
});

test("pilot video binding switches between full input and a persisted custom crop", async ({ page }) => {
  await page.goto("/");
  const onboarding = page.getByRole("dialog", { name: "首次使用检查" });
  if (await onboarding.isVisible()) await onboarding.getByRole("button", { name: "已了解" }).click();

  const binding = page.getByRole("region", { name: "选手 1 画面绑定" });
  await expect(binding.getByRole("button", { name: "选手取景：完整画面" })).toHaveAttribute("aria-pressed", "true");
  await binding.getByRole("button", { name: "选手取景：裁切区域" }).click();

  await binding.getByRole("slider", { name: "裁切画面宽度" }).fill("70");
  await binding.getByRole("slider", { name: "裁切画面高度" }).fill("60");
  await binding.getByRole("slider", { name: "裁切左边界" }).fill("10");
  await binding.getByRole("slider", { name: "裁切上边界" }).fill("15");

  await page.getByRole("button", { name: "打开画面" }).click();
  await expect(page.getByText("1/1 路 UVC 在线")).toBeVisible();

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
  await page.getByRole("button", { name: "+ 独立输入" }).click();

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
  await expect(page.locator(".video-viewport .hud-top-left")).toHaveCount(1);
  await page.locator('.video-viewport[data-source-id="video-source-1"] .video-viewport-select').click();
  await expect(page.locator(".video-viewport.is-active")).toHaveAttribute("data-source-id", "video-source-1");
  await expect(page.locator(".video-viewport.is-active .hud-top-left")).toHaveCount(1);

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

  await expect(page.getByRole("checkbox", { name: "同时录制当前选手视频" })).toBeChecked();
  await expect(page.getByText(/本地保存目录：/)).toBeVisible();
  await page.getByRole("button", { name: "打开画面" }).click();
  await expect(page.getByText("1/1 路 UVC 在线")).toBeVisible();
  await page.getByRole("button", { name: "连接桥接飞控" }).click();
  await expect(page.locator(".status-chip")).toContainText("数据桥在线");
  await page.getByRole("textbox", { name: "选手代号" }).fill("VIDEO-01");

  const recordButton = page.getByRole("button", { name: "● 开始记录" });
  await expect(recordButton).toBeEnabled();
  await recordButton.click();
  await expect(page.getByTestId("local-video-recording-status")).toContainText("REC");
  await page.waitForTimeout(1_200);
  await page.getByRole("button", { name: "■ 结束记录" }).click();
  await expect(page.getByTestId("local-video-recording-status")).toContainText("SAVED");

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

  const recordings = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const files: Array<{ name: string; size: number }> = [];
    for await (const [name, handle] of root.entries()) {
      if (handle.kind !== "file" || !name.endsWith(".webm")) continue;
      const file = await (handle as FileSystemFileHandle).getFile();
      files.push({ name, size: file.size });
    }
    return files;
  });
  expect(recordings).toHaveLength(2);
  expect(recordings.some((recording) => /-VIDEO-01-.*-full\.webm$/.test(recording.name))).toBe(true);
  expect(recordings.some((recording) => /-VIDEO-01-.*-crop\.webm$/.test(recording.name))).toBe(true);
  expect(recordings.every((recording) => recording.size > 0)).toBe(true);

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
  await expect(page.getByRole("heading", { name: "最近记录已保存在本机" })).toBeVisible();
  await page.evaluate(() => {
    (window as Window & { __releaseDelayedVideoClose?: () => void }).__releaseDelayedVideoClose?.();
  });
  await expect(page.getByTestId("local-video-recording-status")).toContainText("VIDEO ERROR");
  await expect(page.getByTestId("local-video-recording-status")).toContainText("视频源已中断");
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
  await page.getByRole("textbox", { name: "选手代号" }).fill("RACE-01");

  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const prototype = Object.getPrototypeOf(root) as {
      getFileHandle: FileSystemDirectoryHandle["getFileHandle"];
    };
    const getFileHandle = prototype.getFileHandle;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    (window as Window & { __releaseDelayedVideoFile?: () => void }).__releaseDelayedVideoFile = release;
    prototype.getFileHandle = async function (...args) {
      await gate;
      return getFileHandle.apply(this, args);
    };
  });

  await page.getByRole("button", { name: "● 开始记录" }).click();
  await expect(page.getByRole("heading", { name: "正在记录 RACE-01" })).toBeVisible();
  await page.getByRole("button", { name: "■ 结束记录" }).click();
  await expect(page.getByRole("heading", { name: "最近记录已保存在本机" })).toBeVisible();
  await page.evaluate(() => {
    (window as Window & { __releaseDelayedVideoFile?: () => void }).__releaseDelayedVideoFile?.();
  });
  await expect(page.getByTestId("local-video-recording-status")).toContainText("未启动孤立录像");
  await expect(page.getByTestId("local-video-recording-status")).toContainText("VIDEO ERROR");
});

test("two pilot bridges keep MSP_RC streams and Sessions isolated", async ({ page }) => {
  await page.route("**/api/events", (route) => route.abort("blockedbyclient"));
  await page.goto("/");
  await page.getByRole("button", { name: "+ 独立输入" }).click();

  const firstViewport = page.locator('.video-viewport[data-source-id="video-source-1"]');
  const secondViewport = page.locator('.video-viewport[data-source-id="video-source-2"]');
  await page.getByRole("textbox", { name: "选手代号" }).fill("PILOT-02");
  await firstViewport.locator(".video-viewport-select").click();
  await page.getByRole("textbox", { name: "选手代号" }).fill("PILOT-01");

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
  await expect(page.locator(".hud-bottom-left")).toContainText("ROLL STICK -20");
  await expect(page.locator(".hud-bottom-left")).toContainText("PITCH STICK +20");
  await expect(page.locator(".hud-bottom-left")).toContainText("YAW STICK -10");
  await expect(page.locator(".throttle-ladder")).toContainText("75%");
  await expect(firstViewport.locator(".pilot-mini-telemetry")).toContainText("THR 25%");

  await firstViewport.locator(".video-viewport-select").click();
  await expect(page.locator(".hud-bottom-left")).toContainText("ROLL STICK +20");
  await expect(page.locator(".hud-bottom-left")).toContainText("PITCH STICK -20");
  await expect(page.locator(".hud-bottom-left")).toContainText("YAW STICK +10");
  await expect(page.locator(".throttle-ladder")).toContainText("25%");

  const recordButton = page.getByRole("button", { name: "● 开始记录" });
  await expect(recordButton).toBeEnabled();
  await recordButton.click();
  await expect(page.getByRole("heading", { name: "正在记录 PILOT-01" })).toBeVisible();
  await expect(secondViewport.locator(".video-viewport-select")).toBeDisabled();
  const uniqueSampleCount = page.locator(".session-stats span").filter({ hasText: "独立样本" }).locator("b");
  await expect.poll(async () => Number((await uniqueSampleCount.textContent()) ?? "0")).toBeGreaterThanOrEqual(3);
  await page.getByRole("button", { name: "■ 结束记录" }).click();
  await expect(page.getByRole("heading", { name: "最近记录已保存在本机" })).toBeVisible();

  await secondViewport.locator(".video-viewport-select").click();
  await expect(recordButton).toBeEnabled();
  await recordButton.click();
  await expect(page.getByRole("heading", { name: "正在记录 PILOT-02" })).toBeVisible();
  await expect.poll(async () => Number((await uniqueSampleCount.textContent()) ?? "0")).toBeGreaterThanOrEqual(3);
  await page.getByRole("button", { name: "■ 结束记录" }).click();
  await expect(page.locator(".today-records-card")).toContainText("共 2 条");

  const sessions = await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("fpvhelper-training", 1);
      request.addEventListener("success", () => resolve(request.result));
      request.addEventListener("error", () => reject(request.error));
    });
    const transaction = database.transaction("sessions", "readonly");
    const request = transaction.objectStore("sessions").getAll();
    return await new Promise<Array<{ athleteCode: string; samples: Array<{ channelsUs: number[] }> }>>((resolve, reject) => {
      request.addEventListener("success", () => resolve(request.result));
      request.addEventListener("error", () => reject(request.error));
    });
  });
  const pilotOne = sessions.find((session) => session.athleteCode === "PILOT-01");
  const pilotTwo = sessions.find((session) => session.athleteCode === "PILOT-02");
  expect(pilotOne?.samples[0]?.channelsUs.slice(0, 4)).toEqual([1_600, 1_400, 1_550, 1_250]);
  expect(pilotTwo?.samples[0]?.channelsUs.slice(0, 4)).toEqual([1_400, 1_600, 1_450, 1_750]);

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

  await expect(page.getByRole("heading", { name: "飞行操控台" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "本机统计 · 关闭" })).toBeVisible();
  await expect(page.getByText("当前域名仅用于内部验证，不采集统计事件。")).toBeVisible();

  await page.getByRole("button", { name: "打开画面" }).click();
  await expect(page.getByText(/HDMI 画面在线/)).toBeVisible();
  await expect.poll(() => page.locator("video").evaluate((video) => {
    const element = video as HTMLVideoElement;
    return element.srcObject instanceof MediaStream && element.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
  })).toBe(true);

  const recordButton = page.getByRole("button", { name: "● 开始记录" });
  await expect(recordButton).toBeDisabled();

  await page.getByRole("button", { name: "连接桥接飞控" }).click();
  await expect(page.locator(".status-chip")).toContainText("数据桥在线");
  await expect(page.locator(".source-badge")).toHaveText("GROUND_RC");
  await expect(page.locator(".hud-bottom-left")).toContainText("ROLL STICK +20");
  await expect(page.locator(".hud-bottom-left")).toContainText("PITCH STICK -20");
  await expect(page.locator(".hud-bottom-left")).toContainText("YAW STICK +10");
  await expect(page.locator(".throttle-ladder")).toContainText("25%");
  await expect(page.locator(".gauge-grid--primary")).toContainText("1250 μs · GROUND_RC / MSP_RC");
  await expect(page.locator(".hud-top-right")).toContainText("5.0 V");

  await page.getByText("桥接诊断字段（非机上 LQ）").click();
  await expect(page.getByText("遥控链路：遥控链路正常。Bridge FC 在线不等于遥控器在线。")).toBeVisible();
  await expect(page.locator(".bridge-card .card-heading")).toContainText("RX OK");
  await expect(page.getByText(/解析质量：良好 · 有效帧/)).toBeVisible();
  const rssiGauge = page.locator(".gauge-card").filter({ hasText: "地面桥 RSSI 字段" });
  await expect(rssiGauge.locator("strong")).toHaveText("88");

  await expect.poll(() => page.evaluate(() => (
    [...new Set(window.__fpvFakeSerial.requestedCommands)].sort((left, right) => left - right)
  ))).toEqual([105, 110, 150]);
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

  await page.getByRole("textbox", { name: "选手代号" }).fill("E2E-07");
  await expect(recordButton).toBeEnabled();
  await expect(recordButton).toHaveAttribute("title", "已满足开始条件");
  await recordButton.click();
  await expect(page.getByRole("button", { name: "■ 结束记录" })).toBeEnabled();
  await expect(page.getByRole("heading", { name: "正在记录 E2E-07" })).toBeVisible();

  const uniqueSampleCount = page.locator(".session-stats span").filter({ hasText: "独立样本" }).locator("b");
  await expect.poll(async () => Number((await uniqueSampleCount.textContent()) ?? "0")).toBeGreaterThanOrEqual(3);

  await page.getByRole("button", { name: "■ 结束记录" }).click();
  await expect(page.getByRole("heading", { name: "最近记录已保存在本机" })).toBeVisible();
  await expect(page.getByRole("article", { name: /训练 Session：E2E-07/ })).toBeVisible();
  await expect(page.locator(".today-records-card")).toContainText("共 1 条");

  const stored = await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("fpvhelper-training", 1);
      request.addEventListener("success", () => resolve(request.result));
      request.addEventListener("error", () => reject(request.error));
    });
    const transaction = database.transaction(["drafts", "sessions"], "readonly");
    const draftsRequest = transaction.objectStore("drafts").getAll();
    const sessionsRequest = transaction.objectStore("sessions").getAll();
    const requestResult = <T,>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
      request.addEventListener("success", () => resolve(request.result));
      request.addEventListener("error", () => reject(request.error));
    });
    const [drafts, sessions] = await Promise.all([
      requestResult(draftsRequest),
      requestResult(sessionsRequest),
    ]);
    await new Promise<void>((resolve, reject) => {
      transaction.addEventListener("complete", () => resolve());
      transaction.addEventListener("abort", () => reject(transaction.error));
      transaction.addEventListener("error", () => reject(transaction.error));
    });
    database.close();
    return { drafts, sessions };
  }) as { drafts: unknown[]; sessions: StoredSession[] };

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
