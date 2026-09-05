export type TelemetrySource = "demo" | "serial";

export type ConnectionState = "demo" | "connecting" | "live" | "stale" | "error";
export type LinkState = "unknown" | "ok" | "lost";

export interface FlightTelemetry {
  timestamp: number;
  monotonicTimestampMs: number;
  sequence: number;
  rollStickPercent: number;
  pitchStickPercent: number;
  yawStickPercent: number;
  throttleStickPercent: number;
  rcThrottleUs: number;
  rcChannelsUs: number[];
  groundMspRssiPercent: number | null;
  groundBridgeVoltage: number | null;
}

export type TelemetrySampleListener = (sample: FlightTelemetry, source: TelemetrySource) => void;
export type SubscribeTelemetrySamples = (listener: TelemetrySampleListener) => () => void;

export interface MspFrame {
  command: number;
  payload: Uint8Array;
  error: boolean;
}

export interface MspParserStats {
  bytesReceived: number;
  checksumValidFrames: number;
  protocolErrors: number;
  checksumErrors: number;
  resyncs: number;
  discardedBytes: number;
}

export type MspParserQuality = "unknown" | "good" | "degraded" | "poor";

export const MSP = {
  API_VERSION: 1,
  NAME: 10,
  RC: 105,
  ANALOG: 110,
  STATUS_EX: 150,
  GET_TEXT: 0x3006,
} as const;

export const MSP_RC_TARGET_HZ = 100;
export const MSP_RC_POLL_INTERVAL_MS = 1_000 / MSP_RC_TARGET_HZ;
export const MSP_RC_RESPONSE_TIMEOUT_MS = 100;
export const MSP_STATUS_EX_POLL_INTERVAL_MS = 100;
export const MSP_ANALOG_POLL_INTERVAL_MS = 500;
export const RC_RECEIVE_RATE_WINDOW_MS = 1_000;

export function createRcReceiveRate() {
  let receivedAt: number[] = [];
  return {
    observe(monotonicTimestampMs: number) {
      receivedAt.push(monotonicTimestampMs);
    },
    getHz(nowMs: number) {
      receivedAt = receivedAt.filter((timestamp) => timestamp > nowMs - RC_RECEIVE_RATE_WINDOW_MS);
      return receivedAt.length * 1_000 / RC_RECEIVE_RATE_WINDOW_MS;
    },
    reset() {
      receivedAt = [];
    },
  };
}

export function canIssueMspRcRequest(nowMs: number, pendingSinceMs: number | null) {
  return pendingSinceMs === null || nowMs - pendingSinceMs >= MSP_RC_RESPONSE_TIMEOUT_MS;
}

const ARMING_DISABLED_FAILSAFE = 1 << 1;
const ARMING_DISABLED_RX_FAILSAFE = 1 << 2;
const RX_LINK_LOST_ARMING_FLAGS = ARMING_DISABLED_FAILSAFE | ARMING_DISABLED_RX_FAILSAFE;
const STATUS_EX_FIXED_PAYLOAD_BYTES = 15;
const STATUS_EX_MAX_FLIGHT_MODE_EXTRA_BYTES = 15;

export const RC_FIRST_FRAME_TIMEOUT_MS = 5_000;
export const RC_STALE_TIMEOUT_MS = 1_500;
export const STATUS_EX_STALE_TIMEOUT_MS = 1_500;

export interface StatusExFreshnessWatchdog {
  observe: () => void;
  reset: () => void;
}

