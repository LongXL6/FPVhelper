# ARM 自动记录 Beta

ARM 自动记录是 FPVHelper 飞行工作台的可选 Beta 功能，默认关闭。它共用当前选手、输入画面、裁切、摇杆叠层、Session 和保存目录。代码在基于 `origin/main` `f3fbba4` 的开发工作区中验证；原工作目录与未提交改动保留。

## 运行

```sh
cd /Users/longxl/.codex/worktrees/fpvhelper-arm-auto-record
npm run dev -- --hostname 127.0.0.1 --port 3117
```

使用桌面 Chrome 或 Edge 打开 `http://localhost:3117/`。顶部「ARM 自动记录 · Beta」可展开「保存与录像设置」内的 Beta 设置。旧 `/arm-record` 地址会跳转主页。

1. 连接地面 Betaflight 数据桥，确认接收机链路正常。
2. 选择并连接 HDMI 采集卡或摄像头，确认预览画面。
3. 选择本地保存目录，填写选手代号。
4. 将录制内容设为「视频＋打杆 OSD＋数据」，打开 ARM Beta 设置。
5. 按实际遥控设置选择 AUX 和 ARM 有效区间。初始显示 AUX1 / CH5、1700–2100 μs，须核对；上限不包含在区间内。
6. 点击「启用 ARM 自动记录」，先确认一次 DISARM，再拨 ARM 开始。

## 启停规则

- 收到连续约 120 ms 的 ARM 通道数据，使用工作台原有录制流程启动遥控数据与视频记录。
- DISARM 后显示 15 秒倒计时；15 秒内重新 ARM，立即取消倒计时，保留同一段记录。
- 连续有效 DISARM 满 15 秒才结束并保存，随后继续等待下一次 ARM。
- 原有「结束记录」按钮和已启用的长按空格快捷键可结束本段并停用自动记录；「停用 ARM 自动记录」也会先结束正在记录的本段。再次自动记录需重新启用。
- 等待 ARM 时锁定选手、输入、裁切与录制内容，避免触发期间切到另一位选手；自动保存后继续留在实时工作台等待下一次 ARM。
- 数据链路失联、AUX 缺失或状态过期不是 DISARM：取消倒计时，视频继续。记录只保留实际收到的数据，数据链路中断会在最终 JSON 中标记。
- 视频设备断开或编码/写入失败时收尾并显示错误，不能将残缺视频标成完整录像。
- 停止操作等待视频写入和文件关闭，再关联同一次记录的收据并导出 JSON；快速手动停止不会在结束后启动孤立录像。

## 信号与文件边界

当前路径为 `遥控器 → 地面 ELRS RX → 地面 Betaflight 桥 → USB MSP`。ARM 取自显式配置的 RC AUX 通道，代表遥控解锁请求，不能确认飞机实际已解锁。

Betaflight 的实际 ARMED 标志可以通过 MSP_STATUS / STATUS_EX 读取，但代表**被查询的那块飞控**。地面桥不会自动获得机上飞控的 ARMED 状态；要实现机上确认，需要增加机上遥测回传入口。协议依据：[Betaflight 模式打包](https://github.com/betaflight/betaflight/blob/master/src/main/msp/msp_box.c)、[MSP 响应](https://github.com/betaflight/betaflight/blob/master/src/main/msp/msp.c)、[ELRS Backpack 遥测转发](https://www.expresslrs.org/software/mfd-crossbow/)。

视频沿用当前选手的完整或裁切画面和现有摇杆 OSD，按浏览器支持保存 MP4 或 WebM。JSON 记录原始 RC 通道和地面桥诊断数据，并关联视频文件名、字节数、叠层说明和写入收据；它不包含机上姿态、GPS、电机或电池遥测。起始时间分别记录，尚未进行帧级同步校准。

浏览器首次使用需要手动授权串口、视频输入和目录。使用期间保持页面打开。关闭页面或电脑休眠不能保证最后片段完整；当前浏览器的 IndexedDB 草稿仅是数据恢复机制，视频文件以成功写入关闭的收据为准。

## 验证入口

```sh
npm run check
npm exec playwright -- test e2e/arm-auto-record.e2e.ts --project=chromium-smoke
```

浏览器用例使用模拟串口、虚拟摄像头、真实 MediaRecorder 和浏览器本地文件存储，验证连续 DISARM 15 秒、重新 ARM、手动停止及断线处理。通过这些检查不能代替真实飞控、接收机和 HDMI 采集卡联动验收。

2026-09-06 本地验证：73 个测试文件、722 项测试及类型检查通过；Beta 的 5 个浏览器流程通过（含实际等待 15 秒、重新 ARM、人工结束、数据失联、编码器错误和旧入口重定向），原手动录像的 3 个浏览器回归通过（录制准备、完整/裁切视频、启动取消）。视频文件已验证非空、格式与收据一致且可以解码播放。

本次比赛测试版本为 `0.7.0-beta.1`。实体硬件联动尚未验证；Git 提交、CI 与托管部署的当前状态需通过对应提交和 `/version.json` 分别核验。
