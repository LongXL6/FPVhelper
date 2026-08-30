"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  buildMspV1Request,
  ConnectionState,
  createDemoTelemetry,
  decodeAnalog,
  decodeMotors,
  decodeRc,
  EMPTY_TELEMETRY,
  FlightTelemetry,
  MSP,
  MspV1StreamParser,
  TelemetrySource,
} from "@/lib/telemetry";
import {
  advanceStickPeakTracker,
  appendStickMotionSample,
  createStickPeakTracker,
  EMPTY_STICK_MOTION,
  visibleStickPeak,
  type StickMotionVisualization,
} from "@/lib/stick-motion";

interface TelemetryController {
  telemetry: FlightTelemetry;
  throttleHistory: number[];
  stickMotion: StickMotionVisualization;
  connection: ConnectionState;
  source: TelemetrySource;
  error: string | null;
  serialSupported: boolean;
  connectSerial: () => Promise<void>;
  useDemo: () => Promise<void>;
}

export function useBetaflightTelemetry(): TelemetryController {
  const [telemetry, setTelemetry] = useState(EMPTY_TELEMETRY);
  const [throttleHistory, setThrottleHistory] = useState<number[]>([]);
  const [stickMotion, setStickMotion] = useState<StickMotionVisualization>(EMPTY_STICK_MOTION);
  const [connection, setConnection] = useState<ConnectionState>("demo");
  const [source, setSource] = useState<TelemetrySource>("demo");
  const [error, setError] = useState<string | null>(null);
  const portRef = useRef<SerialPort | null>(null);
  const readerRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
  const writerRef = useRef<WritableStreamDefaultWriter<Uint8Array> | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const demoTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const parserRef = useRef(new MspV1StreamParser());
  const sequenceRef = useRef(0);
  const leftPeakTrackerRef = useRef(createStickPeakTracker({ x: 0, y: -100 }));
  const rightPeakTrackerRef = useRef(createStickPeakTracker({ x: 0, y: 0 }));

  const recordStickMotion = useCallback((sample: Pick<FlightTelemetry, "rollStickPercent" | "pitchStickPercent" | "yawStickPercent" | "throttleStickPercent">, sequence: number) => {
    const left = { x: sample.yawStickPercent, y: sample.throttleStickPercent * 2 - 100 };
    const right = { x: sample.rollStickPercent, y: sample.pitchStickPercent };
    leftPeakTrackerRef.current = advanceStickPeakTracker(leftPeakTrackerRef.current, left);
    rightPeakTrackerRef.current = advanceStickPeakTracker(rightPeakTrackerRef.current, right);
    setStickMotion((current) => ({
      samples: appendStickMotionSample(current.samples, { sequence, left, right }),
      leftPeak: visibleStickPeak(leftPeakTrackerRef.current),
      rightPeak: visibleStickPeak(rightPeakTrackerRef.current),
    }));
  }, []);

  const resetStickMotion = useCallback(() => {
    leftPeakTrackerRef.current = createStickPeakTracker({ x: 0, y: -100 });
    rightPeakTrackerRef.current = createStickPeakTracker({ x: 0, y: 0 });
    setStickMotion(EMPTY_STICK_MOTION);
  }, []);

  const stopTimers = useCallback(() => {
    if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    if (demoTimerRef.current) clearInterval(demoTimerRef.current);
    pollTimerRef.current = null;
    demoTimerRef.current = null;
  }, []);

  const disconnect = useCallback(async () => {
    stopTimers();
    const reader = readerRef.current;
    const writer = writerRef.current;
    const port = portRef.current;
    readerRef.current = null;
    writerRef.current = null;
    portRef.current = null;

    try {
      await reader?.cancel();
      reader?.releaseLock();
    } catch {
      // The port can already be gone when a USB cable is removed.
    }
    try {
      writer?.releaseLock();
      await port?.close();
    } catch {
      // Closing is best-effort after a device disconnect.
    }
  }, [stopTimers]);

  const startDemo = useCallback(() => {
    stopTimers();
    resetStickMotion();
    setSource("demo");
    setConnection("demo");
    setError(null);
    demoTimerRef.current = setInterval(() => {
      sequenceRef.current += 1;
      const nextTelemetry = createDemoTelemetry(performance.now(), sequenceRef.current);
      setTelemetry(nextTelemetry);
      setThrottleHistory((current) => [...current.slice(-59), nextTelemetry.throttleStickPercent]);
      recordStickMotion(nextTelemetry, nextTelemetry.sequence);
    }, 50);
  }, [recordStickMotion, resetStickMotion, stopTimers]);

  const useDemo = useCallback(async () => {
    await disconnect();
    startDemo();
  }, [disconnect, startDemo]);

  useEffect(() => {
    demoTimerRef.current = setInterval(() => {
      sequenceRef.current += 1;
      const nextTelemetry = createDemoTelemetry(performance.now(), sequenceRef.current);
      setTelemetry(nextTelemetry);
      setThrottleHistory((current) => [...current.slice(-59), nextTelemetry.throttleStickPercent]);
      recordStickMotion(nextTelemetry, nextTelemetry.sequence);
    }, 50);
    return () => {
      stopTimers();
      void readerRef.current?.cancel();
      readerRef.current?.releaseLock();
      writerRef.current?.releaseLock();
      void portRef.current?.close();
    };
  }, [recordStickMotion, stopTimers]);

  const applyFrame = useCallback((command: number, payload: Uint8Array) => {
    const timestamp = Date.now();
    const monotonicTimestampMs = performance.now();
    if (command === MSP.RC) {
      const rc = decodeRc(payload);
      if (!rc) return;
      sequenceRef.current += 1;
      setTelemetry((current) => ({
        ...current,
        ...rc,
        timestamp,
        monotonicTimestampMs,
        sequence: sequenceRef.current,
      }));
      setThrottleHistory((current) => [...current.slice(-59), rc.throttleStickPercent]);
      recordStickMotion(rc, sequenceRef.current);
      setConnection("live");
    } else if (command === MSP.MOTOR) {
      const motors = decodeMotors(payload);
      setTelemetry((current) => ({ ...current, ...motors, timestamp, monotonicTimestampMs }));
    } else if (command === MSP.ANALOG) {
      const analog = decodeAnalog(payload);
      if (analog) setTelemetry((current) => ({ ...current, ...analog, timestamp, monotonicTimestampMs }));
    }
  }, [recordStickMotion]);

  const readLoop = useCallback(
    async (port: SerialPort) => {
      if (!port.readable) throw new Error("飞控串口不可读");
      const reader = port.readable.getReader();
      readerRef.current = reader;

      while (portRef.current === port) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        for (const frame of parserRef.current.push(value)) {
          if (!frame.error) applyFrame(frame.command, frame.payload);
        }
      }
    },
    [applyFrame],
  );

  const connectSerial = useCallback(async () => {
    if (!navigator.serial) {
      setConnection("error");
      setError("当前浏览器不支持 Web Serial，请使用桌面版 Chrome 或 Edge，并通过 HTTPS 或 localhost 打开。 ");
      return;
    }

    await disconnect();
    resetStickMotion();
    setConnection("connecting");
    setSource("serial");
    setError(null);

    try {
      const port = await navigator.serial.requestPort();
      await port.open({ baudRate: 115200, bufferSize: 4096 });
      if (!port.writable) throw new Error("飞控串口不可写");
      portRef.current = port;
      writerRef.current = port.writable.getWriter();
      parserRef.current = new MspV1StreamParser();

      let pollCount = 0;
      let writing = false;
      pollTimerRef.current = setInterval(() => {
        const writer = writerRef.current;
        if (!writer || writing) return;
        writing = true;
        pollCount += 1;
        const requests = [buildMspV1Request(MSP.RC)];
        if (pollCount % 10 === 0) requests.push(buildMspV1Request(MSP.ANALOG));
        void Promise.all(requests.map((request) => writer.write(request)))
          .catch(() => {
            setConnection("error");
            setError("飞控数据读取中断，请检查 USB 连接和串口占用。 ");
          })
          .finally(() => {
            writing = false;
          });
      }, 50);

      void readLoop(port).catch((readError: unknown) => {
        if (portRef.current !== port) return;
        setConnection("error");
        setError(readError instanceof Error ? readError.message : "飞控数据读取失败");
      });
    } catch (connectError) {
      await disconnect();
      setConnection("error");
      setError(connectError instanceof Error ? connectError.message : "无法连接飞控");
    }
  }, [disconnect, readLoop, resetStickMotion]);

  return {
    telemetry,
    throttleHistory,
    stickMotion,
    connection,
    source,
    error,
    serialSupported: typeof navigator !== "undefined" && Boolean(navigator.serial),
    connectSerial,
    useDemo,
  };
}
