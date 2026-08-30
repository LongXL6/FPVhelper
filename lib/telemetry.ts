export type TelemetrySource = "demo" | "serial";

export type ConnectionState = "demo" | "connecting" | "live" | "error";

export interface FlightTelemetry {
  timestamp: number;
  sequence: number;
  roll: number;
  pitch: number;
  yaw: number;
  throttlePercent: number;
  rcThrottleUs: number;
  motors: number[];
  motorAveragePercent: number | null;
  linkQualityPercent: number | null;
  voltage: number | null;
}

export interface MspFrame {
  command: number;
  payload: Uint8Array;
  error: boolean;
}

export const MSP = {
  STATUS: 101,
  MOTOR: 104,
  RC: 105,
  ANALOG: 110,
} as const;

export const EMPTY_TELEMETRY: FlightTelemetry = {
  timestamp: 0,
  sequence: 0,
  roll: 0,
  pitch: 0,
  yaw: 0,
  throttlePercent: 0,
  rcThrottleUs: 1000,
  motors: [],
  motorAveragePercent: null,
  linkQualityPercent: null,
  voltage: null,
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

export function buildMspV1Request(command: number) {
  return Uint8Array.of(36, 77, 60, 0, command, command);
}

export class MspV1StreamParser {
  private buffer: number[] = [];

  push(chunk: Uint8Array) {
    this.buffer.push(...chunk);
    const frames: MspFrame[] = [];

    while (this.buffer.length >= 6) {
      const start = this.findHeader();
      if (start === -1) {
        this.buffer = this.buffer.slice(-2);
        break;
      }

      if (start > 0) this.buffer.splice(0, start);
      if (this.buffer.length < 6) break;

      const payloadSize = this.buffer[3];
      const frameSize = payloadSize + 6;
      if (this.buffer.length < frameSize) break;

      const direction = this.buffer[2];
      const command = this.buffer[4];
      const payload = Uint8Array.from(this.buffer.slice(5, 5 + payloadSize));
      const receivedChecksum = this.buffer[5 + payloadSize];
      let checksum = payloadSize ^ command;
      for (const byte of payload) checksum ^= byte;

      this.buffer.splice(0, frameSize);
      if (checksum === receivedChecksum) {
        frames.push({ command, payload, error: direction === 33 });
      }
    }

    return frames;
  }

  private findHeader() {
    for (let index = 0; index <= this.buffer.length - 3; index += 1) {
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
    roll: normalizeRcAxis(roll),
    pitch: normalizeRcAxis(pitch),
    yaw: normalizeRcAxis(yaw),
    throttlePercent: normalizeThrottle(throttle),
    rcThrottleUs: throttle,
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
  const voltage = payload[0] / 10;
  const rawRssi = view.getUint16(3, true);

  return {
    voltage,
    linkQualityPercent: clamp((rawRssi / 1023) * 100, 0, 100),
  };
}

export function createDemoTelemetry(now: number, sequence: number): FlightTelemetry {
  const seconds = now / 1000;
  const throttlePercent = clamp(42 + Math.sin(seconds * 0.72) * 26 + Math.sin(seconds * 2.1) * 8, 6, 92);
  const rcThrottleUs = 1000 + throttlePercent * 10;
  const motorAveragePercent = clamp(throttlePercent + Math.sin(seconds * 3.2) * 5, 0, 100);

  return {
    timestamp: Date.now(),
    sequence,
    roll: Math.sin(seconds * 1.35) * 72,
    pitch: Math.cos(seconds * 0.91) * 54,
    yaw: Math.sin(seconds * 0.58 + 1.4) * 66,
    throttlePercent,
    rcThrottleUs,
    motors: [
      1000 + clamp(motorAveragePercent + 5, 0, 100) * 10,
      1000 + clamp(motorAveragePercent - 3, 0, 100) * 10,
      1000 + clamp(motorAveragePercent + 1, 0, 100) * 10,
      1000 + clamp(motorAveragePercent - 4, 0, 100) * 10,
    ],
    motorAveragePercent,
    linkQualityPercent: 91 + Math.sin(seconds * 0.35) * 5,
    voltage: 15.8 - ((seconds % 180) / 180) * 1.5,
  };
}
