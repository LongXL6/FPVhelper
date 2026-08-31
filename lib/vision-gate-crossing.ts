import type { VisionLapDirection } from "./vision-lap-evaluation";

export interface VisionGateSample {
  timestampMs: number;
  signedDistance: number;
  confidence: number;
}

export interface VisionGateCrossing {
  gateId: string;
  direction: VisionLapDirection;
  timestampMs: number;
  confidence: number;
}

export interface VisionGateCrossingConfig {
  gateId: string;
  direction: VisionLapDirection;
  confidenceThreshold: number;
  hysteresisDistance: number;
  cooldownMs: number;
}

function stableSide(distance: number, hysteresisDistance: number): -1 | 0 | 1 {
  if (distance <= -hysteresisDistance) return -1;
  if (distance >= hysteresisDistance) return 1;
  return 0;
}

function crossingTimestamp(previous: VisionGateSample, current: VisionGateSample) {
  const totalDistance = Math.abs(previous.signedDistance) + Math.abs(current.signedDistance);
  if (totalDistance === 0) return current.timestampMs;
  const fraction = Math.abs(previous.signedDistance) / totalDistance;
  return previous.timestampMs + (current.timestampMs - previous.timestampMs) * fraction;
}

export function createVisionGateCrossingDetector(config: VisionGateCrossingConfig) {
  if (!config.gateId.trim()) throw new Error("gateId 不能为空");
  if (!Number.isFinite(config.confidenceThreshold) || config.confidenceThreshold < 0 || config.confidenceThreshold > 1) {
    throw new Error("confidenceThreshold 必须在 0 至 1");
  }
  if (!Number.isFinite(config.hysteresisDistance) || config.hysteresisDistance <= 0) throw new Error("hysteresisDistance 必须大于 0");
  if (!Number.isFinite(config.cooldownMs) || config.cooldownMs < 0) throw new Error("cooldownMs 不能为负数");

  let previousStableSide: -1 | 1 | null = null;
  let previousStableSample: VisionGateSample | null = null;
  let lastEventAt = Number.NEGATIVE_INFINITY;
  let lastTimestamp = Number.NEGATIVE_INFINITY;

  return {
    push(sample: VisionGateSample): VisionGateCrossing | null {
      if (!Number.isFinite(sample.timestampMs) || sample.timestampMs < lastTimestamp) throw new Error("门检测时间戳必须单调");
      if (!Number.isFinite(sample.signedDistance)) throw new Error("signedDistance 必须是有限数值");
      if (!Number.isFinite(sample.confidence) || sample.confidence < 0 || sample.confidence > 1) throw new Error("confidence 必须在 0 至 1");
      lastTimestamp = sample.timestampMs;
      if (sample.confidence < config.confidenceThreshold) return null;

      const side = stableSide(sample.signedDistance, config.hysteresisDistance);
      if (side === 0) return null;
      if (previousStableSide === null) {
        previousStableSide = side;
        previousStableSample = sample;
        return null;
      }
      if (side === previousStableSide) {
        previousStableSample = sample;
        return null;
      }

      const direction: VisionLapDirection = previousStableSide === -1 && side === 1 ? "forward" : "reverse";
      const prior = previousStableSample;
      previousStableSide = side;
      previousStableSample = sample;
      if (!prior || direction !== config.direction) return null;
      const timestampMs = crossingTimestamp(prior, sample);
      if (timestampMs - lastEventAt < config.cooldownMs) return null;
      lastEventAt = timestampMs;
      return {
        gateId: config.gateId,
        direction,
        timestampMs,
        confidence: Math.min(prior.confidence, sample.confidence),
      };
    },
    reset() {
      previousStableSide = null;
      previousStableSample = null;
      lastEventAt = Number.NEGATIVE_INFINITY;
      lastTimestamp = Number.NEGATIVE_INFINITY;
    },
  };
}
