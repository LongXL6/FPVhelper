"use client";

import type { useDvrRecording } from "@/hooks/use-dvr-recording";

interface DvrRecordingPanelProps {
  dvr: ReturnType<typeof useDvrRecording>;
  canStart: boolean;
  blockReason: string;
  videoReady: boolean;
  videoConnecting: boolean;
  canOpenVideo: boolean;
  onOpenVideo: () => void;
  directoryReady: boolean;
  directoryName: string | null;
  onChooseDirectory: () => void;
  format: string;
  cropped: boolean;
}

export function DvrRecordingPanel({ dvr, canStart, blockReason, videoReady, videoConnecting, canOpenVideo,
  onOpenVideo, directoryReady, directoryName, onChooseDirectory, format, cropped }: DvrRecordingPanelProps) {
  const duration = `${Math.floor(dvr.elapsedMs / 60000).toString().padStart(2, "0")}:${Math.floor(dvr.elapsedMs / 1000 % 60).toString().padStart(2, "0")}`;
  return (
    <section className="recording-readiness" aria-label="DVR 视频录制">
      <div className="recording-readiness__summary">
        <b>仅视频 DVR · 无需连接飞控</b>
        <span>保存当前{cropped ? "裁切" : "完整"}画面为 {format}，不烧录打杆叠层、不生成遥测 JSON。选手姓名可留空。</span>
      </div>
      {!dvr.isActive ? <div className="recording-readiness__steps">
        <button className="recording-readiness__step" type="button" data-ready={videoReady}
          disabled={!canOpenVideo || videoReady || videoConnecting} onClick={onOpenVideo}>
          <span>视频画面</span><b>{videoReady ? "已接入" : videoConnecting ? "正在连接…" : "打开视频输入 →"}</b>
        </button>
        <button className="recording-readiness__step" type="button" data-ready={directoryReady} onClick={onChooseDirectory}>
          <span>保存文件夹</span><b>{directoryReady ? `更换文件夹 · ${directoryName ?? "已授权"}` : "选择 DVR 保存目录 →"}</b>
        </button>
      </div> : null}
      {dvr.hasDirectory ? <small>本页使用“{dvr.directoryName}”；刷新后可重新选择目录。</small> : directoryReady ? <small>使用已授权的本地保存目录：{directoryName}</small> : null}
      {dvr.directoryError ? <p role="alert">{dvr.directoryError}</p> : null}
      <p className="recording-readiness__result" data-ready={canStart} data-testid="dvr-recording-status" role="status">
        {dvr.isStarting ? "正在准备 DVR，可随时取消。" : dvr.isStopping ? "正在写完最后一段并关闭视频文件…" : dvr.isRecording ? `● REC ${duration} · ${dvr.filename}`
          : dvr.state === "error" ? `视频未保存完整：${dvr.error}`
            : dvr.state === "saved" && dvr.receipt ? `已确认写入并关闭：${dvr.receipt.filename} · ${(dvr.receipt.bytes / 1024 / 1024).toFixed(1)} MB`
              : canStart ? "视频与目录已就绪，可直接开始 DVR。" : blockReason}
      </p>
      {dvr.isActive ? <small>可切换工作台页面；结束前请保持浏览器打开。</small> : null}
    </section>
  );
}
