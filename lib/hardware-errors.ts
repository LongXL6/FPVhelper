export interface HardwareIssue<Code extends string> {
  code: Code;
  message: string;
}

export type VideoCaptureErrorCode =
  | "video_insecure_context"
  | "video_media_unsupported"
  | "video_permission_denied"
  | "video_device_busy"
  | "video_device_not_found"
  | "video_constraints_failed"
  | "video_playback_failed"
  | "video_device_disconnected"
  | "video_unknown";

export type SerialErrorCode =
  | "serial_insecure_context"
  | "serial_unsupported"
  | "serial_picker_cancelled"
  | "serial_permission_denied"
  | "serial_port_busy"
  | "serial_device_disconnected"
  | "serial_not_readable"
  | "serial_not_writable"
  | "serial_no_rc_frames"
  | "serial_read_failed"
  | "serial_write_failed"
  | "serial_unknown";

export type VideoCaptureIssue = HardwareIssue<VideoCaptureErrorCode>;
export type SerialIssue = HardwareIssue<SerialErrorCode>;

const VIDEO_ISSUES: Record<VideoCaptureErrorCode, VideoCaptureIssue> = {
  video_insecure_context: {
    code: "video_insecure_context",
    message: "当前页面不是安全连接。请通过 HTTPS 或 localhost 打开后再连接 HDMI 采集卡。",
  },
  video_media_unsupported: {
    code: "video_media_unsupported",
    message: "当前浏览器无法访问视频采集设备。请使用最新版桌面 Chrome 或 Edge。",
  },
  video_permission_denied: {
    code: "video_permission_denied",
    message: "视频权限被拒绝。请在浏览器地址栏允许摄像头权限后重试。",
  },
  video_device_busy: {
    code: "video_device_busy",
    message: "HDMI 采集卡可能正被其他软件占用。请关闭 OBS、DVR 或会议软件后重试。",
  },
  video_device_not_found: {
    code: "video_device_not_found",
    message: "没有找到所选 HDMI 采集卡。请重新插拔采集卡并选择当前可用的视频输入。",
  },
  video_constraints_failed: {
    code: "video_constraints_failed",
    message: "采集卡不支持当前视频参数。请确认 HDMI 信号格式后重新选择设备。",
  },
  video_playback_failed: {
    code: "video_playback_failed",
    message: "已打开采集卡，但画面无法播放。请确认 HDMI 输入有信号后重试。",
  },
  video_device_disconnected: {
    code: "video_device_disconnected",
    message: "HDMI 采集卡连接已中断。请检查 USB 与 HDMI 线缆，然后重新打开画面。",
  },
  video_unknown: {
    code: "video_unknown",
    message: "HDMI 采集卡连接失败。请重新插拔设备，并关闭可能占用采集卡的软件后重试。",
  },
};

const SERIAL_ISSUES: Record<SerialErrorCode, SerialIssue> = {
  serial_insecure_context: {
    code: "serial_insecure_context",
    message: "当前页面不是安全连接。请通过 HTTPS 或 localhost 打开后再连接桥接飞控。",
  },
  serial_unsupported: {
    code: "serial_unsupported",
    message: "当前浏览器不支持 Web Serial。请使用最新版桌面 Chrome 或 Edge。",
  },
  serial_picker_cancelled: {
    code: "serial_picker_cancelled",
    message: "未选择串口，当前继续使用演示数据。",
  },
  serial_permission_denied: {
    code: "serial_permission_denied",
    message: "串口权限被拒绝。请重新点击连接，并在设备选择器中允许桥接飞控。",
  },
  serial_port_busy: {
    code: "serial_port_busy",
    message: "桥接飞控串口正被占用。请关闭 Betaflight Configurator 或其他串口软件后重试。",
  },
  serial_device_disconnected: {
    code: "serial_device_disconnected",
    message: "桥接飞控 USB 已断开。请检查线缆，重新插入原设备后再次连接。",
  },
  serial_not_readable: {
    code: "serial_not_readable",
    message: "桥接飞控串口不可读。请重新插拔设备并确认没有其他软件占用串口。",
  },
  serial_not_writable: {
    code: "serial_not_writable",
    message: "桥接飞控串口不可写入 MSP 读取请求。请重新插拔设备并检查串口占用。",
  },
  serial_no_rc_frames: {
    code: "serial_no_rc_frames",
    message: "连接后 5 秒内未收到有效 MSP_RC 数据。请检查飞控、接收机供电与接收机协议。",
  },
  serial_read_failed: {
    code: "serial_read_failed",
    message: "读取桥接飞控数据失败。请检查 USB 线缆和串口占用后重试。",
  },
  serial_write_failed: {
    code: "serial_write_failed",
    message: "发送 MSP 读取请求失败。请检查 USB 线缆和串口占用后重试。",
  },
  serial_unknown: {
    code: "serial_unknown",
    message: "无法连接桥接飞控。请重新插拔设备并关闭其他串口软件后重试。",
  },
};

