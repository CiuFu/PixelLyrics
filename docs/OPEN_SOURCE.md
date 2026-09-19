# 开源发布清单

发布前确认：

- [ ] `LICENSE` 存在（MIT）  
- [ ] `README.md` 含：功能、免责声明、安装、构建、Release  
- [ ] `docs/ARCHITECTURE.md` / `docs/TROUBLESHOOTING.md` 可用  
- [ ] `.github/workflows/build.yml` 在仓库根目录  
- [ ] `.gitignore` 忽略 `node_modules` / `dist` / `.pixellyrics-data`  
- [ ] `app/package.json` 版本号与 tag 一致（如 `0.1.0` ↔ `v0.1.0`）  
- [ ] 本地或 CI：`npm ci && npm run build` 可产出 `.exe`  
- [ ] **不要**把 `refs/` 里的第三方完整仓库当本项目源码宣传；可保留为参考并注明来源许可证  
- [ ] 不提交：token 文件、日志、`dist/`、`node_modules/`  

## 建议 tag 流程

```powershell
# 确认 app/package.json version
cd app
npm.cmd run test:display-strategy
npm.cmd run test:halo-ownership
npm.cmd run test:app-lifecycle

cd ..
git add LICENSE README.md docs .github app/package.json app/package-lock.json
git commit -m "chore: open-source docs and release prep"
git tag v0.1.0
git push origin main --tags
```

## 仓库主页建议

- 简介：汽水音乐 → EDIFIER Halo PixelBar 实时歌词  
- 徽章：License MIT、CI  
- 截图：Dashboard UI + 花在实拍（自备）  
- 置顶免责声明：非官方关联项目  

## 第三方

| 依赖 | 用途 | 许可证（以 node_modules 为准） |
|---|---|---|
| Electron | 桌面壳 | MIT |
| node-hid | Halo HID | 见包内 LICENSE |
| windows-media-sessions | 媒体会话 | 见包内 LICENSE |
| @electron/asar | 汽水 asar 读写 | MIT |
| electron-builder | 打包 | MIT |

协议参考：`refs/halo-pixelbar-mcp-main`（MIT，见其 LICENSE）。
