import type { Page } from "@playwright/test";
import type { TrainingSession } from "../lib/training-session";
import { expect, readStoredTrainingRecords, test } from "./fixtures/fpv-hardware";

const directoryName = "arm-auto-record-exports";

interface ArmRecordingMetrics {
  starts: number;
  stops: number;
  encodedBytes: number;
  pendingVideoOpens: number;
  recorders: Array<{
    mimeType: string;
    timesliceMs: number | null;
    state: RecordingState;
    chunks: Array<{ elapsedMs: number; bytes: number }>;
    errors: string[];
  }>;
}

declare global {
  interface Window {
    __fpvArmRecording: ArmRecordingMetrics;
    __fpvArmRecordingControl: {
      holdNextVideoOpen(): void;
      releaseVideoOpen(): void;
      failActiveRecorder(): void;
    };
  }
}

async function installRecordingInstrumentation(page: Page) {
  await page.addInitScript(({ directoryName }) => {
    const metrics: ArmRecordingMetrics = { starts: 0, stops: 0, encodedBytes: 0, pendingVideoOpens: 0, recorders: [] };
    window.__fpvArmRecording = metrics;
    let holdNextVideoOpen = false;
    let releaseVideoOpen: (() => void) | null = null;
    let failRecorder: (() => void) | null = null;
    window.__fpvArmRecordingControl = {
      holdNextVideoOpen: () => { holdNextVideoOpen = true; },
      releaseVideoOpen: () => {
        releaseVideoOpen?.();
        releaseVideoOpen = null;
      },
      failActiveRecorder: () => {
        if (!failRecorder) throw new Error("No native recorder is active");
        failRecorder();
      },
    };

    // Instrument the native encoder; camera frames, encoded chunks and OPFS writes remain real.
    const nativeStart = MediaRecorder.prototype.start;
    MediaRecorder.prototype.start = function (timeslice?: number) {
      const startedAt = performance.now();
      const recorder: ArmRecordingMetrics["recorders"][number] = {
        mimeType: this.mimeType, timesliceMs: timeslice ?? null, state: this.state, chunks: [], errors: [],
      };
      const failThisRecorder = () => {
        if (this.state !== "recording") throw new Error("Native recorder is no longer recording");
        this.dispatchEvent(new ErrorEvent("error", {
          error: new DOMException("E2E 原生编码器错误事件", "EncodingError"),
        }));
      };
      this.addEventListener("stop", () => {
        metrics.stops += 1;
        recorder.state = this.state;
        if (failRecorder === failThisRecorder) failRecorder = null;
      }, { once: true });
      this.addEventListener("dataavailable", (event) => {
        metrics.encodedBytes += event.data.size;
        recorder.chunks.push({ elapsedMs: Math.round(performance.now() - startedAt), bytes: event.data.size });
      });
      this.addEventListener("error", (event) => {
        const failure = event as Event & { error?: DOMException };
        recorder.errors.push(failure.error?.message ?? "MediaRecorder error");
      });
      nativeStart.call(this, timeslice);
      failRecorder = failThisRecorder;
      recorder.state = this.state;
      metrics.recorders.push(recorder);
      metrics.starts += 1;
    };

    const nativeCreateWritable = FileSystemFileHandle.prototype.createWritable;
    FileSystemFileHandle.prototype.createWritable = async function (options?: FileSystemCreateWritableOptions) {
      if (holdNextVideoOpen && /\.(mp4|webm)$/.test(this.name)) {
        holdNextVideoOpen = false;
        metrics.pendingVideoOpens += 1;
        await new Promise<void>((resolve) => { releaseVideoOpen = resolve; });
        metrics.pendingVideoOpens -= 1;
      }
      return nativeCreateWritable.call(this, options);
    };

    Object.defineProperty(window, "showDirectoryPicker", {
      configurable: true,
      value: async () => (await navigator.storage.getDirectory()).getDirectoryHandle(directoryName, { create: true }),
    });
    Object.defineProperty(window, "showSaveFilePicker", {
      configurable: true,
      value: async () => { throw new Error("ARM recording must reuse its authorized directory"); },
    });
  }, { directoryName });
}

async function readJsonExports(page: Page) {
  return page.evaluate(async (directoryName) => {
    const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle(directoryName);
    const exports: Array<{ filename: string; bytes: number; contents: string; session: TrainingSession }> = [];
    for await (const [filename, handle] of directory.entries()) {
      if (handle.kind !== "file" || !filename.endsWith(".json")) continue;
      const file = await (handle as FileSystemFileHandle).getFile();
      if (file.size === 0) continue;
      const contents = await file.text();
      exports.push({ filename, bytes: file.size, contents, session: JSON.parse(contents) as TrainingSession });
    }
    return exports;
  }, directoryName);
}

