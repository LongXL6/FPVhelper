export type TelemetrySource = "demo" | "serial";

export type ConnectionState = "demo" | "connecting" | "live" | "stale" | "error";

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
  motors: number[];
  motorAveragePercent: number | null;
  groundMspRssiPercent: number | null;
  groundBridgeVoltage: number | null;
}

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
  STATUS: 101,
  MOTOR: 104,
  RC: 105,
  ANALOG: 110,
} as const;

export const RC_FIRST_FRAME_TIMEOUT_MS = 5_000;
export const RC_STALE_TIMEOUT_MS = 1_500;

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
  motors: [],
  motorAveragePercent: null,
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

export type ReadOnlyMspCommand = typeof MSP.RC | typeof MSP.ANALOG;

export function buildMspV1Request(command: ReadOnlyMspCommand) {
  return Uint8Array.of(36, 77, 60, 0, command, command);
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
    this.buffer.push(...chunk);
    const frames: MspFrame[] = [];

    while (this.buffer.length >= 3) {
      const start = this.findHeader();
      if (start === -1) {
        const retainedBytes = this.trailingHeaderPrefixLength();
        this.discard(this.buffer.length - retainedBytes);
        break;
      }

      if (start > 0) this.discard(start);
      if (this.buffer.length < 6) break;

      const payloadSize = this.buffer[3];
      const frameSize = payloadSize + 6;
      if (this.buffer.length < frameSize) {
        const recoveryStart = this.findValidatedFrameHeader(3);
        if (recoveryStart === -1) break;
        this.discard(recoveryStart);
        continue;
      }

      const direction = this.buffer[2];
      const command = this.buffer[4];
      const payload = Uint8Array.from(this.buffer.slice(5, 5 + payloadSize));
      const receivedChecksum = this.buffer[5 + payloadSize];
      const checksum = this.checksumAt(0);

      if (checksum !== receivedChecksum) {
        this.stats.checksumErrors += 1;
        const recoveryStart = this.findValidatedFrameHeader(1);
        this.discard(recoveryStart === -1 ? frameSize : recoveryStart);
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
        this.buffer[index + 1] === 77 &&
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
      if (this.buffer.length - start >= 6) {
        const payloadSize = this.buffer[start + 3];
        const frameSize = payloadSize + 6;
        if (
          this.buffer.length - start >= frameSize &&
          this.checksumAt(start) === this.buffer[start + 5 + payloadSize]
        ) {
          return start;
        }
      }
      start = this.findHeader(start + 1);
    }
    return -1;
  }

  private checksumAt(start: number) {
    const payloadSize = this.buffer[start + 3];
    let checksum = payloadSize ^ this.buffer[start + 4];
    for (let index = start + 5; index < start + 5 + payloadSize; index += 1) {
      checksum ^= this.buffer[index];
    }
    return checksum;
  }

  private trailingHeaderPrefixLength() {
    const length = this.buffer.length;
    if (length >= 2 && this.buffer[length - 2] === 36 && this.buffer[length - 1] === 77) return 2;
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

export function decodeMotors(payload: Uint8Array) {
  const motors = readUint16Values(payload).filter((value) => value > 0);
  if (motors.length === 0) return { motors: [], motorAveragePercent: null };

  const average = motors.reduce((sum, value) => sum + normalizeThrottle(value), 0) / motors.length;
  return { motors, motorAveragePercent: average };
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
  const motorAveragePercent = clamp(throttleStickPercent + Math.sin(seconds * 3.2) * 5, 0, 100);

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
    motors: [
      1000 + clamp(motorAveragePercent + 5, 0, 100) * 10,
      1000 + clamp(motorAveragePercent - 3, 0, 100) * 10,
      1000 + clamp(motorAveragePercent + 1, 0, 100) * 10,
      1000 + clamp(motorAveragePercent - 4, 0, 100) * 10,
    ],
    motorAveragePercent,
    groundMspRssiPercent: 91 + Math.sin(seconds * 0.35) * 5,
    groundBridgeVoltage: 5 - ((seconds % 180) / 180) * 0.08,
  };
}
