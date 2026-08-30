"use client";

import { useMemo, useState } from "react";
import {
  DraggableStickOverlay,
  storeStickOverlayLayout,
  type StickOverlayMode,
} from "@/components/draggable-stick-overlay";
import { useBetaflightTelemetry } from "@/hooks/use-betaflight-telemetry";
import { useTrainingSession } from "@/hooks/use-training-session";
import { useVideoCapture } from "@/hooks/use-video-capture";
import { clamp } from "@/lib/telemetry";

const statusCopy = {
  demo: "演示数据",
  connecting: "正在连接",
  live: "数据桥在线",
  error: "需要检查",
} as const;

const TRAIL_LEFT_STICK_LAYOUT = { xPercent: 3, yPercent: 59, size: 154 };
const TRAIL_RIGHT_STICK_LAYOUT = { xPercent: 78, yPercent: 59, size: 154 };
const SIMPLE_LEFT_STICK_LAYOUT = { xPercent: 3, yPercent: 74, size: 92 };
const SIMPLE_RIGHT_STICK_LAYOUT = { xPercent: 82, yPercent: 74, size: 92 };

function formatSigned(value: number) {
  const rounded = Math.round(value);
  return rounded > 0 ? `+${rounded}` : String(rounded);
}

function formatSessionDuration(durationMs: number) {
  const totalSeconds = Math.max(0, durationMs) / 1000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = (totalSeconds % 60).toFixed(1).padStart(4, "0");
  return `${String(minutes).padStart(2, "0")}:${seconds}`;
}

function SignalMark({ active }: { active: boolean }) {
  return (
    <span className="signal-mark" aria-hidden="true">
      {[1, 2, 3, 4].map((bar) => <i key={bar} className={active || bar === 1 ? "active" : ""} />)}
    </span>
  );
}

function StickPlot({
  eyebrow,
  xLabel,
  yLabel,
  x,
  y,
  tone,
}: {
  eyebrow: string;
  xLabel: string;
  yLabel: string;
  x: number;
  y: number;
  tone: "blue" | "orange";
}) {
  const left = `${(clamp(x, -100, 100) + 100) / 2}%`;
  const top = `${(100 - clamp(y, -100, 100)) / 2}%`;

  return (
    <section className={`stick-card stick-card--${tone}`}>
      <div className="card-heading">
        <span>{eyebrow}</span>
        <b>{formatSigned(x)}</b>
      </div>
      <div className="stick-field" aria-label={`${eyebrow}，${xLabel} ${Math.round(x)}，${yLabel} ${Math.round(y)}`}>
        <span className="axis axis-x" />
        <span className="axis axis-y" />
        <span className="stick-trace" style={{ left, top }} />
        <span className="stick-dot" style={{ left, top }} />
        <small className="axis-label axis-label-x">{xLabel}</small>
        <small className="axis-label axis-label-y">{yLabel}</small>
      </div>
      <div className="stick-values">
        <span><i />{xLabel}<b>{Math.round(x)}</b></span>
        <span><i />{yLabel}<b>{Math.round(y)}</b></span>
      </div>
    </section>
  );
}

function Gauge({ label, value, detail, accent = "blue" }: { label: string; value: number | null; detail: string; accent?: "blue" | "orange" }) {
  const safeValue = value === null ? 0 : clamp(value, 0, 100);
  const circumference = 2 * Math.PI * 44;
  const dashOffset = circumference - (safeValue / 100) * circumference;

  return (
    <section className={`gauge-card gauge-card--${accent}`}>
      <div className="gauge-ring">
        <svg viewBox="0 0 104 104" aria-hidden="true">
          <circle className="gauge-track" cx="52" cy="52" r="44" />
          <circle
            className="gauge-value"
            cx="52"
            cy="52"
            r="44"
            strokeDasharray={circumference}
            strokeDashoffset={dashOffset}
          />
        </svg>
        <strong>{value === null ? "—" : Math.round(value)}</strong>
        <small>{value === null ? "N/A" : "%"}</small>
      </div>
      <div>
        <span className="metric-label">{label}</span>
        <p>{detail}</p>
      </div>
    </section>
  );
}

function ThrottleTimeline({ samples }: { samples: number[] }) {
  const points = useMemo(() => {
    if (samples.length < 2) return "0,80 640,80";
    return samples
      .map((value, index) => `${(index / (samples.length - 1)) * 640},${96 - clamp(value, 0, 100) * 0.84}`)
      .join(" ");
  }, [samples]);

  return (
    <div className="timeline-plot" aria-label="最近三秒的油门曲线">
      <svg viewBox="0 0 640 104" preserveAspectRatio="none" aria-hidden="true">
        <line x1="0" y1="24" x2="640" y2="24" />
        <line x1="0" y1="60" x2="640" y2="60" />
        <line x1="0" y1="96" x2="640" y2="96" />
        <polyline points={points} />
      </svg>
      <div className="timeline-labels"><span>-3.0 s</span><span>现在</span></div>
    </div>
  );
}

