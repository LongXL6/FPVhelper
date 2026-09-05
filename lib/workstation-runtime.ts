export type WorkstationTabState = "checking" | "primary" | "blocked" | "unsupported";

export type WorkstationShortcut =
  | "toggle_fullscreen"
  | "record_hold"
  | "add_marker"
  | "export_latest"
  | "cancel_connection";

export type ScreenWakeState = "idle" | "requesting" | "active" | "released" | "unsupported" | "error";

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
  interactive: boolean;
  singleKeyEnabled: boolean;
}

interface RecordHoldActionInput {
  isRecording: boolean;
  isStarting: boolean;
  isFinishing: boolean;
  canStart: boolean;
  tabAllowsStart: boolean;
}

interface RecordHoldControllerOptions {
  delayMs: number;
  schedule: (callback: () => void, delayMs: number) => unknown;
  clearScheduled: (timer: unknown) => void;
  canTrigger: () => boolean;
  onTrigger: () => void;
  onCancel: (reason: "released" | "environment") => void;
}

export interface WakeLockSentinelLike {
  release: () => Promise<void>;
  addEventListener: (type: "release", listener: () => void, options?: AddEventListenerOptions) => void;
}

interface WakeLockCoordinatorOptions<TSentinel extends WakeLockSentinelLike> {
  request: () => Promise<TSentinel>;
  isVisible: () => boolean;
  onState: (state: ScreenWakeState) => void;
}

