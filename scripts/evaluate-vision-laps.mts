import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { evaluateVisionLapRun } from "../lib/vision-lap-evaluation.ts";

const inputPath = process.argv[2];
if (!inputPath) {
  console.error("用法：npm run vision:evaluate -- /绝对路径/vision-test-run.json");
  process.exitCode = 1;
} else {
  try {
    const raw = await readFile(resolve(inputPath), "utf8");
    const report = evaluateVisionLapRun(JSON.parse(raw));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "视觉计圈评估失败");
    process.exitCode = 1;
  }
}
