import { buildMspV1Request, buildMspV2GetTextRequest, MSP, type MspFrame } from "./telemetry";

export interface BetaflightDeviceNames {
  readonly pilotName: string;
  readonly craftName: string;
  readonly status: "idle" | "reading" | "ready" | "unavailable";
}

export const EMPTY_BETAFLIGHT_DEVICE_NAMES: BetaflightDeviceNames = Object.freeze({
  pilotName: "",
  craftName: "",
  status: "idle",
});

export const BETAFLIGHT_NAME_RESPONSE_TIMEOUT_MS = 600;

type NameRequestKind = "api" | "pilot" | "craft" | "legacy";

function requestCommand(kind: NameRequestKind) {
  return kind === "api" ? MSP.API_VERSION : kind === "legacy" ? MSP.NAME : MSP.GET_TEXT;
}

function decodeName(bytes: Uint8Array): string | null {
  if (bytes.length > 255) return null;
  let name = "";
  for (const byte of bytes) {
    if (byte < 0x20 || (byte >= 0x7f && byte <= 0x9f)) return null;
    // Betaflight/Configurator exchange single-byte characters, without a UTF-8 guarantee.
    name += String.fromCharCode(byte);
  }
  return name.trim();
}

/** Optional metadata reads; the caller keeps RC polling independent and supplies its monotonic clock. */
export class BetaflightNameReader {
  private snapshot = EMPTY_BETAFLIGHT_DEVICE_NAMES;
  private nextKind: NameRequestKind | null = "api";
  private pending: { kind: NameRequestKind; startedAtMs: number } | null = null;

  reset() {
    this.snapshot = EMPTY_BETAFLIGHT_DEVICE_NAMES;
    this.nextKind = "api";
    this.pending = null;
  }

  getSnapshot(): BetaflightDeviceNames {
    return this.snapshot;
  }

  nextRequest(nowMs: number): Uint8Array | null {
    if (!Number.isFinite(nowMs)) return null;
    if (this.pending) {
      if (nowMs - this.pending.startedAtMs < BETAFLIGHT_NAME_RESPONSE_TIMEOUT_MS) return null;
      this.finishRequest(null);
    }
    const kind = this.nextKind;
    if (!kind) return null;

    this.pending = { kind, startedAtMs: nowMs };
    this.updateSnapshot({ status: "reading" });
    if (kind === "api") return buildMspV1Request(MSP.API_VERSION);
    if (kind === "legacy") return buildMspV1Request(MSP.NAME);
    return buildMspV2GetTextRequest(kind === "pilot" ? 1 : 2);
  }

  acceptFrame(frame: MspFrame): void {
    const kind = this.pending?.kind;
    if (!kind || frame.command !== requestCommand(kind)) return;
    if (frame.error) {
      // GET_TEXT errors have no type to distinguish a late pilot reply from the craft request.
      if (kind !== "pilot" && kind !== "craft") this.finishRequest(null);
      return;
    }

    if (kind === "api") {
      // API_VERSION is [protocol, major, minor]; protocol=0 also supports native MSPv2.
      const supportsText = frame.payload.length === 3 && frame.payload[1] === 1 && frame.payload[2] >= 45;
      this.pending = null;
      this.nextKind = supportsText ? "pilot" : "legacy";
      return;
    }
    if (kind === "legacy") {
      this.finishRequest(decodeName(frame.payload));
      return;
    }

    const expectedType = kind === "pilot" ? 1 : 2;
    if (frame.payload[0] !== expectedType) return;
    const length = frame.payload[1];
    this.finishRequest(frame.payload.length === length + 2 ? decodeName(frame.payload.subarray(2)) : null);
  }

  private finishRequest(name: string | null) {
    const kind = this.pending?.kind;
    if (!kind) return;
    this.pending = null;
    if (kind === "api") {
      this.nextKind = "legacy";
    } else if (kind === "pilot") {
      if (name !== null) this.updateSnapshot({ pilotName: name });
      this.nextKind = "craft";
    } else if (kind === "craft" && name === null) {
      this.nextKind = "legacy";
    } else {
      if (name !== null) this.updateSnapshot({ craftName: name });
      this.nextKind = null;
      this.updateSnapshot({ status: this.snapshot.pilotName || this.snapshot.craftName ? "ready" : "unavailable" });
    }
  }

  private updateSnapshot(change: Partial<BetaflightDeviceNames>) {
    const next = { ...this.snapshot, ...change };
    if (
      next.pilotName !== this.snapshot.pilotName
      || next.craftName !== this.snapshot.craftName
      || next.status !== this.snapshot.status
    ) this.snapshot = Object.freeze(next);
  }
}
