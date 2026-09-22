"use client";

import { MAX_OVERLAY_SIZE, MIN_OVERLAY_SIZE, type StickOverlayMember, type StickOverlayPairLayout } from "@/lib/stick-overlay-layout";

export function StickOverlayControls({ pair, opacity, disabled, onSizeChange, onOpacityChange }: {
  pair: StickOverlayPairLayout;
  opacity: number;
  disabled: boolean;
  onSizeChange: (member: StickOverlayMember, size: number) => void;
  onOpacityChange: (opacity: number) => void;
}) {
  return (
    <div className="stick-overlay-controls">
      {(["left", "right"] as const).map((member) => (
        <label className="stick-overlay-setting" key={member}>
          <span>{member === "left" ? "左摇杆尺寸" : "右摇杆尺寸"}<output>{Math.round(pair[member].size)} px</output></span>
          <input type="range" min={Math.min(MIN_OVERLAY_SIZE, pair[member].size)} max={MAX_OVERLAY_SIZE} step="1"
            aria-label={member === "left" ? "左摇杆尺寸" : "右摇杆尺寸"}
            value={pair[member].size} disabled={disabled}
            onChange={(event) => onSizeChange(member, Number(event.target.value))} />
        </label>
      ))}
      <label className="stick-overlay-setting">
        <span>不透明度<output>{Math.round(opacity * 100)}%</output></span>
        <input type="range" min="25" max="100" step="1" aria-label="摇杆不透明度"
          value={Math.round(opacity * 100)} onChange={(event) => onOpacityChange(Number(event.target.value) / 100)} />
      </label>
      <p>{disabled ? "添加飞手后可调整摇杆尺寸。" : pair.locked ? "左右摇杆已锁定，调整任意尺寸会同步缩放。" : "拖动摇杆标题调整位置，拖动右下角或使用滑块缩放。"} 设置自动保存在本机；尺寸、位置与不透明度同步到录像。</p>
    </div>
  );
}
