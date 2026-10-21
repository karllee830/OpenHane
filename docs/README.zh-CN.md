<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../clients/web/packages/ui/src/assets/logo-dark.png">
    <img src="../clients/web/packages/ui/src/assets/logo-light.png" width="128" height="128" alt="羽见图标">
  </picture>
</p>

<h1 align="center">羽见 · OpenHane</h1>

<p align="center"><a href="../README.md">English</a> · <b>简体中文</b></p>

<p align="center">
  自托管的语音、视频与屏幕共享，适合团队、朋友和社区使用。<br>
  服务器握在自己手里，不用注册账号，各个平台都有客户端。
</p>

<p align="center">
  <a href="https://github.com/karllee830/OpenHane/releases">下载</a> ·
  <a href="https://github.com/karllee830/OpenHane/wiki/部署指南">部署指南</a> ·
  <a href="https://github.com/karllee830/OpenHane/wiki/管理员手册">管理员手册</a> ·
  <a href="https://github.com/karllee830/OpenHane/wiki/常见问题">常见问题</a>
</p>

## 为什么选羽见

- **几分钟搭好自己的服务器**：一个 Docker 容器、一个数据卷、一个端口，不需要外部数据库，也不需要云服务账号。
- **不用注册**：填个昵称就能连接。你的身份是在自己设备上生成的密钥，管理员用权限令牌给大家分配角色。
- **屏幕共享看得清**：分辨率、帧率和码率会按共享的内容自动调整，文档和代码清晰锐利，视频和游戏流畅。
- **AI 降噪**：键盘声、狗叫、旁人说话都能去掉，在你自己的设备上运行（DeepFilterNet3）。
- **端到端加密**：可以按房间开启，也可以全服务器强制开启，声音、视频、屏幕共享和聊天都会加密。核对安全码，就能确认没有人被偷偷加进来。
- **房间与主持管理**：常驻的主会议，加上可以设密码、可以锁定的临时房间；主持人可以静音、移动、踢出和封禁，所有管理操作都有记录。
- **资源占用小**：单个 Go 程序，内置媒体服务器。20 人语音只需要大约 3 Mbps 的上行带宽。

## 下载

| 平台 | 获取方式 |
|---|---|
| macOS | 从 [Releases](https://github.com/karllee830/OpenHane/releases) 下载 `.dmg` |
| iPhone / iPad | 从 [Releases](https://github.com/karllee830/OpenHane/releases) 下载 `.ipa`；TestFlight 和 App Store 正在准备上架 |
| Windows | 从 [Releases](https://github.com/karllee830/OpenHane/releases) 下载 `OpenHane-Setup-*.exe` |
| Linux | 从 [Releases](https://github.com/karllee830/OpenHane/releases) 下载 `.AppImage` 或 `.deb` |
| Android | 即将推出 |
| 浏览器 | 直接打开服务器地址，例如 `https://meet.example.com`（Chrome、Edge、Safari、Firefox） |

## 搭建服务器

```bash
docker run -d --name openhane --restart unless-stopped \
  -p 9800:9800/tcp -p 9800:9800/udp -p 9801:9801/tcp \
  -v openhane-data:/data ghcr.io/karllee830/openhane-server:beta
```

同样的镜像也发布在 Docker Hub：`karllee830/openhane-server`。

然后：

1. 在防火墙或云服务器的安全组里放行 **9800/tcp**、**9800/udp**，以及建议放行的 **9801/tcp**。
2. 运行 `docker logs openhane`，从启动信息里复制**管理员权限令牌**（`HANE-XXXX-…`）。
3. 用任意客户端连接服务器，在 **更多 → 使用权限令牌** 里兑换令牌，你就成了管理员。

Linux 上推荐用 host 网络的 docker compose（[`deploy/`](../deploy/)）。不用 Docker 的独立程序在 [Releases](https://github.com/karllee830/OpenHane/releases) 页面下载。证书、反向代理、备份、升级和全部配置项见[部署指南](https://github.com/karllee830/OpenHane/wiki/部署指南)。

## 文档

- [部署指南](https://github.com/karllee830/OpenHane/wiki/部署指南)：安装、网络、证书、备份、监控
- [管理员手册](https://github.com/karllee830/OpenHane/wiki/管理员手册)：角色、权限令牌、房间、主持操作、封禁、邀请、设置
- [常见问题](https://github.com/karllee830/OpenHane/wiki/常见问题)：连接、声音、屏幕共享和隐私相关的问题
- [安全策略](../.github/SECURITY.md)：如何报告安全漏洞
- [Releases](https://github.com/karllee830/OpenHane/releases)：每个版本的更新内容

## 参与贡献

欢迎提交议题和拉取请求。第一次提交拉取请求时需要同意[贡献者协议](https://gist.github.com/karllee830/5236f985bd1cb302d51bd506c5e91b80)（英文）：在拉取请求的描述里勾选同意即可，只需要同意一次。

从源码构建需要 Go 1.26 和 Node 22 以上：

```bash
cd server && make test && make run
```

```bash
cd clients/web && npm install && npm test
```

苹果客户端在 [`clients/apple/`](../clients/apple/)，AI 降噪库在 [`clients/deepfilter/`](../clients/deepfilter/)（需要 [Rust](https://rustup.rs)）。

## 致谢

- 图标设计：[Kubai087](https://github.com/Kubai087)
- [LiveKit](https://github.com/livekit)
- [DeepFilterNet](https://github.com/Rikorose/DeepFilterNet)（作者 Hendrik Schröter）
- [RNNoise](https://github.com/xiph/rnnoise)

第三方组件按各自的许可证使用。

## 许可证

Copyright (C) 2026 Karl Lee ([karllee830](https://github.com/karllee830))

羽见是以 [GNU AGPL-3.0](../LICENSE) 授权的自由软件。

「羽见」「OpenHane」名称和纸鹤图标**不在 AGPL-3.0 的授权范围内，保留所有权利**。可以原样转发未经修改的官方版本，修改版必须换用其他名称和图标。详见[名称与图标声明](../TRADEMARKS.md)（英文）。
