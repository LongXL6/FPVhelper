/** Synthetic transport only. The application still owns polling, parsing and recording. */
export interface FixtureFrame {
  streamId: number;
  generation: number;
  frameIndex: number;
  requestedAtMs: number;
  plannedAtMs: number;
  generatedAtMs: number;
  deliveredAtMs: number | null;
}
export interface MeasurementHardwareSnapshot {
  timeOriginEpochMs: number;
  timeMs: number;
  frames: FixtureFrame[];
  detailed: Array<Record<string, unknown>>;
  overflowCount: number;
  protocolErrors: string[];
  ports: Array<{ streamId: number; generation: number; open: boolean; paused: boolean; requested: number; rcRequested: number; generated: number; delivered: number; opens: number; closes: number; pendingReads: number; pendingWrites: number; maxPendingReads: number; maxPendingWrites: number }>;
  media: { requests: number; tracks: Array<{ readyState: string; kind: string }> };
}
export interface MeasurementHardwareOptions { inputHz: 50 | 100; detailed: boolean; maxFrames: number; maxEvents: number }
export interface MeasurementHardwareControl {
  snapshot(): MeasurementHardwareSnapshot;
  pause(streamId: number): void;
  resume(streamId: number): void;
  disconnect(streamId: number): void;
}
export function fixtureFrameKey(channels: readonly number[]): string | null {
  if (channels.length < 8 || channels.slice(4, 8).some((value) => !Number.isInteger(value) || value < 1000 || value > 2000)) return null;
  const stream = channels[6] - 1000, generation = channels[7] - 1000;
  if (stream < 1 || stream > 2 || generation < 1) return null;
  return `${stream}:${generation}:${channels[4] - 1000 + (channels[5] - 1000) * 1001}`;
}
export function frameKey(frame: Pick<FixtureFrame, "streamId" | "generation" | "frameIndex">) {
  return `${frame.streamId}:${frame.generation}:${frame.frameIndex}`;
}

