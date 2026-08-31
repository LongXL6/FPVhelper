"use client";

import { useState } from "react";
import type { AnalyticsLocalStatus } from "@/lib/analytics/client";

interface AnalyticsWorkstationIdProps {
  workstationId: string;
}

interface AnalyticsTokenReplacementActionProps {
  onReplace: () => void;
}

interface AnalyticsTokenReplacementController {
  status: AnalyticsLocalStatus;
  prepareTokenReplacement: () => boolean;
}

export function prepareAnalyticsTokenReplacementAction(controller: AnalyticsTokenReplacementController) {
  const prepared = controller.status.state === "enabled" && controller.prepareTokenReplacement();
  return {
    prepared,
    message: prepared
      ? "发送已暂停；旧令牌已清除，待发送队列与工作站 ID 保留。"
      : "当前状态无法更换工作站令牌。",
  };
}

export function AnalyticsTokenReplacementAction({ onReplace }: AnalyticsTokenReplacementActionProps) {
  return (
    <button className="mini-button" type="button" onClick={onReplace}>
      更换工作站令牌
    </button>
  );
}

export function AnalyticsWorkstationId({ workstationId }: AnalyticsWorkstationIdProps) {
  const [copyStatus, setCopyStatus] = useState<string | null>(null);

  async function copyWorkstationId() {
    try {
      await navigator.clipboard.writeText(workstationId);
      setCopyStatus("完整 workstation ID 已复制。尚未开启或发送统计。");
    } catch {
      setCopyStatus("复制失败，请手动选择并复制完整 workstation ID。");
    }
  }

  return (
    <div className="analytics-workstation-id">
      <span>WORKSTATION ID</span>
      <code>{workstationId}</code>
      <button className="mini-button" type="button" onClick={() => void copyWorkstationId()}>
        复制完整 ID
      </button>
      {copyStatus ? <small role="status">{copyStatus}</small> : null}
    </div>
  );
}
