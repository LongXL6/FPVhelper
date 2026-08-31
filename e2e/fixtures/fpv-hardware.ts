import { test as base } from "@playwright/test";

export interface FakeSerialMetrics {
  requestPortCalls: number;
  openCalls: number;
  closeAttempts: number;
  closeCalls: number;
  closeRejectedWhileLocked: number;
  cancelCalls: number;
  abortCalls: number;
  readerReleaseCalls: number;
  writerReleaseCalls: number;
  pendingReads: number;
  maxPendingReads: number;
  pendingWrites: number;
  maxPendingWrites: number;
  cancelledPendingRead: boolean;
  abortedPendingWrite: boolean;
  rcResponses: number;
  statusExResponses: number;
  analogResponses: number;
  requestedCommands: number[];
  protocolErrors: string[];
  lastBaudRate: number | null;
}

export interface FakeSerialPortMetrics {
  portIndex: number;
  openCalls: number;
  closeCalls: number;
  rcResponses: number;
  requestedCommands: number[];
  rcChannelsUs: number[];
}

interface FakeSerialControl {
  holdNextWrite: () => void;
  attemptClose: () => Promise<string>;
  disconnectPort: (portIndex: number) => void;
}

declare global {
  interface Window {
    __fpvFakeSerial: FakeSerialMetrics;
    __fpvFakeSerialPorts: FakeSerialPortMetrics[];
    __fpvFakeSerialControl: FakeSerialControl;
  }
}

