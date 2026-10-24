# DeadlockLingua

> 《Deadlock》聊天实时翻译：队友和对手的外语聊天自动译成中文，**译文直接显示在原消息下面**，不用切出游戏，也不用第二个窗口。

`GPL-3.0` · `v2.1.0` · Windows 10/11 · Node.js 18+ · 基于 [BabelTower](https://github.com/c1375rick/BabelTower) 二次开发，由 [Thirt927](https://github.com/Thirt927) 维护

[简体中文](README.md) · [English](README_EN.md)

## 目录

- [简介](#简介)
- [安装](#安装)
- [使用](#使用)
- [配置与接口](#配置与接口)
- [技术说明](#技术说明)
- [常见问题](#常见问题)
- [开发](#开发)

## 简介

DeadlockLingua 由两部分组成：

- **游戏内模组**（Panorama）：扫描聊天、请求翻译，并把译文插回原消息下方。
- **本地桥**（Node.js，只监听 `127.0.0.1:8791`）：调用翻译服务商，并通过 **BTIPC** 双向信道把译文送回游戏。

v2.1.0 起译文重新显示在游戏内，设置面板也回到游戏内（ESC 菜单「翻译设置」，或聊天框输入 `/tr`）。v2.0.x 的悬浮窗方案保留在仓库中作为备选，可在设置里切换。

## 功能

**看别人说什么**

- 译文直接显示在原消息下面；HUD 顶栏气泡、大厅聊天记录同样支持
- 已是中文的消息、纯数字/符号、`/` 开头的指令自动跳过

**说你想说的话**

- 发送前翻译：输入中文回车，先译成英文再走原版发送链路
- 显示模式可选「仅译文」或「原文 + 译文」

**翻译能力**

- 5 个服务商：Bing（免 Key）、Microsoft、OpenAI 兼容（DeepSeek 等）、DeepL、Google Cloud
- 主服务商超时或失败时自动回退到备用服务商
- 内置术语表：42 个可玩英雄、194 件商店装备、常用战术术语
- 自适应词典：高频短句自动固化，秒回不再请求服务商

**其他**

- 聊天日志按对局写入 JSONL，便于赛后复盘
- SteamID 被动回填（昵称 → SteamID64）
- 游戏外悬浮窗（v2.0.x 方案）保留可用

## 安装

1. 下载最新版，解压到**无空格、无中文**的路径（如 `D:\DeadlockLingua`）：
   <https://github.com/Thirt927/DeadlockLingua/releases/latest>

2. **给 Deadlock 加 `-condebug` 启动参数（必做，只需设置一次）**

   Steam 库 → Deadlock 右键 → 属性 → 常规 → **启动选项**，填：

   ```text
   -condebug
   ```

   游戏不带它就不会写 `game/citadel/console.log`，而那是请求送出、译文回来的唯一通路；缺了它 mod 会表现为「装了完全没反应」。

3. **把 VPK 放进 addons**

   - 包里的 `pak01_dir.vpk` 先改名（不与 addons 内已有文件重名即可），推荐 `pak22_dir.vpk`
   - 只能放 `game/citadel/addons/`；不要用 `pak01` 这个名字（与游戏本体冲突），也不要放到 `citadel/` 根目录（会覆盖游戏资源）
   - 推荐用 Deadlock Mod Manager 导入，或手动复制到：
     `<Steam 库>\steamapps\common\Deadlock\game\citadel\addons\`

4. **启动本地桥（二选一）**

   - `install-autostart.bat`：装成开机自启（推荐）
   - `StartBridgeSilent.vbs`：临时后台启动

5. **重启 Deadlock**

> [!TIP]
> `StartDeadlock.bat` 可以在启动桥的同时用 Steam 拉起游戏（`StartDeadlock.bat -game`）；`-condebug` 仍以游戏的启动选项为准。

## 使用

### 看译文

进对局即可。别人说外语时，译文会出现在那条消息下方（浅蓝底、斜体）。

- 单条约 **2～6 秒**（位信道有效带宽约 16 字节/秒，是当前通道的上限）
- 聊天滚动回收后，译文会从缓存自动重建

一直不出现译文时，按顺序检查：

1. 启动选项里有没有 `-condebug`（最常见的原因）
2. 桥是否在跑：打开 `http://127.0.0.1:8791/api/v1/health`，能返回 JSON 即正常
3. `logs/bridge.log` 里有没有 `BTIPC TRQ` / `BTIPC: r=.. seq=.. OK`

### 发消息

聊天框输入中文，回车即可——发送前会先译成英文，再走原版发送链路。开关和显示模式见[设置](#设置)。

### 设置

| 入口 | 用法 | 说明 |
|---|---|---|
| **ESC 菜单** | ESC →「翻译设置」 | 打开游戏内面板；ESC 菜单自带鼠标指针，可以直接点（推荐） |
| **游戏内快捷** | 输入 `/tr`，或点聊天框右侧 `set` | 同一个面板；聊天布局下要先按住 `Tab` 出指针 |
| **网页设置页** | 打开 `http://127.0.0.1:8791/settings` | 服务商、API Key、端点、回退链等全部字段 |

> [!NOTE]
> 游戏内信道是窄带：一帧只有 10 字节载荷，协议上限 128 帧（约 1280 字节），整份配置约 1.3 KB 读不回来。所以游戏内面板秒开常用开关、保存只回执；完整配置请用网页页。

配置保存在 `config/config.json`（首次运行自动生成）。该文件含 API Key，已被 `.gitignore` 忽略，**不要提交到 Git**。设置保存后，**下一条消息**即按新配置执行。

### 启动 / 停止桥

| 操作 | 方式 |
|---|---|
| 后台启动桥 | `StartBridgeSilent.vbs`（或 `StartDeadlock.bat`） |
| 启动桥并拉起游戏 | `StartDeadlock.bat -game` |
| 停止 / 重启 | `StopBridge.bat` / `RestartBridge.bat` |
| 开机自启 | `install-autostart.bat` / `remove-autostart.bat` |
| 手动打开悬浮窗（不必开游戏） | `ShowOverlay.bat` |

## 配置与接口

### 配置文件

配置文件为 `config/config.json`，主要字段：

| 字段 | 默认值 | 说明 |
|---|---|---|
| `port` | `8791` | 桥监听端口 |
| `provider` | `"bing"` | 主服务商：`bing` / `microsoft` / `openai` / `deepl` / `google` |
| `fallbackProviders` | `[]` | 主服务商失败后的回退顺序（只尝试已配置 Key 的服务商） |
| `defaults.sourceLanguage` | `"auto"` | 源语言 |
| `defaults.targetLanguage` | `"zh-Hans"` | 目标语言 |
| `timeoutMs` | `15000` | 翻译超时预算（毫秒） |
| `chatLog.enabled` | `true` | 是否写聊天日志 |
| `chatLog.dir` | `"logs/chat"` | 聊天日志目录 |
| `deadlockConsoleLog` | 自动探测 | 游戏 `console.log` 路径（只在带 `-condebug` 时存在） |
| `steamIdEnrichment.enabled` | `false` | 是否启用 SteamID 回填 |
| `overlay.enabled` | `false` | 是否启用悬浮窗（v2.1.0 起默认关闭） |
| `overlay.mode` / `overlay.view` | `"native"` / `"panel"` | `native` 原生 WPF / `web` 浏览器；`panel` 面板 / `subtitle` 字幕浮层 |
| `overlay.edge` | `"right"` | 收起时贴哪条屏边：`left` / `right` / `top` / `bottom` / `float` |

> [!CAUTION]
> `config/config.json` 含服务商 API Key。日志输出**绝不包含** apiKey，该文件也被 `.gitignore` 忽略，任何情况下都不要提交。

### HTTP 接口

桥只监听 `127.0.0.1:8791`，不对外暴露，也不做任意 URL 代理。请求体上限 64 KB，单条文本上限 4000 字符。

| 方法 | 端点 | 说明 |
|---|---|---|
| `GET` | `/btipc/dl` | 游戏侧位信道下行：按 `w` / `r` 取帧，位=1 返回 `200` + PNG，位=0 返回 `404` |
| `POST` / `GET` | `/api/v1/translate` | 翻译文本，返回 `{ ok, translation, detectedLanguage }` |
| `POST` / `GET` | `/api/v1/test` | 用当前配置测试服务商连通性 |
| `GET` | `/api/v1/health` | 健康检查：版本、当前服务商与回退链 |
| `GET` / `POST` | `/api/v1/config` | 读取（Key 打码）/ 保存配置 |
| `POST` / `GET` | `/api/v1/log` | 写入聊天日志条目（现由 `console.log` 通道主导） |
| `POST` / `GET` | `/api/v1/diag` | 游戏侧诊断信息写入桥日志 |
| `GET` | `/api/v1/overlay/messages` | 悬浮窗轮询：最近聊天、会话标识与目标语言 |
| `POST` / `GET` | `/api/v1/overlay/translate` | 悬浮窗发消息：中文 → 英文 |
| `GET` | `/settings` | 网页设置页 |
| `GET` | `/overlay` | 网页版悬浮窗（`overlay.mode = "web"` 时用） |
| `GET` | `/bridge` | 旧游戏内面板页（已废弃，仅诊断用） |

示例：

```bash
curl.exe http://127.0.0.1:8791/api/v1/health
```

## 技术说明

### 数据流

**上行（游戏 → 桥）**：游戏把每条请求写成 `console.log` 里的一行结构化文本，桥增量 tail 这个文件（`-condebug` 是前提）：

```text
[LCT] BTIPC REQ w=<窗口> id=<请求> len=<字节数> crc=<校验> b64=<原文>
```

**下行（桥 → 游戏）**：桥把译文编码成 16 字节帧，游戏侧用 128 个隐藏的 2×2 `Image` 面板逐轮读取 `GET /btipc/dl?w=&r=&p=&t=` 的**状态码**——`200` = 位 1，`404` = 位 0。帧里带 `seq` / `VALID` / `LEN` 与 CRC-16，轮号 `r` 前进即隐式确认；校验失败就同轮重投，桥端幂等重发。

**渲染**：译文由 mod 追加为聊天行下的 `Label`。渲染能力一直都在，之前缺的只是数据来源。

> [!NOTE]
> 图片加载由引擎渲染管线自行发起，不走 Panorama 的 JS HTTP API，所以游戏移除 `AsyncWebRequest` 不影响这条下行。
> 引擎侧另有一条受信任的 HTTPS 面板通道，下行可做到 1 秒级（上游 BabelTower 已实车验证；真因是引擎在加载前按**证书链**拒绝未受信任页面，`error:-202` = `ERR_CERT_AUTHORITY_INVALID`）；本版 2.1.0 尚未移植，延迟仍是 2～6 秒。

完整协议规格见 [`docs/btipc-v1.md`](docs/btipc-v1.md)，架构细节见 [`docs/architecture.md`](docs/architecture.md)。

### 术语表

[`core/glossary.js`](core/glossary.js) 会把术语表注入**每一次**翻译提示词，并对输出做英雄名纠正：

- `heroNames`：42 个可玩英雄的官方英文名
- `heroCnToEn`：中文昵称 → 英文英雄名
- `itemEnToCn`：194 条商店装备的官方中英对照
- `termsCnToEn`：战术术语（兵线、推塔、回城……）

英雄与装备数据可一键刷新：`node scripts/sync_heroes.js`（默认 dry-run，加 `--write` 落盘）；权威数据源是 `https://api.deadlock-api.com/v1/assets/heroes` 与 `/v1/assets/items`。

### 聊天日志与 SteamID

- 聊天日志：`logs/chat/<matchId>.jsonl`；身份缓存：`logs/chat/identity_cache.json`
- 日志由**桥**写入：游戏侧把已去重、sender 已解析的消息写成 `[LCT-CHAT]{json}` 一行进 `console.log`，桥增量 tail 后落盘
- 缓存按昵称与 `account:<account_id>` 两类键存放；昵称回填在文件写入 3 分钟后尝试，整局 12 人名单在 6 小时后首次请求公开 API，失败每小时重试

### 目录结构

```text
DeadlockLingua/
├── mod/panorama/            Panorama 模组（layout / scripts / styles）
├── core/                    本地 Node.js 桥
│   ├── bridge_server.js     HTTP 服务与 /btipc/dl 路由
│   ├── btipc/               BTIPC 帧 / 窗口 / 传输实现
│   ├── providers/           翻译服务商实现
│   ├── glossary.js          英雄 / 装备 / 战术术语表
│   ├── dictionary.js        自适应词典
│   ├── overlay.js           悬浮窗数据源（legacy）
│   ├── steamid_enrich.js    SteamID 回填
│   └── settings_page.html   网页设置页
├── tests/btipc/             BTIPC 协议测试（离线可跑）
├── scripts/                 构建 / 打包 / 模拟测试 / 悬浮窗
├── config/                  配置与词典
├── docs/                    架构、BTIPC 规格、优化日志
├── *.bat / *.vbs            启动、停止、自启、悬浮窗脚本
└── LICENSE / LICENSE_NOTICE.md
```

运行时目录不进 Git：`config/config.json`（密钥）、`logs/`（日志）、`dist/`（构建产物）、`portable-node/`（本地 Node）、`tools/`（打包工具）。

## 常见问题

**游戏里一直不显示译文？**
先查启动选项里有没有 `-condebug`；再确认桥在跑（`http://127.0.0.1:8791/api/v1/health` 返回 JSON）；最后看 `logs/bridge.log` 里有没有 `BTIPC TRQ` / `BTIPC: r=.. seq=.. OK`。

**译文要等好几秒？**
正常。位信道有效带宽约 16 字节/秒，一条 60 字节的译文约 4 秒，不是卡住。

**翻译失败会怎样？**
服务商失败会回退显示原文；桥整个不在时约 3 秒放弃并跳过，不会在聊天里刷红字。

**桥没启动 / 显示「桥离线」？**
双击 `StartBridgeSilent.vbs`，或检查任务管理器里有没有 `node.exe`。

**输入 `/tr` 没反应？**
推荐改用 ESC →「翻译设置」（自带指针）。`/tr` 面板在聊天布局里，需要先按住 `Tab` 出鼠标指针才能点。

**还能用悬浮窗吗？**
可以，代码仍在。设置里可切显示形态；`overlay.mode = "web"` 还能退回浏览器小窗。

## 开发

### 从源码构建

需要 Reduced CSDK 12 与 [VPKEdit CLI](https://github.com/craftablescience/VPKEdit/releases)（放进 `tools/`）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/build.ps1 -Csdk12Root "<CSDK_DIR>"
```

产物为 `dist/pak01_dir.vpk`。部署前先改成不与 addons 现有文件重名的名字（推荐 `pak22_dir.vpk`），再复制到 `game/citadel/addons/`。

### 测试

```powershell
# 离线协议测试（不需要游戏）
node tests\btipc\crc.test.js
node tests\btipc\frame.test.js
node tests\btipc\transport.test.js
node tests\btipc\e2e_tail.test.js
node tests\btipc\route.test.js
node tests\btipc\live_http.test.js

# 模拟器（需要桥在跑）
node scripts\lingua_chat_simtest.js
node scripts\overlay_test.js
node scripts\test_sender_backfill.js
node scripts\test_steamid_roster.js
node scripts\test_bridge_dedup.js
node scripts\test_bridge_fallback.js
```

### 发布打包

```powershell
powershell -ExecutionPolicy Bypass -File scripts\package_release.ps1 -Version 2.1.0
```

产出 `dist/DeadlockLingua-2.1.0-win64.zip`，内含 VPK、桥、内置 Node、启动/停止脚本与文档。

### 贡献

欢迎提交 Issue 与 Pull Request。提交前请自查：

- 不要带 `apiKey`、`sk-` 开头的 Key、SteamID、`matchId`、聊天原文或本机绝对路径
- `config/config.json`、`logs/`、`dist/`、`*.vpk`、`portable-node/` 均已被忽略，不要强行加入
- `.js` 文件保持 UTF-8、行尾 CRLF
- 改 BTIPC 协议任一侧，**必须同步另一侧**（游戏侧内联了 crc16 / 位序 / UTF-8 / base64 副本），并跑 `tests/btipc/*` 与 `scripts/lingua_chat_simtest.js`

进度：

- [x] 游戏内译文显示（BTIPC 双向信道 + Image 位编码）
- [x] 发送前翻译
- [x] ESC 菜单设置入口与 `/tr` 三标签面板
- [x] 游戏外悬浮窗 / 字幕浮层（备选）
- [x] 术语表（42 英雄 / 194 装备）
- [x] SteamID 被动回填
- [ ] 位信道提速（规格 v1.1：目标 60B 回程 ≤2.5s）

## 许可证

- 本项目代码：GNU GPL v3，见 [`LICENSE`](LICENSE)
- 第三方协议说明：见 [`LICENSE_NOTICE.md`](LICENSE_NOTICE.md)
- 游戏内 Valve 布局素材仅用于兼容性，版权归 Valve
