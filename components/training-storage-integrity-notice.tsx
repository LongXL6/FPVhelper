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
  if (quarantinedCount === 0) return null;

  return (
    <div className="session-progress" role="alert">
      <b>已隔离 {quarantinedCount} 条异常记录</b>
      <span>
        草稿 {integrity.quarantinedDraftCount} 条 · Session {integrity.quarantinedSessionCount} 条。
        其余 {integrity.readableSessionCount} 条 Session 与新训练仍可使用；异常记录不会进入恢复、今日列表、导出或有效统计。
        原始异常记录仍保留在 IndexedDB，系统未自动删除。
      </span>
    </div>
  );
}
