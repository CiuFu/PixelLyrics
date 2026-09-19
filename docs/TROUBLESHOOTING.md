# 故障排查

## 启动与终端

| 问题 | 处理 |
|---|---|
| `npm.ps1` 无法加载 | 使用 `npm.cmd` |
| 中文日志乱码 | `chcp 65001`，或 `npm.cmd run start:utf8` |
| 端口 19228 占用 | 结束占用的 node/electron 后再启动 |

## 汽水桥接

| 问题 | 处理 |
|---|---|
| 无 payload / 花在无歌词 | 打开汽水 **桌面歌词**；功能不要关闭 |
| 「直读组件未安装」 | 完全退出汽水 → `npm.cmd run test:soda-bridge -- --reconnect` → 再开汽水 |
| Token 不一致 | 统一使用 Electron `userData`（应用配置目录）；旧 `app/.pixellyrics-data` 仅告警、不使用 |
| 汽水升级后失效 | 重新执行 reconnect 安装 asar（主路径可能是 `Packages/<新版本>/`） |

## Halo PixelBar

| 问题 | 处理 |
|---|---|
| 未连接 / 等待设备 | 检查 USB 数据线；应用约 2s 自动扫描重连 |
| 歌词只显示前半 | 设备单包约 16 字限制；长句由循环窗口分帧显示 |
| 切歌后显示旧歌词 | 确认 MediaSession 有新曲目；日志应有 `track-changed` / `track-info` |
| 退出后仍显示歌词 | 用 **退出 PixelLyrics** 或窗口 X **确认退出**；强杀进程可能来不及还原 |
| 希望恢复原显示 | 真退出会还原接管前 scene；采集失败时回退时钟 |

## 诊断命令

```powershell
cd app
npm.cmd run test:soda-bridge -- --probe
npm.cmd run test:soda-bridge -- --listen
npm.cmd run diagnose:track-switch
npm.cmd run test:halo-reconnect
```

真机日志关键字：

```text
[soda] payload:
[pipeline] lyric received
[ticker] offset=
[halo] connected / reconnect success
[halo-ownership] releasing / restore scene
```

## 开发注意

- 改 `app/` 代码后 **重启 Electron**（先清 19228）。  
- 不要修改 `refs/` 作为运行时依赖。  
- 协议实验放 `app/tests/`，勿直接改生产 `packets.js` 除非明确变更协议。
