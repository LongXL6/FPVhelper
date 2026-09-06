export type ArmSwitchConfig = {
  /** Zero-based AUX index: AUX 1 is channels[4]. */
  auxIndex: number;
  min: number;
  max: number;
};

export type ArmAutoRecordPhase =
  | "disabled"
  | "waiting_disarm"
  | "ready"
  | "starting"
  | "recording"
  | "stopping"
  | "error";

export type ArmAutoRecordStopReason = "disarm" | "signal_lost" | "disabled";

export type ArmAutoRecordSnapshot = {
  phase: ArmAutoRecordPhase;
  enabled: boolean;
  error: "invalid_arm_config" | "start_failed" | "stop_failed" | null;
  disarmRemainingMs: number | null;
};

export type ArmAutoRecordOptions = {
  /** Clean up partial capture before resolving false or rejecting. Honor abort during startup. */
  start: (signal: AbortSignal) => Promise<boolean>;
  stop: (reason: ArmAutoRecordStopReason) => Promise<void>;
  onState?: (snapshot: ArmAutoRecordSnapshot) => void;
  debounceMs?: number;
  signalTimeoutMs?: number;
  disarmDelayMs?: number;
};

export function isValidArmSwitchConfig(config: ArmSwitchConfig): boolean {
  return (
    Number.isInteger(config.auxIndex) &&
    config.auxIndex >= 0 &&
    config.auxIndex < 14 &&
    Number.isFinite(config.min) &&
    Number.isFinite(config.max) &&
    config.min >= 750 &&
    config.max <= 2250 &&
    config.min < config.max
  );
}

/** This detects the configured RC switch range, not the aircraft's armed state. */
export function detectArmSwitch(
  config: ArmSwitchConfig,
  channels: readonly number[],
): boolean | null {
  if (!isValidArmSwitchConfig(config)) return null;
  const value = channels[4 + config.auxIndex];
  if (!Number.isFinite(value) || value < 750 || value > 2250) return null;
  return value >= config.min && value < config.max;
}

export class ArmAutoRecordController {
  private snapshot: ArmAutoRecordSnapshot = {
    phase: "disabled",
    enabled: false,
    error: null,
    disarmRemainingMs: null,
  };
  private config: ArmSwitchConfig | null = null;
  private readonly debounceMs: number;
  private readonly signalTimeoutMs: number;
  private readonly disarmDelayMs: number;
  private lastTimestamp: number | null = null;
  private lastArrival: number | null = null;
  private candidate: boolean | null = null;
  private candidateSince = 0;
  private confirmed: boolean | null = null;
  private disarmSince: number | null = null;
  private operation: Promise<void> | null = null;
  private abortController: AbortController | null = null;
  private stopReason: ArmAutoRecordStopReason | null = null;
  private stopFailed = false;

  constructor(private readonly options: ArmAutoRecordOptions) {
    this.debounceMs = options.debounceMs ?? 120;
    this.signalTimeoutMs = options.signalTimeoutMs ?? 1000;
    this.disarmDelayMs = options.disarmDelayMs ?? 15000;
    if (
      !Number.isFinite(this.debounceMs) ||
      this.debounceMs < 0 ||
      !Number.isFinite(this.signalTimeoutMs) ||
      this.signalTimeoutMs <= this.debounceMs ||
      !Number.isFinite(this.disarmDelayMs) ||
      this.disarmDelayMs <= this.debounceMs
    ) {
      throw new Error("Invalid ARM recording timing configuration");
    }
  }

  getSnapshot(): ArmAutoRecordSnapshot {
    return { ...this.snapshot };
  }

  enable(config: ArmSwitchConfig): boolean {
    if (
      this.operation ||
      this.snapshot.phase === "recording" ||
      (this.snapshot.enabled && this.snapshot.phase !== "error")
    ) return false;
    if (!isValidArmSwitchConfig(config)) {
      this.publish("error", "invalid_arm_config", false);
      return false;
    }
    this.config = { ...config };
    this.stopFailed = false;
    this.stopReason = null;
    this.lastTimestamp = null;
    this.resetSignal();
    this.publish("waiting_disarm", null, true);
    return true;
  }

  /** Resolves after pending startup and capture cleanup, including a failed stop. */
  disable(): Promise<void> {
    this.resetSignal();
    if (this.operation || this.snapshot.phase === "recording") {
      this.requestStop("disabled");
      return this.operation ?? Promise.resolve();
    }
    this.publish(this.stopFailed ? "error" : "disabled", this.stopFailed ? "stop_failed" : null, false);
    return Promise.resolve();
  }

