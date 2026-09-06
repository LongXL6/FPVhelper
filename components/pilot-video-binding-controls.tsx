"use client";

import { useCallback, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { VideoSourceState, VideoWorkspaceElementRegistrar } from "@/hooks/use-video-workspace-capture";
import { PilotNameField } from "@/components/pilot-name-field";
import type { BetaflightDeviceNames } from "@/lib/betaflight-device-name";
import {
  resolvedPilotVideoViewMode,
  videoSourcePilotCount,
  transformVideoCrop,
  type PilotChannelConfig,
  type VideoCropInteraction,
  type VideoCropRect,
  type VideoSourceConfig,
  type VideoSourceLayout,
} from "@/lib/video-workspace";

interface PilotVideoBindingControlsProps {
  sources: readonly VideoSourceConfig[];
  source: VideoSourceConfig;
  sourceChannels: readonly PilotChannelConfig[];
  channel: PilotChannelConfig;
  videoState: VideoSourceState;
  disabled: boolean;
  registerVideoElement: VideoWorkspaceElementRegistrar;
  onSourceChange: (sourceId: string) => void;
  onSourceLabelChange: (label: string) => void;
  onSourceLayoutChange: (layout: VideoSourceLayout) => void;
  onPilotCountChange: (count: number) => void;
  onChannelChange: (channelId: string) => void;
  onAthleteCodeChange: (athleteCode: string) => void;
  deviceNames?: BetaflightDeviceNames;
  onUseDeviceName: () => void;
  onViewModeChange: (mode: "full" | "crop") => void;
  onCropChange: (crop: VideoCropRect) => void;
  onResetCrop: () => void;
}

const cropFields = [
  { key: "xPercent", label: "左边界", shortLabel: "左" },
  { key: "yPercent", label: "上边界", shortLabel: "上" },
  { key: "widthPercent", label: "画面宽度", shortLabel: "宽" },
  { key: "heightPercent", label: "画面高度", shortLabel: "高" },
] as const;

const cropHandles: ReadonlyArray<{ action: Exclude<VideoCropInteraction, "move">; label: string }> = [
  { action: "resize-nw", label: "调整裁切左上角" },
  { action: "resize-ne", label: "调整裁切右上角" },
  { action: "resize-sw", label: "调整裁切左下角" },
  { action: "resize-se", label: "调整裁切右下角" },
];

function sourceDisplayName(source: VideoSourceConfig, index: number) {
  return source.label.trim() || `视频输入 ${index + 1}`;
}

function CropSelectionEditor({
  sourceId,
  crop,
  videoState,
  disabled,
  registerVideoElement,
  onCropChange,
}: {
  sourceId: string;
  crop: VideoCropRect;
  videoState: VideoSourceState;
  disabled: boolean;
  registerVideoElement: VideoWorkspaceElementRegistrar;
  onCropChange: (crop: VideoCropRect) => void;
}) {
  const editorRef = useRef<HTMLDivElement | null>(null);
  const [sourceAspectRatio, setSourceAspectRatio] = useState<{ sourceId: string; value: number } | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    interaction: VideoCropInteraction;
    startClientX: number;
    startClientY: number;
    editorWidth: number;
    editorHeight: number;
    crop: VideoCropRect;
  } | null>(null);

  const videoRef = useCallback((element: HTMLVideoElement | null) => {
    const unregister = registerVideoElement(sourceId, element);
    if (!element) return () => unregister?.();

    const updateAspectRatio = () => {
      if (element.videoWidth <= 0 || element.videoHeight <= 0) return;
      setSourceAspectRatio({ sourceId, value: element.videoWidth / element.videoHeight });
    };

    element.addEventListener("loadedmetadata", updateAspectRatio);
    element.addEventListener("resize", updateAspectRatio);
    updateAspectRatio();

    return () => {
      element.removeEventListener("loadedmetadata", updateAspectRatio);
      element.removeEventListener("resize", updateAspectRatio);
      unregister?.();
    };
  }, [registerVideoElement, sourceId]);

  const cropActionFromTarget = (target: EventTarget | null): VideoCropInteraction => {
    if (!(target instanceof HTMLElement)) return "move";
    const action = target.closest<HTMLElement>("[data-crop-action]")?.dataset.cropAction;
    return action === "resize-nw" || action === "resize-ne" || action === "resize-sw" || action === "resize-se"
      ? action
      : "move";
  };

  const beginCropInteraction = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || !editorRef.current) return;
    const bounds = editorRef.current.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      interaction: cropActionFromTarget(event.target),
      startClientX: event.clientX,
      startClientY: event.clientY,
      editorWidth: bounds.width,
      editorHeight: bounds.height,
      crop,
    };
  };

  const moveCropInteraction = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    onCropChange(transformVideoCrop(
      drag.crop,
      drag.interaction,
      ((event.clientX - drag.startClientX) / drag.editorWidth) * 100,
      ((event.clientY - drag.startClientY) / drag.editorHeight) * 100,
    ));
  };

  const endCropInteraction = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const nudgeCrop = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (disabled || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    const step = event.shiftKey ? 5 : 1;
    const deltaX = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
    const deltaY = event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
    onCropChange(transformVideoCrop(crop, cropActionFromTarget(event.target), deltaX, deltaY));
  };

  return (
    <div
      className="crop-editor"
      ref={editorRef}
      style={sourceAspectRatio?.sourceId === sourceId ? { aspectRatio: sourceAspectRatio.value } : undefined}
    >
      <video ref={videoRef} muted playsInline aria-label="裁切输入预览" />
      {videoState !== "live" ? (
        <div className="crop-editor__empty">
          <b>等待输入画面</b>
          <span>打开该输入后，可直接在真实画面上拖动选框</span>
        </div>
      ) : null}
      <div
        className="crop-editor__selection"
        role="group"
        aria-label={`裁切选框，左 ${Math.round(crop.xPercent)}%，上 ${Math.round(crop.yPercent)}%，宽 ${Math.round(crop.widthPercent)}%，高 ${Math.round(crop.heightPercent)}%`}
        data-crop-action="move"
        tabIndex={disabled ? -1 : 0}
        style={{
          left: `${crop.xPercent}%`,
          top: `${crop.yPercent}%`,
          width: `${crop.widthPercent}%`,
          height: `${crop.heightPercent}%`,
        }}
        onPointerDown={beginCropInteraction}
        onPointerMove={moveCropInteraction}
        onPointerUp={endCropInteraction}
        onPointerCancel={endCropInteraction}
        onKeyDown={nudgeCrop}
      >
        <span>拖动选择区域</span>
        {cropHandles.map((handle) => (
          <button
            key={handle.action}
            className={`crop-editor__handle crop-editor__handle--${handle.action.slice(-2)}`}
            type="button"
            data-crop-action={handle.action}
            aria-label={handle.label}
            disabled={disabled}
          />
        ))}
      </div>
    </div>
  );
}

