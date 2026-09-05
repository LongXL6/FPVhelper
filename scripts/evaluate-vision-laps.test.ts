import { spawnSync } from "node:child_process";
import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("vision lap evaluator CLI", () => {
  it("rejects an evaluation file larger than the 20 MiB local safety cap before parsing", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "fpvhelper-vision-cli-"));
    temporaryDirectories.push(directory);
    const inputPath = resolve(directory, "oversize.json");
    const manifestPath = resolve(directory, "manifest.json");
    await writeFile(inputPath, "{}");
    await truncate(inputPath, 20 * 1024 * 1024 + 1);
    await writeFile(manifestPath, "{}");

    const result = spawnSync(process.execPath, [
      "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
      resolve("scripts/evaluate-vision-laps.mts"),
      inputPath,
      manifestPath,
    ], { cwd: process.cwd(), encoding: "utf8" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("评估输入必须是小于或等于 20 MiB 的本地文件");
    expect(result.stdout).toBe("");
  });

  it("applies the same 20 MiB local safety cap to the manifest", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "fpvhelper-vision-cli-"));
    temporaryDirectories.push(directory);
    const inputPath = resolve(directory, "evaluation.json");
    const manifestPath = resolve(directory, "oversize-manifest.json");
    await writeFile(inputPath, "{}");
    await writeFile(manifestPath, "{}");
    await truncate(manifestPath, 20 * 1024 * 1024 + 1);

    const result = spawnSync(process.execPath, [
      "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
      resolve("scripts/evaluate-vision-laps.mts"),
      inputPath,
      manifestPath,
    ], { cwd: process.cwd(), encoding: "utf8" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("manifest 必须是小于或等于 20 MiB 的本地文件");
    expect(result.stdout).toBe("");
  });
});