interface StorageLike {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

export const WORKSTATION_LOCK_NAME = "fpvhelper-training-workstation-v1";
export const WORKSTATION_SINGLE_KEY_SHORTCUTS_KEY = "fpvhelper.workstation.single-key-shortcuts.v1";
export const WORKSTATION_INTERACTIVE_SELECTOR = [
  "button",
  "a[href]",
  "[role=\"button\"]",
  "summary",
  "input",
  "select",
  "textarea",
  "[contenteditable]:not([contenteditable=\"false\"])",
].join(", ");

export function createWorkstationTabLease(
  lockManager: WorkstationLockManager,
  onState: (state: WorkstationTabState) => void,
) {
  let disposed = false;
  let retries = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let releaseLease: () => void = () => undefined;
  const lease = new Promise<void>((resolve) => {
    releaseLease = resolve;
  });

  const requestLease = () => {
    if (disposed) return;
    void lockManager.request(
      WORKSTATION_LOCK_NAME,
      { mode: "exclusive", ifAvailable: true },
      async (lock) => {
        if (disposed) return;
        if (!lock) {
          // StrictMode or HMR may request a new lease before the previous release settles.
          if (retries < 2) {
            retries += 1;
            onState("checking");
            retryTimer = setTimeout(() => {
              retryTimer = null;
              requestLease();
            }, 50);
          } else {
            onState("blocked");
          }
          return;
        }
        onState("primary");
        await lease;
      },
    ).catch(() => {
      if (!disposed) onState("unsupported");
    });
  };
  requestLease();

  return () => {
    disposed = true;
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
    releaseLease();
  };
}

export function classifyWorkstationShortcut(input: ShortcutInput): WorkstationShortcut | null {
  if (input.repeat || input.modified) return null;
  const key = input.key.toLowerCase();
  if (key === "escape") return "cancel_connection";
  if (input.interactive) return null;
  if (input.code === "Space" || input.key === " ") return "record_hold";
  if (!input.singleKeyEnabled) return null;
  if (key === "f") return "toggle_fullscreen";
  if (key === "m") return "add_marker";
  if (key === "e") return "export_latest";
  return null;
}

export function workstationRecordHoldAction(input: RecordHoldActionInput): "start" | "stop" | "blocked" {
  if (input.isStarting || input.isFinishing) return "blocked";
  if (input.isRecording) return "stop";
  if (input.canStart && input.tabAllowsStart) return "start";
  return "blocked";
}

export function workstationShortcutShouldPreventDefault(shortcut: WorkstationShortcut) {
  return shortcut !== "cancel_connection";
}

export function isWorkstationInteractiveTarget(target: EventTarget | null) {
  const candidate = target as { closest?: (selector: string) => unknown } | null;
  return typeof candidate?.closest === "function" && Boolean(candidate.closest(WORKSTATION_INTERACTIVE_SELECTOR));
}

export function loadWorkstationSingleKeyShortcuts(storage: StorageLike) {
  try {
    return storage.getItem(WORKSTATION_SINGLE_KEY_SHORTCUTS_KEY) === "enabled";
  } catch {
    return false;
  }
}

export function saveWorkstationSingleKeyShortcuts(storage: StorageLike, enabled: boolean) {
  try {
    storage.setItem(WORKSTATION_SINGLE_KEY_SHORTCUTS_KEY, enabled ? "enabled" : "disabled");
    return null;
  } catch (error) {
    return error instanceof Error && error.message ? error.message : "无法保存本机单键快捷操作设置";
  }
}

export function createRecordHoldController(options: RecordHoldControllerOptions) {
  let held = false;
  let triggered = false;
  let timer: unknown = null;

  const clearTimer = () => {
    if (timer !== null) options.clearScheduled(timer);
    timer = null;
  };

  return {
    press() {
      if (held) return false;
      held = true;
      triggered = false;
      timer = options.schedule(() => {
        timer = null;
        if (!held || !options.canTrigger()) {
          held = false;
          options.onCancel("environment");
          return;
        }
        triggered = true;
        options.onTrigger();
      }, options.delayMs);
      return true;
    },
    release() {
      if (!held && !triggered) return false;
      held = false;
      if (timer !== null) {
        clearTimer();
        options.onCancel("released");
      }
      triggered = false;
      return true;
    },
    cancel() {
      if (!held && !triggered) return false;
      const wasPending = timer !== null;
      held = false;
      triggered = false;
      clearTimer();
      if (wasPending) options.onCancel("environment");
      return true;
    },
  };
}

export function createWakeLockCoordinator<TSentinel extends WakeLockSentinelLike>(
  options: WakeLockCoordinatorOptions<TSentinel>,
) {
  let active = true;
  let generation = 0;
  let sentinel: TSentinel | null = null;
  let inflight: Promise<void> | null = null;

  const release = async (target: TSentinel) => {
    try {
      await target.release();
    } catch {
      // A stale or already released sentinel is safe to ignore.
    }
  };

  const acquire = () => {
    if (!active || !options.isVisible() || sentinel) return Promise.resolve();
    if (inflight) return inflight;

    const requestGeneration = generation;
    options.onState("requesting");
    const pending = options.request()
      .then(async (nextSentinel) => {
        if (!active || requestGeneration !== generation || !options.isVisible()) {
          await release(nextSentinel);
          return;
        }

        sentinel = nextSentinel;
        nextSentinel.addEventListener("release", () => {
          if (sentinel !== nextSentinel) return;
          sentinel = null;
          if (!active) return;
          options.onState("released");
          if (options.isVisible()) void acquire();
        }, { once: true });
        options.onState("active");
      })
      .catch(() => {
        if (active && requestGeneration === generation) options.onState("error");
      })
      .finally(() => {
        inflight = null;
        if (active && options.isVisible() && !sentinel && requestGeneration !== generation) void acquire();
      });
    inflight = pending;
    return pending;
  };

  const visibilityChanged = () => {
    generation += 1;
    if (!options.isVisible()) {
      const staleSentinel = sentinel;
      sentinel = null;
      if (staleSentinel) {
        options.onState("released");
        void release(staleSentinel);
      }
      return;
    }
    void acquire();
  };

  const dispose = () => {
    active = false;
    generation += 1;
    const staleSentinel = sentinel;
    sentinel = null;
    if (staleSentinel) void release(staleSentinel);
  };

  return { acquire, visibilityChanged, dispose };
}

export function workstationTabStartBlockReason(state: WorkstationTabState) {
  if (state === "checking") return "正在确认本机是否已有训练页面";
  if (state === "blocked") return "另一标签页已占用训练工作站，请关闭另一页后刷新";
  if (state === "unsupported") return "当前浏览器无法安全锁定单一训练页面；记录、串口和视频连接已停用，请改用最新版 Chrome 或 Edge";
  return null;
}