export function PilotVideoBindingControls({
  sources,
  source,
  sourceChannels,
  channel,
  videoState,
  disabled,
  registerVideoElement,
  onSourceChange,
  onSourceLabelChange,
  onSourceLayoutChange,
  onPilotCountChange,
  onChannelChange,
  onAthleteCodeChange,
  deviceNames,
  onUseDeviceName,
  onViewModeChange,
  onCropChange,
  onResetCrop,
}: PilotVideoBindingControlsProps) {
  const viewMode = resolvedPilotVideoViewMode(source, channel);
  const pilotLabel = channel.athleteCode.trim() || `选手 ${channel.slot + 1}`;
  const crop = channel.crop;

  const fieldMaximum = (field: (typeof cropFields)[number]["key"]) => {
    if (field === "xPercent") return 100 - crop.widthPercent;
    if (field === "yPercent") return 100 - crop.heightPercent;
    if (field === "widthPercent") return 100 - crop.xPercent;
    return 100 - crop.yPercent;
  };

  const fieldMinimum = (field: (typeof cropFields)[number]["key"]) => (
    field === "widthPercent" || field === "heightPercent" ? 10 : 0
  );

  return (
    <section className="pilot-video-binding" aria-label={`${pilotLabel} 画面绑定`}>
      <header className="pilot-video-binding__heading">
        <span>PLAYER VIEW ROUTING</span>
        <div>
          <b>选手画面设置</b>
          <small>输入来源和选手画面分开设置，全部保存在本机</small>
        </div>
      </header>

      <div className="pilot-video-binding__route">
        <section className="pilot-binding-card pilot-binding-card--source" aria-label="画面输入设置">
          <header><i>01</i><div><b>选择画面输入</b><small>先确认使用哪一路采集卡画面</small></div></header>
          <div className="pilot-binding-card__fields">
            <label>
              <span>画面输入</span>
              <select
                aria-label="画面输入"
                value={source.id}
                disabled={disabled}
                onChange={(event) => onSourceChange(event.target.value)}
              >
                {sources.map((sourceConfig, index) => (
                  <option key={sourceConfig.id} value={sourceConfig.id}>
                    {`输入 ${index + 1} · ${sourceDisplayName(sourceConfig, index)}`}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>输入名称</span>
              <input
                type="text"
                aria-label="输入名称"
                value={source.label}
                maxLength={40}
                disabled={disabled}
                placeholder="例如 主赛道接收机"
                autoComplete="off"
                onChange={(event) => onSourceLabelChange(event.target.value)}
              />
            </label>
          </div>

          <div className="pilot-binding-card__choice" role="group" aria-label="输入包含的画面">
            <span>输入类型</span>
            <button
              className={source.layout === "full" ? "is-selected" : ""}
              type="button"
              aria-label="输入布局：完整画面"
              aria-pressed={source.layout === "full"}
              disabled={disabled}
              onClick={() => onSourceLayoutChange("full")}
            ><b>独立画面</b><small>整路输入属于一名选手</small></button>
            <button
              className={source.layout === "quad" ? "is-selected" : ""}
              type="button"
              aria-label="输入布局：共享画面"
              aria-pressed={source.layout === "quad"}
              disabled={disabled}
              onClick={() => onSourceLayoutChange("quad")}
            ><b>共享画面</b><small>四合一或同路多选手</small></button>
          </div>

          {source.layout === "quad" ? (
            <>
              <div className="pilot-count-picker" role="group" aria-label="共享画面的选手人数">
                <span>添加选手</span>
                {([1, 2, 3, 4] as const).map((count) => (
                  <button
                    key={count}
                    className={`mini-button ${videoSourcePilotCount(source) === count ? "mini-button--active" : ""}`}
                    type="button"
                    aria-label={`添加 ${count} 名选手`}
                    aria-pressed={videoSourcePilotCount(source) === count}
                    disabled={disabled}
                    onClick={() => onPilotCountChange(count)}
                  >{count} 人</button>
                ))}
                <small>每人单独裁切；减少人数会保留已有设置。</small>
              </div>
              <div className="video-viewport-tabs" aria-label="共享输入的选手位置">
                {sourceChannels.map((sourceChannel) => (
                  <button
                    key={sourceChannel.id}
                    className={`mini-button ${sourceChannel.id === channel.id ? "mini-button--active" : ""}`}
                    type="button"
                    aria-pressed={sourceChannel.id === channel.id}
                    disabled={disabled}
                    onClick={() => onChannelChange(sourceChannel.id)}
                  >{sourceChannel.athleteCode.trim() || `位置 ${sourceChannel.slot + 1}`}</button>
                ))}
              </div>
            </>
          ) : null}
        </section>

        <section className="pilot-binding-card pilot-binding-card--output" aria-label="选手画面输出设置">
          <header><i>02</i><div><b>配置选手画面</b><small>命名并决定直接使用或裁切</small></div></header>
          <PilotNameField channel={channel} deviceNames={deviceNames} disabled={disabled} onChange={onAthleteCodeChange} onUseDeviceName={onUseDeviceName} />

          <div className="pilot-binding-card__choice" role="group" aria-label="选手取景方式">
            <span>显示方式</span>
            <button
              className={viewMode === "full" ? "is-selected" : ""}
              type="button"
              aria-label="选手取景：完整画面"
              aria-pressed={viewMode === "full"}
              disabled={disabled}
              onClick={() => onViewModeChange("full")}
            ><b>完整输入</b><small>{source.layout === "quad" ? "包含整路输入中的所有画面" : "直接把整路画面放入工作区"}</small></button>
            <button
              className={viewMode === "crop" ? "is-selected" : ""}
              type="button"
              aria-label="选手取景：裁切区域"
              aria-pressed={viewMode === "crop"}
              disabled={disabled}
              onClick={() => onViewModeChange("crop")}
            ><b>裁切画面</b><small>只显示选框内的区域</small></button>
          </div>

          {viewMode === "crop" ? (
            <div className="pilot-video-binding__crop-workspace">
              <CropSelectionEditor
                sourceId={source.id}
                crop={crop}
                videoState={videoState}
                disabled={disabled}
                registerVideoElement={registerVideoElement}
                onCropChange={onCropChange}
              />
              <fieldset className="pilot-video-binding__crop" disabled={disabled}>
                <legend>精确调整</legend>
                {cropFields.map((field) => (
                  <label key={field.key}>
                    <span>{field.shortLabel}</span>
                    <input
                      type="range"
                      aria-label={`裁切${field.label}`}
                      min={fieldMinimum(field.key)}
                      max={fieldMaximum(field.key)}
                      step="1"
                      value={crop[field.key]}
                      onChange={(event) => onCropChange({
                        ...crop,
                        [field.key]: Number(event.target.value),
                      })}
                    />
                    <output>{Math.round(crop[field.key])}%</output>
                  </label>
                ))}
                <button className="mini-button" type="button" onClick={onResetCrop}>恢复推荐区域</button>
              </fieldset>
            </div>
          ) : (
            <p className="pilot-video-binding__hint">{pilotLabel} 当前直接使用 {source.label.trim() || "该输入"} 的完整画面。</p>
          )}
        </section>
      </div>
    </section>
  );
}