/** Self-contained because Playwright serializes this function into a fresh document. */
export function installMeasurementHardware(options: MeasurementHardwareOptions) {
  if (![50, 100].includes(options.inputHz) || !Number.isSafeInteger(options.maxFrames) || options.maxFrames < 1 || options.maxFrames > 30000 || !Number.isSafeInteger(options.maxEvents) || options.maxEvents < 1 || options.maxEvents > 200000) throw new Error("Invalid synthetic transport budget");
  const frames: FixtureFrame[] = [], detailed: Array<Record<string, unknown>> = [], protocolErrors: string[] = [];
  let overflowCount = 0, selectedPort = 0, mediaRequests = 0;
  const mediaTracks: MediaStreamTrack[] = [];
  const chunkFrames = new WeakMap<Uint8Array, FixtureFrame>();
  const record = (kind: string, data: Record<string, unknown>) => {
    if (!options.detailed) return;
    if (detailed.length < options.maxEvents) detailed.push({ kind, timeMs: performance.now(), ...data });
    else overflowCount += 1;
  };
  const error = (message: string): never => { if (protocolErrors.length < 20) protocolErrors.push(message); throw new TypeError(message); };
  const crc8 = (data: Uint8Array) => {
    let crc = 0;
    for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = ((crc << 1) ^ (crc & 0x80 ? 0xd5 : 0)) & 0xff; }
    return crc;
  };
  const response = (command: number, payload: Uint8Array, version: number) => {
    if (version === 2) {
      const body = Uint8Array.of(0, command & 255, command >> 8, payload.length & 255, payload.length >> 8, ...payload);
      return Uint8Array.of(36, 88, 62, ...body, crc8(body));
    }
    let checksum = payload.length ^ command;
    for (const byte of payload) checksum ^= byte;
    return Uint8Array.of(36, 77, 62, payload.length, command, ...payload, checksum);
  };
  const validate = (request: Uint8Array) => {
    if (!(request instanceof Uint8Array) || request[0] !== 36 || request[2] !== 60 || ![77, 88].includes(request[1])) return error("Invalid read-only MSP header");
    const version = request[1] === 88 ? 2 : 1;
    const command = version === 2 ? request[4] | request[5] << 8 : request[4];
    if (![1, 10, 105, 110, 150, 0x3006].includes(command)) return error("MSP command is outside the read-only allowlist");
    const payload = version === 2 ? request.slice(8, -1) : request.slice(5, -1);
    if (version === 2) {
      if (request[3] !== 0 || request.length !== 9 + (request[6] | request[7] << 8) || command !== 0x3006 || payload.length !== 1 || ![1, 2].includes(payload[0]) || request.at(-1) !== crc8(request.slice(3, -1))) return error("Invalid MSPv2 GET_TEXT request");
    } else if (request.length !== 6 || request[3] !== 0 || command === 0x3006 || request[5] !== command) return error("Invalid MSPv1 read request");
    return { command, payload, version };
  };
  const listeners = new Set<EventListenerOrEventListenerObject>();
  const ports = [1, 2].map((streamId) => {
    const metrics = { streamId, generation: 0, open: false, paused: false, requested: 0, rcRequested: 0, generated: 0, delivered: 0, opens: 0, closes: 0, pendingReads: 0, pendingWrites: 0, maxPendingReads: 0, maxPendingWrites: 0 };
    let active = false, frameIndex = 0, nextFrameAt = 0;
    let pendingDelay: (() => void) | null = null, pendingResume: (() => void) | null = null;
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    const release = () => { pendingDelay?.(); pendingDelay = null; pendingResume?.(); pendingResume = null; };
    const port = {
      readable: null as { readonly locked: boolean; getReader(): unknown } | null,
      writable: null as { readonly locked: boolean; getWriter(): unknown } | null,
      metrics,
      async open(settings: { baudRate: number }) {
        if (metrics.open || this.readable || this.writable) throw new DOMException("Already open", "InvalidStateError");
        if (settings.baudRate !== 115200) return error("Unexpected synthetic serial baud rate");
        active = true; metrics.open = true; metrics.paused = false; metrics.generation += 1; metrics.opens += 1; frameIndex = 0; nextFrameAt = performance.now();
        const generation = metrics.generation;
        const readable = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
        this.readable = { get locked() { return readable.locked; }, getReader() {
          const reader = readable.getReader();
          return {
            async read() {
              metrics.pendingReads += 1; metrics.maxPendingReads = Math.max(metrics.maxPendingReads, metrics.pendingReads);
              try {
                const result = await reader.read();
                if (result.value) {
                  const frame = chunkFrames.get(result.value);
                  const timeMs = performance.now();
                  if (frame) { frame.deliveredAtMs = timeMs; metrics.delivered += 1; }
                  record("chunk.delivered", { streamId, generation, bytes: result.value.length, frameIndex: frame?.frameIndex ?? null });
                }
                return result;
              } finally { metrics.pendingReads -= 1; }
            },
            cancel: () => reader.cancel(),
            releaseLock: () => reader.releaseLock(),
          };
        } };
        const writable = new WritableStream<Uint8Array>({ async write(request) {
          const { command, payload: requestPayload, version } = validate(request);
          metrics.requested += 1;
          const requestedAtMs = performance.now();
          record("request", { streamId, generation, command });
          metrics.pendingWrites += 1; metrics.maxPendingWrites = Math.max(metrics.maxPendingWrites, metrics.pendingWrites);
          try {
            let payload: Uint8Array, frame: FixtureFrame | null = null;
            if (command === 105) {
              metrics.rcRequested += 1;
              // Demand-paced earliest eligibility, not a claim that the application requested every nominal opportunity.
              const plannedAtMs = Math.max(requestedAtMs, nextFrameAt);
              if (metrics.paused) await new Promise<void>((resolve) => { pendingResume = resolve; });
              // Browsers may truncate fractional timeout values; recheck the real deadline.
              while (active && generation === metrics.generation && performance.now() < nextFrameAt) {
                await new Promise<void>((resolve) => {
                  const timer = window.setTimeout(() => { pendingDelay = null; resolve(); }, Math.max(1, nextFrameAt - performance.now()));
                  pendingDelay = () => { clearTimeout(timer); resolve(); };
                });
              }
              if (!active || generation !== metrics.generation) throw new DOMException("Synthetic source closed", "AbortError");
              const generatedAtMs = performance.now();
              nextFrameAt = generatedAtMs + 1000 / options.inputHz;
              const index = frameIndex++;
              const values = [streamId === 1 ? 1600 : 1400, 1500, 1500, streamId === 1 ? 1250 : 1750,
                1000 + index % 1001, 1000 + Math.floor(index / 1001), 1000 + streamId, 1000 + generation];
              if (values.some((value) => value > 2000)) return error("Synthetic AUX key overflow");
              payload = new Uint8Array(16); const view = new DataView(payload.buffer); values.forEach((value, i) => view.setUint16(i * 2, value, true));
              frame = { streamId, generation, frameIndex: index, requestedAtMs, plannedAtMs, generatedAtMs, deliveredAtMs: null };
              metrics.generated += 1;
              if (frames.length < options.maxFrames) frames.push(frame); else overflowCount += 1;
            } else if (command === 150) { payload = new Uint8Array(21); payload[16] = 3; }
            else if (command === 110) payload = Uint8Array.of(50, 0, 0, 132, 3);
            else if (command === 1) payload = Uint8Array.of(0, 1, 45);
            else {
              const text = new TextEncoder().encode(command === 10 || requestPayload[0] === 2 ? `SYNTH-CRAFT-${streamId}` : `SYNTH-PILOT-${streamId}`);
              payload = command === 10 ? text : Uint8Array.of(requestPayload[0], text.length, ...text);
            }
            if (!active || generation !== metrics.generation) throw new DOMException("Synthetic source closed", "AbortError");
            const chunk = response(command, payload, version);
            if (frame) chunkFrames.set(chunk, frame);
            controller!.enqueue(chunk);
          } finally { metrics.pendingWrites -= 1; }
        } });
        this.writable = { get locked() { return writable.locked; }, getWriter() {
          const writer = writable.getWriter();
          return { write: (value: Uint8Array) => writer.write(value), abort: async () => { active = false; release(); await writer.abort(); }, releaseLock: () => writer.releaseLock() };
        } };
        record("port.open", { streamId, generation });
      },
      async close() {
        if (this.readable?.locked || this.writable?.locked) throw new DOMException("Serial streams still locked", "InvalidStateError");
        active = false; release(); this.readable = null; this.writable = null; controller = null; metrics.open = false; metrics.closes += 1;
        record("port.close", { streamId, generation: metrics.generation });
      },
      getInfo: () => ({ usbVendorId: 0x0483, usbProductId: 0x5740 }),
      pause() { metrics.paused = true; record("port.pause", { streamId, generation: metrics.generation }); },
      resume() { metrics.paused = false; nextFrameAt = performance.now(); pendingResume?.(); pendingResume = null; record("port.resume", { streamId, generation: metrics.generation }); },
    };
    return port;
  });
  const authorized: typeof ports = [];
  Object.defineProperty(navigator, "serial", { configurable: true, value: {
    getPorts: async () => [...authorized],
    requestPort: async () => { const port = ports[selectedPort++ % ports.length]; if (!authorized.includes(port)) authorized.push(port); return port; },
    addEventListener: (kind: string, listener: EventListenerOrEventListenerObject) => { if (kind === "disconnect") listeners.add(listener); },
    removeEventListener: (kind: string, listener: EventListenerOrEventListenerObject) => { if (kind === "disconnect") listeners.delete(listener); },
  } });
  const originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (constraints) => { mediaRequests += 1; const stream = await originalGetUserMedia(constraints); mediaTracks.push(...stream.getTracks()); return stream; };
  Object.defineProperty(window, "showDirectoryPicker", { configurable: true, value: async () => navigator.storage.getDirectory() });
  const control: MeasurementHardwareControl = {
    snapshot: () => ({ timeOriginEpochMs: performance.timeOrigin, timeMs: performance.now(), frames, detailed, overflowCount, protocolErrors, ports: ports.map((port) => ({ ...port.metrics })), media: { requests: mediaRequests, tracks: mediaTracks.map((track) => ({ readyState: track.readyState, kind: track.kind })) } }),
    pause: (id) => { const port = ports.find((item) => item.metrics.streamId === id); if (!port) throw new Error("Unknown synthetic stream"); port.pause(); },
    resume: (id) => { const port = ports.find((item) => item.metrics.streamId === id); if (!port) throw new Error("Unknown synthetic stream"); port.resume(); },
    disconnect: (id) => { const port = ports.find((item) => item.metrics.streamId === id); if (!port) throw new Error("Unknown synthetic stream"); listeners.forEach((listener) => { const event = { target: port } as unknown as Event; if (typeof listener === "function") listener(event); else listener.handleEvent(event); }); },
  };
  (window as unknown as Window & { __fpvMeasurementHardware: MeasurementHardwareControl }).__fpvMeasurementHardware = control;
}
