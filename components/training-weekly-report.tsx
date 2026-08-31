"use client";

import { useMemo, useState, type ChangeEvent } from "react";
import {
  MAX_TRAINING_SESSION_FILE_BYTES,
  trainingSessionFileSizeError,
} from "@/components/training-session-file-validator";
import { parseTrainingSession, type TrainingSession } from "@/lib/training-session";
import {
  buildTrainingWeeklyReport,
  formatTrainingWeeklyReportMarkdown,
} from "@/lib/training-weekly-report";

const MAX_REPORT_FILES = 200;
const MAX_REPORT_TOTAL_BYTES = 128 * 1_024 * 1_024;

function currentLocalWeekStart() {
  const date = new Date();
  const day = date.getDay();
  date.setDate(date.getDate() - (day === 0 ? 6 : day - 1));
  date.setHours(0, 0, 0, 0);
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((value, index) => String(value).padStart(index === 0 ? 4 : 2, "0"))
    .join("-");
}

function reportErrorMessage(error: unknown) {
  return error instanceof Error && error.message ? error.message : "无法生成本地周报";
}

export function TrainingWeeklyReport({ localSessions }: { localSessions: TrainingSession[] }) {
  const [weekStart, setWeekStart] = useState(currentLocalWeekStart);
  const [importedSessions, setImportedSessions] = useState<TrainingSession[]>([]);
  const [importSummary, setImportSummary] = useState("尚未导入其他工作站文件");
  const [error, setError] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const requestedWindowStartedAtEpochMs = new Date(`${weekStart}T00:00:00`).getTime();
  const windowStartedAtEpochMs = Number.isFinite(requestedWindowStartedAtEpochMs)
    ? requestedWindowStartedAtEpochMs
    : new Date(`${currentLocalWeekStart()}T00:00:00`).getTime();
  const report = useMemo(
    () => buildTrainingWeeklyReport([...localSessions, ...importedSessions], windowStartedAtEpochMs),
    [importedSessions, localSessions, windowStartedAtEpochMs],
  );
  const markdown = useMemo(() => formatTrainingWeeklyReportMarkdown(report), [report]);

  const importFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const files = [...(input.files ?? [])];
    setError(null);
    setCopyStatus(null);
    try {
      if (files.length === 0) return;
      if (files.length > MAX_REPORT_FILES) throw new Error(`一次最多读取 ${MAX_REPORT_FILES} 个 Session JSON`);
      const totalBytes = files.reduce((total, file) => total + file.size, 0);
      if (totalBytes > MAX_REPORT_TOTAL_BYTES) throw new Error("所选文件合计超过 128 MB，请按周分批处理");

      const parsed: TrainingSession[] = [];
      const failures: string[] = [];
      for (const file of files) {
        const sizeError = trainingSessionFileSizeError(file.size);
        if (sizeError || file.size > MAX_TRAINING_SESSION_FILE_BYTES) {
          failures.push(`${file.name}：${sizeError ?? "文件过大"}`);
          continue;
        }
        try {
          parsed.push(parseTrainingSession(await file.text()));
        } catch (parseError) {
          failures.push(`${file.name}：${reportErrorMessage(parseError)}`);
        }
      }
      setImportedSessions(parsed);
      setImportSummary(`已读取 ${parsed.length} 条；失败 ${failures.length} 条`);
      if (failures.length > 0) setError(failures.slice(0, 5).join("；"));
    } catch (importError) {
      setImportedSessions([]);
      setImportSummary("导入未完成");
      setError(reportErrorMessage(importError));
    } finally {
      input.value = "";
    }
  };

  const copyReport = async () => {
    try {
      await navigator.clipboard.writeText(markdown);
      setCopyStatus("周报已复制");
    } catch {
      setCopyStatus("复制失败，请从下方只读文本框手动复制");
    }
  };

  return (
    <section className="training-weekly-report" aria-label="本地多工作站试点周报">
      <div className="training-weekly-report__heading">
        <div>
          <span>LOCAL PILOT REPORT</span>
          <h2>合并两台工作站 Session 周报</h2>
          <p>自动包含本浏览器历史；可一次选择另一台工作站导出的多个 JSON。全程只在本页读取，不上传文件或内容。</p>
        </div>
        <label>
          <span>周一开始日期</span>
          <input type="date" value={weekStart} onChange={(event) => setWeekStart(event.target.value)} />
        </label>
        <label className="mini-button mini-button--active">
          选择多个 Session JSON
          <input type="file" multiple accept="application/json,.json" onChange={(event) => void importFiles(event)} />
        </label>
      </div>

      <div className="training-weekly-report__metrics" role="status" aria-live="polite">
        <span>工作站<b>{report.workstationCount}</b></span>
        <span>真实尝试<b>{report.attemptCount}</b></span>
        <span>技术有效<b>{report.validCount}</b></span>
        <span>有效覆盖率<b>{report.validCoveragePercent === null ? "—" : `${report.validCoveragePercent.toFixed(1)}%`}</b></span>
        <span>已确认导出<b>{report.exportedCount}</b></span>
        <span>Marker<b>{report.markerCount}</b></span>
      </div>

      <div className="training-weekly-report__output">
        <div>
          <b>{importSummary}</b>
          <small>完全重复文件会去重；同 ID 内容冲突会排除并要求人工核对。20 Hz 左右的打杆数据不会被包装成运动员进步分数。</small>
          {report.conflictingSessionIds.length > 0 ? <p role="alert">有 {report.conflictingSessionIds.length} 条冲突 Session 已排除。</p> : null}
          {error ? <p role="alert">{error}</p> : null}
        </div>
        <button className="mini-button mini-button--active" type="button" onClick={() => void copyReport()}>复制 Markdown 周报</button>
        {copyStatus ? <small role="status">{copyStatus}</small> : null}
        <textarea readOnly value={markdown} aria-label="试点验收周报 Markdown" />
      </div>
    </section>
  );
}
