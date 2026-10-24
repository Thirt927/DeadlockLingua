# DeadlockLingua

> 《Deadlock》聊天实时翻译：队友和对手的外语聊天自动译成中文，**译文直接显示在原消息下面**，不用切出游戏，也不用第二个窗口。装了本机证书后下行 **<1 秒**；没装则自动退回位信道（2～6 秒），不需要任何切换。

`GPL-3.0` · `v2.1.0 + https 通道` · Windows 10/11 · Node.js 18+ · 基于 [BabelTower](https://github.com/c1375rick/BabelTower) 二次开发，由 [Thirt927](https://github.com/Thirt927) 维护

[简体中文](README.md) · [English](README_EN.md)

> [!NOTE]
> 仓库当前状态：v2.1.0 之后又落了 **https 面板通道**（2026-10-24，尚未打 tag）。
> 装了证书 → 下行 ≈ 一个 RTT；没装 → 整局自动留在 BTIPC 位信道，功能与之前完全一致。

## 目录

- [简介](#简介)
- [功能](#功能)
- [安装](#安装)
- [使用](#使用)
- [配置与接口](#配置与接口)
- [技术说明](#技术说明)
- [常见问题](#常见问题)
- [开发](#开发)
- [许可证与来源](#许可证与来源)

## 简介

DeadlockLingua 由两部分组成：

- **游戏内模组**（Panorama）：扫描聊天、把请求写进 `console.log`，并把译文插回原消息下方。
- **本地桥**（Node.js，只监听 `127.0.0.1`）：调用翻译服务商，再把译文送回游戏。

下行有两条通道，按可用性自动选：

| 通道 | 条件 | 延迟 |
|---|---|---|
| **https 面板**（主） | 本机自签证书被信任 + 桥的 `core/bridge_https.js` 在 8792 做 TLS 终结 | ≈ 一个 RTT（<1 秒） |
| **BTIPC 位信道**（兜底） | 只需游戏带 `-condebug`，零配置 | 2～6 秒（≈16 B/s） |

选择逻辑：开机时桥通过 `op=ui` 告诉游戏"https 就绪没有"；就绪才探一次针，判活走 https，判死整局留在 BTIPC。证书后来失效、页面加载失败、连续 3 次硬失败，都会自动退回，不需要用户操作。

## 功能

**看别人说什么**

- 译文直接显示在原消息下面；HUD 顶栏气泡、大厅聊天记录同样支持
- 已是中文的消息、纯数字/符号、`/` 开头的指令自动跳过
- 聊天滚动回收后，译文从缓存自动重建

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
- 游戏外悬浮窗（v2.0.x 方案）代码保留、可切换

## 安装

1. 下载最新版，解压到**无空格、无中文**的路径（如 `D:\DeadlockLingua`）：
   <https://github.com/Thirt927/DeadlockLingua/releases/latest>
   （https 面板通道是仓库里**尚未发版**的新功能：在下次发版前，请直接使用源码仓库的
   `scripts/gen_bridge_cert.ps1` 与 `core/bridge_https.js`）

2. **给 Deadlock 加 `-condebug` 启动参数（必做，只需设置一次）**

   Steam 库 → Deadlock 右键 → 属性 → 常规 → **启动选项**，填：

   ```text
   -condebug
   ```

   游戏不带它就不会写 `game/citadel/console.log`，而那是**请求送出**的唯一通路（两条下行都靠它）。

3. **把 VPK 放进 addons**

   - 包里的 `pak01_dir.vpk` 先改名（不与 addons 内已有文件重名即可），推荐 `pak22_dir.vpk`
   - 只能放 `game/citadel/addons/`；不要用 `pak01` 这个名字（与游戏本体冲突），也不要放到 `citadel/` 根目录（会覆盖游戏资源）
   - 推荐用 Deadlock Mod Manager 导入，或手动复制到：
     `<Steam 库>\steamapps\common\Deadlock\game\citadel\addons\`

4. **启动本地桥（二选一）**

   - `install-autostart.bat`：装成开机自启（推荐）
   - `StartBridgeSilent.vbs`：临时后台启动

5. **重启 Deadlock**

6. **【推荐】把下行提速到 <1 秒（可选，但强烈建议）**

   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\gen_bridge_cert.ps1 -Trust
   ```

   然后**完全退出 Steam（托盘图标也要退）再重开**，进对局看 `console.log` 里有没有 `https panel: ALIVE`。

   - 命令会生成一张只签给 `localhost` / `127.0.0.1` / `::1` 的自签证书，写进**当前用户**的根证书库，不需要管理员
   - 执行时 Windows 会弹一次「安全警告」，需要点「是」（不要在隐藏窗口里跑，否则会一直等 UI）
   - 信任决定缓存在 Steam 进程里：**只重启游戏无效，必须完全重启 Steam**
   - 不放心随时撤销：`powershell -ExecutionPolicy Bypass -File scripts\gen_bridge_cert.ps1 -Untrust`（同样要完全重启 Steam）
   - 不装也完全能用 —— 桥检测不到证书就不启动 https 子进程，整局留在 BTIPC

> [!TIP]
> `StartDeadlock.bat` 可以在启动桥的同时用 Steam 拉起游戏（`StartDeadlock.bat -game`）；`-condebug` 仍以游戏的启动选项为准。

## 使用

### 看译文

进对局即可。别人说外语时，译文会出现在那条消息下方（浅蓝底、斜体）。

| 当前通道 | 单条延迟 | 怎么判断 |
|---|---|---|
| https 面板 | 通常 **<1 秒** | `console.log` 有 `https panel: ALIVE` |
| BTIPC 位信道 | **2～6 秒**（约 16 B/s） | 出现 `https panel: not usable (...)` 或没装证书 |

一直不出现译文时，按顺序检查：

1. 启动选项里有没有 `-condebug`（最常见的原因）
2. 桥是否在跑：`http://127.0.0.1:8791/api/v1/health` 能返回 JSON 即正常
3. `logs/bridge.log` 里有没有 `BTIPC TRQ` / `BTIPC: r=.. seq=.. OK`

### 发消息

聊天框输入中文，回车即可——发送前会先译成英文，再走原版发送链路。开关和显示模式见[设置](#设置)。

### 设置

| 入口 | 用法 | 说明 |
|---|---|---|
| **ESC 菜单** | ESC →「翻译设置」 | 游戏内面板；ESC 菜单自带鼠标指针，可以直接点（推荐） |
| **游戏内快捷** | 输入 `/tr`，或点聊天框右侧 `set` | 同一个面板；聊天布局下要先按住 `Tab` 出指针 |
| **网页设置页** | 打开 `http://127.0.0.1:8791/settings` | 服务商、API Key、端点、回退链等全部字段 |

> [!NOTE]
> 游戏内信道是窄带：位信道一帧 10 字节载荷、协议上限 128 帧；整份配置约 1.3 KB 读不回来。
> 所以游戏内面板秒开常用开关、保存只回执；完整配置请用网页页。走 https 时虽然更快，但为兼容仍保持同一套约定。

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
| `https.enabled` | `true` | 有证书时是否启动 https 面板通道子进程 |
| `https.port` | `8792` | https 监听端口（只绑 `127.0.0.1` + `::1`） |
| `https.pfx` / `https.passFile` | `config/certs/bridge.pfx` / `.pass` | 证书与口令文件（已 gitignore） |
| `https.timeoutMs` | `30000` | 反代硬超时；必须大于翻译超时，否则长句会被截成 502 |
| `overlay.enabled` | `false` | 是否启用悬浮窗（v2.1.0 起默认关闭） |
| `overlay.mode` / `overlay.view` | `"native"` / `"panel"` | `native` 原生 WPF / `web` 浏览器；`panel` 面板 / `subtitle` 字幕浮层 |
| `overlay.edge` | `"right"` | 收起时贴哪条屏边：`left` / `right` / `top` / `bottom` / `float` |

> [!CAUTION]
> `config/config.json` 含服务商 API Key。日志输出**绝不包含** apiKey，该文件也被 `.gitignore` 忽略，任何情况下都不要提交。

### HTTP / TLS 接口

桥只监听回环，不对外暴露，也不做任意 URL 代理。请求体上限 64 KB，单条文本上限 4000 字符。

| 方法 | 端点 | 说明 |
|---|---|---|
| `GET` | `https://localhost:8792/bridge` | https 面板页面（游戏内隐藏面板加载；同源 fetch 后写 `document.title`） |
| `*` | `https://localhost:8792/api/v1/*` | 原样代理到 8791（方法/头/体/状态码保留） |
| `GET` | `/btipc/dl` | 位信道下行：按 `w` / `r` 取帧，位=1 返回 `200` + PNG，位=0 返回 `404` |
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
| `GET` | `/bridge` | 旧游戏内面板页（http 通道已废，仅诊断与 https 代理的源站） |

示例：

```powershell
curl.exe http://127.0.0.1:8791/api/v1/health
curl.exe -k https://localhost:8792/api/v1/health   # 未信任证书时用 -k
```

## 技术说明

### 上行（游戏 → 桥，两条下行共用）

游戏把每条请求写成 `console.log` 里的一行结构化文本，桥增量 tail 这个文件（`-condebug` 是前提）：

```text
[LCT] BTIPC REQ w=<窗口> id=<请求> len=<字节数> crc=<校验> b64=<原文>
```

### 下行 A：https 面板（主，<1 秒）

隐藏 HTML 面板导航到 `https://localhost:8792/bridge?...` → 页面在**同源**下 `fetch('/api/v1/translate')` → 把整条结果一次写进 `document.title` → 游戏侧读回（事件 + 0.1s 轮询兜底）。

- TLS 终结在**独立进程** `core/bridge_https.js`：证书坏了/握手失败不会连带 BTIPC 一起死；桥本体仍只有一处 `listen`。
- 证书由 `scripts/gen_bridge_cert.ps1` 生成：`CN=BabelTower-localhost`，SAN = `DNS:localhost` + **IP** `127.0.0.1` + **IP** `::1`，EKU serverAuth。
- 引擎在加载页面**之前**校验证书链；未受信任时表现为 `panel.title` 永不更新（上游实测 `error:-202` = `ERR_CERT_AUTHORITY_INVALID`），信任后需**完全重启 Steam** 才生效。
- 游戏侧策略：探一次定生死；硬失败（页面没加载/面板不可用/超长 payload 被 title 上限截断）把任务原样交回 BTIPC；软失败（页面活了但慢）按原语义结算；连续 3 次硬失败整局退位泵。

细节、排障与安全边界见 [`docs/https-panel.md`](docs/https-panel.md)。

### 下行 B：BTIPC 位信道（兜底，2～6 秒）

桥把译文编码成 16 字节帧，游戏侧用 128 个隐藏的 2×2 `Image` 面板逐轮读取 `GET /btipc/dl?w=&r=&p=&t=` 的**状态码**——`200` = 位 1，`404` = 位 0。帧里带 `seq` / `VALID` / `LEN` 与 CRC-16，轮号 `r` 前进即隐式确认；校验失败就同轮重投，桥端幂等重发。

> [!NOTE]
> 图片加载由引擎渲染管线自行发起，不走 Panorama 的 JS HTTP API，所以游戏移除 `AsyncWebRequest` 不影响这条下行。

近期提速（Phase 1）：桥端 `console.log` 尾随改为 `fs.watch`（约 50ms 读到，替代 800ms 轮询）、首拍 1.2s → 0.3s、BUSY 退避 500ms → 180ms、翻译服务商复用连接。完整规格见 [`docs/btipc-v1.md`](docs/btipc-v1.md)，架构见 [`docs/architecture.md`](docs/architecture.md)。

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
│   ├── bridge_server.js     HTTP 服务、/btipc/dl 路由、https 子进程管理
│   ├── bridge_https.js      https 面板通道：8792 TLS 终结 + 反代（独立进程）
│   ├── btipc/               BTIPC 帧 / 窗口 / 传输实现
│   ├── providers/           翻译服务商实现
│   ├── glossary.js          英雄 / 装备 / 战术术语表
│   ├── dictionary.js        自适应词典
│   ├── overlay.js           悬浮窗数据源（legacy）
│   ├── steamid_enrich.js    SteamID 回填
│   └── settings_page.html   网页设置页
├── tests/btipc/             BTIPC 协议测试（离线）
├── tests/https_panel_server.test.js   https 通道测试（离线）
├── scripts/                 构建 / 打包 / 模拟测试 / 证书 / 悬浮窗
├── config/                  配置与词典（config/certs/ 为本地证书，已忽略）
├── docs/                    架构、https/BTIPC 规格、优化日志
├── *.bat / *.vbs            启动、停止、自启、悬浮窗脚本
└── LICENSE / LICENSE_NOTICE.md
```

运行时目录不进 Git：`config/config.json`（密钥）、`config/certs/`（私钥）、`logs/`、`dist/`、`portable-node/`、`tools/`。

### 实验分支：原生 mod

仓库的 `feat/native-mod` 分支有一份**原生 DLL 实验骨架**（进程内 DXGI 覆盖层 + WinHTTP），不依赖 Panorama/CEF，也不需要装证书。它**未编译、未实机验证**，且向游戏进程注入 DLL 有反作弊/封号风险，仅供实验，不是本 mod 的一部分。

## 常见问题

**游戏里一直不显示译文？**
先查启动选项里有没有 `-condebug`；再确认桥在跑（`http://127.0.0.1:8791/api/v1/health` 返回 JSON）；最后看 `logs/bridge.log` 里有没有 `BTIPC TRQ` / `BTIPC: r=.. seq=.. OK`。

**还是 2～6 秒，没到 1 秒？**
说明 https 通道没起来。看游戏 `console.log`：`https panel: not usable (bridge_nav_failed)` = 页面没加载，多半是没跑 `-Trust` 或没完全重启 Steam；`bridge_https.log` 里出现 `TLS handshake rejected by client` 也是同一件事（引擎用证书告警拒了）。

**开了 https 但偶尔退回慢通道？**
连续 3 次硬失败会整局退回 BTIPC（日志 `https panel: dead ...`）。修好证书/重启 Steam 后重进游戏即恢复。

**翻译失败会怎样？**
服务商失败会回退显示原文；桥整个不在时约 3 秒放弃并跳过，不会在聊天里刷红字。

**桥没启动 / 显示「桥离线」？**
双击 `StartBridgeSilent.vbs`，或检查任务管理器里有没有 `node.exe`。

**输入 `/tr` 没反应？**
推荐改用 ESC →「翻译设置」（自带指针）。`/tr` 面板在聊天布局里，需要先按住 `Tab` 出鼠标指针才能点。

**还能用悬浮窗吗？**
可以，代码仍在。设置里可切显示形态；`overlay.mode = "web"` 还能退回浏览器小窗。

**装证书安全吗？**
证书只签给 `localhost` / `127.0.0.1` / `::1`，冒充不了任何公网域名；私钥只在本地 `config/certs/`（已 gitignore）。它写进的是**当前用户**的信任库，不碰机器级证书；`-Untrust` 可随时撤销。

## 开发

### 从源码构建

需要 Reduced CSDK 12 与 [VPKEdit CLI](https://github.com/craftablescience/VPKEdit/releases)（放进 `tools/`）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/build.ps1 -Csdk12Root "<CSDK_DIR>"
```

产物为 `dist/pak01_dir.vpk`。部署前先改成不与 addons 现有文件重名的名字（推荐 `pak22_dir.vpk`），再复制到 `game/citadel/addons/`。

### 测试

```powershell
# 离线协议/通道测试（不需要游戏）
node tests\btipc\crc.test.js
node tests\btipc\frame.test.js
node tests\btipc\transport.test.js
node tests\btipc\e2e_tail.test.js
node tests\btipc\route.test.js
node tests\btipc\live_http.test.js
node tests\https_panel_server.test.js   # 临时证书 + 桩上游，验证 TLS/反代/降级

# 模拟器与桥侧回归（部分需要桥在跑）
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

产出 `dist/DeadlockLingua-2.1.0-win64.zip`，内含 VPK、桥（含 `bridge_https.js`）、内置 Node、启动/停止脚本、证书脚本与文档。

### 贡献

欢迎提交 Issue 与 Pull Request。提交前请自查：

- 不要带 `apiKey`、`sk-` 开头的 Key、SteamID、`matchId`、聊天原文或本机绝对路径
- `config/config.json`、`config/certs/`、`logs/`、`dist/`、`*.vpk`、`portable-node/` 均已被忽略，不要强行加入
- `.js` 文件保持 UTF-8、行尾 CRLF
- 改 BTIPC 协议任一侧，**必须同步另一侧**（游戏侧内联了 crc16 / 位序 / UTF-8 / base64 副本），并跑 `tests/btipc/*` 与 `scripts/lingua_chat_simtest.js`
- 改 https 通道，跑 `tests/https_panel_server.test.js`，并确认「证书缺失 → 整局 BTIPC」这条降级没被破坏

进度：

- [x] 游戏内译文显示（BTIPC 双向信道 + Image 位编码）
- [x] 发送前翻译
- [x] ESC 菜单设置入口与 `/tr` 三标签面板
- [x] 游戏外悬浮窗 / 字幕浮层（备选）
- [x] 术语表（42 英雄 / 194 装备）
- [x] SteamID 被动回填
- [x] **https 面板通道（2026-10-24，下行 <1s，BTIPC 兜底）**
- [x] BTIPC 提速 Phase 1（fs.watch / 首拍 300ms / BUSY 180ms / keep-alive）
- [ ] 位信道 v1.1（瘦帧 + 中文 UTF-16，目标 60B 回程 ≤2.5s）
- [ ] 原生 mod（实验分支，未编译未实机验证）

## 许可证与来源

- 本项目代码：GNU GPL v3，见 [`LICENSE`](LICENSE)
- 第三方协议与素材说明：见 [`LICENSE_NOTICE.md`](LICENSE_NOTICE.md)
- 游戏内 Valve 布局素材仅用于兼容性，版权归 Valve

**https 面板通道的来源**：协议语义参考上游 [BabelTower `docs/btipc-https-v1.md`](https://github.com/c1375rick/BabelTower/blob/main/docs/btipc-https-v1.md)（TLS 终结独立进程、页面同源 fetch 写 `document.title`、探针定生死、硬/软失败分类），本仓库独立实现，未复制其代码；「自签证书 + 写入 `CurrentUser\Root` + 完全重启 Steam」这一方案的最初实机先例来自该文档转述的 **DeadlockTranslate 0.6.19**。隐藏 HTML 面板 `SetURL` / `panel.title` 的机制事实来自 DLCT 与 `Hantu-Raya/Deadlock-mods-collection`（Apache-2.0）的公开可观测行为，实现为本项目独立编写。
