interface WorkstationShortcutToggleProps {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
}

export function WorkstationShortcutToggle({ enabled, onChange }: WorkstationShortcutToggleProps) {
  return (
    <aside className="workstation-shortcuts" aria-label="本机键盘快捷操作设置">
      <div>
        <b>本机单键快捷操作</b>
        <span>F 全屏 / M 标记 / E 导出默认关闭；Space 长按与 Esc 安全操作始终可用。</span>
      </div>
      <label>
        <input
          type="checkbox"
          aria-label={`本机单键快捷操作：${enabled ? "已开启" : "已关闭"}`}
          checked={enabled}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span>{enabled ? "已开启" : "已关闭"}</span>
      </label>
    </aside>
  );
}
