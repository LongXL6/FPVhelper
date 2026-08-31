"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  classifySerialError,
  serialDisconnectDecision,
  serialIssue,
  serialPreflightIssue,
  type SerialErrorCode,
  type SerialIssue,
} from "@/lib/hardware-errors";
import {
  buildMspV1Request,
  connectionStateAfterRcSilence,
  createStatusExFreshnessWatchdog,
  createDemoTelemetry,
  decodeAnalog,
  decodeRc,
  decodeStatusExLinkState,
  EMPTY_MSP_PARSER_STATS,
  EMPTY_TELEMETRY,
  MSP,
  mspParserQuality,
  MspV1StreamParser,
  RC_FIRST_FRAME_TIMEOUT_MS,
  RC_STALE_TIMEOUT_MS,
  type ConnectionState,
  type FlightTelemetry,
  type LinkState,
  type MspParserQuality,
  type MspParserStats,
  type StatusExFreshnessWatchdog,
  type TelemetrySource,
} from "@/lib/telemetry";
import {
  advanceStickPeakTracker,
  appendStickMotionSample,
  createStickPeakTracker,
  EMPTY_STICK_MOTION,
  visibleStickPeak,
  type StickMotionVisualization,
} from "@/lib/stick-motion";
import { useRawSerialCapture, type RawSerialCaptureState } from "@/hooks/use-raw-serial-capture";

export interface TelemetryController {
  telemetry: FlightTelemetry;
  throttleHistory: number[];
  stickMotion: StickMotionVisualization;
  connection: ConnectionState;
  source: TelemetrySource;
  error: string | null;
  errorCode: SerialErrorCode | null;
  parserStats: MspParserStats;
  parserQuality: MspParserQuality;
  linkState: LinkState;
  rawCapture: RawSerialCaptureState;
  serialSupported: boolean;
  connectSerial: () => Promise<void>;
  useDemo: () => Promise<void>;
  startRawCapture: () => boolean;
  cancelRawCapture: () => void;
  downloadRawCapture: () => boolean;
}

