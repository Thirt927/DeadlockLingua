# 架构文档

> 本文描述 v2.0.0（2026-10-01）起的现状。
> Deadlock 该次更新移除了 Panorama 的全部 HTTP 能力（`$.AsyncWebRequest` 调用即抛
> `AsyncWebRequest has been removed.`，隐藏 HTML 面板不再创建浏览器实例），
> **游戏内收发网络已不可能**。旧的「隐藏面板 + 轮询 `panel.title`」通道已废弃，见第 8 节。

## 1. 总览

```
┌──────────────────────── 游戏进程 ─────────────────────────┐
│  Panorama（聊天 UI）                                       │
│  lingua_chat.js: 扫描聊天行 / 顶栏与资料卡身份采集         │
│  每落档一条聊天 → $.Msg("[LCT-CHAT]" + 单行 JSON)          │
└────────────────────────────┬───────────────────────────────┘
                             │ 单向：写 console.log（游戏安装目录）
                             ▼
┌──────────────────────── 本地桥 Node.js（core/）───────────┐
│  overlay.js: 增量 tail console.log，解析 [LCT-CHAT]        │
│   去重 → 串行/并发翻译 → 环形缓冲（最近 300 条）           │
│  providers/*: bing(免Key) / microsoft / openai / deepl /   │
│               google；失败按 fallbackProviders 回退        │
│  glossary / dictionary: 术语表注入 + 自适应词典 + 结果缓存 │
│  HTTP 监听 127.0.0.1:8791                                  │
│   /api/v1/overlay/messages   悬浮窗轮询最近聊天            │
│   /api/v1/overlay/translate  悬浮窗出站（中文→英文）       │
│   /api/v1/translate|test|config|health|log|diag            │
│  steamid_enrich.js: 赛后按公开 API 回填整局 SteamID        │
└────────────────────────────┬───────────────────────────────┘
                             │ HTTP（仅本机）
                             ▼
┌────────────── 游戏外悬浮窗（scripts/overlay_window.ps1）───┐
│ 原生 WPF 窗口：面板窗（聊天/输入/设置）+ 字幕浮层（可穿透） │
│  面板：轮询 /api/v1/overlay/messages 显示原文 + 译文        │
│  出站：输入中文 → /api/v1/overlay/translate → 写剪贴板      │
│  桥检测到 deadlock.exe 启动时自动拉起；退出时关闭           │
│  回退：overlay.mode="web" → 浏览器打开 /overlay             │
└────────────────────────────────────────────────────────────┘
```

## 2. 消息流（收）—— 单向 `游戏 → console.log`

1. `lingua_chat.js` 扫描聊天行；每落档一条就发一行 `$.Msg("[LCT-CHAT]" + JSON)`
   （`emitOverlayChat`，埋点在 `pushEntry()`）。行格式：
   `<时间戳> [PanoramaScript] [LCT-CHAT]{"o":0,"n":"Alice","c":"chat","h":"","t":"hello"}`
2. `core/overlay.js` **增量**读取 `console.log`：记录上次字节偏移，并用「尾部指纹」检测
   日志重写（每次启动游戏 `console.log` 被清空重写，只靠 size 变化会从错位字节读起）。
3. 解析 → 去重（2 分钟窗口，覆盖聊天行与顶栏气泡的同一句副本）→ 入队翻译。
4. 翻译链：词典直译 → 结果缓存（10 分钟）→ 服务商（注入术语表）→ 失败按
   `fallbackProviders` 依次回退。主服务商单次上限约 20s。
5. 译文进环形缓冲（最近 300 条），悬浮窗轮询 `/api/v1/overlay/messages` 取回显示。
6. 会话标识 `session`：桥重启 / 进新一局（日志被重写）/ 游戏退出都会变，
   悬浮窗据此清屏，避免上一局聊天残留。

## 3. 消息流（发）—— 剪贴板

- 悬浮窗输入中文 → `POST /api/v1/overlay/translate` → 译成英文 → 写入系统剪贴板。
- 用户回游戏，打开聊天按 `Ctrl+V` **手动粘贴**发送。
  （游戏侧收不到任何外部数据，无法自动把文字注入游戏输入框。）
