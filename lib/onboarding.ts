export const ONBOARDING_DECISION_STORAGE_KEY = "fpvhelper.onboarding.v1";

export type OnboardingDecision = "acknowledged" | "later";

export interface OnboardingStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

export interface OnboardingEnvironmentInput {
  userAgent: string;
  secureContext: boolean;
  serialSupported: boolean;
  mediaSupported: boolean;
  indexedDbSupported: boolean;
  directoryPickerSupported: boolean;
}

export interface OnboardingEnvironment extends OnboardingEnvironmentInput {
  isWeChat: boolean;
  compatibilityNotice: string | null;
}

export function isWeChatBrowser(userAgent: string) {
  return /MicroMessenger(?:\/|\s)/i.test(userAgent);
}

export function assessOnboardingEnvironment(
  input: OnboardingEnvironmentInput,
): OnboardingEnvironment {
  const isWeChat = isWeChatBrowser(input.userAgent);
  const missingCapabilities = [
    !input.secureContext ? "安全上下文" : null,
    !input.mediaSupported ? "视频采集能力" : null,
    !input.serialSupported ? "Web Serial" : null,
  ].filter((value): value is string => value !== null);

  const compatibilityNotice = isWeChat
    ? "检测到微信内置浏览器。请复制链接到最新版桌面 Chrome 或 Edge；能否连接仍以本页能力检查和实际设备授权为准。"
    : missingCapabilities.length > 0
      ? `当前环境缺少${missingCapabilities.join("、")}。建议改用最新版桌面 Chrome 或 Edge，并通过 HTTPS 或 localhost 打开；最终仍以本页能力检查为准。`
      : null;

  return { ...input, isWeChat, compatibilityNotice };
}

export function loadOnboardingDecision(
  storage: Pick<OnboardingStorage, "getItem"> | null,
): OnboardingDecision | null {
  if (!storage) return null;
  try {
    const value = storage.getItem(ONBOARDING_DECISION_STORAGE_KEY);
    return value === "acknowledged" || value === "later" ? value : null;
  } catch {
    return null;
  }
}

export function saveOnboardingDecision(
  storage: Pick<OnboardingStorage, "setItem"> | null,
  decision: OnboardingDecision,
) {
  if (!storage) return "当前浏览器无法访问 localStorage；本次可以关闭清单，但下次仍会显示。";
  try {
    storage.setItem(ONBOARDING_DECISION_STORAGE_KEY, decision);
    return null;
  } catch {
    return "当前浏览器无法保存 localStorage；本次可以关闭清单，但下次仍会显示。";
  }
}

export function shouldAutoOpenOnboarding(decision: OnboardingDecision | null) {
  return decision !== "acknowledged";
}
