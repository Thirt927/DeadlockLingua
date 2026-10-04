# DeadlockLingua

<p align="center">
  <img src="./assets/readme/hero.svg" width="100%" alt="DeadlockLingua：把 Deadlock 游戏内聊天实时翻译到游戏外悬浮窗；右侧示意 [LCT-CHAT] 日志到双语字幕胶囊" />
</p>

<div align="center"><img alt="License: GPL-3.0" src="./assets/readme/badge-license.svg" height="26" /><img alt="Version 2.0.0" src="./assets/readme/badge-version.svg" height="26" /><img alt="Platform: Windows 10/11" src="./assets/readme/badge-platform.svg" height="26" /><img alt="Runtime: Node.js" src="./assets/readme/badge-runtime.svg" height="26" /><img alt="Providers: 5 services" src="./assets/readme/badge-providers.svg" height="26" /></div>

<p align="center">
🇨🇳 <a href="./README.md">简体中文</a> | 🇺🇸 <a href="./README_EN.md">English</a>
</p>

> 《Deadlock》聊天实时翻译工具，基于 [BabelTower](https://github.com/c1375rick/BabelTower) 二次开发，由 [Thirt927](https://github.com/Thirt927) 维护。

把《Deadlock》里队友和对手的外语聊天实时翻译成中文，显示在**游戏外的悬浮窗**上；你要说的话也可以先译成英文，一键复制回游戏发送。

> [!WARNING]
> **从 v2.0.0 起，译文不再显示在游戏内。**
> 《Deadlock》**2026-10-01 的更新移除了游戏的全部网络能力**（`$.AsyncWebRequest` 调用即抛 `AsyncWebRequest has been removed.`），Mod 已无法在游戏里接收任何数据。因此：
> - ❌ 游戏内的聊天行不再显示译文，原 `/tr` 设置面板已被移除，游戏内不再有任何设置入口
> - ✅ 译文改在**游戏外的悬浮窗**里显示，这是目前唯一可行的方式
>
> 这不是本项目的选择，而是游戏引擎层面的限制。若游戏后续更新恢复网络能力，游戏内翻译会自动具备恢复条件（`probeInboundChannels()` 探针会第一时间发现）。

---

## 目录

- [功能](#功能)
- [安装](#安装)
- [使用](#使用)
- [API 参考](#api-参考)
- [配置](#配置)
- [术语表](#术语表)
- [聊天日志与 SteamID](#聊天日志与-steamid)
- [从源码构建](#从源码构建)
- [测试](#测试)
- [发布打包](#发布打包)
- [目录结构](#目录结构)
- [工作原理](#工作原理)
- [常见问题](#常见问题)
- [贡献](#贡献)
- [许可证](#许可证)

---

<p align="center">
  <img src="./assets/readme/section-01-features.svg" width="100%" alt="章节 01 · 功能 / Features" />
</p>

## 功能

**看别人说什么**

- 悬浮窗实时显示聊天原文 + 中文译文
- **字幕浮层**：屏幕角落堆叠的聊天胶囊（发言者色牌 + 昵称 + 原文 + 译文），全屏游戏时不挡视野
- 字幕鼠标完全穿透，不影响操作；位置可直接**拖拽**摆放
- 可开启「一直留存」：不按时间消失，只保留最近 N 条

**说你想说的话**

- 悬浮窗输入中文 → 自动译成英文 → 复制到剪贴板 → 回游戏 `Ctrl+V` 发送

**翻译服务**

- 多服务商：Bing（免 Key）、Microsoft、OpenAI 兼容（如 DeepSeek）、DeepL、Google Cloud
- 主服务商超时或失败时**自动回退**到备用服务商
- 内置**游戏术语表**：46 个可玩英雄、194 件商店装备、常用战术术语，保证译名统一

**其他**

- 聊天日志按对局 ID 写入 JSONL，便于赛后复盘
- SteamID 回填：聊天昵称自动补全 SteamID64

---

<p align="center">
  <img src="./assets/readme/section-02-install.svg" width="100%" alt="章节 02 · 安装 / Installation" />
</p>

## 安装

下载最新版：`https://github.com/Thirt927/DeadlockLingua/releases/latest`

1. 解压 `DeadlockLingua-<版本>-win64.zip` 到**无空格、无中文**的路径，例如 `D:\DeadlockLingua`。
2. **把 Mod 放进游戏**
   - 压缩包内的 VPK 叫 `pak01_dir.vpk`，**先给它改个名字**：只要在 addons 里不重名就行，推荐 `pak22_dir.vpk`（数字随意，22 只是本项目用的空位号）。
   - ⚠️ **不要直接用 `pak01_dir.vpk` 这个名字**：`pak01` 是游戏本体占用的，同名会冲突；另外**千万不要放到 `citadel\` 目录下**（那会覆盖游戏本体资源），只能放 `citadel\addons\`。
   - 推荐用 **Deadlock Mod Manager** 导入；或手动复制到：
     `<Steam 库>\steamapps\common\Deadlock\game\citadel\addons\`
3. **启动本地桥**（二选一）
   - 双击 `install-autostart.bat` 装成开机自启（推荐）
   - 或双击 `StartBridgeSilent.vbs` 临时后台启动
4. **重启 Deadlock**

> [!TIP]
> 打不开悬浮窗？双击 `ShowOverlay.bat` 即可手动打开，**不需要先启动游戏**。

---

<p align="center">
  <img src="./assets/readme/section-03-usage.svg" width="100%" alt="章节 03 · 使用 / Usage" />
</p>

## 使用

### 看译文

进入对局后，悬浮窗会自动弹出（前提是桥已启动）。窗口默认贴在**屏幕右边缘**，平时只留一条很细的竖条，**鼠标扫过去就会滑出来**。

想让它一直显示，点窗口里的「**固定**」按钮。

如果窗口跑到别处或没出现：

- 切到桌面看任务栏 / 用 `Alt+Tab` 找标题 `DeadlockLingua`
- 或双击 `ShowOverlay.bat` 重新打开

### 发消息

1. 在悬浮窗底部输入框输入中文
2. 点「**翻译并复制**」（或按 `Enter`）
3. 回到游戏，打开聊天，按 `Ctrl+V` 粘贴发送

> [!IMPORTANT]
> 这一步必须手动粘贴——游戏侧收不到任何外部数据，无法自动把文字送进输入框。

### 字幕浮层

在设置里把「显示形态」改成「**字幕浮层**」，屏幕角落就会出现聊天胶囊。

- **调整位置**：设置 →「调整字幕位置(拖动)」→ 拖到想要的地方 → 点「完成放置」
- 位置会记住，换分辨率也不会跑偏

### 启动 / 停止桥

| 操作 | 方式 |
|---|---|
| 后台启动 | `StartBridgeSilent.vbs` |
| 终端启动（可看日志） | `StartDeadlock.bat` |
| 停止 | `StopBridge.bat` |
| 重启 | `RestartBridge.bat` |
| 安装/卸载开机自启 | `install-autostart.bat` / `remove-autostart.bat` |

### 设置

点悬浮窗标题栏的「**设置**」。可配置：

- **翻译**：服务商、API Key、目标语言、显示模式、发送模式、超时
- **悬浮窗**：显示形态、不透明度、背景色、圆角、主题色、贴边方向
- **字幕浮层**：一直留存、留存时间、淡入淡出、字号、文字颜色、同屏条数、每条宽度

配置保存在 `config/config.json`，首次运行自动生成。该文件含 API Key，已被 `.gitignore` 忽略，**不要提交到 Git**。

> [!NOTE]
> 原游戏内 `/tr` 设置面板已随网络能力一并移除：`/tr` 不再打开任何面板，会作为普通聊天文本发送。所有设置请用悬浮窗里的「设置」。

---

## API 参考

本地桥只监听 `127.0.0.1:8791`，不对外暴露，也不提供任意 URL 代理。请求体上限 64 KB，单条文本上限 4000 字符。

| 方法 | 端点 | 说明 |
|---|---|---|
| `POST` / `GET` | `/api/v1/translate` | 翻译一段文本，返回 `{ ok, translation, detectedLanguage }` |
| `POST` / `GET` | `/api/v1/test` | 用当前配置测试服务商连通性 |
| `GET` | `/api/v1/health` | 健康检查，返回版本、当前服务商与回退链 |
| `GET` / `POST` | `/api/v1/config` | 读取配置（API Key 打码）/ 保存配置 |
| `POST` / `GET` | `/api/v1/log` | 写入一条聊天日志（游戏侧旧通道，现由 console.log 通道替代） |
| `POST` / `GET` | `/api/v1/diag` | 游戏侧诊断信息写入桥日志 |
| `GET` | `/api/v1/overlay/messages` | 悬浮窗轮询：返回最近聊天、会话标识与目标语言 |
| `POST` / `GET` | `/api/v1/overlay/translate` | 悬浮窗发消息：把中文译成英文供复制 |
| `GET` | `/bridge` | 桥页面（旧游戏内面板用，已废弃） |
| `GET` | `/overlay` | 网页版悬浮窗页面（`overlay.mode = "web"` 时的回退） |

<details>
<summary>查看调用示例</summary>

```bash
# 健康检查
curl.exe http://127.0.0.1:8791/api/v1/health

# 翻译（POST）
curl.exe -X POST http://127.0.0.1:8791/api/v1/translate ^
  -H "Content-Type: application/json" ^
  -d "{\"text\":\"gg wp\",\"targetLanguage\":\"zh-Hans\"}"
```

```json
{ "ok": true, "translation": "打得好", "detectedLanguage": "en" }
```

</details>

---

## 配置

配置文件为 `config/config.json`（首次运行从 `config/config.example.json` 生成）。主要字段：

| 字段 | 默认值 | 说明 |
|---|---|---|
| `port` | `8791` | 桥监听端口 |
| `provider` | `"bing"` | 主翻译服务商：`bing` / `microsoft` / `openai` / `deepl` / `google` |
| `fallbackProviders` | `[]` | 主服务商失败时的回退顺序（仅尝试已配置 Key 的服务商） |
| `defaults.sourceLanguage` | `"auto"` | 源语言 |
| `defaults.targetLanguage` | `"zh-Hans"` | 目标语言 |
| `timeoutMs` | `15000` | 出站翻译总预算 |
| `chatLog.enabled` | `true` | 是否写聊天日志 |
| `chatLog.dir` | `"logs/chat"` | 聊天日志目录 |
| `steamIdEnrichment.enabled` | `false` | 是否启用 SteamID 回填 |
| `overlay.enabled` | `true` | 是否启用悬浮窗 |
| `overlay.autoOpen` | `true` | 检测到游戏启动时自动开窗 |
| `overlay.mode` | `"native"` | `native` = 原生 WPF 窗口；`web` = 浏览器小窗回退 |
| `overlay.view` | `"panel"` | `panel` = 面板窗；`subtitle` = 字幕浮层 |
| `overlay.edge` | `"right"` | 收起时贴哪条屏边：`left` / `right` / `top` / `bottom` / `float` |

> [!CAUTION]
> `config/config.json` 含服务商 API Key。日志输出**绝不包含** apiKey，该文件也被 `.gitignore` 忽略，**任何情况下都不要提交**。

---

## 术语表

[`core/glossary.js`](core/glossary.js) 会把术语表注入**每一次**翻译提示词，并对输出做英雄名纠正：

- `heroNames` — 46 个可玩英雄的官方英文名
- `heroCnToEn` — 中文昵称 → 英文英雄名
- `itemEnToCn` — 194 条商店装备的官方中英对照
- `termsCnToEn` — 战术术语（兵线、推塔、回城……）

权威数据源为 `https://api.deadlock-api.com/v1/assets/heroes` 与 `/v1/assets/items`，均支持 `?language=english|schinese`。

---

## 聊天日志与 SteamID

聊天日志默认写入 `logs/chat/<matchId>.jsonl`，身份缓存写入 `logs/chat/identity_cache.json`。

缓存包含两类键：

- **昵称键**：用于聊天消息回填 SteamID
- **`account:<account_id>` 键**：整局玩家权威记录，避免重名和改名冲突

处理策略：

- 聊天消息中的具名玩家，在文件写入 3 分钟后尝试按昵称回填
- 整局 12 人名单在比赛文件写入 6 小时后首次请求公开 API
- 首次请求失败后每小时自动重试
- 同一账号跨多局遇到时 `matchCount` 递增，不产生重复记录

日志与缓存均已被 `.gitignore` 忽略。

---

## 从源码构建

需要 Reduced CSDK 12：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/build.ps1 -Csdk12Root "<CSDK_DIR>"
```

产物为 `dist/pak01_dir.vpk`。**部署前要先改成不与 addons 现有文件重名的名字**（推荐 `pak22_dir.vpk`），再复制到 Deadlock 的 `game/citadel/addons/`。

> [!WARNING]
> 别用裸的 `pak01_dir.vpk`：`pak01` 是游戏本体的 pak 组名，同名会冲突。

---

## 测试

```powershell
node scripts/lingua_chat_simtest.js
node scripts/overlay_test.js
node scripts/test_sender_backfill.js
node scripts/test_steamid_roster.js
node scripts/test_bridge_dedup.js
node scripts/test_bridge_fallback.js
```

桥健康检查：

```powershell
curl.exe http://127.0.0.1:8791/api/v1/health
```

---

## 发布打包

```powershell
powershell -ExecutionPolicy Bypass -File scripts/package_release.ps1 -Version 2.0.0
```

产出 `dist/DeadlockLingua-2.0.0-win64.zip`，内含桥、内置 Node、启动/停止脚本与文档。

---

## 目录结构

```text
DeadlockLingua/
├── mod/                          Panorama UI 源码
│   └── panorama/
│       ├── layout/               布局覆盖
│       ├── scripts/              聊天扫描与桥接逻辑（lingua_chat.js）
│       └── styles/               聊天译文与测试浮层样式
├── core/                         本地 Node.js 桥
│   ├── bridge_server.js          HTTP 服务与配置接口
│   ├── config.js                 本地配置管理
│   ├── glossary.js               游戏术语表（英雄/装备/战术）
│   ├── hero_names.js             英雄译名与缩写
│   ├── dictionary.js             自适应学习词典
│   ├── overlay.js                悬浮窗数据源（tail console.log）
│   ├── overlay_page.html         网页版悬浮窗页面
│   ├── steamid_enrich.js         SteamID 回填与整局名单
│   └── providers/                翻译服务商（bing/microsoft/openai/deepl/google）
├── scripts/
│   ├── overlay_window.ps1        游戏外悬浮窗（原生 WPF）
│   ├── build.ps1                 构建
│   ├── package_release.ps1       发布打包
│   └── *_test.js / *simtest.js   测试
├── config/                       配置与词典
├── docs/                         架构说明与优化日志
├── assets/readme/                README 视觉素材（hero / 章节条 / 架构图 / 徽章）
├── ShowOverlay.bat               手动打开悬浮窗（不必开游戏）
├── StartBridgeSilent.vbs         无窗口后台启动
├── StartDeadlock.bat             终端/带游戏启动
├── StopBridge.bat                停止桥
├── RestartBridge.bat             重启桥
└── LICENSE / LICENSE_NOTICE.md
```

以下运行时目录不进入 Git：

- `config/config.json` — 本地密钥
- `logs/` — 桥日志与聊天日志
- `dist/` — 构建产物
- `portable-node/` — 本地 Node 运行时
- `tools/` — 本地打包工具

---

## 工作原理

项目由三部分组成：游戏内的 Panorama 模组、本机 Node.js 桥、游戏外悬浮窗。数据是**单向**的——游戏把聊天写进 `console.log`，桥读取后翻译，再由悬浮窗展示。

<p align="center">
  <img src="./assets/readme/architecture.svg" width="100%" alt="数据流：游戏内 Mod 输出 [LCT-CHAT] 到 console.log，本地桥增量读取并调用翻译服务商，再交给游戏外悬浮窗显示；回程仅一条手动粘贴的虚线" />
</p>

> [!NOTE]
> 游戏**2026-10-01 的更新移除了 Panorama 的全部 HTTP 能力**，经探针实测游戏内已不存在任何可用的入站通道，「在游戏内显示译文」在架构上不可行。游戏内收发网络已不可能，唯一活着的通道是单向的 `游戏 → console.log`。

---

## 常见问题

**Q：游戏里怎么不显示译文了？**
A：游戏更新移除了网络能力，游戏内已无法接收数据。请用悬浮窗看译文。

**Q：悬浮窗没出现 / 显示「桥离线」？**
A：桥没启动。双击 `StartBridgeSilent.vbs`，或检查任务管理器里有没有 `node.exe`。

**Q：游戏内还能改设置吗？输入 `/tr` 没反应。**
A：原 `/tr` 设置面板已移除，`/tr` 现在会作为普通聊天文本发送，游戏内已没有设置入口。请在悬浮窗的「设置」里改。

**Q：自动复制失败？**
A：部分浏览器/系统策略会拦截复制。此时英文会被自动选中，按 `Ctrl+C` 再回游戏粘贴即可。

**Q：翻译偶尔变慢或失败？**
A：可在设置里调大「翻译超时」，或配置备用服务商（`fallbackProviders`）做自动回退。

---

## 贡献

欢迎提交 Issue 与 Pull Request。

- 提交前请自查：不要带 `apiKey` / `sk-` 开头的 Key / SteamID / `matchId` / 聊天原文 / 本机绝对路径
- `config/config.json`、`logs/`、`dist/`、`*.vpk`、`portable-node/` 均已被忽略，不要强行加入
- 修改 `.js` 文件时注意行尾为 CRLF，文件编码保持 UTF-8

任务进度：

- [x] 游戏外悬浮窗（原生 WPF）
- [x] 字幕浮层（鼠标穿透 + 可拖拽）
- [x] 术语表补全（46 英雄 / 194 装备）
- [x] SteamID 被动回填
- [ ] 游戏内译文（受引擎限制，待游戏恢复网络能力）

---

## 许可证

- 本项目代码：GNU GPL v3，见 [`LICENSE`](LICENSE)
- 第三方协议说明：见 [`LICENSE_NOTICE.md`](LICENSE_NOTICE.md)
- 游戏内 Valve 布局素材仅用于兼容性，版权归 Valve