export function useBetaflightTelemetry({
  demoPlaybackActive = true,
}: {
  demoPlaybackActive?: boolean;
} = {}): TelemetryController {
  const [telemetry, setTelemetry] = useState(EMPTY_TELEMETRY);
  const [throttleHistory, setThrottleHistory] = useState<number[]>([]);
  const [stickMotion, setStickMotion] = useState<StickMotionVisualization>(EMPTY_STICK_MOTION);
  const [connection, setConnection] = useState<ConnectionState>("demo");
  const [source, setSource] = useState<TelemetrySource>("demo");
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<SerialErrorCode | null>(null);
  const [parserStats, setParserStats] = useState<MspParserStats>(EMPTY_MSP_PARSER_STATS);
  const [linkState, setLinkState] = useState<LinkState>("unknown");
  const portRef = useRef<SerialPort | null>(null);
  const readerRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
  const writerRef = useRef<WritableStreamDefaultWriter<Uint8Array> | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const demoTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const firstFrameTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const staleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statusExWatchdogRef = useRef<StatusExFreshnessWatchdog | null>(null);
  const parserRef = useRef(new MspV1StreamParser());
  const sequenceRef = useRef(0);
  const connectionAttemptRef = useRef(0);
  const demoActiveRef = useRef(false);
  const demoPlaybackActiveRef = useRef(demoPlaybackActive);
  const receivedRcFrameRef = useRef(false);
  const lastRcFrameAtRef = useRef<number | null>(null);
  const leftPeakTrackerRef = useRef(createStickPeakTracker({ x: 0, y: -100 }));
  const rightPeakTrackerRef = useRef(createStickPeakTracker({ x: 0, y: 0 }));
  const {
    capture: rawCapture,
    start: beginRawCapture,
    ingest: ingestRawCapture,
    finish: finishRawCapture,
    cancel: cancelRawCapture,
    download: downloadRawCapture,
  } = useRawSerialCapture();

  const recordStickMotion = useCallback((
    sample: Pick<
      FlightTelemetry,
      "rollStickPercent" | "pitchStickPercent" | "yawStickPercent" | "throttleStickPercent"
    >,
    sequence: number,
  ) => {
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
    statusExWatchdogRef.current?.reset();
    pollTimerRef.current = null;
    firstFrameTimerRef.current = null;
    staleTimerRef.current = null;
    statusExWatchdogRef.current = null;
  }, []);

  const stopTimers = useCallback(() => {
    stopDemoTimer();
    stopSerialTimers();
  }, [stopDemoTimer, stopSerialTimers]);

  const disconnect = useCallback(async () => {
    connectionAttemptRef.current += 1;
    const disconnectedAttempt = connectionAttemptRef.current;
    stopTimers();
    finishRawCapture("disconnected");
    receivedRcFrameRef.current = false;
    lastRcFrameAtRef.current = null;
    setLinkState("unknown");
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
      // Closing is best-effort after a physical disconnect.
    }

    return disconnectedAttempt;
  }, [finishRawCapture, stopTimers]);

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
    setErrorCode(null);
    setLinkState("unknown");
    demoActiveRef.current = true;
    emitDemoFrame();
    if (demoPlaybackActiveRef.current) {
      demoTimerRef.current = setInterval(emitDemoFrame, 50);
    } else {
      demoActiveRef.current = false;
    }
  }, [emitDemoFrame, resetStickMotion, stopTimers]);

  const failSerial = useCallback(async (issue: SerialIssue, connectionAttempt: number) => {
    if (connectionAttemptRef.current !== connectionAttempt) return;
    const recoveryAttempt = await disconnect();
    if (connectionAttemptRef.current !== recoveryAttempt) return;
    startDemo();
    setConnection("error");
    setErrorCode(issue.code);
    setError(issue.message);
  }, [disconnect, startDemo]);

  const useDemo = useCallback(async () => {
    const disconnectedAttempt = await disconnect();
    if (connectionAttemptRef.current !== disconnectedAttempt) return;
    parserRef.current.reset();
    setParserStats(EMPTY_MSP_PARSER_STATS);
    startDemo();
  }, [disconnect, startDemo]);

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
        setErrorCode(null);
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
    } else if (command === MSP.ANALOG) {
      if (!receivedRcFrameRef.current) return;
      const analog = decodeAnalog(payload);
      if (analog) {
        setTelemetry((current) => ({ ...current, ...analog, timestamp, monotonicTimestampMs }));
      }
    } else if (command === MSP.STATUS_EX) {
      setLinkState(decodeStatusExLinkState(payload));
      statusExWatchdogRef.current?.observe();
    }
  }, [armStaleWatchdog, recordStickMotion, resetStickMotion, stopDemoTimer]);

  const readLoop = useCallback(
    async (port: SerialPort, connectionAttempt: number) => {
      if (!port.readable) throw new Error("serial_not_readable");
      const reader = port.readable.getReader();
      readerRef.current = reader;

      try {
        while (portRef.current === port && connectionAttemptRef.current === connectionAttempt) {
          const { value, done } = await reader.read();
          if (done) {
            if (portRef.current === port && connectionAttemptRef.current === connectionAttempt) {
              throw new DOMException("", "NetworkError");
            }
            break;
          }
          if (!value) continue;
          ingestRawCapture(value);
          const frames = parserRef.current.push(value);
          setParserStats(parserRef.current.getStats());
          for (const frame of frames) {
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
    [applyFrame, ingestRawCapture],
  );

  const startRawCapture = useCallback(() => {
    if (source !== "serial" || connection !== "live" || portRef.current === null) return false;
    return beginRawCapture();
  }, [beginRawCapture, connection, source]);

  const connectSerial = useCallback(async () => {
    const serial = navigator.serial;
    const preflightIssue = serialPreflightIssue({
      secureContext: typeof window !== "undefined" && window.isSecureContext,
      serialSupported: Boolean(serial),
    });
    if (preflightIssue || !serial) {
      setSource("demo");
      setConnection("error");
      setErrorCode(preflightIssue?.code ?? "serial_unsupported");
      setError((preflightIssue ?? serialIssue("serial_unsupported")).message);
      return;
    }

    const portSelection = serial.requestPort().then(
      (port) => ({ port, error: null as unknown }),
      (requestError: unknown) => ({ port: null, error: requestError }),
    );

    const connectionAttempt = await disconnect();
    if (connectionAttemptRef.current !== connectionAttempt) return;
    startDemo();
    setConnection("connecting");
    setError(null);
    setErrorCode(null);

    const selection = await portSelection;
    if (!selection.port) {
      if (connectionAttemptRef.current !== connectionAttempt) return;
      const issue = classifySerialError(selection.error, "picker");
      setConnection(issue.code === "serial_picker_cancelled" ? "demo" : "error");
      setSource("demo");
      setErrorCode(issue.code);
      setError(issue.message);
      return;
    }
    const port = selection.port;

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
      if (!port.readable) {
        await failSerial(serialIssue("serial_not_readable"), connectionAttempt);
        return;
      }
      if (!port.writable) {
        await failSerial(serialIssue("serial_not_writable"), connectionAttempt);
        return;
      }
      writerRef.current = port.writable.getWriter();
      parserRef.current = new MspV1StreamParser();
      setParserStats(EMPTY_MSP_PARSER_STATS);
      receivedRcFrameRef.current = false;
      lastRcFrameAtRef.current = null;
      setLinkState("unknown");
      statusExWatchdogRef.current = createStatusExFreshnessWatchdog(() => {
        if (
          connectionAttemptRef.current === connectionAttempt &&
          portRef.current === port
        ) {
          setLinkState("unknown");
        }
      });

      firstFrameTimerRef.current = setTimeout(() => {
        void failSerial(serialIssue("serial_no_rc_frames"), connectionAttempt);
      }, RC_FIRST_FRAME_TIMEOUT_MS);

      void readLoop(port, connectionAttempt).catch((readError: unknown) => {
        void failSerial(classifySerialError(readError, "read"), connectionAttempt);
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
        if (pollCount % 2 === 0) requests.push(buildMspV1Request(MSP.STATUS_EX));
        if (pollCount % 10 === 0) requests.push(buildMspV1Request(MSP.ANALOG));
        void (async () => {
          for (const request of requests) await writer.write(request);
        })()
          .catch((writeError: unknown) => {
            void failSerial(classifySerialError(writeError, "write"), connectionAttempt);
          })
          .finally(() => {
            writing = false;
          });
      }, 50);
    } catch (connectError) {
      await failSerial(classifySerialError(connectError, "open"), connectionAttempt);
    }
  }, [disconnect, failSerial, readLoop, startDemo]);

  useEffect(() => {
    if (demoPlaybackActiveRef.current) {
      demoActiveRef.current = true;
      demoTimerRef.current = setInterval(emitDemoFrame, 50);
    }
    const serial = navigator.serial;
    const handleSerialDisconnect = (event: Event) => {
      if (serialDisconnectDecision(portRef.current, event.target as SerialPort | null) === "ignore") {
        return;
      }
      const connectionAttempt = connectionAttemptRef.current;
      setConnection("stale");
      void failSerial(serialIssue("serial_device_disconnected"), connectionAttempt);
    };
    serial?.addEventListener("disconnect", handleSerialDisconnect);
    return () => {
      serial?.removeEventListener("disconnect", handleSerialDisconnect);
      void disconnect();
    };
  }, [disconnect, emitDemoFrame, failSerial]);

  useEffect(() => {
    demoPlaybackActiveRef.current = demoPlaybackActive;
    if (source !== "demo") return;
    if (!demoPlaybackActive) {
      stopDemoTimer();
      return;
    }
    if (demoTimerRef.current !== null) return;
    demoActiveRef.current = true;
    emitDemoFrame();
    demoTimerRef.current = setInterval(emitDemoFrame, 50);
  }, [demoPlaybackActive, emitDemoFrame, source, stopDemoTimer]);

  return {
    telemetry,
    throttleHistory,
    stickMotion,
    connection,
    source,
    error,
    errorCode,
    parserStats,
    parserQuality: mspParserQuality(parserStats),
    linkState,
    rawCapture,
    serialSupported: typeof navigator !== "undefined" && Boolean(navigator.serial),
    connectSerial,
    useDemo,
    startRawCapture,
    cancelRawCapture,
    downloadRawCapture,
  };
}
