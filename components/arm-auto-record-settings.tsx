"use client";

import type { RefObject } from "react";
import type { useArmAutoRecord } from "@/hooks/use-arm-auto-record";
import { detectArmSwitch, type ArmAutoRecordSnapshot } from "@/lib/arm-auto-record";
import styles from "./arm-auto-record-settings.module.css";

export function armAutoRecordStatus(state: ArmAutoRecordSnapshot) {
  if (state.disarmRemainingMs !== null) return `DISARM · ${Math.ceil(state.disarmRemainingMs / 1000)} 秒后结束并保存`;
  switch (state.phase) {
    case "disabled": return "未启用";
    case "waiting_disarm": return "请先拨回 DISARM，等待下一次 ARM";
    case "ready": return "等待 ARM 自动开始";
    case "starting": return "正在启动记录";
    case "recording": return "自动记录中";
    case "stopping": return "正在结束并保存";
    case "error": return state.error === "stop_failed" ? "保存未完成，请检查保存状态" : "未能开始，请检查录制准备条件";
  }
}

export function ArmAutoRecordSettings({ automatic, detailsRef, channels, signalReady, locked, blockReason }: {
  automatic: ReturnType<typeof useArmAutoRecord>;
  detailsRef: RefObject<HTMLDetailsElement | null>;
  channels: readonly number[];
  signalReady: boolean;
  locked: boolean;
  blockReason: string | null;
}) {
  const { state, config, setConfig } = automatic;
  const currentArm = signalReady ? detectArmSwitch(config, channels) : null;
  return (
    <details className={styles.settings} ref={detailsRef}>
      <summary>ARM 自动记录 <small>Beta</small></summary>
      <div className={styles.body}>
        <p>使用当前选手、画面和保存目录。ARM 开始；连续 DISARM 15 秒结束；期间重新 ARM 则继续同一段。</p>
        <div className={styles.fields}>
          <label>ARM 通道<select aria-label="ARM 通道" disabled={locked} value={config.auxIndex} onChange={(event) => setConfig({ ...config, auxIndex: Number(event.target.value) })}>
            {Array.from({ length: 14 }, (_, index) => <option key={index} value={index}>AUX{index + 1} / CH{index + 5}</option>)}
          </select></label>
          <label>ARM 下限（μs）<input type="number" min={750} max={2250} step={25} disabled={locked} value={Number.isFinite(config.min) ? config.min : ""} onChange={(event) => setConfig({ ...config, min: event.target.value === "" ? NaN : Number(event.target.value) })} /></label>
          <label>ARM 上限（μs，不含）<input type="number" min={750} max={2250} step={25} disabled={locked} value={Number.isFinite(config.max) ? config.max : ""} onChange={(event) => setConfig({ ...config, max: event.target.value === "" ? NaN : Number(event.target.value) })} /></label>
        </div>
        <p>当前开关：<b>{currentArm === null ? "未知" : `${currentArm ? "ARM" : "DISARM"} · ${channels[4 + config.auxIndex]} μs`}</b>。核对通道及范围后启用，先确认一次 DISARM。</p>
        <div className={styles.actions}>
          {state.enabled
            ? <button type="button" className="button button--quiet" onClick={() => void automatic.disable()}>停用 ARM 自动记录</button>
            : <button type="button" className="button button--quiet" disabled={locked || Boolean(blockReason)} onClick={() => automatic.enable()}>启用 ARM 自动记录</button>}
          <span role="status">{armAutoRecordStatus(state)}</span>
        </div>
        {!state.enabled && blockReason ? <p>{blockReason}</p> : null}
        <p className={styles.note}>识别地面桥的 ARM 开关，不代表机上已解锁。数据失联会取消倒计时并继续录像；仍可通过“结束记录”手动保存。Beta 每次打开工作台默认关闭。</p>
      </div>
    </details>
  );
}
