# ELRS 地面数据桥

## 结论

飞行时不依赖机上飞控的 USB 连接。第一版正式数据路径为**每位选手一整套独立、预绑定的 Ground ELRS RX + Betaflight Bridge FC**：换人更换整套 USB Bridge，Betaflight 负责 CRSF 解码，FPVHelper 通过 USB MSP 读取通道。

## 推荐结构

```text
                                      ┌─ HDMI Receiver → UVC Capture ─┐
FPV Aircraft ── video RF ─────────────┤                               ├→ Dashboard
                                      └───────────────────────────────┘

当前选手 Radio ── ELRS control ──→ Aircraft RX → Betaflight
  │                            │
  │                            └─ CRSF telemetry → ELRS TX module
  │                                                  │
  ├─ control channels → 该选手专属 Ground ELRS RX → 专属 Bridge FC → USB MSP → FPVHelper
  └─ TX Backpack telemetry ── ESP-NOW ───────────────→ Future telemetry adapter
```

### 通道输入

每位选手使用自己的地面 ELRS 接收机输出 CRSF，并由同一专属模块内的独立 Betaflight Bridge FC 解析；FPVHelper 轮询 `MSP_RC (105)`：

- CH1–CH4：Roll、Pitch、Yaw、Throttle。
- CH5–CH16：Arm、Mode 和其他 AUX。
- 软件目标轮询频率为 100 Hz，并以单请求 lease 防止未回复请求持续堆叠；真实有效频率必须在具体 Bridge FC、USB 与俱乐部工作站上实测。
- 每套地面接收机的 telemetry 行为必须按具体硬件与固件在拆桨台架上验证；不能仅凭 Web UI 选项假定它不会与机上接收机的回传冲突。

这条路径反映发射机发出的通道值，适合操控叠层。`MSP_ANALOG` 的电压和 legacy RSSI 字段属于地面桥；地面接收机离遥控器很近，因此这些值不能代表无人机电池或机上链路质量。

### 飞行器遥测

优先从 ELRS TX Backpack 的 ESP-NOW Telemetry 获取发射模块实际收到的 CRSF 遥测：

- 上/下行 RSSI、LQ、SNR 和发射功率。
- 电池电压、电流、容量。
- Betaflight 提供的姿态、GPS 和飞行模式。

标准 Betaflight CRSF telemetry 默认不含每路电机输出。若产品确实需要电机输出，需要单独评估 MSP-over-CRSF、自定义遥测帧或飞后 Blackbox 对齐；不能把 RC throttle 伪装成 motor output。

## 开发阶段

1. 为每位选手组装并贴代号一套 ELRS RX + Betaflight Bridge FC + USB，预绑定后完成 `MSP_RC` 通道读取。
2. 逐套验证地面接收机的 telemetry 行为，并确认它不影响机上接收机、遥控链路和频谱环境。
3. 加入 TX Backpack ESP-NOW 接收，验证机上链路遥测的来源和刷新率。
4. 给每个数据包加单调时钟时间戳，与 UVC 视频采集时间做延迟标定。
5. 只有在成本、体积或批量生产需要时，再用 ESP32-S3 取代桥接飞控并设计 PCB。

## 安全边界

- Dashboard 只发送 MSP 读取请求，不写入 Betaflight 设置。
- 桥接飞控不连接 ESC 或电机；第二接收机只用于台架验证，直到其 telemetry 行为与链路影响已经实测确认。
- 不在第一版做发射机 CRSF 总线的内联设备，避免单点故障影响操控。
- 每位选手的专属地面桥必须先在拆桨台架上确认 telemetry 行为及其对机上接收机的影响，未验证前不得用于正式飞行或赛事。
- Binding phrase 不写入 Dashboard、日志或仓库。
- 视频与原始 RC 永不上传。条件式假名化产品统计的数据边界以 [`../README.md`](../README.md#离开本机的数据) 为准；书面确认、FPVSuperApp 共享项目的受限摄入路径和工程验收完成前保持关闭。