- 早期「接管 `chat.xml` 的 `oninputsubmit` 做发送前翻译」的游戏内出站路径，
  随网络能力一并失效，不再保留。

## 4. 桥协议（受限，非通用代理）

| 端点 | 方法 | 说明 |
| --- | --- | --- |
| `/api/v1/overlay/messages` | GET | 悬浮窗轮询：最近聊天 + 会话标识 + 目标语言 |
| `/api/v1/overlay/translate` | POST/GET | 悬浮窗出站：中文 → 英文（供复制） |
| `/api/v1/translate` | POST/GET | 通用翻译 `{text,sourceLanguage,targetLanguage,provider?}` |
| `/api/v1/test` | POST/GET | 用当前配置翻译固定文本，验证连通性/Key |
| `/api/v1/config` | GET/POST | 读（打码）/ 写（支持打码回传）配置 |
| `/api/v1/health` | GET | 健康检查（版本、当前服务商、回退链） |
| `/api/v1/log` | POST/GET | 写一条聊天日志（旧游戏内通道，现由 console.log 通道替代） |
| `/api/v1/diag` | POST/GET | 游戏侧诊断信息写入桥日志 |
| `/overlay` | GET | 网页版悬浮窗（`overlay.mode="web"` 时的回退） |
| `/bridge` | GET | 旧游戏内面板页面（已废弃，仅诊断用） |

安全：仅监听 `127.0.0.1`；请求体 ≤ 64KB；单文本 ≤ 4000 字符；无任意 URL 代理；
日志不含 apiKey；apiKey 只在本地 `config/config.json`（`.gitignore` 忽略）。

## 5. 配置

- **桥配置**（`config/config.json`，含 apiKey）：由悬浮窗设置面板经 `/api/v1/config`
  写回，或手动编辑。首次运行从 `config/config.example.json` 生成。
- **悬浮窗/字幕偏好**：`overlay.*`（`view` / `edge` / `opacity` / `background` / `accent` /
  `subtitle.*` 等），同样保存在 `config/config.json`。
- **进程与开窗**：`watchGame`（默认 `false` = 桥常驻，游戏退出只关悬浮窗）、
  `overlay.autoOpen`（检测到游戏启动时自动开窗）。

## 6. 游戏内身份采集（SteamID）

- 顶栏条目本身不含 steamid，steamid 只存在于悬停资料卡；主动模拟悬停会抢鼠标控制，
  已移除。
- 被动采集：ESC 玩家行（`players_list_entry.xml` 隐藏 `{i:r:account_id}`）、
  资料卡（`profile_card.xml` / `citadel_db_page_profile.xml`），零交互。
- 桥端 `steamid_enrich.js` 在赛后按公开 API 补全整局 roster，写 `identity_cache.json`；
  本机身份由桥端从 `console.log` 连接行回填。

## 7. 复用与扩展

- 新增翻译服务商：`core/providers/` 新增文件并在 `registry.js` 注册即可，游戏侧无需改动。
- 术语表：`core/glossary.js`（英雄中英名 / 商店装备 / 战术术语），注入每次翻译提示词。
- 多语言：设置面板改 `targetLanguage` 即可。

## 8. 历史（已废弃）

- **隐藏 HTML 面板 + 轮询 `panel.title`**：Panorama 无法直接发 HTTP 时，
  用隐藏 HTML 面板加载 `/bridge` 页面，页面内 JS 同源调用受限 API，
  再把结果写回 `document.title`，Panorama 轮询读回。该通道在 2026-10-01 更新后
  彻底失效（面板不再创建浏览器实例，桥端 `/bridge` 请求计数为 0）。
- **`$.AsyncWebRequest` 直连**：同版本调用即同步抛错，已移除。
- `lingua_chat.js` 保留 `probeInboundChannels()` 作 canary：若引擎将来恢复 CEF/HTTP，
  会第一时间在日志中暴露。