  /** Both timestamps must use the same monotonic clock, normally performance.now(). */
  observe(sample: { channels: readonly number[]; timestampMs: number }, nowMs: number): void {
    if (!this.snapshot.enabled || !this.config || this.stopFailed || this.snapshot.phase === "stopping") return;
    if (!Number.isFinite(sample.timestampMs) || !Number.isFinite(nowMs)) {
      this.loseSignal();
      return;
    }
    // A repeated UI snapshot cannot refresh signal freshness or advance debounce.
    if (this.lastTimestamp !== null && sample.timestampMs <= this.lastTimestamp) return;
    if (sample.timestampMs > nowMs || nowMs - sample.timestampMs >= this.signalTimeoutMs) {
      this.loseSignal();
      return;
    }
    if (
      (this.lastTimestamp !== null && sample.timestampMs - this.lastTimestamp >= this.signalTimeoutMs) ||
      (this.lastArrival !== null && (nowMs < this.lastArrival || nowMs - this.lastArrival >= this.signalTimeoutMs))
    ) this.loseSignal();
    this.lastTimestamp = sample.timestampMs;
    const armed = detectArmSwitch(this.config, sample.channels);
    if (armed === null) {
      this.loseSignal();
      return;
    }
    this.lastArrival = nowMs;
    if (this.candidate !== armed) {
      this.candidate = armed;
      this.candidateSince = sample.timestampMs;
    }
    if (this.isCaptureActive()) {
      if (armed) {
        // Even a brief return to ARM breaks a continuously DISARM interval.
        this.disarmSince = null;
        this.publish(this.snapshot.phase, this.snapshot.error, this.snapshot.enabled, null);
      } else if (sample.timestampMs - this.candidateSince >= this.debounceMs) {
        this.disarmSince ??= this.candidateSince;
        this.advanceDisarm(nowMs);
      }
      return;
    }
    if (sample.timestampMs - this.candidateSince < this.debounceMs || this.confirmed === armed) return;
    this.confirmed = armed;
    if (!armed) {
      this.publish("ready");
    } else if (this.snapshot.phase === "ready") {
      this.beginStart();
    }
  }

  tick(nowMs: number, connected: boolean): void {
    if (!this.snapshot.enabled || this.stopFailed || this.snapshot.phase === "stopping") return;
    if (
      !connected ||
      !Number.isFinite(nowMs) ||
      (this.lastArrival !== null && (nowMs < this.lastArrival || nowMs - this.lastArrival >= this.signalTimeoutMs)) ||
      (this.lastTimestamp !== null && nowMs - this.lastTimestamp >= this.signalTimeoutMs)
    ) {
      // Unknown signal must cancel the countdown before checking its deadline.
      this.loseSignal();
      return;
    }
    this.advanceDisarm(nowMs);
  }

  private publish(
    phase: ArmAutoRecordPhase,
    error: ArmAutoRecordSnapshot["error"] = null,
    enabled = this.snapshot.enabled,
    disarmRemainingMs = phase === "starting" || phase === "recording" ? this.snapshot.disarmRemainingMs : null,
  ): void {
    const previous = this.snapshot;
    this.snapshot = { phase, error, enabled, disarmRemainingMs };
    if (phase !== previous.phase || error !== previous.error || enabled !== previous.enabled || disarmRemainingMs !== previous.disarmRemainingMs) {
      this.options.onState?.(this.getSnapshot());
    }
  }

  private resetSignal(): void {
    this.lastArrival = null;
    this.candidate = null;
    this.confirmed = null;
    this.disarmSince = null;
  }

  private isCaptureActive(): boolean {
    return this.snapshot.phase === "starting" || this.snapshot.phase === "recording";
  }

  private loseSignal(): void {
    this.resetSignal();
    if (this.isCaptureActive()) {
      this.publish(this.snapshot.phase, this.snapshot.error, this.snapshot.enabled, null);
    } else {
      this.publish("waiting_disarm");
    }
  }

  private advanceDisarm(nowMs: number): void {
    if (this.disarmSince === null || !this.isCaptureActive()) return;
    const remainingMs = this.disarmDelayMs - (nowMs - this.disarmSince);
    if (remainingMs <= 0) {
      this.requestStop("disarm");
      return;
    }
    const displayedRemainingMs = Math.min(this.disarmDelayMs, Math.ceil(remainingMs / 1000) * 1000);
    this.publish(this.snapshot.phase, this.snapshot.error, this.snapshot.enabled, displayedRemainingMs);
  }

  private beginStart(): void {
    const controller = new AbortController();
    this.abortController = controller;
    this.operation = Promise.resolve().then(async () => {
      try {
        let started = false;
        try {
          started = await this.options.start(controller.signal);
        } catch {
          // Startup owns partial-resource cleanup; cancellation also gets stop below.
        }
        if (this.stopReason) {
          await this.finishStop(this.stopReason);
        } else {
          this.abortController = null;
          if (!started) this.resetSignal();
          this.publish(started ? "recording" : "error", started ? null : "start_failed");
        }
      } finally {
        this.operation = null;
      }
    });
    this.publish("starting");
  }

  private requestStop(reason: "disarm" | "disabled"): void {
    if (!this.stopReason || reason === "disabled") this.stopReason = reason;
    this.abortController?.abort();
    if (!this.operation) {
      this.operation = Promise.resolve().then(async () => {
        try {
          await this.finishStop(this.stopReason ?? reason);
        } finally {
          this.operation = null;
        }
      });
    }
    this.publish("stopping", null, reason === "disabled" ? false : this.snapshot.enabled);
  }

  private async finishStop(reason: ArmAutoRecordStopReason): Promise<void> {
    try {
      await this.options.stop(reason);
      this.resetSignal();
      this.publish(this.snapshot.enabled ? "waiting_disarm" : "disabled");
    } catch {
      this.stopFailed = true;
      this.publish("error", "stop_failed");
    } finally {
      this.abortController = null;
      this.stopReason = null;
    }
  }
}
