import type { Page } from "@playwright/test";
import { test, expect, readStoredTrainingRecords } from "./fixtures/fpv-hardware";
import { installPhase2AMediaGate } from "./fixtures/phase2a-media-gate";

test.use({ seedDataOnlyPreference: false });

async function prepareDvr(page: Page, query = "") {
  await page.route("**/api/events", (route) => route.abort());
  await page.addInitScript(() => Object.defineProperty(window, "showDirectoryPicker", {
    configurable: true,
    value: async () => (await navigator.storage.getDirectory()).getDirectoryHandle("dvr-e2e", { create: true }),
  }));
  await page.goto(`/?analytics=off${query}`);
  await page.getByRole("combobox", { name: "录制内容", exact: true }).selectOption("dvr");
  const panel = page.getByRole("region", { name: "DVR 视频录制", exact: true });
  await panel.getByRole("button", { name: /打开视频输入/ }).click();
  await panel.getByRole("button", { name: /选择 DVR 保存目录/ }).click();
  await expect(page.getByRole("button", { name: "● 强制录制 DVR", exact: true })).toBeEnabled();
}

async function dvrFiles(page: Page) {
  return page.evaluate(async () => {
    const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle("dvr-e2e");
    const files: Array<{ name: string; bytes: number; width?: number; height?: number }> = [];
    for await (const [name, handle] of directory.entries()) {
      if (handle.kind !== "file") continue;
      const file = await (handle as FileSystemFileHandle).getFile();
      if (!/\.(mp4|webm)$/.test(name) || file.size === 0) { files.push({ name, bytes: file.size }); continue; }
      const video = document.createElement("video"), url = URL.createObjectURL(file);
      try {
        await new Promise<void>((resolve, reject) => {
          video.onloadedmetadata = () => resolve();
          video.onerror = () => reject(new Error("DVR file cannot be decoded"));
          video.src = url;
        });
        files.push({ name, bytes: file.size, width: video.videoWidth, height: video.videoHeight });
      } finally { video.removeAttribute("src"); video.load(); URL.revokeObjectURL(url); }
    }
    return files;
  });
}

test("DVR records a cropped video without pilot name, serial input or any IndexedDB database", async ({ page }) => {
  await page.addInitScript(() => {
    IDBFactory.prototype.open = function () { throw new DOMException("E2E database unavailable", "SecurityError"); };
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === "fpvhelper.training-preferences.v1") throw new DOMException("E2E preference write unavailable", "QuotaExceededError");
      setItem.call(this, key, value);
    };
  });
  await prepareDvr(page);
  await expect(page.getByRole("textbox", { name: "当前训练选手代号", exact: true })).toHaveValue("");
  await page.locator(".video-setup-details > summary").click();
  await page.getByRole("button", { name: "输入布局：共享画面", exact: true }).click();
  await page.getByRole("button", { name: "添加 1 名选手", exact: true }).click();
  await expect.poll(() => page.locator('.video-viewport video').evaluate((element) => (element as HTMLVideoElement).videoWidth)).toBeGreaterThan(0);
  const originalSize = await page.locator('.video-viewport video').evaluate((element) => {
    const video = element as HTMLVideoElement;
    return { width: video.videoWidth, height: video.videoHeight };
  });
  await page.getByRole("button", { name: "● 强制录制 DVR", exact: true }).click();
  await expect(page.getByTestId("dvr-recording-status")).toContainText("● REC");
  await expect(page.getByRole("combobox", { name: "录制内容", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "添加 2 名选手", exact: true })).toBeDisabled();
  expect(await page.evaluate(() => window.dispatchEvent(new Event("beforeunload", { cancelable: true })))).toBe(false);
  await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "训练记录", exact: true }).click();
  await expect(page.getByTestId("dvr-recording-status")).toContainText("● REC");
  await page.waitForTimeout(350);
  await page.getByRole("button", { name: "■ 结束 DVR", exact: true }).click();
  await expect(page.getByTestId("dvr-recording-status")).toContainText("已确认写入并关闭");
  const files = await dvrFiles(page);
  expect(files).toHaveLength(1);
  expect(files[0].name).toContain("DVR");
  expect(files[0].bytes).toBeGreaterThan(0);
  expect(files[0].width).toBe(originalSize.width / 2);
  expect(files[0].height).toBe(originalSize.height / 2);
  expect(await page.evaluate(() => window.__fpvFakeSerial.requestPortCalls)).toBe(0);
  expect(await page.evaluate(() => window.__fpvFakeSerial.rcResponses)).toBe(0);
  expect(await page.locator('.video-viewport video').evaluate((element) => (element as HTMLVideoElement).srcObject instanceof MediaStream && ((element as HTMLVideoElement).srcObject as MediaStream).getVideoTracks()[0].readyState)).toBe("live");
});

