import {
  resolvedPilotVideoViewMode,
  type PilotChannelConfig,
  type VideoCropRect,
  type VideoSourceConfig,
} from "@/lib/video-workspace";

interface PilotVideoBindingControlsProps {
  source: VideoSourceConfig;
  channel: PilotChannelConfig;
  disabled: boolean;
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

export function PilotVideoBindingControls({
  source,
  channel,
  disabled,
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
      <div className="pilot-video-binding__identity">
        <span>选手画面</span>
        <b>{pilotLabel}</b>
        <small>{source.label} · 自动保存在本机</small>
      </div>

      <div className="pilot-video-binding__modes" role="group" aria-label="选手取景方式">
        <button
          className={`mini-button ${viewMode === "full" ? "mini-button--active" : ""}`}
          type="button"
          aria-label="选手取景：完整画面"
          aria-pressed={viewMode === "full"}
          disabled={disabled}
          onClick={() => onViewModeChange("full")}
        >完整画面</button>
        <button
          className={`mini-button ${viewMode === "crop" ? "mini-button--active" : ""}`}
          type="button"
          aria-label="选手取景：裁切区域"
          aria-pressed={viewMode === "crop"}
          disabled={disabled}
          onClick={() => onViewModeChange("crop")}
        >裁切区域</button>
      </div>

      {viewMode === "crop" ? (
        <fieldset className="pilot-video-binding__crop" disabled={disabled}>
          <legend className="sr-only">调整裁切区域</legend>
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
      ) : (
        <p className="pilot-video-binding__hint">该选手当前使用整路输入；取景设置保存在本机。</p>
      )}
    </section>
  );
}
