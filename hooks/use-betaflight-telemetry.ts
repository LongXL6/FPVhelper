"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  buildMspV1Request,
  connectionStateAfterRcSilence,
  ConnectionState,
  createDemoTelemetry,
  decodeAnalog,
  decodeMotors,
  decodeRc,
  EMPTY_TELEMETRY,
  FlightTelemetry,
  MSP,
  MspV1StreamParser,
  RC_FIRST_FRAME_TIMEOUT_MS,
  RC_STALE_TIMEOUT_MS,
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

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function isPortSelectionCancelled(error: unknown) {
  return error instanceof DOMException && error.name === "NotFoundError";
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
  const firstFrameTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const staleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const parserRef = useRef(new MspV1StreamParser());
  const sequenceRef = useRef(0);
  const connectionAttemptRef = useRef(0);
  const demoActiveRef = useRef(false);
  const receivedRcFrameRef = useRef(false);
  const lastRcFrameAtRef = useRef<number | null>(null);
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

  const stopDemoTimer = useCallback(() => {
    demoActiveRef.current = false;
    if (demoTimerRef.current !== null) clearInterval(demoTimerRef.current);
    demoTimerRef.current = null;
  }, []);

  const stopSerialTimers = useCallback(() => {
    if (pollTimerRef.current !== null) clearInterval(pollTimerRef.current);
    if (firstFrameTimerRef.current !== null) clearTimeout(firstFrameTimerRef.current);
    if (staleTimerRef.current !== null) clearTimeout(staleTimerRef.current);
    pollTimerRef.current = null;
    firstFrameTimerRef.current = null;
    staleTimerRef.current = null;
  }, []);

  const stopTimers = useCallback(() => {
    stopDemoTimer();
    stopSerialTimers();
  }, [stopDemoTimer, stopSerialTimers]);

  const disconnect = useCallback(async () => {
    connectionAttemptRef.current += 1;
    const disconnectedAttempt = connectionAttemptRef.current;
    stopTimers();
    receivedRcFrameRef.current = false;
    lastRcFrameAtRef.current = null;
    const reader = readerRef.current;
    const writer = writerRef.current;
    const port = portRef.current;
    readerRef.current = null;
    writerRef.current = null;
    portRef.current = null;

    try {
      await reader?.cancel();
    } catch {
      // The port can already be gone when a USB cable is removed.
    } finally {
      try {
        reader?.releaseLock();
      } catch {
        // The read loop may already have released its lock.
      }
    }
    try {
      await writer?.abort();
    } catch {
      // Pending writes can already be rejected after a device disconnect.
    } finally {
      try {
        writer?.releaseLock();
      } catch {
        // The stream may already have released its lock.
      }
    }
    try {
      await port?.close();
    } catch {
      // Closing is best-effort after a device disconnect.
    }

    return disconnectedAttempt;
  }, [stopTimers]);

  const emitDemoFrame = useCallback(() => {
    if (!demoActiveRef.current) return;
    sequenceRef.current += 1;
    const nextTelemetry = createDemoTelemetry(performance.now(), sequenceRef.current);
    setTelemetry(nextTelemetry);
    setThrottleHistory((current) => [...current.slice(-59), nextTelemetry.throttleStickPercent]);
    recordStickMotion(nextTelemetry, nextTelemetry.sequence);
  }, [recordStickMotion]);

  const startDemo = useCallback(() => {
    stopTimers();
    resetStickMotion();
    setSource("demo");
    setConnection("demo");
    setError(null);
    demoActiveRef.current = true;
    emitDemoFrame();
    demoTimerRef.current = setInterval(emitDemoFrame, 50);
  }, [emitDemoFrame, resetStickMotion, stopTimers]);

  const failSerial = useCallback(async (message: string, connectionAttempt: number) => {
    if (connectionAttemptRef.current !== connectionAttempt) return;
    const recoveryAttempt = await disconnect();
    if (connectionAttemptRef.current !== recoveryAttempt) return;
    startDemo();
    setConnection("error");
    setError(message);
  }, [disconnect, startDemo]);

  const useDemo = useCallback(async () => {
    const disconnectedAttempt = await disconnect();
    if (connectionAttemptRef.current !== disconnectedAttempt) return;
    startDemo();
  }, [disconnect, startDemo]);

  useEffect(() => {
    demoActiveRef.current = true;
    demoTimerRef.current = setInterval(emitDemoFrame, 50);
    return () => {
      void disconnect();
    };
  }, [disconnect, emitDemoFrame]);

  const armStaleWatchdog = useCallback((connectionAttempt: number) => {
    if (staleTimerRef.current !== null) clearTimeout(staleTimerRef.current);

    const scheduleCheck = (delayMs: number) => {
      const staleTimer = setTimeout(() => {
        if (staleTimerRef.current !== staleTimer) return;
        if (
          connectionAttemptRef.current !== connectionAttempt ||
          portRef.current === null ||
          lastRcFrameAtRef.current === null
        ) {
          staleTimerRef.current = null;
          return;
        }

        const silenceMs = performance.now() - lastRcFrameAtRef.current;
        const nextConnection = connectionStateAfterRcSilence("live", silenceMs);
        if (nextConnection === "stale") {
          staleTimerRef.current = null;
          setConnection((current) => connectionStateAfterRcSilence(current, silenceMs));
          return;
        }

        scheduleCheck(Math.max(1, RC_STALE_TIMEOUT_MS - silenceMs));
      }, delayMs);
      staleTimerRef.current = staleTimer;
    };

    scheduleCheck(RC_STALE_TIMEOUT_MS);
  }, []);

  const applyFrame = useCallback((command: number, payload: Uint8Array, connectionAttempt: number) => {
    if (connectionAttemptRef.current !== connectionAttempt) return;
    const timestamp = Date.now();
    const monotonicTimestampMs = performance.now();
    if (command === MSP.RC) {
      const rc = decodeRc(payload);
      if (!rc) return;
      const isFirstRcFrame = !receivedRcFrameRef.current;
      receivedRcFrameRef.current = true;
      lastRcFrameAtRef.current = monotonicTimestampMs;

      if (isFirstRcFrame) {
        if (firstFrameTimerRef.current !== null) clearTimeout(firstFrameTimerRef.current);
        firstFrameTimerRef.current = null;
        stopDemoTimer();
        resetStickMotion();
        setThrottleHistory([]);
        setSource("serial");
        setError(null);
      }

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
      armStaleWatchdog(connectionAttempt);
    } else if (command === MSP.MOTOR) {
      if (!receivedRcFrameRef.current) return;
      const motors = decodeMotors(payload);
      setTelemetry((current) => ({ ...current, ...motors, timestamp, monotonicTimestampMs }));
    } else if (command === MSP.ANALOG) {
      if (!receivedRcFrameRef.current) return;
      const analog = decodeAnalog(payload);
      if (analog) setTelemetry((current) => ({ ...current, ...analog, timestamp, monotonicTimestampMs }));
    }
  }, [armStaleWatchdog, recordStickMotion, resetStickMotion, stopDemoTimer]);

  const readLoop = useCallback(
    async (port: SerialPort, connectionAttempt: number) => {
      if (!port.readable) throw new Error("飞控串口不可读");
      const reader = port.readable.getReader();
      readerRef.current = reader;

      try {
        while (portRef.current === port && connectionAttemptRef.current === connectionAttempt) {
          const { value, done } = await reader.read();
          if (done) {
            if (portRef.current === port && connectionAttemptRef.current === connectionAttempt) {
              throw new Error("飞控 USB 连接已断开");
            }
            break;
          }
          if (!value) continue;
          for (const frame of parserRef.current.push(value)) {
            if (!frame.error) applyFrame(frame.command, frame.payload, connectionAttempt);
          }
        }
      } finally {
        if (readerRef.current === reader) readerRef.current = null;
        try {
          reader.releaseLock();
        } catch {
          // Disconnect cleanup may already have released the lock.
        }
      }
    },
    [applyFrame],
  );

  const connectSerial = useCallback(async () => {
    if (!navigator.serial) {
      setSource("demo");
      setConnection("error");
      setError("当前浏览器不支持 Web Serial，请使用桌面版 Chrome 或 Edge，并通过 HTTPS 或 localhost 打开。");
      return;
    }

    const connectionAttempt = await disconnect();
    if (connectionAttemptRef.current !== connectionAttempt) return;
    startDemo();
    setConnection("connecting");
    setError(null);

    let port: SerialPort;
    try {
      port = await navigator.serial.requestPort();
    } catch (requestError) {
      if (connectionAttemptRef.current !== connectionAttempt) return;
      setConnection(isPortSelectionCancelled(requestError) ? "demo" : "error");
      setError(isPortSelectionCancelled(requestError)
        ? "未选择串口，已继续使用演示数据。"
        : `无法选择飞控串口：${errorMessage(requestError, "请重试")}`);
      return;
    }

    if (connectionAttemptRef.current !== connectionAttempt) return;

    try {
      await port.open({ baudRate: 115200, bufferSize: 4096 });
      if (connectionAttemptRef.current !== connectionAttempt) {
        try {
          await port.close();
        } catch {
          // A superseded connection may already have closed the port.
        }
        return;
      }
      portRef.current = port;
      if (!port.writable) throw new Error("飞控串口不可写");
      writerRef.current = port.writable.getWriter();
      parserRef.current = new MspV1StreamParser();
      receivedRcFrameRef.current = false;
      lastRcFrameAtRef.current = null;

      firstFrameTimerRef.current = setTimeout(() => {
        void failSerial("连接后 5 秒内未收到有效 RC 数据，已恢复演示；请检查飞控、接收机和串口占用。", connectionAttempt);
      }, RC_FIRST_FRAME_TIMEOUT_MS);

      void readLoop(port, connectionAttempt).catch((readError: unknown) => {
        void failSerial(`飞控数据读取失败：${errorMessage(readError, "请检查 USB 连接和串口占用")}`, connectionAttempt);
      });

      let pollCount = 0;
      let writing = false;
      pollTimerRef.current = setInterval(() => {
        if (connectionAttemptRef.current !== connectionAttempt) return;
        const writer = writerRef.current;
        if (!writer || writing) return;
        writing = true;
        pollCount += 1;
        const requests = [buildMspV1Request(MSP.RC)];
        if (pollCount % 10 === 0) requests.push(buildMspV1Request(MSP.ANALOG));
        void Promise.all(requests.map((request) => writer.write(request)))
          .catch((writeError: unknown) => {
            void failSerial(`飞控数据写入中断：${errorMessage(writeError, "请检查 USB 连接和串口占用")}`, connectionAttempt);
          })
          .finally(() => {
            writing = false;
          });
      }, 50);
    } catch (connectError) {
      await failSerial(`无法连接飞控：${errorMessage(connectError, "请检查 USB 连接和串口占用")}`, connectionAttempt);
    }
  }, [disconnect, failSerial, readLoop, startDemo]);

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
