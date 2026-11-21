# 电池标识（Battery badge）

在 DSH 侧栏底部显示这台 Mac 的电池状态，macOS 菜单栏风格。

## 显示内容

显示在**侧栏底部账号那一行的右侧**，与你的头像和昵称同一行，从左到右依次是：

```
[头像] 森度          MacBook Air M1  57%  [电池图标]
```

- **机型名**：由硬件标识（如 `MacBookAir10,1`）映射为紧凑名称 `MacBook Air M1`
- **百分比**：等宽数字
- **电池图标**：随电量填充的内联 SVG；充电时叠加闪电
- **无进度条**：保持账号行的原有高度和视觉重量

悬停可见完整信息：`MacBook Air (M1, 2020) · 57% · 剩余 12:10`。

侧栏收起为图标栏时隐藏（56px 宽度放不下文字，避免遮挡头像按钮）；徽标区域不拦截点击，账号菜单照常可用。

## 配色规则

| 状态 | 颜色 |
|---|---|
| 正常（>20%） | 跟随主题前景色 |
| 低电量（≤20%） | 黄色警告 |
| 危险（≤10%） | 红色 |
| 充电中 / 已充满 | 绿色 + 闪电图标 |

## 数据来源

| 数据 | 命令 | 权限 |
|---|---|---|
| 电量 / 充放电状态 / 剩余时间 | `/usr/bin/pmset -g batt` | 无需授权 |
| 机型标识 | `/usr/sbin/sysctl -n hw.model` | 无需授权 |

两者都是 macOS 系统自带命令，普通用户直接可读。宿主侧缓存 15 秒，前端每 60 秒轮询一次，页面隐藏时暂停。

## 隐私说明

- **不联网**：插件只注册一个本地回环路由 `GET /api/device-badge/status`，前端 `fetch` 同源请求
- **不上传**：没有任何外部网络请求
- **不写盘**：数据只在内存中缓存 15 秒，不落文件、不写日志
- **不采集唯一标识**：只读取电量、充放电状态、剩余时间、机型代号。**不读取**序列号、硬件 UUID、Provisioning UDID、Apple ID
- **回环限制**：路由拒绝非 127.0.0.1 / localhost 的请求，返回 403

> 为什么不用 `system_profiler SPHardwareDataType`：它能给出更"官方"的机型名，但同一次输出里会连带给出序列号、硬件 UUID 和 Provisioning UDID。本插件刻意避开这些唯一标识，改用 `sysctl -n hw.model` + 内置映射表，只取机型代号。

## 机型映射

内置 M1 / M2 / M3 / M4 各尺寸 MacBook Air 与 MacBook Pro，以及部分 Intel 机型。未收录的机型会显示原始标识（如 `Mac15,3`）而不是报错。

## 限制

- **仅 macOS**：电池读取依赖 `pmset`；其他平台返回 `supported: false`
- **无电池机型**（iMac / Mac mini / Mac Studio）：显示"未检测到电池"
- **剩余时间是系统估算值**：macOS 会在使用过程中动态调整，刚插拔电源时空值属正常

## 配置

无。插件没有设置项，装上即用。

## 刷新机制

状态更新走两条路径：

1. **浏览器 Battery API 事件（主）**：`navigator.getBattery()` 的 `chargingchange` / `levelchange` / `chargingtimechange` / `dischargingtimechange`。插拔电源瞬间触发，无需等待轮询。
2. **20 秒兜底轮询**：为不支持 Battery API 的浏览器，以及"剩余 1:33"这类纯时间推移准备的。

宿主侧缓存只有 1 秒，并且支持 `?fresh=1` 强制刷新，所以事件到达时能立刻拿到新数据，不会被缓存挡住。

实测：本机 Battery API 的 `level` / `charging` / `dischargingTime` 与 `pmset -g batt` 完全一致（70% / false / 4:02）。