export const test = base.extend<{ fakeHardware: void }>({
  fakeHardware: [async ({ context }, use) => {
    await context.addInitScript(() => {
      const metrics: FakeSerialMetrics = {
        requestPortCalls: 0,
        openCalls: 0,
        closeAttempts: 0,
        closeCalls: 0,
        closeRejectedWhileLocked: 0,
        cancelCalls: 0,
        abortCalls: 0,
        readerReleaseCalls: 0,
        writerReleaseCalls: 0,
        pendingReads: 0,
        maxPendingReads: 0,
        pendingWrites: 0,
        maxPendingWrites: 0,
        cancelledPendingRead: false,
        abortedPendingWrite: false,
        rcResponses: 0,
        statusExResponses: 0,
        analogResponses: 0,
        requestedCommands: [],
        protocolErrors: [],
        lastBaudRate: null,
      };
      let holdNextWrite = false;
      window.__fpvFakeSerial = metrics;
      window.__fpvFakeSerialPorts = [
        [1_600, 1_400, 1_550, 1_250, 1_000, 1_000, 1_000, 1_000],
        [1_400, 1_600, 1_450, 1_750, 1_000, 1_000, 1_000, 1_000],
        [1_700, 1_300, 1_600, 1_500, 1_000, 1_000, 1_000, 1_000],
        [1_300, 1_700, 1_400, 1_900, 1_000, 1_000, 1_000, 1_000],
      ].map((rcChannelsUs, portIndex) => ({
        portIndex,
        openCalls: 0,
        closeCalls: 0,
        rcResponses: 0,
        requestedCommands: [],
        rcChannelsUs,
      }));
      window.localStorage.setItem(
        "fpvhelper.analytics.ingest-token.v1",
        `fpvh_ingest_${"a".repeat(43)}`,
      );
      window.localStorage.setItem("fpvhelper.onboarding.v1", "acknowledged");
      window.localStorage.setItem("fpvhelper.training-preferences.v1", JSON.stringify({
        autoExport: false,
        recordPilotVideo: false,
        showStickOverlays: true,
        stickOverlayMode: "trail",
      }));

      const mspResponse = (command: number, payload: Uint8Array) => {
        let checksum = payload.byteLength ^ command;
        for (const byte of payload) checksum ^= byte;
        return Uint8Array.of(36, 77, 62, payload.byteLength, command, ...payload, checksum);
      };

      const uint16Payload = (values: number[]) => {
        const payload = new Uint8Array(values.length * 2);
        const view = new DataView(payload.buffer);
        values.forEach((value, index) => view.setUint16(index * 2, value, true));
        return payload;
      };

      const validateReadRequest = (request: Uint8Array) => {
        const errors: string[] = [];
        if (!(request instanceof Uint8Array)) errors.push("request_not_uint8array");
        if (request.byteLength !== 6) errors.push("request_length_not_6");
        if (request[0] !== 36 || request[1] !== 77 || request[2] !== 60) errors.push("request_header_not_$M<");
        if (request[3] !== 0) errors.push("request_payload_not_empty");
        const command = request[4];
        if (command !== 105 && command !== 110 && command !== 150) errors.push("request_command_not_read_only");
        if (request[5] !== (request[3] ^ command)) errors.push("request_checksum_invalid");
        if (errors.length > 0) {
          metrics.protocolErrors.push(...errors);
          throw new TypeError(`Invalid MSP read request: ${errors.join(",")}`);
        }
        return command;
      };

      class FakeReadable {
        locked = false;
        private activeReader = false;
        private queuedResponses: Uint8Array[] = [];
        private pendingRead: ((result: ReadableStreamReadResult<Uint8Array>) => void) | null = null;

        getReader() {
          if (this.locked) throw new TypeError("Readable stream is already locked");
          this.locked = true;
          this.activeReader = true;
          return {
            read: () => {
              if (!this.activeReader) return Promise.reject(new TypeError("Reader lock was released"));
              const queued = this.queuedResponses.shift();
              if (queued) return Promise.resolve({ value: queued, done: false as const });
              metrics.pendingReads = 1;
              metrics.maxPendingReads = Math.max(metrics.maxPendingReads, metrics.pendingReads);
              return new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) => {
                this.pendingRead = resolve;
              });
            },
            cancel: async () => {
              metrics.cancelCalls += 1;
              if (this.pendingRead) {
                metrics.cancelledPendingRead = true;
                const resolve = this.pendingRead;
                this.pendingRead = null;
                metrics.pendingReads = 0;
                resolve({ value: undefined, done: true });
              }
              this.queuedResponses = [];
            },
            releaseLock: () => {
              if (!this.activeReader) throw new TypeError("Reader lock was already released");
              if (this.pendingRead) throw new TypeError("Cannot release a reader with a pending read");
              this.activeReader = false;
              this.locked = false;
              metrics.readerReleaseCalls += 1;
            },
          };
        }

        enqueue(response: Uint8Array) {
          if (!this.activeReader) throw new DOMException("Readable stream is not active", "InvalidStateError");
          if (this.pendingRead) {
            const resolve = this.pendingRead;
            this.pendingRead = null;
            metrics.pendingReads = 0;
            resolve({ value: response, done: false });
            return;
          }
          this.queuedResponses.push(response);
        }
      }

      class FakeWritable {
        locked = false;
        private activeWriter = false;
        private aborted = false;
        private pendingWrite: (() => void) | null = null;

        constructor(
          private readonly readable: FakeReadable,
          private readonly portMetrics: FakeSerialPortMetrics,
        ) {}

        getWriter() {
          if (this.locked) throw new TypeError("Writable stream is already locked");
          this.locked = true;
          this.activeWriter = true;
          return {
            write: (request: Uint8Array) => {
              if (!this.activeWriter || this.aborted) return Promise.reject(new DOMException("Writer is not active", "InvalidStateError"));
              const command = validateReadRequest(request);
              metrics.requestedCommands.push(command);
              this.portMetrics.requestedCommands.push(command);

              let payload: Uint8Array;
              if (command === 105) {
                payload = uint16Payload(this.portMetrics.rcChannelsUs);
                metrics.rcResponses += 1;
                this.portMetrics.rcResponses += 1;
              } else if (command === 150) {
                payload = new Uint8Array(21);
                payload[15] = 0;
                payload[16] = 3;
                metrics.statusExResponses += 1;
              } else {
                payload = Uint8Array.of(50, 0, 0, 132, 3);
                metrics.analogResponses += 1;
              }
              this.readable.enqueue(mspResponse(command, payload));

              if (!holdNextWrite) return Promise.resolve();
              holdNextWrite = false;
              metrics.pendingWrites = 1;
              metrics.maxPendingWrites = Math.max(metrics.maxPendingWrites, metrics.pendingWrites);
              return new Promise<void>((resolve) => {
                this.pendingWrite = resolve;
              });
            },
            abort: async () => {
              metrics.abortCalls += 1;
              this.aborted = true;
              if (this.pendingWrite) {
                metrics.abortedPendingWrite = true;
                const resolve = this.pendingWrite;
                this.pendingWrite = null;
                metrics.pendingWrites = 0;
                resolve();
              }
            },
            releaseLock: () => {
              if (!this.activeWriter) throw new TypeError("Writer lock was already released");
              if (this.pendingWrite) throw new TypeError("Cannot release a writer with a pending write");
              this.activeWriter = false;
              this.locked = false;
              metrics.writerReleaseCalls += 1;
            },
          };
        }
      }

      class FakeSerialPort {
        readable: FakeReadable | null = null;
        writable: FakeWritable | null = null;

        constructor(readonly portMetrics: FakeSerialPortMetrics) {}

        async open(options: { baudRate: number }) {
          if (this.readable || this.writable) {
            throw new DOMException("Serial port is already open", "InvalidStateError");
          }
          metrics.openCalls += 1;
          this.portMetrics.openCalls += 1;
          metrics.lastBaudRate = options.baudRate;
          this.readable = new FakeReadable();
          this.writable = new FakeWritable(this.readable, this.portMetrics);
        }

        async close() {
          metrics.closeAttempts += 1;
          if (this.readable?.locked || this.writable?.locked) {
            metrics.closeRejectedWhileLocked += 1;
            throw new DOMException("Serial streams are still locked", "InvalidStateError");
          }
          metrics.closeCalls += 1;
          this.portMetrics.closeCalls += 1;
          this.readable = null;
          this.writable = null;
        }

        getInfo() {
          return { usbVendorId: 0x0483, usbProductId: 0x5740 };
        }
      }

      const ports = window.__fpvFakeSerialPorts.map((portMetrics) => new FakeSerialPort(portMetrics));
      const authorizedPorts: FakeSerialPort[] = [];
      const disconnectListeners = new Set<EventListenerOrEventListenerObject>();
      const serial = {
        async getPorts() {
          return [...authorizedPorts];
        },
        async requestPort() {
          const portIndex = Math.min(metrics.requestPortCalls, ports.length - 1);
          const port = ports[portIndex];
          metrics.requestPortCalls += 1;
          if (!authorizedPorts.includes(port)) authorizedPorts.push(port);
          return port;
        },
        addEventListener(type: string, listener: EventListenerOrEventListenerObject | null) {
          if (type === "disconnect" && listener) disconnectListeners.add(listener);
        },
        removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null) {
          if (type === "disconnect" && listener) disconnectListeners.delete(listener);
        },
        emitDisconnect(port: FakeSerialPort) {
          const event = { target: port } as unknown as Event;
          disconnectListeners.forEach((listener) => {
            if (typeof listener === "function") listener.call(serial, event);
            else listener.handleEvent(event);
          });
        },
      };
      window.__fpvFakeSerialControl = {
        holdNextWrite: () => {
          holdNextWrite = true;
        },
        attemptClose: async () => {
          try {
            await ports[0].close();
            return "resolved";
          } catch (error) {
            return error instanceof DOMException ? error.name : "unknown_error";
          }
        },
        disconnectPort: (portIndex) => {
          const port = ports[portIndex];
          if (port) serial.emitDisconnect(port);
        },
      };

      Object.defineProperty(navigator, "serial", {
        configurable: true,
        value: serial,
      });
    });
    await use();
  }, { auto: true }],
});

export { expect } from "@playwright/test";
