"use client";

import { useMemo } from "react";
import { useBetaflightTelemetry } from "@/hooks/use-betaflight-telemetry";
import { useVideoCapture } from "@/hooks/use-video-capture";
import { clamp } from "@/lib/telemetry";

const statusCopy = {
  demo: "演示数据",
  connecting: "正在连接",
  live: "数据桥在线",
  error: "需要检查",
} as const;

function formatSigned(value: number) {
  const rounded = Math.round(value);
  return rounded > 0 ? `+${rounded}` : String(rounded);
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
  const { telemetry, throttleHistory, connection, source, error } = telemetryControl;
  const videoLabel = videoState === "live" ? "HDMI 画面在线" : videoState === "connecting" ? "正在打开视频" : "等待 HDMI 输入";
  const timecode = telemetry.timestamp ? new Date(telemetry.timestamp).toISOString().slice(11, 23) : "--:--:--.---";
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
          <span className="session-meta">SESSION <b>LOCAL / 001</b></span>
          <span className="session-meta">RATE <b>{source === "demo" ? "20 HZ" : "MSP LIVE"}</b></span>
        </div>

        <div className="top-actions">
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
              <b>{telemetry.voltage === null ? "—" : telemetry.voltage.toFixed(1)} V</b>
              <span>BATTERY</span>
            </div>
            <div className="control-fingerprint" aria-hidden="true">
              <i className="fingerprint-x" style={{ transform: `translateX(${telemetry.roll * 0.42}px)` }} />
              <i className="fingerprint-y" style={{ transform: `translateY(${-telemetry.pitch * 0.42}px)` }} />
              <span style={{ transform: `translate(${telemetry.roll * 0.42}px, ${-telemetry.pitch * 0.42}px)` }} />
            </div>
            <div className="hud hud-bottom-left">
              <span>ROLL <b>{formatSigned(telemetry.roll)}</b></span>
              <span>PITCH <b>{formatSigned(telemetry.pitch)}</b></span>
              <span>YAW <b>{formatSigned(telemetry.yaw)}</b></span>
            </div>
            <div className="throttle-ladder">
              <span>THR</span>
              <div><i style={{ height: `${telemetry.throttlePercent}%` }} /></div>
              <b>{Math.round(telemetry.throttlePercent)}%</b>
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
            <span className={`source-badge source-badge--${source}`}>{source === "demo" ? "DEMO" : "BENCH"}</span>
          </div>

          <div className="stick-grid">
            <StickPlot eyebrow="左摇杆" xLabel="YAW" yLabel="THR" x={telemetry.yaw} y={telemetry.throttlePercent * 2 - 100} tone="orange" />
            <StickPlot eyebrow="右摇杆" xLabel="ROLL" yLabel="PITCH" x={telemetry.roll} y={telemetry.pitch} tone="blue" />
          </div>

          <div className="gauge-grid">
            <Gauge label="遥控油门" value={telemetry.throttlePercent} detail={`${Math.round(telemetry.rcThrottleUs)} μs · RC 指令`} accent="orange" />
            <Gauge label="地面接收质量" value={telemetry.linkQualityPercent} detail="LOCAL LQ · 不代表机上链路" />
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
            <p>只读取 MSP_RC；桥接飞控不接电机，其输出不代表飞行器。</p>
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
          <div className="legend"><span><i className="legend-rc" />遥控油门</span><b>{Math.round(telemetry.throttlePercent)}%</b></div>
        </div>
        <ThrottleTimeline samples={throttleHistory} />
      </section>

      <footer className="dashboard-footer">
        <p><i className={`footer-light footer-light--${connection}`} />{source === "demo" ? "当前为演示数据，未连接真实飞控" : "只读 MSP 轮询，不写入 Betaflight 配置"}</p>
        <p>地面接收机 LQ ≠ 机上 LQ；真实飞行遥测仍待接入</p>
      </footer>
    </main>
  );
}
