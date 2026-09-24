# PixelLyrics 架构说明

面向开源贡献者与二次开发者。生产代码在 `app/`；`refs/` 仅作协议与实现参考，**不参与运行时**。

## 数据流

```text
┌─────────────────────────────────────────────┐
│ SodaMusic 桌面歌词 (desktopLyrics.asar)     │
│  inject: 读 DOM → POST 127.0.0.1:19228     │
└───────────────────┬─────────────────────────┘
                    │ token 校验
                    ▼
┌─────────────────────────────────────────────┐
│ SodaLyricsDirectService (app/src/lyrics)    │
│  HTTP bridge / asar 安装检测 / 状态         │
└───────────────────┬─────────────────────────┘
                    │ onPayload
        ┌───────────┴───────────┐
        ▼                       ▼
 MediaSession              LyricPipeline
  trackKey                    去重 / 事件
        │                       │
        ▼                       ▼
 SongStateManager ──────► DisplayStrategy
  切歌 track-info            循环窗口 / center
        │                       │
        └───────────┬───────────┘
                    ▼
              HaloClient (HID)
                    ▼
           EDIFIER Halo PixelBar
```

## 模块职责

| 模块 | 路径 | 职责 |
|---|---|---|
| 主进程接线 | `app/src/main.js` | Electron 生命周期、托盘、IPC、模块组装 |
| 汽水桥 | `app/src/lyrics/soda-lyrics-service.js` | 19228 监听、token、asar 路径、安装 |
| 汽水注入 | `app/src/lyrics/soda-lyrics-inject.js` | 桌面歌词 DOM → payload |
| 媒体会话 | `app/src/media/media-session-monitor.js` | `trackKey`（id+artist+title） |
| 切歌状态 | `app/src/media/song-state-manager.js` | 切歌清理、track-info 上屏 |
| 歌词管线 | `app/src/pipeline/lyric-pipeline.js` | 同句去重、事件 `lyric-updated`/`track-info` |
| 显示策略 | `app/src/halo/display-strategy.js` | 按显示宽度分窗；英文按完整单词滚动，超长单词按字素推进 |
| HID 协议 | `app/src/halo/packets.js` | ED 帧 `2E AA ED`、`0xE8`/`0xEF`/scene |
| HID 设备 | `app/src/halo/device.js` | 枚举、写包、重连、`0xEE` 采集 |
| 控制权 | `app/src/halo/ownership.js` | idle/active/releasing；退出还原 scene |
| UI | `app/src/ui/*` | Dashboard（预览 + 状态 + 开关） |

## 关键约束

1. **汽水桌面歌词功能必须保持开启**；只可 CSS 隐藏视觉，不可关闭该功能（否则无 payload）。  
2. **bridge token** 与 Electron `userData` 一致（应用配置目录，不入库）。  
3. **asar 主路径** 优先 `Packages/<latestVersion>/desktopLyrics.asar`（汽水小包更新）。  
4. **Halo 文本帧**最多携带 48 UTF-8 字节；布局另按约 32 个半角显示单位（约 16 个中文字符）分窗，长句由 DisplayStrategy 软件 ticker 发送，不依赖设备滚动。
5. **UI 歌词** 只消费 Pipeline 事件；`track-info` 不得当作歌词行。  
6. **切歌**：Halo 先显示「歌名 - 歌手」（center），无 `♪`；新歌词覆盖。  
7. **退出**：窗口 X / UI 退出 → 主题确认 → `HaloOwnership.release()` → 还原接管前 scene（未知则 clock fallback）。  
8. **启动** 不自动拉起汽水；仅检测进程并提示打开桌面歌词。

## HID 要点

```text
文本 0xE8: 2E AA ED E8 | len BE | 00 <utf8_len> <utf8> | checksum | pad→64
布局 0xEF center: 01 R G B 00 02 00 01 FF + checksum
场景 0xEF clock:  02 R G B 00 01 00 FF FF + checksum
查询 0xEE: 空 payload（接管前采集 display mode，尽力解析）
checksum: sum(bytes from 0xAA) & 0xFF
```

设备过滤：VID `0x2D99` PID `0xA106` iface `4` usage `0xFF14`/`1`。

## 显示策略（当前生产）

- 短句在可视宽度内时：**center** 单帧。
- 长句：按可视宽度构造循环窗口；英文优先在单词边界推进，单个超长词按字素推进，中文及其他宽字符按字素推进。
- 同句心跳 **不** 重发；新句取消旧 ticker 后启动新循环。  
- 设备滚动 marquee 在本机 PixelBar 上存在相位问题，**默认不启用** 装置滚动。

## 构建

- 开发：`npm.cmd run start:utf8`  
- 打包：`npm run build` → NSIS + portable；`asarUnpack` 含 `node-hid`、`windows-media-sessions`  
- CI：`.github/workflows/build.yml`，tag `v*` 触发 Release  

## 参考项目（refs/）

| 目录 | 用途 |
|---|---|
| `halo-pixelbar-mcp-main` | ED HID 协议（halo_core / PROTOCOL_NOTES） |
| `watch-heart-desktop-main` | 汽水 asar 注入与桥思路 |
| `HaloLyricSync-master` | ToolBox/EC 协议与歌词同步参考（非生产路径） |

贡献时请勿修改 `refs/` 作为产品逻辑；协议实验可放在 `app/tests/diagnose_*`。