function errorName(error: unknown) {
  if (!error || typeof error !== "object" || !("name" in error)) return "";
  return typeof error.name === "string" ? error.name : "";
}

export function videoIssue(code: VideoCaptureErrorCode): VideoCaptureIssue {
  return VIDEO_ISSUES[code];
}

export function serialIssue(code: SerialErrorCode): SerialIssue {
  return SERIAL_ISSUES[code];
}

export function videoPreflightIssue(options: {
  secureContext: boolean;
  mediaSupported: boolean;
}): VideoCaptureIssue | null {
  if (!options.secureContext) return videoIssue("video_insecure_context");
  if (!options.mediaSupported) return videoIssue("video_media_unsupported");
  return null;
}

export function classifyVideoCaptureError(error: unknown): VideoCaptureIssue {
  switch (errorName(error)) {
    case "NotAllowedError":
    case "SecurityError":
      return videoIssue("video_permission_denied");
    case "NotReadableError":
    case "AbortError":
      return videoIssue("video_device_busy");
    case "NotFoundError":
      return videoIssue("video_device_not_found");
    case "OverconstrainedError":
    case "ConstraintNotSatisfiedError":
      return videoIssue("video_constraints_failed");
    default:
      return videoIssue("video_unknown");
  }
}

export type SerialErrorContext = "picker" | "open" | "read" | "write";

export function serialPreflightIssue(options: {
  secureContext: boolean;
  serialSupported: boolean;
}): SerialIssue | null {
  if (!options.secureContext) return serialIssue("serial_insecure_context");
  if (!options.serialSupported) return serialIssue("serial_unsupported");
  return null;
}

export function classifySerialError(error: unknown, context: SerialErrorContext): SerialIssue {
  const name = errorName(error);
  if (context === "picker" && name === "NotFoundError") return serialIssue("serial_picker_cancelled");
  if (name === "NotAllowedError" || name === "SecurityError") {
    return serialIssue("serial_permission_denied");
  }
  if (context === "open" && (name === "InvalidStateError" || name === "NetworkError")) {
    return serialIssue("serial_port_busy");
  }
  if (name === "NotFoundError" || name === "NetworkError" || name === "AbortError") {
    return serialIssue("serial_device_disconnected");
  }
  if (context === "read") return serialIssue("serial_read_failed");
  if (context === "write") return serialIssue("serial_write_failed");
  return serialIssue("serial_unknown");
}

export function selectPreviouslyAuthorizedPort<T>(ports: readonly T[], previousPort: T | null) {
  return previousPort !== null && ports.includes(previousPort) ? previousPort : null;
}

export function serialDisconnectDecision<T>(
  activePort: T | null,
  eventPort: T | null,
): "ignore" | "unexpected_disconnect" {
  return activePort !== null && activePort === eventPort ? "unexpected_disconnect" : "ignore";
}