export function FlightDashboard() {
  const [showStickOverlays, setShowStickOverlays] = useState(true);
  const [stickOverlayMode, setStickOverlayMode] = useState<StickOverlayMode>("trail");
  const telemetryControl = useBetaflightTelemetry();
  const {
    videoRef,
    devices: videoDevices,
    selectedDeviceId,
    state: videoState,
    error: videoError,
    setSelectedDeviceId,
    connect: connectVideo,
    disconnect: disconnectVideo,
  } = useVideoCapture();
  const { telemetry, throttleHistory, stickMotion, connection, source, error } = telemetryControl;
  const trainingSession = useTrainingSession(telemetry, source);
  const videoLabel = videoState === "live" ? "HDMI 画面在线" : videoState === "connecting" ? "正在打开视频" : "等待 HDMI 输入";
  const rcSourceLabel = source === "demo" ? "DEMO" : "GROUND_RC";
  const bridgeSourceLabel = source === "demo" ? "DEMO" : "GROUND_BRIDGE";
  const timecode = telemetry.timestamp ? new Date(telemetry.timestamp).toISOString().slice(11, 23) : "--:--:--.---";
  const sessionRate = trainingSession.isRecording
    ? trainingSession.sampleCount > 1 && trainingSession.elapsedMs > 0
      ? (trainingSession.sampleCount - 1) / (trainingSession.elapsedMs / 1000)
      : null
    : trainingSession.lastSession?.estimatedRcSampleRateHz ?? null;
  const sessionSources = trainingSession.isRecording
    ? rcSourceLabel
    : trainingSession.lastSession?.dataSources.map((dataSource) => dataSource === "ground_rc" ? "GROUND_RC" : "DEMO").join(" + ") ?? "—";
  const visibleSessionId = trainingSession.sessionId?.slice(0, 8).toUpperCase() ?? "READY";
  const leftStickTrail = useMemo(() => stickMotion.samples.map((sample) => sample.left), [stickMotion.samples]);
  const rightStickTrail = useMemo(() => stickMotion.samples.map((sample) => sample.right), [stickMotion.samples]);
  const leftStickLayout = stickOverlayMode === "trail" ? TRAIL_LEFT_STICK_LAYOUT : SIMPLE_LEFT_STICK_LAYOUT;
  const rightStickLayout = stickOverlayMode === "trail" ? TRAIL_RIGHT_STICK_LAYOUT : SIMPLE_RIGHT_STICK_LAYOUT;
  const leftStickStorageKey = `fpvhelper.overlay.${stickOverlayMode}.left-stick.v1`;
  const rightStickStorageKey = `fpvhelper.overlay.${stickOverlayMode}.right-stick.v1`;
  return (
    <main className="dashboard-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true"><span /><span /><span /></div>
          <div>
            <p>FPV / CONTROL ROOM</p>
            <h1>飞行操控台</h1>
          </div>
        </div>

        <div className="session-strip">
          <span className={`status-chip status-chip--${connection}`}><i />{statusCopy[connection]}</span>
          <span className="session-meta">SESSION <b>{trainingSession.isRecording ? `REC / ${visibleSessionId}` : "LOCAL / READY"}</b></span>
          <span className="session-meta">RATE <b>{source === "demo" ? "20 HZ" : "MSP LIVE"}</b></span>
        </div>

        <div className="top-actions">
          <button
            className={`button button--record ${trainingSession.isRecording ? "button--recording" : ""}`}
            type="button"
            aria-pressed={trainingSession.isRecording}
            onClick={trainingSession.isRecording ? trainingSession.stopRecording : trainingSession.startRecording}
          >
            {trainingSession.isRecording ? "■ 结束记录" : "● 开始记录"}
          </button>
          {source === "serial" ? (
            <button className="button button--quiet" onClick={() => void telemetryControl.useDemo()}>返回演示</button>
          ) : null}
          <button className="button button--primary" onClick={() => void telemetryControl.connectSerial()}>
            <span className="usb-icon">⌁</span>连接桥接飞控
          </button>
        </div>
      </header>

      {(error || videoError) && (
        <aside className="error-banner" role="status">
          <b>连接提示</b>
          <span>{error || videoError}</span>
        </aside>
      )}

      <div className="workspace-grid">
        <section className="video-console">
          <div className="section-bar">
            <div>
              <span className={`live-dot ${videoState === "live" ? "is-live" : ""}`} />
              <b>HDMI IN / MAIN FEED</b>
              <small>{videoLabel}</small>
            </div>
            <div className="video-controls">
              <label>
                <span className="sr-only">视频采集设备</span>
                <select value={selectedDeviceId} onChange={(event) => setSelectedDeviceId(event.target.value)}>
                  {videoDevices.length === 0 ? <option value="">自动选择采集卡</option> : null}
                  {videoDevices.map((device, index) => (
                    <option key={device.deviceId} value={device.deviceId}>
                      {device.label || `视频输入 ${index + 1}`}
                    </option>
                  ))}
                </select>
              </label>
              {videoState === "live" ? (
                <button className="mini-button" onClick={disconnectVideo}>断开画面</button>
              ) : (
                <button className="mini-button mini-button--active" onClick={() => void connectVideo()}>打开画面</button>
              )}
              <button
                className={`mini-button ${showStickOverlays ? "mini-button--active" : ""}`}
                type="button"
                aria-pressed={showStickOverlays}
                onClick={() => setShowStickOverlays((visible) => !visible)}
              >{showStickOverlays ? "叠层开启" : "叠层关闭"}</button>
              {showStickOverlays ? (
                <>
                  <button
                    className={`mini-button ${stickOverlayMode === "trail" ? "mini-button--active" : ""}`}
                    type="button"
                    aria-pressed={stickOverlayMode === "trail"}
                    onClick={() => setStickOverlayMode("trail")}
                  >动态轨迹</button>
                  <button
                    className={`mini-button ${stickOverlayMode === "simple" ? "mini-button--active" : ""}`}
                    type="button"
                    aria-pressed={stickOverlayMode === "simple"}
                    onClick={() => setStickOverlayMode("simple")}
                  >简洁模式</button>
                  <button
                    className="mini-button"
                    type="button"
                    onClick={() => {
                      storeStickOverlayLayout(leftStickStorageKey, leftStickLayout);
                      storeStickOverlayLayout(rightStickStorageKey, rightStickLayout);
                    }}
                  >重置叠层</button>
                </>
              ) : null}
            </div>
          </div>

          <div className={`video-stage ${videoState === "live" ? "has-video" : ""}`}>
            <video ref={videoRef} muted playsInline />
            <div className="video-idle">
              <div className="flight-gate" aria-hidden="true"><span /><span /></div>
              <p>选择 HDMI 采集卡后打开画面</p>
              <small>浏览器读取 UVC 视频设备 · 不录制 · 不上传</small>
            </div>

            <div className="hud hud-top-left">
              <span>{source === "demo" ? "SIM" : "MSP"}</span>
              <b>{source === "demo" ? "演示遥测" : "桥接飞控"}</b>
            </div>
            <div className="hud hud-top-right">
              <b>{telemetry.groundBridgeVoltage === null ? "—" : telemetry.groundBridgeVoltage.toFixed(1)} V</b>
              <span>{source === "demo" ? "DEMO BRIDGE VOLTAGE" : "GROUND BRIDGE VOLTAGE"}</span>
            </div>
            {showStickOverlays ? (
              <>
                <DraggableStickOverlay
                  storageKey={leftStickStorageKey}
                  label="左摇杆"
                  xLabel="YAW"
                  yLabel="THR"
                  x={telemetry.yawStickPercent}
                  y={telemetry.throttleStickPercent * 2 - 100}
                  tone="orange"
                  mode={stickOverlayMode}
                  trail={leftStickTrail}
                  peak={stickMotion.leftPeak}
                  defaultLayout={leftStickLayout}
                />
                <DraggableStickOverlay
                  storageKey={rightStickStorageKey}
                  label="右摇杆"
                  xLabel="ROLL"
                  yLabel="PITCH"
                  x={telemetry.rollStickPercent}
                  y={telemetry.pitchStickPercent}
                  tone="blue"
                  mode={stickOverlayMode}
                  trail={rightStickTrail}
                  peak={stickMotion.rightPeak}
                  defaultLayout={rightStickLayout}
                />
              </>
            ) : null}
            <div className="hud hud-bottom-left">
              <span>ROLL STICK <b>{formatSigned(telemetry.rollStickPercent)}</b></span>
              <span>PITCH STICK <b>{formatSigned(telemetry.pitchStickPercent)}</b></span>
              <span>YAW STICK <b>{formatSigned(telemetry.yawStickPercent)}</b></span>
            </div>
            <div className="throttle-ladder">
              <span>THR STICK</span>
              <div><i style={{ height: `${telemetry.throttleStickPercent}%` }} /></div>
              <b>{Math.round(telemetry.throttleStickPercent)}%</b>
            </div>
          </div>

          <div className="video-footer">
            <span><SignalMark active={videoState === "live"} />{videoState === "live" ? "UVC 采集正常" : "未接入采集卡"}</span>
            <span>画面与遥测在浏览器本地合成</span>
            <span className="timecode">TC {timecode}</span>
          </div>
        </section>

        <aside className="telemetry-rail">
          <div className="rail-heading">
            <div><span>CONTROL INPUT</span><h2>遥控输入</h2></div>
            <span className={`source-badge source-badge--${source}`}>{rcSourceLabel}</span>
          </div>

          <div className="stick-grid">
            <StickPlot eyebrow={`左摇杆 · ${rcSourceLabel}`} xLabel="YAW" yLabel="THR" x={telemetry.yawStickPercent} y={telemetry.throttleStickPercent * 2 - 100} tone="orange" />
            <StickPlot eyebrow={`右摇杆 · ${rcSourceLabel}`} xLabel="ROLL" yLabel="PITCH" x={telemetry.rollStickPercent} y={telemetry.pitchStickPercent} tone="blue" />
          </div>

          <div className="gauge-grid">
            <Gauge label="遥控油门指令" value={telemetry.throttleStickPercent} detail={`${Math.round(telemetry.rcThrottleUs)} μs · ${rcSourceLabel}${source === "serial" ? " / MSP_RC" : ""}`} accent="orange" />
            <Gauge label="地面桥 RSSI 字段" value={telemetry.groundMspRssiPercent} detail={`${bridgeSourceLabel} · MSP legacy RSSI · 非机上 LQ`} />
          </div>

          <section className="bridge-card">
            <div className="card-heading"><span>GROUND BRIDGE</span><b>{source === "serial" ? "MSP LIVE" : "WAIT"}</b></div>
            <div className="bridge-path">
              <div className={source === "serial" ? "is-active" : ""}><i />ELRS RX</div>
              <span>→</span>
              <div className={source === "serial" ? "is-active" : ""}><i />BETAFLIGHT</div>
              <span>→</span>
              <div className={source === "serial" ? "is-active" : ""}><i />DASHBOARD</div>
            </div>
            <p>只读 MSP_RC + MSP_ANALOG；电压与 legacy RSSI 只属于地面桥，不代表飞行器。</p>
          </section>

          <section className="link-card">
            <div>
              <span className="metric-label">AIRCRAFT TELEMETRY</span>
              <strong>未接入</strong>
            </div>
            <SignalMark active={false} />
            <p>真实机上 LQ、电池和姿态预留给 ELRS TX Backpack。</p>
          </section>
        </aside>
      </div>

      <section className="timeline-card">
        <div className="timeline-heading">
          <div><span>LIVE TRACE</span><h2>油门时间轴</h2></div>
          <div className="legend"><span><i className="legend-rc" />遥控油门指令 · {rcSourceLabel}</span><b>{Math.round(telemetry.throttleStickPercent)}%</b></div>
        </div>
        <ThrottleTimeline samples={throttleHistory} />
      </section>

      <section className={`session-card ${trainingSession.isRecording ? "session-card--recording" : ""}`}>
        <div className="session-heading">
          <div>
            <span>LOCAL SESSION RECORDER</span>
            <h2>{trainingSession.isRecording ? "正在记录遥控输入" : trainingSession.lastSession ? "最近记录可以导出" : "等待开始训练记录"}</h2>
          </div>
          <span className={`session-state ${trainingSession.isRecording ? "session-state--recording" : ""}`}>
            <i />{trainingSession.isRecording ? "REC" : trainingSession.lastSession ? "READY" : "IDLE"}
          </span>
        </div>

        <div className="session-stats">
          <span>样本数<b>{trainingSession.sampleCount.toLocaleString()}</b></span>
          <span>持续时间<b>{formatSessionDuration(trainingSession.elapsedMs)}</b></span>
          <span>估算采样率<b>{sessionRate === null ? "—" : `${sessionRate.toFixed(1)} Hz`}</b></span>
          <span>数据来源<b>{sessionSources}</b></span>
        </div>

        <div className="session-note">
          <p>记录保存在浏览器内存，JSON 仅包含打杆与地面桥数据；当前不录制视频，视频时间偏移也尚未校准。</p>
          {trainingSession.lastSession && !trainingSession.isRecording ? (
            <button className="button button--export" type="button" onClick={trainingSession.exportLastSession}>导出 Session JSON</button>
          ) : null}
        </div>
      </section>

      <footer className="dashboard-footer">
        <p><i className={`footer-light footer-light--${connection}`} />{source === "demo" ? "当前为演示数据，未连接真实飞控" : "只读 MSP 轮询，不写入 Betaflight 配置"}</p>
        <p>地面桥 MSP RSSI 字段 ≠ 机上 ELRS LQ；地面桥电压 ≠ 飞行器电池</p>
      </footer>
    </main>
  );
}
