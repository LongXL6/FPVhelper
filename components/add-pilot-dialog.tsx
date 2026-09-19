"use client";

import { useEffect, useRef, useState } from "react";
import { addedPilotIds, availablePilotChannels, restorablePilotChannels, type AddPilotInput, type PilotPicture, type VideoWorkspaceConfig } from "@/lib/video-workspace";
import styles from "./pilot-setup.module.css";

const pictures: { value: PilotPicture; label: string }[] = [
  { value: "full", label: "完整画面" },
  { value: "top-left", label: "左上" },
  { value: "top-right", label: "右上" },
  { value: "bottom-left", label: "左下" },
  { value: "bottom-right", label: "右下" },
];

export function AddPilotDialog({ workspace, occupiedPilotIds = [], disabled, onAdd, onRestore, onClose }: {
  workspace: VideoWorkspaceConfig;
  occupiedPilotIds?: readonly string[];
  disabled: boolean;
  onAdd: (input: AddPilotInput) => boolean;
  onRestore?: (channelId: string) => boolean;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const added = addedPilotIds(workspace);
  const countFor = (sourceId: string) => workspace.pilotChannels.filter((channel) => channel.sourceId === sourceId && added.includes(channel.id)).length;
  const hasSpace = (sourceId: string) => availablePilotChannels(workspace, sourceId, occupiedPilotIds).length > 0;
  const [sourceId, setSourceId] = useState(() => hasSpace(workspace.activeSourceId) ? workspace.activeSourceId : "new");
  const [athleteCode, setAthleteCode] = useState("");
  const [picture, setPicture] = useState<PilotPicture>("full");
  const [error, setError] = useState<string | null>(null);
  const sourceFull = sourceId !== "new" && !hasSpace(sourceId);
  const restorable = restorablePilotChannels(workspace, occupiedPilotIds);

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    nameRef.current?.focus();
    return () => dialog?.close();
  }, []);

  return <dialog className={styles.dialog} ref={dialogRef} aria-labelledby="add-pilot-title" onCancel={onClose}>
    <form onSubmit={(event) => {
      event.preventDefault();
      if (disabled || sourceFull || !athleteCode.trim()) return;
      if (onAdd({ sourceId, athleteCode, picture })) onClose();
      else setError("未能添加飞手，请检查本机存储或重新选择输入后再试。");
    }}>
      <header className={styles.heading}><div><h2 id="add-pilot-title">添加飞手</h2><p>一个飞手，一个对应的画面。</p></div><button type="button" className={styles.close} aria-label="关闭添加飞手" onClick={onClose}>×</button></header>
      {onRestore && restorable.length > 0 && <section className={styles.saved} aria-label="保留的飞手"><b>恢复之前的飞手</b><p>沿用原来的姓名、画面和配置。</p><div>{restorable.map((channel) => <button key={channel.id} className="mini-button" type="button" disabled={disabled} onClick={() => {
        if (onRestore(channel.id)) onClose();
        else setError("未能恢复飞手，请检查本机存储后再试。");
      }}>恢复 {channel.athleteCode.trim() || `${workspace.sources.find((source) => source.id === channel.sourceId)?.label || "视频输入"} · 飞手 ${channel.slot + 1}`}</button>)}</div></section>}
      <label className={styles.field}>飞手名称<input ref={nameRef} required maxLength={40} value={athleteCode} placeholder="姓名或飞手代号" disabled={disabled} onChange={(event) => setAthleteCode(event.target.value)} /></label>
      <label className={styles.field}>画面来源<select aria-label="画面来源" value={sourceId} disabled={disabled} onChange={(event) => setSourceId(event.target.value)}>
        {workspace.sources.map((source) => <option key={source.id} value={source.id} disabled={!hasSpace(source.id)}>{source.label || "未命名输入"}{hasSpace(source.id) ? countFor(source.id) ? ` · 已关联 ${countFor(source.id)} 位飞手` : " · 尚未关联飞手" : " · 位置已使用或保留"}</option>)}
        <option value="new">新增独立视频输入</option>
      </select></label>
      <fieldset className={styles.pictures} disabled={disabled}><legend>这位飞手的画面</legend><p>单人输入选完整画面；四合一输入选择他所在的区域。</p><div className={styles.pictureChoices}>
        {pictures.map((item) => <label key={item.value} className={styles.pictureChoice}><input type="radio" name="pilot-picture" value={item.value} checked={picture === item.value} onChange={() => setPicture(item.value)} /><span className={styles.miniFrame} data-picture={item.value}><i /><i /><i /><i /></span><span>{item.label}</span></label>)}
      </div></fieldset>
      <p className={styles.hint}>添加后可连接采集卡，并在「裁切与绑定」中微调画面。配置仅保存在本机。</p>
      {error && <p className={styles.error} role="alert">{error}</p>}
      {disabled && <p role="status">当前操作期间不能修改飞手配置，完成后可继续添加。</p>}
      <footer className={styles.actions}><button className="button button--quiet" type="button" onClick={onClose}>取消</button><button className="button button--primary" type="submit" disabled={disabled || sourceFull || !athleteCode.trim()}>添加飞手</button></footer>
    </form>
  </dialog>;
}
