interface TrainingExportNoticeProps {
  notice: string | null;
  warning: string | null;
}

export function TrainingExportNotice({ notice, warning }: TrainingExportNoticeProps) {
  const message = warning ?? notice;
  if (!message) return null;

  return (
    <aside
      className={`export-banner ${warning ? "export-banner--warning" : ""}`}
      role="status"
      aria-live="polite"
    >
      <b>{warning ? "导出警告" : "导出提示"}</b>
      <span>{message}</span>
    </aside>
  );
}
