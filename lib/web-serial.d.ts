interface SerialPort {
  readonly readable: ReadableStream<Uint8Array> | null;
  readonly writable: WritableStream<Uint8Array> | null;
  open(options: { baudRate: number; bufferSize?: number }): Promise<void>;
  close(): Promise<void>;
}

interface Serial {
  requestPort(options?: { filters?: Array<Record<string, number>> }): Promise<SerialPort>;
}

interface Navigator {
  readonly serial?: Serial;
}
