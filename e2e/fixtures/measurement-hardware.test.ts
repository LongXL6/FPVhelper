import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fixtureFrameKey, installMeasurementHardware, type MeasurementHardwareControl } from "./measurement-hardware";

interface TestPort {
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
}
const rc = Uint8Array.of(36, 77, 60, 0, 105, 105);
function control() { return (window as unknown as { __fpvMeasurementHardware: MeasurementHardwareControl }).__fpvMeasurementHardware; }
async function openPort() {
  const port = await (navigator as unknown as { serial: { requestPort(): Promise<TestPort> } }).serial.requestPort();
  await port.open({ baudRate: 115200 });
  return { port, reader: port.readable.getReader(), writer: port.writable.getWriter() };
}
async function closePort(connection: Awaited<ReturnType<typeof openPort>>) {
  await connection.reader.cancel(); await connection.writer.abort();
  connection.reader.releaseLock(); connection.writer.releaseLock(); await connection.port.close();
}
function decodeChannels(response: Uint8Array) {
  return Array.from({ length: 8 }, (_, index) => response[5 + index * 2] | response[6 + index * 2] << 8);
}
beforeEach(() => {
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn() }, storage: { getDirectory: vi.fn() } });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("bounded independent synthetic transport", () => {
  it("uses actual separate readers and records delivery when read resolves, not when response is generated", async () => {
    installMeasurementHardware({ inputHz: 100, detailed: false, maxFrames: 100, maxEvents: 100 });
    const connection = await openPort();
    await connection.writer.write(rc);
    expect(control().snapshot().frames[0].deliveredAtMs).toBeNull();
    const response = await connection.reader.read();
    const frame = control().snapshot().frames[0];
    expect(frame.deliveredAtMs).toBeGreaterThanOrEqual(frame.generatedAtMs);
    expect(frame.generatedAtMs).toBeGreaterThanOrEqual(frame.requestedAtMs);
    expect(fixtureFrameKey(decodeChannels(response.value!))).toBe("1:1:0");
    expect(control().snapshot().detailed).toEqual([]);
    expect(control().snapshot().ports[0]).toMatchObject({ rcRequested: 1, generated: 1, delivered: 1 });
    await closePort(connection);
    expect(control().snapshot().ports[0]).toMatchObject({ open: false, pendingReads: 0, pendingWrites: 0 });
  });
  it("allows stream 2 to deliver while stream 1 is paused, and does not merge their frame keys", async () => {
    installMeasurementHardware({ inputHz: 100, detailed: false, maxFrames: 100, maxEvents: 100 });
    const first = await openPort(), second = await openPort();
    control().pause(1);
    const firstRead = first.reader.read(), firstWrite = first.writer.write(rc);
    const secondRead = second.reader.read(); await second.writer.write(rc);
    expect(fixtureFrameKey(decodeChannels((await secondRead).value!))).toBe("2:1:0");
    expect(control().snapshot().ports[0].delivered).toBe(0);
    control().resume(1); await firstWrite;
    expect(fixtureFrameKey(decodeChannels((await firstRead).value!))).toBe("1:1:0");
    await closePort(first); await closePort(second);
  });
  it("abort releases a paused write so ordinary cleanup can close the locked streams", async () => {
    installMeasurementHardware({ inputHz: 100, detailed: false, maxFrames: 100, maxEvents: 100 });
    const connection = await openPort(); control().pause(1);
    const read = connection.reader.read();
    const write = connection.writer.write(rc).catch((error: DOMException) => error.name);
    await Promise.resolve();
    await closePort(connection);
    expect(await write).toBe("AbortError");
    expect((await read).done).toBe(true);
    expect(control().snapshot().ports[0]).toMatchObject({ open: false, pendingReads: 0, pendingWrites: 0 });
  });
  it("enforces the real source eligibility deadline while primary axes repeat", async () => {
    installMeasurementHardware({ inputHz: 100, detailed: false, maxFrames: 100, maxEvents: 100 });
    const connection = await openPort(); const samples: number[][] = [];
    for (let i = 0; i < 2; i++) { const read = connection.reader.read(); await connection.writer.write(rc); samples.push(decodeChannels((await read).value!)); }
    const frames = control().snapshot().frames;
    expect(samples[0].slice(0, 4)).toEqual(samples[1].slice(0, 4));
    expect(samples.map(fixtureFrameKey)).toEqual(["1:1:0", "1:1:1"]);
    expect(frames[1].generatedAtMs).toBeGreaterThanOrEqual(frames[0].generatedAtMs + 10);
    expect(frames[1].generatedAtMs).toBeGreaterThanOrEqual(frames[1].plannedAtMs);
    await closePort(connection);
  });
  it("fails closed on an MSP setter and retains the protocol error", async () => {
    installMeasurementHardware({ inputHz: 100, detailed: false, maxFrames: 100, maxEvents: 100 });
    const connection = await openPort();
    await expect(connection.writer.write(Uint8Array.of(36, 77, 60, 0, 200, 200))).rejects.toThrow(/allowlist/);
    expect(control().snapshot().protocolErrors).toHaveLength(1);
    await closePort(connection);
  });
  it("retains a hard bounded ledger and explicit overflow instead of silently claiming complete input", async () => {
    installMeasurementHardware({ inputHz: 100, detailed: false, maxFrames: 1, maxEvents: 100 });
    const connection = await openPort();
    for (let i = 0; i < 2; i++) { const read = connection.reader.read(); await connection.writer.write(rc); await read; }
    expect(control().snapshot()).toMatchObject({ overflowCount: 1, frames: [expect.anything()] });
    expect(control().snapshot().ports[0].delivered).toBe(2);
    await closePort(connection);
  });
  it("rejects malformed or excessive budgets before installing transports", () => {
    for (const maxFrames of [0, -1, 1.5, 30001]) expect(() => installMeasurementHardware({ inputHz: 100, detailed: false, maxFrames, maxEvents: 100 })).toThrow(/budget/);
  });
});
