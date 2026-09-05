"use client";

import { useId } from "react";
import type { BetaflightDeviceNames } from "@/lib/betaflight-device-name";
import type { PilotChannelConfig } from "@/lib/video-workspace";

interface PilotNameFieldProps {
  channel: PilotChannelConfig;
  deviceNames?: BetaflightDeviceNames;
  disabled: boolean;
  compact?: boolean;
  onChange: (name: string) => void;
  onUseDeviceName: () => void;
}

export function PilotNameField({ channel, deviceNames, disabled, compact = false, onChange, onUseDeviceName }: PilotNameFieldProps) {
  const helpId = useId();
  const manual = channel.athleteCodeMode === "manual";
  const hint = manual
    ? "手动命名"
    : deviceNames?.pilotName
      ? "自动 · Pilot Name"
      : deviceNames?.craftName
        ? "自动 · Aircraft Name"
        : deviceNames?.status === "reading"
          ? "正在读取飞控名称…"
          : deviceNames?.status === "unavailable" || deviceNames?.status === "ready"
            ? "未读到名称，可直接输入"
            : "连接飞控后自动读取，也可直接输入";

  return (
    <div className={`pilot-name-field${compact ? " pilot-name-field--compact" : ""}`}>
      <label className={compact ? "active-pilot-field" : "pilot-binding-card__athlete"}>
        <span>{compact ? "当前选手" : "选手姓名或代号"}</span>
        <input
          type="text"
          aria-label={compact ? "当前训练选手代号" : "选手姓名或代号"}
          aria-describedby={helpId}
          value={channel.athleteCode}
          maxLength={40}
          disabled={disabled}
          placeholder="自动读取或手动输入"
          autoComplete="off"
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
      <div className="pilot-name-field__source" id={helpId}>
        <small title="从当前 USB 连接的飞控读取；Pilot Name 优先，空时使用 Aircraft Name。">{hint}</small>
        {manual ? <button
          className="pilot-name-field__reset"
          type="button"
          aria-label={compact ? "使用飞控名称" : "选手画面使用飞控名称"}
          disabled={disabled}
          onClick={onUseDeviceName}
        >使用飞控名称</button> : null}
      </div>
      {!compact ? <p className="pilot-name-field__help">读取当前 USB 连接飞控的配置名；若连接地面桥接飞控，请确认与画面中的选手一致。</p> : null}
    </div>
  );
}
