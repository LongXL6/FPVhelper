interface SerialPortFilter {
  usbVendorId?: number;
  usbProductId?: number;
  bluetoothServiceClassId?: string;
}

interface SerialPortInfo {
  usbVendorId?: number;
  usbProductId?: number;
  bluetoothServiceClassId?: string;
}

interface SerialPort extends EventTarget {
  readonly connected: boolean;
  readonly readable: ReadableStream<Uint8Array> | null;
  readonly writable: WritableStream<Uint8Array> | null;
  getInfo(): SerialPortInfo;
  open(options: { baudRate: number; bufferSize?: number }): Promise<void>;
  close(): Promise<void>;
}

interface Serial extends EventTarget {
  requestPort(options?: { filters?: SerialPortFilter[] }): Promise<SerialPort>;
  getPorts(): Promise<SerialPort[]>;
  addEventListener(
    type: "connect" | "disconnect",
    listener: (event: Event) => void,
  ): void;
  removeEventListener(
    type: "connect" | "disconnect",
    listener: (event: Event) => void,
  ): void;
}

interface Navigator {
  readonly serial?: Serial;
}
