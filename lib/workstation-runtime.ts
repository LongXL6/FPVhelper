export type WorkstationTabState = "checking" | "primary" | "blocked" | "unsupported";

export type WorkstationShortcut =
  | "toggle_fullscreen"
  | "record_hold"
  | "add_marker"
  | "export_latest"
  | "cancel_connection";

interface WorkstationLockManager {
  request: (
    name: string,
    options: { mode: "exclusive"; ifAvailable: true },
    callback: (lock: object | null) => Promise<void> | void,
  ) => Promise<unknown>;
}

interface ShortcutInput {
  key: string;
  code: string;
  repeat: boolean;
  modified: boolean;
  typing: boolean;
}

export const WORKSTATION_LOCK_NAME = "fpvhelper-training-workstation-v1";

export function createWorkstationTabLease(
  lockManager: WorkstationLockManager,
  onState: (state: WorkstationTabState) => void,
) {
  let disposed = false;
  let releaseLease: () => void = () => undefined;
  const lease = new Promise<void>((resolve) => {
    releaseLease = resolve;
  });

  void lockManager.request(
    WORKSTATION_LOCK_NAME,
    { mode: "exclusive", ifAvailable: true },
    async (lock) => {
      if (disposed) return;
      if (!lock) {
        onState("blocked");
        return;
      }
      onState("primary");
      await lease;
    },
  ).catch(() => {
    if (!disposed) onState("unsupported");
  });

  return () => {
    disposed = true;
    releaseLease();
  };
}

export function classifyWorkstationShortcut(input: ShortcutInput): WorkstationShortcut | null {
  if (input.repeat || input.modified || input.typing) return null;
  const key = input.key.toLowerCase();
  if (key === "f") return "toggle_fullscreen";
  if (key === "m") return "add_marker";
  if (key === "e") return "export_latest";
  if (key === "escape") return "cancel_connection";
  if (input.code === "Space" || input.key === " ") return "record_hold";
  return null;
}

export function workstationTabStartBlockReason(state: WorkstationTabState) {
  if (state === "checking") return "正在确认本机是否已有训练页面";
  if (state === "blocked") return "另一标签页已占用训练工作站，请关闭另一页后刷新";
  return null;
}
