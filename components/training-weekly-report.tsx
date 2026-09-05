"use client";

import { useMemo, useState, useSyncExternalStore, type ChangeEvent } from "react";
import { parseTrainingSession, type TrainingSession } from "../lib/training-session";
import {
  buildTrainingWeeklyReport,
  formatTrainingWeeklyReportMarkdown,
  MAX_REPORT_FILE_BYTES,
  MAX_REPORT_FILES,
  MAX_REPORT_TOTAL_BYTES,
  MAX_INTENDED_RECORDINGS,
  type TrainingWeeklyReport as TrainingWeeklyReportResult,
  type TrainingWeeklyReportSessionInput,
} from "../lib/training-weekly-report";

function currentLocalWeekStart() {
  const date = new Date();
  const day = date.getDay();
  date.setDate(date.getDate() - (day === 0 ? 6 : day - 1));
  date.setHours(0, 0, 0, 0);
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((value, index) => String(value).padStart(index === 0 ? 4 : 2, "0"))
    .join("-");
}

function subscribeToLocalCalendar() {
  return () => undefined;
}

function serverWeekStartSnapshot() {
  return "";
}

export function validateTrainingWeekStartInput(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return { epochMs: null, error: "请选择有效的本地日期" };
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const day = Number(match[3]);
  const date = new Date(year, monthIndex, day);
  if (date.getFullYear() !== year || date.getMonth() !== monthIndex || date.getDate() !== day) {
    return { epochMs: null, error: "请选择有效的本地日期" };
  }
  if (date.getDay() !== 1) return { epochMs: null, error: "周开始必须选择本地周一" };
  return { epochMs: date.getTime(), error: null };
}

export function validateIntendedRecordingsInput(value: string) {
  if (value === "") return { intendedRecordings: undefined, error: null };
  if (!/^\d+$/.test(value)) {
    return { intendedRecordings: undefined, error: `请输入 0…${MAX_INTENDED_RECORDINGS.toLocaleString("en-US")} 的整数` };
  }
  const intendedRecordings = Number(value);
  if (!Number.isSafeInteger(intendedRecordings) || intendedRecordings > MAX_INTENDED_RECORDINGS) {
    return { intendedRecordings: undefined, error: `请输入 0…${MAX_INTENDED_RECORDINGS.toLocaleString("en-US")} 的整数` };
  }
  return { intendedRecordings, error: null };
}

function coverageLabel(
  report: TrainingWeeklyReportResult,
  value: number | null,
) {
  if (report.intentLedgerStatus === "missing") return "— 待台账";
  if (report.intentLedgerStatus === "session-count-mismatch") return "— 待核对";
  return value === null ? "—" : `${value.toFixed(1)}%`;
}

function yieldToMainThread() {
  return new Promise<void>((resolve) => window.setTimeout(resolve, 0));
}

function reportErrorMessage(error: unknown) {
  return error instanceof Error && error.message ? error.message : "无法生成本地周报";
}