async function expectPlayableVideo(page: Page, session: TrainingSession) {
  const receipt = session.video;
  if (!receipt.recorded) throw new Error("Saved session has no confirmed video receipt");
  expect(receipt.receiptEvidence).toBe("write_and_close_resolved");
  expect(receipt.overlay).toBe("sticks");
  expect(receipt.overlayTiming).toBe("latest_available_host_sample");
  expect(receipt.bytes).toBeGreaterThan(0);
  const playback = await page.evaluate(async ({ directoryName, filename }) => {
    const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle(directoryName);
    const file = await (await directory.getFileHandle(filename)).getFile();
    const header = Array.from(new Uint8Array(await file.slice(0, 12).arrayBuffer()));
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.muted = true;
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(() => reject(new Error("Saved ARM recording did not decode")), 5_000);
        video.addEventListener("loadeddata", () => { window.clearTimeout(timer); resolve(); }, { once: true });
        video.addEventListener("error", () => { window.clearTimeout(timer); reject(new Error("Saved ARM recording is not playable")); }, { once: true });
        video.src = url;
        video.load();
      });
      await video.play();
      return { bytes: file.size, header, width: video.videoWidth, height: video.videoHeight };
    } finally {
      video.pause();
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(url);
    }
  }, { directoryName, filename: receipt.filename });
  expect(playback.bytes).toBe(receipt.bytes);
  expect(playback.width).toBeGreaterThan(0);
  expect(playback.height).toBeGreaterThan(0);
  const container = playback.header.slice(4, 8).join(",") === "102,116,121,112"
    ? "mp4"
    : playback.header.slice(0, 4).join(",") === "26,69,223,163" ? "webm" : "unknown";
  expect(container).toBe(receipt.mimeType.startsWith("video/mp4") ? "mp4" : "webm");
  expect(receipt.filename.endsWith(`.${container}`)).toBe(true);
}

async function openArmBetaSettings(page: Page) {
  await page.getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "飞行工作台", exact: true }).click();
  await page.getByRole("button", { name: "ARM 自动记录 · Beta", exact: true }).click();
  const summary = page.locator("summary").filter({ hasText: "ARM 自动记录" });
  await expect(summary).toContainText(/Beta/i);
  await expect(summary).toBeVisible();
}

async function prepareAutomaticRecording(page: Page) {
  await installRecordingInstrumentation(page);
  await page.goto("/");
  await expect(page.getByRole("combobox", { name: "录制内容", exact: true })).toHaveValue("video");
  await openArmBetaSettings(page);
  await expect(page.getByLabel("ARM 通道", { exact: true })).toHaveValue("0");
  await expect(page.getByLabel("ARM 下限（μs）", { exact: true })).toHaveValue("1700");
  await expect(page.getByLabel("ARM 上限（μs，不含）", { exact: true })).toHaveValue("2100");
  const enable = page.getByRole("button", { name: "启用 ARM 自动记录", exact: true });
  await expect(enable).toBeDisabled();
  const setup = page.getByRole("region", { name: "录制准备", exact: true });
  await setup.getByRole("button", { name: /连接当前选手/ }).click();
  await expect(page.getByRole("textbox", { name: "当前训练选手代号", exact: true })).toHaveValue("BF-PILOT-01");
  await page.getByRole("textbox", { name: "当前训练选手代号", exact: true }).fill("AUTO-PILOT");
  await setup.getByRole("button", { name: /打开当前输入/ }).click();
  await expect(setup.getByRole("button", { name: /视频画面/ })).toHaveAttribute("data-ready", "true");
  await setup.getByRole("button", { name: /选择保存目录/ }).click();
  await expect(setup.getByRole("button", { name: /保存文件夹/ })).toHaveAttribute("data-ready", "true");
  await expect.poll(() => page.evaluate(() => window.__fpvFakeSerial.statusExResponses)).toBeGreaterThan(0);
  await expect(page.getByRole("button", { name: "● 开始记录", exact: true })).toBeEnabled();
  await openArmBetaSettings(page);
  await expect(enable).toBeEnabled();
}

async function setArmSwitch(page: Page, active: boolean) {
  await page.evaluate((active) => { window.__fpvFakeSerialPorts[0].rcChannelsUs[4] = active ? 2_000 : 1_000; }, active);
}