export function createStatusExFreshnessWatchdog(
  onStale: () => void,
  timeoutMs = STATUS_EX_STALE_TIMEOUT_MS,
): StatusExFreshnessWatchdog {
  let timer: ReturnType<typeof setTimeout> | null = null;

  return {
    observe() {
      if (timer !== null) clearTimeout(timer);
      const nextTimer = setTimeout(() => {
        if (timer !== nextTimer) return;
        timer = null;
        onStale();
      }, timeoutMs);
      timer = nextTimer;
    },
    reset() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}

export const EMPTY_MSP_PARSER_STATS: MspParserStats = {
  bytesReceived: 0,
  checksumValidFrames: 0,
  protocolErrors: 0,
  checksumErrors: 0,
  resyncs: 0,
  discardedBytes: 0,
};

export const EMPTY_TELEMETRY: FlightTelemetry = {
  timestamp: 0,
  monotonicTimestampMs: 0,
  sequence: 0,
  rollStickPercent: 0,
  pitchStickPercent: 0,
  yawStickPercent: 0,
  throttleStickPercent: 0,
  rcThrottleUs: 1000,
  rcChannelsUs: [],
  groundMspRssiPercent: null,
  groundBridgeVoltage: null,
};

export function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function normalizeRcAxis(microseconds: number) {
  return clamp(((microseconds - 1500) / 500) * 100, -100, 100);
}

export function normalizeThrottle(microseconds: number) {
  return clamp(((microseconds - 1000) / 1000) * 100, 0, 100);
}

export function connectionStateAfterRcSilence(
  current: ConnectionState,
  silenceMs: number,
): ConnectionState {
  if ((current === "live" || current === "stale") && silenceMs >= RC_STALE_TIMEOUT_MS) {
    return "stale";
  }
  return current;
}

export type ReadOnlyMspCommand = typeof MSP.API_VERSION | typeof MSP.NAME | typeof MSP.RC | typeof MSP.ANALOG | typeof MSP.STATUS_EX;

export function buildMspV1Request(command: ReadOnlyMspCommand) {
  if (![MSP.API_VERSION, MSP.NAME, MSP.RC, MSP.ANALOG, MSP.STATUS_EX].some((allowed) => allowed === command)) {
    throw new RangeError("Unsupported read-only MSP v1 command");
  }
  return Uint8Array.of(36, 77, 60, 0, command, command);
}

function crc8DvbS2(bytes: ArrayLike<number>, start: number, end: number) {
  let crc = 0;
  for (let index = start; index < end; index += 1) {
    crc ^= bytes[index];
    for (let bit = 0; bit < 8; bit += 1) {
      crc = ((crc << 1) ^ ((crc & 0x80) ? 0xd5 : 0)) & 0xff;
    }
  }
  return crc;
}

export function buildMspV2GetTextRequest(textType: 1 | 2) {
  if (textType !== 1 && textType !== 2) throw new RangeError("Unsupported read-only MSP text type");
  // Native MSPv2: flags, little-endian command/length, then the requested text type.
  const request = Uint8Array.of(36, 88, 60, 0, MSP.GET_TEXT & 0xff, MSP.GET_TEXT >> 8, 1, 0, textType, 0);
  request[request.length - 1] = crc8DvbS2(request, 3, request.length - 1);
  return request;
}

export function mspParserQuality(stats: MspParserStats): MspParserQuality {
  if (stats.bytesReceived === 0) return "unknown";
  const failures = stats.checksumErrors + stats.protocolErrors;
  const completedFrames = stats.checksumValidFrames + stats.checksumErrors;
  if (failures === 0 && stats.resyncs === 0) return "good";
  if (failures >= 3 && (completedFrames === 0 || failures / completedFrames >= 0.2)) return "poor";
  return "degraded";
}

export class MspV1StreamParser {
  private buffer: number[] = [];
  private stats: MspParserStats = { ...EMPTY_MSP_PARSER_STATS };

  push(chunk: Uint8Array) {
    this.stats.bytesReceived += chunk.byteLength;
    for (const byte of chunk) this.buffer.push(byte);
    const frames: MspFrame[] = [];

    while (this.buffer.length >= 3) {
      const start = this.findHeader();
      if (start === -1) {
        const retainedBytes = this.trailingHeaderPrefixLength();
        this.discard(this.buffer.length - retainedBytes);
        break;
      }

      if (start > 0) this.discard(start);
      const layout = this.frameLayoutAt(0);
      if (!layout) break;
      const { frameSize, payloadOffset, payloadSize, command } = layout;
      if (this.buffer.length < frameSize) {
        const recoveryStart = this.findValidatedFrameHeader(3);
        if (recoveryStart === -1) break;
        this.discard(recoveryStart);
        continue;
      }

      const direction = this.buffer[2];
      const payload = Uint8Array.from(this.buffer.slice(payloadOffset, payloadOffset + payloadSize));
      const receivedChecksum = this.buffer[frameSize - 1];
      const checksum = this.checksumAt(0, frameSize);

      if (checksum !== receivedChecksum) {
        this.stats.checksumErrors += 1;
        const recoveryStart = this.findValidatedFrameHeader(1);
        // A corrupt length may include part of the following frame; retain header prefixes.
        this.discard(recoveryStart === -1 ? 1 : recoveryStart);
        continue;
      }

      this.buffer.splice(0, frameSize);
      this.stats.checksumValidFrames += 1;
      if (direction === 33) this.stats.protocolErrors += 1;
      frames.push({ command, payload, error: direction === 33 });
    }

    return frames;
  }

  getStats(): MspParserStats {
    return { ...this.stats };
  }

  reset() {
    this.buffer = [];
    this.stats = { ...EMPTY_MSP_PARSER_STATS };
  }

  private discard(count: number) {
    if (count <= 0) return;
    this.buffer.splice(0, count);
    this.stats.discardedBytes += count;
    this.stats.resyncs += 1;
  }

  private findHeader(fromIndex = 0) {
    for (let index = fromIndex; index <= this.buffer.length - 3; index += 1) {
      if (
        this.buffer[index] === 36 &&
        (this.buffer[index + 1] === 77 || this.buffer[index + 1] === 88) &&
        (this.buffer[index + 2] === 62 || this.buffer[index + 2] === 33)
      ) {
        return index;
      }
    }
    return -1;
  }

  private findValidatedFrameHeader(fromIndex: number) {
    let start = this.findHeader(fromIndex);
    while (start !== -1) {
      const layout = this.frameLayoutAt(start);
      if (layout) {
        const { frameSize } = layout;
        if (
          this.buffer.length - start >= frameSize &&
          this.checksumAt(start, frameSize) === this.buffer[start + frameSize - 1]
        ) {
          return start;
        }
      }
      start = this.findHeader(start + 1);
    }
    return -1;
  }

  private frameLayoutAt(start: number) {
    const isV2 = this.buffer[start + 1] === 88;
    if (this.buffer.length - start < (isV2 ? 8 : 5)) return null;
    const payloadSize = isV2
      ? this.buffer[start + 6] | (this.buffer[start + 7] << 8)
      : this.buffer[start + 3];
    return {
      frameSize: payloadSize + (isV2 ? 9 : 6),
      payloadOffset: start + (isV2 ? 8 : 5),
      payloadSize,
      command: isV2 ? this.buffer[start + 4] | (this.buffer[start + 5] << 8) : this.buffer[start + 4],
    };
  }

  private checksumAt(start: number, frameSize: number) {
    if (this.buffer[start + 1] === 88) return crc8DvbS2(this.buffer, start + 3, start + frameSize - 1);
    let checksum = 0;
    for (let index = start + 3; index < start + frameSize - 1; index += 1) {
      checksum ^= this.buffer[index];
    }
    return checksum;
  }

  private trailingHeaderPrefixLength() {
    const length = this.buffer.length;
    if (length >= 2 && this.buffer[length - 2] === 36 && (this.buffer[length - 1] === 77 || this.buffer[length - 1] === 88)) return 2;
    if (length >= 1 && this.buffer[length - 1] === 36) return 1;
    return 0;
  }
}

function readUint16Values(payload: Uint8Array) {
  const values: number[] = [];
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  for (let offset = 0; offset + 1 < payload.byteLength; offset += 2) {
    values.push(view.getUint16(offset, true));
  }
  return values;
}

export function decodeRc(payload: Uint8Array) {
  const channels = readUint16Values(payload);
  if (channels.length < 4) return null;

  const [roll, pitch, yaw, throttle] = channels;
  return {
    rollStickPercent: normalizeRcAxis(roll),
    pitchStickPercent: normalizeRcAxis(pitch),
    yawStickPercent: normalizeRcAxis(yaw),
    throttleStickPercent: normalizeThrottle(throttle),
    rcThrottleUs: throttle,
    rcChannelsUs: channels,
  };
}

export function decodeAnalog(payload: Uint8Array) {
  if (payload.byteLength < 5) return null;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const groundBridgeVoltage = payload[0] / 10;
  const rawRssi = view.getUint16(3, true);

  return {
    groundBridgeVoltage,
    groundMspRssiPercent: clamp((rawRssi / 1023) * 100, 0, 100),
  };
}

export function decodeStatusExLinkState(payload: Uint8Array): LinkState {
  if (payload.byteLength <= STATUS_EX_FIXED_PAYLOAD_BYTES) return "unknown";

  const flightModeExtraByteCount = payload[STATUS_EX_FIXED_PAYLOAD_BYTES];
  if (flightModeExtraByteCount > STATUS_EX_MAX_FLIGHT_MODE_EXTRA_BYTES) return "unknown";

  const armingDisableCountOffset = STATUS_EX_FIXED_PAYLOAD_BYTES + 1 + flightModeExtraByteCount;
  const armingDisableFlagsOffset = armingDisableCountOffset + 1;
  if (armingDisableFlagsOffset + 4 > payload.byteLength) return "unknown";

  const armingDisableCount = payload[armingDisableCountOffset];
  if (armingDisableCount < 3) return "unknown";

  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const armingDisableFlags = view.getUint32(armingDisableFlagsOffset, true);
  return (armingDisableFlags & RX_LINK_LOST_ARMING_FLAGS) !== 0 ? "lost" : "ok";
}

export function createDemoTelemetry(now: number, sequence: number): FlightTelemetry {
  const seconds = now / 1000;
  const rollStickPercent = Math.sin(seconds * 1.35) * 72;
  const pitchStickPercent = Math.cos(seconds * 0.91) * 54;
  const yawStickPercent = Math.sin(seconds * 0.58 + 1.4) * 66;
  const throttleStickPercent = clamp(42 + Math.sin(seconds * 0.72) * 26 + Math.sin(seconds * 2.1) * 8, 6, 92);
  const rcThrottleUs = Math.round(1000 + throttleStickPercent * 10);
  const rcChannelsUs = [
    Math.round(1500 + rollStickPercent * 5),
    Math.round(1500 + pitchStickPercent * 5),
    Math.round(1500 + yawStickPercent * 5),
    rcThrottleUs,
  ];

  return {
    timestamp: Date.now(),
    monotonicTimestampMs: now,
    sequence,
    rollStickPercent,
    pitchStickPercent,
    yawStickPercent,
    throttleStickPercent,
    rcThrottleUs,
    rcChannelsUs,
    groundMspRssiPercent: 91 + Math.sin(seconds * 0.35) * 5,
    groundBridgeVoltage: 5 - ((seconds % 180) / 180) * 0.08,
  };
}
