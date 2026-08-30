import type { SerialErrorCode, VideoCaptureErrorCode } from "../hardware-errors";

export const ANALYTICS_ERROR_DOMAINS = ["serial", "video", "storage", "unknown"] as const;
export type AnalyticsErrorDomain = (typeof ANALYTICS_ERROR_DOMAINS)[number];

export const ANALYTICS_ERROR_STAGES = [
  "unsupported",
  "picker",
  "open",
  "handshake",
  "read",
  "write",
  "capture",
  "storage_read",
  "storage_write",
  "runtime",
] as const;
export type AnalyticsErrorStage = (typeof ANALYTICS_ERROR_STAGES)[number];

export const ANALYTICS_ERROR_CODES = [
  "serial_unsupported",
  "serial_picker_cancelled",
  "serial_port_busy",
  "serial_open_failed",
  "serial_not_readable",
  "serial_not_writable",
  "serial_first_frame_timeout",
  "serial_device_lost",
  "serial_unknown",
  "video_unsupported",
  "video_insecure_context",
  "video_permission_denied",
  "video_device_not_found",
  "video_device_busy",
  "video_constraint_failed",
  "video_aborted",
  "video_device_lost",
  "video_unknown",
  "storage_unavailable",
  "storage_quota_exceeded",
  "storage_access_denied",
  "storage_corrupt",
  "storage_unknown",
  "unexpected_exception",
] as const;
export type AnalyticsErrorCode = (typeof ANALYTICS_ERROR_CODES)[number];

export interface ClassifiedAnalyticsError {
  domain: AnalyticsErrorDomain;
  code: AnalyticsErrorCode;
  stage: AnalyticsErrorStage;
  nextStepZh: string;
  fingerprint: string;
}

const NEXT_STEPS_ZH: Record<AnalyticsErrorCode, string> = {
  serial_unsupported: "请改用支持 Web Serial 的桌面版 Chrome 或 Edge，并通过 HTTPS 打开。",
  serial_picker_cancelled: "请重新连接，并在系统选择器中选择桥接飞控串口。",
  serial_port_busy: "请关闭 Betaflight Configurator 等占用串口的软件后重试。",
  serial_open_failed: "请重新插拔 USB 数据线，确认桥接飞控已供电后重试。",
  serial_not_readable: "请确认串口仍在线，并关闭可能读取该端口的其他软件。",
  serial_not_writable: "请确认串口仍在线，并关闭可能写入该端口的其他软件。",
  serial_first_frame_timeout: "请确认选中的是桥接飞控端口，并检查 Betaflight MSP 串口配置。",
  serial_device_lost: "请重新插拔桥接飞控 USB，确认供电和数据线稳定后重连。",
  serial_unknown: "请返回演示模式，再重新连接桥接飞控；若仍失败请记录故障时间。",
  video_unsupported: "请改用支持摄像头采集的桌面浏览器。",
  video_insecure_context: "请通过 HTTPS 打开页面后重试。",
  video_permission_denied: "请在浏览器站点设置中允许摄像头权限后重试。",
  video_device_not_found: "请连接 HDMI 采集卡，并确认系统能够识别视频输入。",
  video_device_busy: "请关闭 OBS、DVR 或其他占用采集卡的软件后重试。",
  video_constraint_failed: "请选择另一个视频输入，或降低采集卡输出分辨率后重试。",
  video_aborted: "请重新连接采集卡并再次打开画面。",
  video_device_lost: "请重新插拔采集卡，确认 USB 与 HDMI 连接稳定后重试。",
  video_unknown: "请断开再重新打开画面；若仍失败请记录故障时间。",
  storage_unavailable: "请允许浏览器使用本地存储，或改用普通浏览窗口。",
  storage_quota_exceeded: "请先导出并清理本机旧记录，再重新开始训练记录。",
  storage_access_denied: "请检查浏览器站点存储权限后重试。",
  storage_corrupt: "请先导出现有记录，再清理该站点的本地数据并重新打开。",
  storage_unknown: "请先导出现有记录并重新打开页面；若仍失败请记录故障时间。",
  unexpected_exception: "请重新打开页面；若问题可复现，请记录故障时间和操作阶段。",
};

function errorName(error: unknown) {
  if (typeof error !== "object" || error === null || !("name" in error)) return "";
  return typeof error.name === "string" ? error.name : "";
}

function errorMessageForClassification(error: unknown) {
  if (typeof error !== "object" || error === null || !("message" in error)) return "";
  return typeof error.message === "string" ? error.message.toLowerCase() : "";
}

function stableFingerprint(domain: AnalyticsErrorDomain, code: AnalyticsErrorCode, stage: AnalyticsErrorStage) {
  // The fingerprint deliberately hashes only stable enums. Raw messages, stack frames,
  // device labels, port names and bytes never influence or leave this function.
  const input = `fpvhelper-error-v1|${domain}|${code}|${stage}`;
  let high = 0xcbf29ce4;
  let low = 0x84222325;
  for (let index = 0; index < input.length; index += 1) {
    low ^= input.charCodeAt(index);
    const nextLow = Math.imul(low, 0x1b3);
    const carry = Math.floor((low >>> 0) * 0x1b3 / 0x1_0000_0000);
    high = (Math.imul(high, 0x1b3) + carry) >>> 0;
    low = nextLow >>> 0;
  }
  return `${high.toString(16).padStart(8, "0")}${low.toString(16).padStart(8, "0")}`;
}

