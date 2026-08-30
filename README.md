# FPV Control Room

把 HDMI 飞行画面、ELRS 遥控输入和飞行遥测放在同一块本地 Dashboard 上，方便选手复盘、教练观察和赛事导播。

## 当前能力

- 通过浏览器 `getUserMedia` 打开 UVC HDMI 采集卡，并在本地显示画面。
- 通过 Web Serial 连接独立的地面桥接飞控，以只读 MSP v1 请求轮询 Betaflight：
  - `MSP_RC`：Roll / Pitch / Yaw / RC Throttle。
  - `MSP_ANALOG`：桥接飞控提供的本地接收机 RSSI / LQ 值。
- 未连接硬件时使用明确标记的演示数据。
- 不写入 Betaflight 配置，不录制或上传视频。

## 信号路径

```text
FPV Camera → Air Unit / VTX → HDMI Receiver → UVC Capture Card → Browser Video

Radio → Ground ELRS RX → Betaflight Bridge FC → USB MSP → Dashboard
```

浏览器无法直接读取电脑的 HDMI 端口；HDMI 接收端必须以 UVC 视频设备的形式出现。推荐在桌面版 Chrome 或 Edge 中通过 `localhost` 使用，这两类浏览器同时支持媒体采集和 Web Serial。

## 本地运行

```bash
npm install
npm run dev
```

打开 `http://localhost:3000`。点击“打开画面”选择 HDMI 采集卡，点击“连接桥接飞控”选择 Betaflight USB 串口。

如果 Betaflight Configurator 或其他程序占用串口，请先断开该程序。连接飞控时建议先拆下桨叶；Dashboard 本身只发送读取请求，但设备操作仍应按现场安全流程进行。

## 数据边界

- `遥控油门` 是接收机传入飞控的 RC 指令，范围按 1000–2000 μs 映射。
- 桥接飞控不接 ESC/电机，因此不读取或展示 `MSP_MOTOR`。真实飞行器电机输出仍需独立数据路径。
- 地面桥接接收机的 RSSI/LQ 不代表机上接收机的真实链路质量；机上值需要从 ELRS TX Backpack 收到的 aircraft telemetry 获取。
- 画面与遥测目前在浏览器内实时显示，但尚未做帧级时间戳校准；不能把视觉上的同时出现当成测量级同步。

飞行阶段的数据桥方案和取值边界见 [`docs/hardware-architecture.md`](docs/hardware-architecture.md)。

## 检查

```bash
npm run check
npm run build
```