export function TrainingWeeklyReport({ localSessions }: { localSessions: TrainingSession[] }) {
  const localWeekStart = useSyncExternalStore(
    subscribeToLocalCalendar,
    currentLocalWeekStart,
    serverWeekStartSnapshot,
  );
  const [selectedWeekStart, setSelectedWeekStart] = useState<string | null>(null);
  const [intendedRecordingsInput, setIntendedRecordingsInput] = useState("");
  const [importedSessions, setImportedSessions] = useState<TrainingWeeklyReportSessionInput[]>([]);
  const [importSummary, setImportSummary] = useState("尚未导入其他工作站文件");
  const [error, setError] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);

  const weekStart = selectedWeekStart ?? localWeekStart;
  const weekValidation = validateTrainingWeekStartInput(weekStart);
  const intendedValidation = validateIntendedRecordingsInput(intendedRecordingsInput);
  const weekFieldError = selectedWeekStart === null ? null : weekValidation.error;
  const reportSessions = useMemo<TrainingWeeklyReportSessionInput[]>(() => [
    ...localSessions.map((session) => ({ session, source: "browser-local" as const })),
    ...importedSessions,
  ], [importedSessions, localSessions]);
  const report = useMemo(
    () => weekValidation.epochMs === null ? null : buildTrainingWeeklyReport({
      sessions: reportSessions,
      windowStartedAtEpochMs: weekValidation.epochMs,
      intendedRecordings: intendedValidation.error ? undefined : intendedValidation.intendedRecordings,
    }),
    [intendedValidation.error, intendedValidation.intendedRecordings, reportSessions, weekValidation.epochMs],
  );
  const intendedFieldError = intendedValidation.error
    ?? (report?.intentLedgerStatus === "session-count-mismatch"
      ? "台账与 Session 范围不一致，待核对"
      : null);
  const markdown = useMemo(() => report ? formatTrainingWeeklyReportMarkdown(report) : "", [report]);

  const importFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const files = [...(input.files ?? [])];
    setError(null);
    setCopyStatus(null);
    try {
      if (files.length === 0) return;
      if (files.length > MAX_REPORT_FILES) throw new Error(`一次最多读取 ${MAX_REPORT_FILES} 个 Session JSON`);
      const totalBytes = files.reduce((total, file) => total + file.size, 0);
      if (totalBytes > MAX_REPORT_TOTAL_BYTES) throw new Error("所选文件合计超过 20 MB，请按周分批处理");

      const parsed: TrainingWeeklyReportSessionInput[] = [];
      const failures: string[] = [];
      for (const file of files) {
        try {
          if (file.size > MAX_REPORT_FILE_BYTES) {
            throw new Error("文件超过 5 MB，请确认选择的是单条 FPVHelper Session JSON");
          }
          parsed.push({ session: parseTrainingSession(await file.text()), source: "imported-file" });
        } catch (parseError) {
          failures.push(`${file.name}：${reportErrorMessage(parseError)}`);
        }
        await yieldToMainThread();
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
      if (!report) throw new Error("周报尚未就绪");
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
          <input
            type="date"
            value={weekStart}
            aria-invalid={weekFieldError !== null}
            aria-describedby={weekFieldError ? "training-week-error" : undefined}
            onChange={(event) => setSelectedWeekStart(event.target.value)}
          />
          {weekFieldError ? <small id="training-week-error" className="training-weekly-report__field-error" role="alert">{weekFieldError}</small> : null}
        </label>
        <label>
          <span>计划录像次数（外部台账）</span>
          <input
            type="number"
            min="0"
            max={MAX_INTENDED_RECORDINGS}
            step="1"
            value={intendedRecordingsInput}
            placeholder="待台账"
            aria-invalid={intendedFieldError !== null}
            aria-describedby={intendedFieldError ? "training-intended-error" : undefined}
            onChange={(event) => setIntendedRecordingsInput(event.target.value)}
          />
          {intendedFieldError ? <small id="training-intended-error" className="training-weekly-report__field-error" role="alert">{intendedFieldError}</small> : null}
        </label>
        <label className="mini-button mini-button--active">
          选择多个 Session JSON
          <input type="file" multiple accept="application/json,.json" onChange={(event) => void importFiles(event)} />
        </label>
      </div>

      {report ? (
        <div className="training-weekly-report__metrics" role="status" aria-live="polite">
          <span>工作站<b>{report.workstationCount}</b></span>
          <span>已完成 Session<b>{report.completedSessionCount}</b></span>
          <span>技术有效<b>{report.validCount}</b></span>
          <span>技术有效 ÷ 台账<b>{coverageLabel(report, report.validCoveragePercent)}</b></span>
          <span>已确认文件<b>{report.confirmedFileCount}</b></span>
          <span>确认文件 ÷ 台账<b>{coverageLabel(report, report.exportCoveragePercent)}</b></span>
          <span>Marker<b>{report.markerCount}</b></span>
        </div>
      ) : <p className="training-weekly-report__pending" role="status">{weekFieldError ?? "正在读取浏览器本地周起始日期…"}</p>}

      <div className="training-weekly-report__output">
        <div>
          <b>{importSummary}</b>
          <small>完全重复记录会去重；同 ID 内容冲突会排除并要求人工核对。导入文件经重解析后算文件证据；本浏览器记录只采信一致的导出时间与次数。</small>
          <small>“技术有效 ÷ 台账”和“确认文件 ÷ 台账”是采集完整性指标，不是最终 80% 业务验收率；缺少台账时保持“— 待台账”。</small>
          {report && report.conflictingSessionIds.length > 0 ? <p role="alert">有 {report.conflictingSessionIds.length} 条冲突 Session 已排除。</p> : null}
          {error ? <p role="alert">{error}</p> : null}
        </div>
        <button className="mini-button mini-button--active" type="button" disabled={!report} onClick={() => void copyReport()}>复制 Markdown 周报</button>
        {copyStatus ? <small role="status">{copyStatus}</small> : null}
        <textarea readOnly value={markdown} aria-label="试点验收周报 Markdown" />
      </div>
    </section>
  );
}