test("DVR keeps the recording locked until the real video file closes, without creating a Training Session", async ({ page }) => {
  await page.addInitScript(installPhase2AMediaGate);
  await prepareDvr(page, "&mediaGate=before-close");
  await page.getByRole("button", { name: "● 强制录制 DVR", exact: true }).click();
  await expect(page.getByTestId("dvr-recording-status")).toContainText("● REC");
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: "■ 结束 DVR", exact: true }).click();
  await expect(page.getByTestId("dvr-recording-status")).toContainText("正在写完最后一段");
  await expect(page.getByRole("combobox", { name: "录制内容", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "正在保存视频…", exact: true })).toBeDisabled();
  await expect(page.getByTestId("dvr-recording-status")).not.toContainText("已确认写入并关闭");
  expect((await readStoredTrainingRecords(page)).sessions).toHaveLength(0);
  expect((await readStoredTrainingRecords(page)).drafts).toHaveLength(0);
  await page.evaluate(() => (window as unknown as { __phase2aMediaGate: { release(): void } }).__phase2aMediaGate.release());
  await expect(page.getByTestId("dvr-recording-status")).toContainText("已确认写入并关闭");
  await expect(page.getByRole("combobox", { name: "录制内容", exact: true })).toBeEnabled();
  expect(await dvrFiles(page)).toHaveLength(1);
  await page.getByRole("combobox", { name: "录制内容", exact: true }).selectOption("video");
  await expect(page.getByRole("button", { name: "● 开始记录", exact: true })).toBeDisabled();
  expect((await readStoredTrainingRecords(page)).sessions).toHaveLength(0);
});

test("cancelled DVR setup never starts the encoder after its file open eventually returns", async ({ page }) => {
  await prepareDvr(page);
  await page.evaluate(() => {
    const recorderStart = MediaRecorder.prototype.start;
    const fileOpen = FileSystemDirectoryHandle.prototype.getFileHandle;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const control = { release: () => release(), starts: 0, waiting: false };
    Object.assign(window, { __dvrSetup: control });
    MediaRecorder.prototype.start = function (...args) { control.starts += 1; recorderStart.apply(this, args); };
    FileSystemDirectoryHandle.prototype.getFileHandle = async function (...args) {
      if (/\.(mp4|webm)$/.test(args[0])) { control.waiting = true; await gate; }
      return fileOpen.apply(this, args);
    };
  });
  await page.getByRole("button", { name: "● 强制录制 DVR", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __dvrSetup: { waiting: boolean } }).__dvrSetup.waiting)).toBe(true);
  await page.getByRole("button", { name: "取消 DVR 准备", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "录制内容", exact: true })).toBeDisabled();
  await page.evaluate(() => (window as unknown as { __dvrSetup: { release(): void } }).__dvrSetup.release());
  await expect(page.getByRole("button", { name: "● 强制录制 DVR", exact: true })).toBeEnabled();
  expect(await page.evaluate(() => (window as unknown as { __dvrSetup: { starts: number } }).__dvrSetup.starts)).toBe(0);
  await expect(page.getByTestId("dvr-recording-status")).not.toContainText("已确认写入并关闭");
  expect((await readStoredTrainingRecords(page)).sessions).toHaveLength(0);
  const files = await dvrFiles(page);
  expect(files.every((file) => file.bytes === 0)).toBe(true);
});

test("DVR remains available when a closed training video cannot be associated with its Session", async ({ page }) => {
  await page.addInitScript(installPhase2AMediaGate);
  await page.addInitScript(() => Object.defineProperty(window, "showDirectoryPicker", {
    configurable: true,
    value: async () => (await navigator.storage.getDirectory()).getDirectoryHandle("dvr-e2e", { create: true }),
  }));
  await page.goto("/?analytics=off&associationFault=once");
  const setup = page.getByRole("region", { name: "录制准备", exact: true });
  await setup.getByRole("button", { name: /连接当前选手/ }).click();
  await setup.getByRole("button", { name: /打开当前输入/ }).click();
  await setup.getByRole("button", { name: /选择保存目录/ }).click();
  await page.getByRole("button", { name: "● 开始记录", exact: true }).click();
  await expect.poll(async () => (await readStoredTrainingRecords(page)).drafts[0]?.samples.length ?? 0).toBeGreaterThan(30);
  await page.getByRole("button", { name: "■ 结束记录", exact: true }).click();
  await expect.poll(() => page.evaluate(() => JSON.stringify((window as unknown as { __phase2aMediaGate: { snapshot(): unknown } }).__phase2aMediaGate.snapshot()))).toContain("media-association-transaction-fault");
  await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "飞行工作台", exact: true }).click();
  await expect(page.getByRole("button", { name: "重试关联视频收据", exact: true })).toBeVisible();
  const original = (await readStoredTrainingRecords(page)).sessions[0];
  expect(original.video.recorded).toBe(false);
  const mode = page.getByRole("combobox", { name: "录制内容", exact: true });
  await expect(mode).toBeEnabled();
  await mode.selectOption("dvr");
  await page.getByRole("button", { name: "● 强制录制 DVR", exact: true }).click();
  await expect(page.getByTestId("dvr-recording-status")).toContainText("● REC");
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: "■ 结束 DVR", exact: true }).click();
  await expect(page.getByTestId("dvr-recording-status")).toContainText("已确认写入并关闭");
  const records = await readStoredTrainingRecords(page);
  expect(records.sessions).toHaveLength(1);
  expect(records.sessions[0]).toEqual(original);
  const files = await dvrFiles(page);
  expect(files).toHaveLength(2);
  expect(files.every((file) => /\.(mp4|webm)$/.test(file.name) && file.bytes > 0)).toBe(true);
});
