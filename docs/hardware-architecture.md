# ELRS 地面数据桥

## 结论

飞行时不依赖机上飞控的 USB 连接。第一版正式数据路径使用一块独立的地面 Betaflight 飞控作为 ELRS Bridge：Betaflight 负责 CRSF 解码，Dashboard 通过 USB MSP 读取通道。

## 推荐结构

```text
                                      ┌─ HDMI Receiver → UVC Capture ─┐
FPV Aircraft ── video RF ─────────────┤                               ├→ Dashboard
                                      └───────────────────────────────┘

Radio ── ELRS control ──→ Aircraft RX → Betaflight
  │                            │
  │                            └─ CRSF telemetry → ELRS TX module
  │                                                  │
  ├─ control channels → Ground ELRS RX → Bridge FC → USB MSP → Dashboard
  └─ TX Backpack telemetry ── ESP-NOW ───────────────→ Future telemetry adapter
```

### 通道输入

使用一只地面 ELRS 接收机输出 CRSF，由独立 Betaflight 飞控解析；Dashboard 轮询 `MSP_RC (105)`：

- CH1–CH4：Roll、Pitch、Yaw、Throttle。
- CH5–CH16：Arm、Mode 和其他 AUX。
- 地面接收机在 Web UI 中强制关闭 telemetry，避免与机上接收机同时向发射端回传。

这条路径反映发射机发出的通道值，适合操控叠层。地面接收机离遥控器很近，因此它自己的 RSSI/LQ 不能代表无人机上的链路质量。

### 飞行器遥测

优先从 ELRS TX Backpack 的 ESP-NOW Telemetry 获取发射模块实际收到的 CRSF 遥测：

- 上/下行 RSSI、LQ、SNR 和发射功率。
- 电池电压、电流、容量。
- Betaflight 提供的姿态、GPS 和飞行模式。

标准 Betaflight CRSF telemetry 默认不含每路电机输出。若产品确实需要电机输出，需要单独评估 MSP-over-CRSF、自定义遥测帧或飞后 Blackbox 对齐；不能把 RC throttle 伪装成 motor output。

## 开发阶段

1. 用现成 ELRS RX、备用 Betaflight 飞控和 USB 完成 `MSP_RC` 通道读取。
2. 验证地面接收机关闭 telemetry 后，不影响机上接收机和遥控链路。
3. 加入 TX Backpack ESP-NOW 接收，验证机上链路遥测的来源和刷新率。
4. 给每个数据包加单调时钟时间戳，与 UVC 视频采集时间做延迟标定。
5. 只有在成本、体积或批量生产需要时，再用 ESP32-S3 取代桥接飞控并设计 PCB。

## 安全边界

- Dashboard 只发送 MSP 读取请求，不写入 Betaflight 设置。
- 桥接飞控不连接 ESC 或电机，地面接收机的 telemetry 必须关闭。
- 不在第一版做发射机 CRSF 总线的内联设备，避免单点故障影响操控。
- 第二地面接收机必须关闭 telemetry，并在拆桨台架上确认不会影响机上接收机。
- Binding phrase 不写入 Dashboard、日志或仓库。
- HDMI 和遥测均留在本地网络，除非后续明确增加录制或推流能力。
