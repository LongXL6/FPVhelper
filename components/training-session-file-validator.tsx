"use client";

import { useState, type ChangeEvent } from "react";
import {
  assessPilotLedgerCompleteness,
  parseTrainingSession,
  type TrainingSession,
} from "../lib/training-session";

export interface TrainingSessionFileInspection {
  session: TrainingSession;
  technicalValidityLabel: "有效" | "无效";
  pilotLedgerLabel: "完整" | "不完整";
}

export function inspectTrainingSessionJson(input: string): TrainingSessionFileInspection {
  const session = parseTrainingSession(input);
  const pilotLedger = assessPilotLedgerCompleteness(session);
  return {
    session,
    technicalValidityLabel: session.validity.valid ? "有效" : "无效",
    pilotLedgerLabel: pilotLedger.complete ? "完整" : "不完整",
  };
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
          <span className={inspection.pilotLedgerLabel === "完整" ? "record-valid" : "record-invalid"}>复盘完整（试点台账）<b>{inspection.pilotLedgerLabel}</b></span>
        </div>
      ) : null}
      {error ? <p className="session-file-error" role="alert">{fileName}：{error}</p> : null}
    </section>
  );
}
