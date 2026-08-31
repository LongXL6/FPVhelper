"use client";

import { useState, type ChangeEvent } from "react";
import {
  assessTrainingAttemptCandidate,
  parseTrainingSession,
  type TrainingSession,
} from "../lib/training-session";

export const MAX_TRAINING_SESSION_FILE_BYTES = 16 * 1_024 * 1_024;

export interface TrainingSessionFileInspection {
  session: TrainingSession;
  technicalValidityLabel: "有效" | "无效";
  attemptCandidateLabel: "满足基础条件" | "不满足";
}

export function inspectTrainingSessionJson(input: string): TrainingSessionFileInspection {
  const session = parseTrainingSession(input);
  const attemptCandidate = assessTrainingAttemptCandidate(session);
  return {
    session,
    technicalValidityLabel: session.validity.valid ? "有效" : "无效",
    attemptCandidateLabel: attemptCandidate.candidate ? "满足基础条件" : "不满足",
  };
}

export function trainingSessionFileSizeError(size: number) {
  return size > MAX_TRAINING_SESSION_FILE_BYTES
    ? "文件超过 16 MB，请确认选择的是单条 FPVHelper Session JSON"
    : null;
}

function formatDuration(durationMs: number) {
  const totalSeconds = Math.max(0, durationMs) / 1_000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = (totalSeconds % 60).toFixed(1).padStart(4, "0");
  return `${String(minutes).padStart(2, "0")}:${seconds}`;
}

function validationErrorMessage(error: unknown) {
  return error instanceof Error && error.message ? error.message : "无法解析 Session JSON";
}

export function TrainingSessionFileValidator() {
  const [fileName, setFileName] = useState<string | null>(null);
  const [inspection, setInspection] = useState<TrainingSessionFileInspection | null>(null);
  const [error, setError] = useState<string | null>(null);

  const inspectFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;

    setFileName(file.name);
    setInspection(null);
    setError(null);
    try {
      const sizeError = trainingSessionFileSizeError(file.size);
      if (sizeError) throw new Error(sizeError);
      setInspection(inspectTrainingSessionJson(await file.text()));
    } catch (inspectionError) {
      setError(validationErrorMessage(inspectionError));
    } finally {
      input.value = "";
    }
  };

  return (
    <section className="session-file-validator" aria-label="本地 Session JSON 校验">
      <div>
        <span>READ-ONLY JSON CHECK</span>
        <h2>校验本地 Session 文件</h2>
        <p>只读取所选 JSON 并调用同一解析器校验；不会写入 IndexedDB，也不会上传。</p>
      </div>
      <label className="mini-button mini-button--active">
        选择 JSON 文件
        <input type="file" accept="application/json,.json" onChange={(event) => void inspectFile(event)} />
      </label>
      {inspection ? (
        <div className="session-file-result" role="status" aria-live="polite">
          <span>文件<b>{fileName}</b></span>
          <span>代号<b>{inspection.session.athleteCode ?? "—"}</b></span>
          <span>时长<b>{formatDuration(inspection.session.durationMs)}</b></span>
          <span>样本<b>{inspection.session.sampleCount.toLocaleString()}</b></span>
          <span className={inspection.session.validity.valid ? "record-valid" : "record-invalid"}>技术有效<b>{inspection.technicalValidityLabel}</b></span>
          <span className={inspection.attemptCandidateLabel === "满足基础条件" ? "record-valid" : "record-invalid"}>80% 验收候选<b>{inspection.attemptCandidateLabel}</b></span>
          <small>这里只检查技术有效与非空复盘备注；仍需外部台账、导出重解析和授权记录确认。</small>
        </div>
      ) : null}
      {error ? <p className="session-file-error" role="alert">{fileName}：{error}</p> : null}
    </section>
  );
}
