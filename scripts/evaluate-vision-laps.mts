import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { evaluateVisionLapRun } from "../lib/vision-lap-evaluation.ts";

const inputPath = process.argv[2];
const manifestPath = process.argv[3];
const MAX_INPUT_BYTES = 20 * 1024 * 1024;
if (!inputPath || !manifestPath) {
  console.error("用法：npm run vision:evaluate -- /绝对路径/vision-test-run.json /绝对路径/vision-dataset-manifest.json");
  process.exitCode = 1;
} else {
  try {
    const resolvedPath = resolve(inputPath);
    const resolvedManifestPath = resolve(manifestPath);
    const file = await stat(resolvedPath);
    const manifestFile = await stat(resolvedManifestPath);
    if (!file.isFile() || file.size > MAX_INPUT_BYTES) throw new Error("评估输入必须是小于或等于 20 MiB 的本地文件");
    if (!manifestFile.isFile() || manifestFile.size > MAX_INPUT_BYTES) throw new Error("manifest 必须是小于或等于 20 MiB 的本地文件");
    const raw = await readFile(resolvedPath, "utf8");
    const manifestRaw = await readFile(resolvedManifestPath, "utf8");
    const report = evaluateVisionLapRun(JSON.parse(raw), manifestRaw);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "视觉计圈评估失败");
    process.exitCode = 1;
  }
}
