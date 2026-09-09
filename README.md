# Yukino Desktop Pet

雪之下雪乃主题的 Windows Live2D 桌宠项目，当前基线为 `v1.4.0-rc3`。

项目包含可编辑的 Live2D/PSD 源文件、Electron 桌宠源码、68 条原创日语语音、中文字幕云、时间与区县级天气感知，以及统一的主动行为协调层。

## 快速入口

- [项目状态](PROJECT_STATUS.md)
- [应用使用与构建](app/README.md)
- [核心台词记录](DIALOGUE_REVIEW_v1.4.md)
- [全部互动说话原理](docs/雪乃桌宠_全部互动说话原理手册.txt)

## 启动

```powershell
cd app
pnpm install
pnpm start
```

## 构建

```powershell
cd app
pnpm dist
```

当前属于发布候选版本。正式分发前仍需完成长期运行验收、单实例与异常恢复、安装程序和第三方许可确认。