async function enableAutomaticRecording(page: Page) {
  await openArmBetaSettings(page);
  await page.getByRole("button", { name: "启用 ARM 自动记录", exact: true }).click();
  await expect(page.getByTestId("auto-phase")).toHaveAttribute("data-phase", "ready");
}

async function waitForVideoFrames(page: Page) {
  const preview = page.locator("video").first();
  const framesBefore = await preview.evaluate((video: HTMLVideoElement) => video.getVideoPlaybackQuality().totalVideoFrames);
  await expect.poll(() => preview.evaluate((video: HTMLVideoElement) => video.getVideoPlaybackQuality().totalVideoFrames))
    .toBeGreaterThan(framesBefore + 10);
}

async function startAndWaitForVideoFrames(page: Page) {
  await setArmSwitch(page, true);
  await expect(page.getByTestId("auto-phase")).toHaveAttribute("data-phase", "recording");
  await expect.poll(() => page.evaluate(() => window.__fpvArmRecording.recorders.at(-1)?.state)).toBe("recording");
  // Native AVC/MP4 can buffer beyond the requested timeslice; final file playback proves encoding.
  await waitForVideoFrames(page);
}

test.describe("FPVHelper ARM recording Beta with a 15 second DISARM delay", () => {
  test.use({ seedDataOnlyPreference: false });
  test.setTimeout(60_000);

  test.afterEach(async ({ page }, testInfo) => {
    const evidence = await page.evaluate(() => {
      const preview = document.querySelector("video");
      const frames = preview?.getVideoPlaybackQuality();
      const source = preview?.srcObject;
      return {
        pathname: window.location.pathname,
        phase: document.querySelector('[data-testid="auto-phase"]')?.getAttribute("data-phase"),
        recorder: window.__fpvArmRecording ?? null,
        preview: preview ? {
          readyState: preview.readyState, width: preview.videoWidth, height: preview.videoHeight,
          currentTime: preview.currentTime, totalFrames: frames?.totalVideoFrames, droppedFrames: frames?.droppedVideoFrames,
          tracks: source instanceof MediaStream ? source.getVideoTracks().map((track) => ({ state: track.readyState, muted: track.muted, enabled: track.enabled })) : [],
        } : null,
        serial: window.__fpvFakeSerial ? {
          rcResponses: window.__fpvFakeSerial.rcResponses, statusResponses: window.__fpvFakeSerial.statusExResponses,
          protocolErrors: window.__fpvFakeSerial.protocolErrors,
        } : null,
      };
    }).catch((error: unknown) => ({ evidenceError: error instanceof Error ? error.message : String(error) }));
    await testInfo.attach("arm-recording-browser-evidence.json", { contentType: "application/json", body: JSON.stringify(evidence, null, 2) });
  });

  test("redirects the former separate ARM recording URL into the FPVHelper dashboard", async ({ page }) => {
    await page.goto("/arm-record");
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("navigation", { name: "主导航" })
      .getByRole("button", { name: "飞行工作台", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(page.locator("summary").filter({ hasText: "ARM 自动记录" })).toContainText(/Beta/i);
  });

  test("keeps short DISARM and re-ARM in one session, saves after 15 seconds disarmed, and allows manual stop next time", async ({ page }) => {
    await prepareAutomaticRecording(page);
    await setArmSwitch(page, true);
    const responsesBefore = await page.evaluate(() => window.__fpvFakeSerial.rcResponses);
    await expect.poll(() => page.evaluate(() => window.__fpvFakeSerial.rcResponses)).toBeGreaterThan(responsesBefore + 10);
    await page.getByRole("button", { name: "启用 ARM 自动记录", exact: true }).click();
    await expect(page.getByTestId("auto-phase")).toHaveAttribute("data-phase", "waiting_disarm");
    expect(await page.evaluate(() => window.__fpvArmRecording.starts)).toBe(0);
    await setArmSwitch(page, false);
    await expect(page.getByTestId("auto-phase")).toHaveAttribute("data-phase", "ready");

    let originalExport: Awaited<ReturnType<typeof readJsonExports>>[number] | undefined;
    for (let cycle = 1; cycle <= 2; cycle += 1) {
      if (cycle > 1) await openArmBetaSettings(page);
      await startAndWaitForVideoFrames(page);
      await setArmSwitch(page, false);
      await waitForVideoFrames(page);
      await expect(page.getByTestId("auto-phase")).toHaveAttribute("data-phase", "recording");
      await expect(page.getByTestId("disarm-countdown")).toContainText(/秒/);
      expect(await readJsonExports(page)).toHaveLength(cycle - 1);

      // A brief crash and re-ARM must cancel the pending end without splitting the recording.
      await startAndWaitForVideoFrames(page);
      await expect(page.getByTestId("disarm-countdown")).toHaveCount(0);
      expect(await page.evaluate(() => window.__fpvArmRecording)).toMatchObject({ starts: cycle, stops: cycle - 1 });
      if (cycle === 1) {
        const disarmedAt = Date.now();
        await setArmSwitch(page, false);
        await expect(page.getByTestId("auto-phase")).toHaveAttribute("data-phase", "ready", { timeout: 20_000 });
        expect(Date.now() - disarmedAt).toBeGreaterThanOrEqual(15_000);
      } else {
        await page.getByRole("button", { name: "■ 结束记录", exact: true }).click();
        await expect(page.getByTestId("auto-phase")).toHaveAttribute("data-phase", "disabled");
      }
      await expect.poll(async () => (await readJsonExports(page)).length).toBe(cycle);
      const exports = await readJsonExports(page);
      const saved = exports.find((entry) => entry.session.id !== originalExport?.session.id);
      if (!saved) throw new Error("Expected a new saved ARM session");
      expect(saved.bytes).toBeGreaterThan(0);
      expect(saved.session).toMatchObject({ athleteCode: "AUTO-PILOT", initialSource: "ground_rc", interrupted: false });
      expect(saved.session.sampleCount).toBe(saved.session.samples.length);
      expect(saved.session.samples.length).toBeGreaterThan(10);
      expect(saved.session.samples.every((sample) => sample.source === "ground_rc")).toBe(true);
      expect(saved.session.samples.some((sample) => sample.channelsUs[4] === 2_000)).toBe(true);
      const switchValues = saved.session.samples.map((sample) => sample.channelsUs[4]);
      const firstDisarmIndex = switchValues.indexOf(1_000);
      expect(firstDisarmIndex).toBeGreaterThan(0);
      expect(switchValues.slice(firstDisarmIndex + 1)).toContain(2_000);
      await expectPlayableVideo(page, saved.session);
      if (!saved.session.video.recorded) throw new Error("Missing video receipt");
      await expect(page.getByTestId("local-video-recording-status")).toContainText(saved.session.video.filename);
      expect((await readStoredTrainingRecords(page)).sessions).toHaveLength(cycle);
      if (originalExport) expect(exports.find((entry) => entry.filename === originalExport!.filename)).toEqual(originalExport);
      else originalExport = saved;
    }
    const sessions = (await readJsonExports(page)).map((entry) => entry.session);
    expect(new Set(sessions.map((session) => session.id)).size).toBe(2);
    expect(new Set(sessions.map((session) => session.video.recorded && session.video.filename)).size).toBe(2);
    expect(await page.evaluate(() => window.__fpvArmRecording)).toMatchObject({ starts: 2, stops: 2 });
    expect(await page.evaluate(() => window.__fpvFakeSerial.protocolErrors)).toEqual([]);
  });

  test("keeps starting through short DISARM but cancels a pending encoder on manual stop and recovers for the next ARM", async ({ page }) => {
    await prepareAutomaticRecording(page);
    await enableAutomaticRecording(page);
    await page.evaluate(() => window.__fpvArmRecordingControl.holdNextVideoOpen());
    await setArmSwitch(page, true);
    await expect(page.getByTestId("auto-phase")).toHaveAttribute("data-phase", "starting");
    await expect.poll(() => page.evaluate(() => window.__fpvArmRecording.pendingVideoOpens)).toBe(1);
    await setArmSwitch(page, false);
    const responsesBefore = await page.evaluate(() => window.__fpvFakeSerial.rcResponses);
    await expect.poll(() => page.evaluate(() => window.__fpvFakeSerial.rcResponses)).toBeGreaterThan(responsesBefore + 30);
    await expect(page.getByTestId("auto-phase")).toHaveAttribute("data-phase", "starting");
    await page.getByRole("button", { name: "停用 ARM 自动记录", exact: true }).click();
    await expect(page.getByTestId("auto-phase")).toHaveAttribute("data-phase", "stopping");
    await page.evaluate(() => window.__fpvArmRecordingControl.releaseVideoOpen());
    await expect(page.getByTestId("auto-phase")).toHaveAttribute("data-phase", "disabled");
    await expect.poll(async () => (await readJsonExports(page)).length).toBe(1);
    const [cancelled] = await readJsonExports(page);
    expect(cancelled.session.video.recorded).toBe(false);
    expect(await page.evaluate(() => window.__fpvArmRecording)).toMatchObject({ starts: 0, stops: 0, pendingVideoOpens: 0 });

    await enableAutomaticRecording(page);
    await startAndWaitForVideoFrames(page);
    await page.getByRole("button", { name: "■ 结束记录", exact: true }).click();
    await expect(page.getByTestId("auto-phase")).toHaveAttribute("data-phase", "disabled");
    await expect.poll(async () => (await readJsonExports(page)).length).toBe(2);
    const saved = (await readJsonExports(page)).find((entry) => entry.session.id !== cancelled.session.id);
    if (!saved) throw new Error("Expected a fresh session after cancelled startup");
    await expectPlayableVideo(page, saved.session);
    expect(await page.evaluate(() => window.__fpvArmRecording)).toMatchObject({ starts: 1, stops: 1, pendingVideoOpens: 0 });
  });

  test("keeps video recording after serial loss and marks the data gap when manually saved", async ({ page }) => {
    await prepareAutomaticRecording(page);
    await enableAutomaticRecording(page);
    await startAndWaitForVideoFrames(page);
    await setArmSwitch(page, false);
    await waitForVideoFrames(page);
    await page.evaluate(() => window.__fpvFakeSerialControl.disconnectPort(0));
    const bytesAtDisconnect = await page.evaluate(() => window.__fpvArmRecording.encodedBytes);
    // The last observed DISARM cannot end the recording after its input becomes unavailable.
    await page.waitForTimeout(15_500);
    expect(await page.evaluate(() => window.__fpvArmRecording.encodedBytes)).toBeGreaterThan(bytesAtDisconnect);
    await expect(page.getByTestId("auto-phase")).toHaveAttribute("data-phase", "recording");
    expect(await page.evaluate(() => window.__fpvArmRecording)).toMatchObject({ starts: 1, stops: 0 });
    expect(await readJsonExports(page)).toHaveLength(0);
    await page.getByRole("button", { name: "■ 结束记录", exact: true }).click();
    await expect(page.getByTestId("auto-phase")).toHaveAttribute("data-phase", "disabled");
    await expect.poll(async () => (await readJsonExports(page)).length).toBe(1);
    const [saved] = await readJsonExports(page);
    expect(saved.session.interrupted).toBe(true);
    expect(saved.session.interruptionReason).toBe("telemetry_unavailable");
    expect(saved.session.sampleCount).toBeGreaterThan(10);
    expect(saved.session.samples.every((sample) => sample.source === "ground_rc")).toBe(true);
    await expectPlayableVideo(page, saved.session);
    expect(await page.evaluate(() => window.__fpvArmRecording)).toMatchObject({ starts: 1, stops: 1 });
    expect(await page.evaluate(() => window.__fpvFakeSerial.protocolErrors)).toEqual([]);
  });

  test("disables automatic recording after a native encoder error and saves interrupted JSON without a successful video receipt", async ({ page }) => {
    await prepareAutomaticRecording(page);
    await enableAutomaticRecording(page);
    await startAndWaitForVideoFrames(page);
    await page.evaluate(() => window.__fpvArmRecordingControl.failActiveRecorder());

    await expect(page.getByTestId("auto-phase")).toHaveAttribute("data-phase", "disabled");
    await expect.poll(async () => (await readJsonExports(page)).length).toBe(1);
    const [saved] = await readJsonExports(page);
    expect(saved.session).toMatchObject({
      athleteCode: "AUTO-PILOT",
      interrupted: true,
      interruptionReason: "telemetry_unavailable",
      video: { recorded: false, synchronized: false },
    });
    expect(saved.session.sampleCount).toBeGreaterThan(10);
    expect(saved.session.samples.every((sample) => sample.source === "ground_rc")).toBe(true);
    const stored = await readStoredTrainingRecords(page);
    expect(stored.sessions).toHaveLength(1);
    expect(stored.sessions[0]).toMatchObject({
      id: saved.session.id,
      interrupted: true,
      interruptionReason: "telemetry_unavailable",
      video: { recorded: false },
    });
    await expect(page.getByTestId("local-video-recording-status")).toContainText("VIDEO ERROR");
    await expect(page.getByTestId("local-video-recording-status")).toContainText("E2E 原生编码器错误事件");
    await expect(page.getByTestId("local-video-recording-status")).not.toContainText("已确认写入并关闭");
    expect(await page.evaluate(() => window.__fpvArmRecording)).toMatchObject({
      starts: 1,
      stops: 1,
      recorders: [{ state: "inactive", errors: ["E2E 原生编码器错误事件"] }],
    });
  });
});