function classified(
  domain: AnalyticsErrorDomain,
  code: AnalyticsErrorCode,
  stage: AnalyticsErrorStage,
): ClassifiedAnalyticsError {
  return {
    domain,
    code,
    stage,
    nextStepZh: NEXT_STEPS_ZH[code],
    fingerprint: stableFingerprint(domain, code, stage),
  };
}

export function classifySerialHardwareErrorCode(code: SerialErrorCode): ClassifiedAnalyticsError {
  switch (code) {
    case "serial_insecure_context":
    case "serial_unsupported":
      return classified("serial", "serial_unsupported", "unsupported");
    case "serial_picker_cancelled":
      return classified("serial", "serial_picker_cancelled", "picker");
    case "serial_permission_denied":
      return classified("serial", "serial_open_failed", "picker");
    case "serial_port_busy":
      return classified("serial", "serial_port_busy", "open");
    case "serial_device_disconnected":
      return classified("serial", "serial_device_lost", "read");
    case "serial_not_readable":
    case "serial_read_failed":
      return classified("serial", "serial_not_readable", "read");
    case "serial_not_writable":
    case "serial_write_failed":
      return classified("serial", "serial_not_writable", "write");
    case "serial_no_rc_frames":
      return classified("serial", "serial_first_frame_timeout", "handshake");
    case "serial_unknown":
      return classified("serial", "serial_unknown", "open");
  }
}

export function classifyVideoHardwareErrorCode(code: VideoCaptureErrorCode): ClassifiedAnalyticsError {
  switch (code) {
    case "video_insecure_context":
      return classified("video", "video_insecure_context", "capture");
    case "video_media_unsupported":
      return classified("video", "video_unsupported", "unsupported");
    case "video_permission_denied":
      return classified("video", "video_permission_denied", "capture");
    case "video_device_busy":
      return classified("video", "video_device_busy", "capture");
    case "video_device_not_found":
      return classified("video", "video_device_not_found", "capture");
    case "video_constraints_failed":
      return classified("video", "video_constraint_failed", "capture");
    case "video_device_disconnected":
      return classified("video", "video_device_lost", "capture");
    case "video_playback_failed":
    case "video_unknown":
      return classified("video", "video_unknown", "capture");
  }
}

export function classifySerialError(
  error: unknown,
  stage: AnalyticsErrorStage = "runtime",
): ClassifiedAnalyticsError {
  const name = errorName(error);
  const message = errorMessageForClassification(error);

  if (name === "NotFoundError" && stage === "picker") {
    return classified("serial", "serial_picker_cancelled", stage);
  }
  if (name === "NotSupportedError" || name === "SecurityError") {
    return classified("serial", "serial_unsupported", stage === "runtime" ? "unsupported" : stage);
  }
  if (name === "InvalidStateError" || /already open|in use|busy|占用/.test(message)) {
    return classified("serial", "serial_port_busy", stage);
  }
  if (stage === "handshake" && /timeout|timed out|超时/.test(message)) {
    return classified("serial", "serial_first_frame_timeout", stage);
  }
  if (stage === "read") {
    return classified("serial", name === "NetworkError" ? "serial_device_lost" : "serial_not_readable", stage);
  }
  if (stage === "write") {
    return classified("serial", name === "NetworkError" ? "serial_device_lost" : "serial_not_writable", stage);
  }
  if (name === "NetworkError" && stage !== "open") {
    return classified("serial", "serial_device_lost", stage);
  }
  if (stage === "open") return classified("serial", "serial_open_failed", stage);
  return classified("serial", "serial_unknown", stage);
}

export function classifyMediaError(
  error: unknown,
  stage: AnalyticsErrorStage = "capture",
): ClassifiedAnalyticsError {
  const name = errorName(error);
  const message = errorMessageForClassification(error);

  if (name === "NotSupportedError") return classified("video", "video_unsupported", "unsupported");
  if (name === "SecurityError" || /secure context|https/.test(message)) {
    return classified("video", "video_insecure_context", stage);
  }
  if (name === "NotAllowedError" || name === "PermissionDeniedError") {
    return classified("video", "video_permission_denied", stage);
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return classified("video", "video_device_not_found", stage);
  }
  if (name === "NotReadableError" || name === "TrackStartError") {
    return classified("video", "video_device_busy", stage);
  }
  if (name === "OverconstrainedError" || name === "ConstraintNotSatisfiedError") {
    return classified("video", "video_constraint_failed", stage);
  }
  if (name === "AbortError") return classified("video", "video_aborted", stage);
  if (name === "NetworkError") return classified("video", "video_device_lost", stage);
  return classified("video", "video_unknown", stage);
}

export function classifyStorageError(
  error: unknown,
  stage: "storage_read" | "storage_write" = "storage_write",
): ClassifiedAnalyticsError {
  const name = errorName(error);
  const message = errorMessageForClassification(error);

  if (name === "QuotaExceededError") return classified("storage", "storage_quota_exceeded", stage);
  if (name === "SecurityError" || name === "NotAllowedError") {
    return classified("storage", "storage_access_denied", stage);
  }
  if (name === "DataError" || name === "DataCloneError" || /corrupt|malformed|invalid json/.test(message)) {
    return classified("storage", "storage_corrupt", stage);
  }
  if (name === "InvalidStateError" || name === "NotSupportedError") {
    return classified("storage", "storage_unavailable", stage);
  }
  return classified("storage", "storage_unknown", stage);
}

export function classifyUnknownError(
  _error: unknown,
  stage: AnalyticsErrorStage = "runtime",
): ClassifiedAnalyticsError {
  return classified("unknown", "unexpected_exception", stage);
}
