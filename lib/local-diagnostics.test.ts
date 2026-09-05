import { describe, expect, it } from "vitest";
import {
  appendDiagnosticTransition,
  appendRawSerialCaptureChunk,
  buildLocalDiagnosticBundle,
  createRawSerialCaptureBlob,
  createRawSerialCaptureBuffer,
  diagnosticBundleFilename,
  MAX_DIAGNOSTIC_TRANSITIONS,
  rawSerialCaptureFilename,
  type LocalDiagnosticSnapshot,
} from "./local-diagnostics";

const snapshot: LocalDiagnosticSnapshot = {
  connection: "demo",
  source: "demo",
  linkState: "unknown",
  videoState: "idle",
  isRecording: false,
  parserQuality: "unknown",
  serialErrorCode: null,
  videoErrorCode: null,
  storageReady: true,
  storageHasError: false,
};

describe("local diagnostics", () => {
  it("records only state changes and keeps the newest 200", () => {
    let transitions = appendDiagnosticTransition([], snapshot, "2026-08-31T00:00:00.000Z");
    transitions = appendDiagnosticTransition(transitions, snapshot, "2026-08-31T00:00:01.000Z");
    expect(transitions).toHaveLength(1);

    for (let index = 0; index <= MAX_DIAGNOSTIC_TRANSITIONS; index += 1) {
      transitions = appendDiagnosticTransition(
        transitions,
        { ...snapshot, storageReady: index % 2 === 0 },
        `2026-08-31T00:00:${String(index).padStart(2, "0")}.000Z`,
      );
    }
    expect(transitions).toHaveLength(MAX_DIAGNOSTIC_TRANSITIONS);
  });

  it("builds a local-only bundle without raw bytes or personal training fields", () => {
    const bundle = buildLocalDiagnosticBundle({
      createdAt: "2026-08-31T01:02:03.456Z",
      build: "0.2.0+abcdef0",
      environment: {
        secureContext: true,
        online: true,
        serialSupported: true,
        mediaSupported: true,
        indexedDbSupported: true,
        directoryPickerSupported: true,
        fullscreenSupported: true,
        wakeLockSupported: true,
      },
      transitions: appendDiagnosticTransition([], snapshot),
    });

    expect(bundle.privacy).toMatchObject({ localOnly: true, includesRawSerialBytes: false });
    expect(bundle).not.toHaveProperty("athleteCode");
    expect(bundle).not.toHaveProperty("notes");
    expect(bundle).not.toHaveProperty("rawSerialBytes");
    expect(bundle.environment).not.toHaveProperty("userAgent");
    expect(bundle.transitions[0]).not.toHaveProperty("rcChannels");
    expect(bundle.transitions[0]).not.toHaveProperty("deviceId");
    expect(diagnosticBundleFilename(bundle.createdAt)).toBe("fpvhelper-diagnostics-2026-08-31T01-02-03-456Z.json");
    expect(rawSerialCaptureFilename(bundle.createdAt)).toBe("fpvhelper-msp-raw-2026-08-31T01-02-03-456Z.bin");
  });

  it("copies raw serial chunks and stops exactly at the local size cap", async () => {
    const source = Uint8Array.of(1, 2, 3);
    let capture = createRawSerialCaptureBuffer("2026-08-31T01:02:03.456Z");
    capture = appendRawSerialCaptureChunk(capture, source, 4);
    source[0] = 9;
    capture = appendRawSerialCaptureChunk(capture, Uint8Array.of(4, 5), 4);

    expect(capture).toMatchObject({ byteLength: 4, truncated: true });
    expect(Array.from(new Uint8Array(await createRawSerialCaptureBlob(capture).arrayBuffer()))).toEqual([1, 2, 3, 4]);
    expect(appendRawSerialCaptureChunk(capture, Uint8Array.of(6), 4)).toBe(capture);
  });
});
