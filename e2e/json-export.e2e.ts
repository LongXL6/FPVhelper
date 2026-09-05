import type { Page } from "@playwright/test";
import type { TrainingSession } from "../lib/training-session";
import { expect, readStoredTrainingRecords, test } from "./fixtures/fpv-hardware";

const directoryName = "versioned-training-exports";
const permissionKey = "fpvhelper-e2e-export-permission";
const pickerCountKey = "fpvhelper-e2e-export-picker-count";

async function readJsonExports(page: Page) {
  return page.evaluate(async (name) => {
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle(name);
    const files: Array<{ filename: string; bytes: number; hash: string; session: TrainingSession }> = [];
    for await (const [filename, handle] of directory.entries()) {
      if (handle.kind !== "file" || !filename.endsWith(".json")) continue;
      const file = await (handle as FileSystemFileHandle).getFile();
      if (file.size === 0) continue;
      const contents = await file.arrayBuffer();
      const digest = await crypto.subtle.digest("SHA-256", contents);
      files.push({
        filename,
        bytes: file.size,
        hash: [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
        session: JSON.parse(new TextDecoder().decode(contents)) as TrainingSession,
      });
    }
    return files;
  }, directoryName);
}

async function connectRecordingInputs(page: Page) {
  const setup = page.getByRole("region", { name: "录制准备", exact: true });
  await setup.getByRole("button", { name: /连接当前选手/ }).click();
  await setup.getByRole("button", { name: /打开当前输入/ }).click();
  await expect(setup.getByRole("button", { name: /视频画面/ })).toHaveAttribute("data-ready", "true");
}

async function recordShortSession(page: Page, addMarker: boolean) {
  const start = page.getByRole("button", { name: "● 开始记录", exact: true });
  await expect(start).toBeEnabled();
  await start.click();
  await expect(page.getByTestId("local-video-recording-status")).toContainText("REC");
  if (addMarker) await page.locator(".marker-button").click();
  await page.waitForTimeout(800);
  await page.getByRole("button", { name: "■ 结束记录", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "训练记录", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.locator(".session-detail-header")).toContainText("已保存到本机");
}

test.describe("versioned JSON exports to an authorized directory", () => {
  test.use({ seedDataOnlyPreference: false });

  test("keeps original JSON bytes while exporting revised notes as v2 and v3 after reauthorization", async ({ page }) => {
    await page.addInitScript(({ directoryName, permissionKey, pickerCountKey }) => {
      type PermissionDirectory = FileSystemDirectoryHandle & {
        queryPermission(descriptor: { mode: "readwrite" }): Promise<PermissionState>;
        requestPermission(descriptor: { mode: "readwrite" }): Promise<PermissionState>;
      };
      const prototype = FileSystemDirectoryHandle.prototype as PermissionDirectory;
      const queryPermission = prototype.queryPermission;
      const requestPermission = prototype.requestPermission;
      // Only permission state is simulated; directory handles, file bytes and writes remain native OPFS.
      Object.defineProperty(prototype, "queryPermission", {
        configurable: true,
        value: async function (this: PermissionDirectory, descriptor: { mode: "readwrite" }) {
          if (this.name === directoryName && sessionStorage.getItem(permissionKey) === "prompt") return "prompt";
          return queryPermission.call(this, descriptor);
        },
      });
      Object.defineProperty(prototype, "requestPermission", {
        configurable: true,
        value: async function (this: PermissionDirectory, descriptor: { mode: "readwrite" }) {
          const permission = await requestPermission.call(this, descriptor);
          if (this.name === directoryName && permission === "granted") sessionStorage.removeItem(permissionKey);
          return permission;
        },
      });
      Object.defineProperty(window, "showDirectoryPicker", {
        configurable: true,
        value: async () => {
          sessionStorage.setItem(pickerCountKey, String(Number(sessionStorage.getItem(pickerCountKey) ?? "0") + 1));
          const root = await navigator.storage.getDirectory();
          return root.getDirectoryHandle(directoryName, { create: true });
        },
      });
      Object.defineProperty(window, "showSaveFilePicker", {
        configurable: true,
        value: async () => { throw new Error("Configured-directory export must not open a different file picker"); },
      });
    }, { directoryName, permissionKey, pickerCountKey });

    await page.goto("/");
    const setup = page.getByRole("region", { name: "录制准备", exact: true });
    await expect(page.getByRole("combobox", { name: "录制内容", exact: true })).toHaveValue("video");
    await setup.getByRole("button", { name: /选择保存目录/ }).click();
    await expect(setup.getByRole("button", { name: /保存文件夹/ })).toHaveAttribute("data-ready", "true");
    await connectRecordingInputs(page);
    await page.getByRole("textbox", { name: "当前训练选手代号" }).fill("ARCHIVE-01");
    await recordShortSession(page, true);

    await expect.poll(async () => (await readJsonExports(page)).length).toBe(1);
    const [original] = await readJsonExports(page);
    expect(original.filename).toMatch(/\.json$/);
    expect(original.filename).not.toMatch(/-v\d+\.json$/);
    expect(original.session.athleteCode).toBe("ARCHIVE-01");
    expect(original.session.notes).toBeNull();
    expect(original.session.samples.length).toBeGreaterThan(0);
    expect(original.session.markers).toHaveLength(1);
    expect(original.session.video).toMatchObject({ recorded: true, overlay: "sticks", receiptEvidence: "write_and_close_resolved" });
    if (!original.session.video.recorded) throw new Error("Initial export is missing its confirmed video receipt");
    const videoReceipt = original.session.video;
    const firstId = original.session.id;
    const v2Filename = original.filename.replace(/\.json$/, "-v2.json");
    const v3Filename = original.filename.replace(/\.json$/, "-v3.json");
    const detail = page.locator(".session-detail");
    const notes = detail.getByRole("textbox", { name: "留给下一次训练", exact: true });
    const exportButton = detail.getByRole("button", { name: "导出 JSON", exact: true });

    const secondNotes = "第二版：进弯保持连续油门，保留首次归档。";
    await notes.fill(secondNotes);
    await exportButton.click();
    await expect(detail.getByRole("status").filter({ hasText: v2Filename })).toBeVisible();
    await expect(page.locator(".export-banner").filter({ hasText: v2Filename })).toBeVisible();
    await expect.poll(async () => (await readJsonExports(page)).length).toBe(2);
    const secondFiles = await readJsonExports(page);
    const v2 = secondFiles.find((file) => file.filename === v2Filename);
    expect(v2?.session.notes).toBe(secondNotes);
    expect(v2?.session.id).toBe(firstId);
    expect(v2?.session.video).toEqual(videoReceipt);
    expect(v2?.session.samples).toEqual(original.session.samples);
    expect(v2?.session.markers).toEqual(original.session.markers);
    expect(secondFiles.find((file) => file.filename === original.filename)).toEqual(original);
    await expect(detail.getByText("备注已保存到本机", { exact: true })).toBeVisible();

    await page.evaluate((key) => sessionStorage.setItem(key, "prompt"), permissionKey);
    await page.reload();
    await expect(setup.getByRole("button", { name: /授权保存目录/ })).toBeVisible();
    await setup.getByRole("button", { name: /授权保存目录/ }).click();
    await expect(setup.getByRole("button", { name: /保存文件夹/ })).toHaveAttribute("data-ready", "true");
    expect(await page.evaluate((key) => sessionStorage.getItem(key), pickerCountKey)).toBe("1");
    await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "训练记录", exact: true }).click();
    await expect(notes).toHaveValue(secondNotes);
    const thirdNotes = "第三版：回看同一段视频后，再练习出弯抬油。";
    await notes.fill(thirdNotes);
    await detail.getByRole("button", { name: "保存备注", exact: true }).click();
    await expect(detail.getByText("备注已保存到本机", { exact: true })).toBeVisible();
    await exportButton.click();
    await expect(detail.getByRole("status").filter({ hasText: v3Filename })).toBeVisible();
    await expect.poll(async () => (await readJsonExports(page)).length).toBe(3);
    const thirdFiles = await readJsonExports(page);
    expect(thirdFiles.find((file) => file.filename === original.filename)).toEqual(original);
    expect(thirdFiles.find((file) => file.filename === v2Filename)).toEqual(v2);
    const v3 = thirdFiles.find((file) => file.filename === v3Filename);
    expect(v3?.session).toMatchObject({ id: firstId, notes: thirdNotes, video: videoReceipt });
    expect(v3?.session.samples).toEqual(original.session.samples);
    expect(v3?.session.markers).toEqual(original.session.markers);
    const stored = await readStoredTrainingRecords(page);
    expect(stored.sessions).toHaveLength(1);
    expect(stored.sessions[0]).toMatchObject({ id: firstId, notes: thirdNotes, video: videoReceipt, exportCount: 3 });

    await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "飞行工作台", exact: true }).click();
    await connectRecordingInputs(page);
    await recordShortSession(page, false);
    await expect.poll(async () => (await readJsonExports(page)).length).toBe(4);
    const allFiles = await readJsonExports(page);
    const nextSessionFiles = allFiles.filter((file) => file.session.id !== firstId);
    expect(nextSessionFiles).toHaveLength(1);
    expect(nextSessionFiles[0].filename).not.toMatch(/-v\d+\.json$/);
    expect(nextSessionFiles[0].session.id).not.toBe(firstId);
    expect(nextSessionFiles[0].session.athleteCode).toBe("ARCHIVE-01");
    expect(allFiles.filter((file) => file.session.id === firstId)).toHaveLength(3);
    expect(allFiles.find((file) => file.filename === original.filename)).toEqual(original);
    expect(allFiles.find((file) => file.filename === v2Filename)).toEqual(v2);
    expect(allFiles.find((file) => file.filename === v3Filename)).toEqual(v3);
    expect((await readStoredTrainingRecords(page)).sessions).toHaveLength(2);
    const videoBytes = await page.evaluate(async ({ directoryName, filename }) => {
      const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle(directoryName);
      return (await (await directory.getFileHandle(filename)).getFile()).size;
    }, { directoryName, filename: videoReceipt.filename });
    expect(videoBytes).toBe(videoReceipt.bytes);
  });
});
