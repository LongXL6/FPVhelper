import type { TrainingSessionStorageIntegrity } from "@/lib/training-session-store";

export function quarantinedTrainingRecordCount(integrity: TrainingSessionStorageIntegrity) {
  return integrity.quarantinedDraftCount + integrity.quarantinedSessionCount;
}

export function TrainingStorageIntegrityNotice({
  integrity,
}: {
  integrity: TrainingSessionStorageIntegrity;
}) {
  const quarantinedCount = quarantinedTrainingRecordCount(integrity);
  if (quarantinedCount === 0 && !integrity.migrationWarning) return null;

  return (
    <>
      {integrity.migrationWarning ? (
        <div className="session-progress" role="alert">
          <b>本机记录暂以只读方式打开</b>
          <span>{integrity.migrationWarning} 现有可读记录可以查看和导出；新录制与本机修改暂不可用。请先备份重要记录，释放浏览器存储空间后重新打开页面重试；系统不会自动删除历史。</span>
        </div>
      ) : null}
      {quarantinedCount > 0 ? <div className="session-progress" role="alert">
        <b>已隔离 {quarantinedCount} 条异常记录</b>
        <span>
          草稿 {integrity.quarantinedDraftCount} 条 · Session {integrity.quarantinedSessionCount} 条。
          其余 {integrity.readableSessionCount} 条 Session {integrity.migrationWarning ? "仍可查看和导出" : "与新训练仍可使用"}；异常记录不会进入恢复、今日列表、导出或有效统计。
          原始异常记录仍保留在 IndexedDB，系统未自动删除。
        </span>
      </div> : null}
    </>
  );
}
