# 架构文档

> **本文描述 v2.1.0（2026-10-09）起、并在 2026-10-24 加入 https 面板通道后的现状。**
>
> 下行有两级：**https 面板（主，≈一个 RTT）** → **BTIPC 位泵（兜底，16 B/s）**。
> - https 面板：隐藏 HTML 面板加载 `https://localhost:8792/bridge`，页面同源 fetch `/api/v1/*`
>   后把整条结果写 `document.title`；游戏侧导航 + 读 title。见 [https-panel.md](https-panel.md)。
> - BTIPC：上行 `console.log` 单行，下行 128 个 Image 面板按位读 HTTP 状态码（200/404）。
>
> 上行始终是 `console.log`（`[LCT] BTIPC REQ` / `[LCT-CHAT]`），**硬依赖 `-condebug`**。
> BTIPC 协议以 [btipc-v1.md](btipc-v1.md) 为唯一契约（帧格式 / 轮次 / CRC / 重试 / 参数表）。
>
> **游戏外悬浮窗自 v2.0.1 起归档为 legacy**（代码保留、不再演进），其管道见第 8 节。
> v2.0.0「游戏内不可能显示译文」与「面板已死」两个结论都已更正，见第 9、10 节。

## 1. 总览

```
┌──────────────────────── 游戏进程(Panorama) ────────────────────────┐
│  lingua_chat.js                                                     │
│   扫描聊天行 → 去重 / 缓存 / 语言启发式 → 串行队列(MAX_ACTIVE=1)    │
│   BTIPC 客户端(State 同层):                                      │
│     上行  $.Msg("[LCT] BTIPC REQ w=.. id=.. len=.. crc=.. b64=..")  │
│     下行  128 个隐藏 2×2 <Image> 面板逐轮 SetImage("/btipc/dl?...") │
│           ImageLoaded 到达 = 位1,静默 = 位0 → 组 16 字节 → CRC 校验 │
│   译文由 injectTranslation() 追加为聊天行下的 Label                 │
└───────────┬──────────────────────────────────┬──────────────────────┘
            │ 上行:console.log(需 -condebug)   │ 下行:GET /btipc/dl?w&r&p&t
            ▼                                  │  (状态码即数据:200 / 404)
┌──────────────────────── 本地桥 Node.js(core/) ──────────────────────┐
│  overlay.js: 增量 tail console.log                                  │
│     ├→ [LCT-CHAT] 行 → 去重 → 翻译链 → 环形缓冲(悬浮窗用,legacy)   │
│     ├→ [LCT] [diag] 行 → 写进 logs/bridge.log                       │
│     └→ [LCT] BTIPC REQ 行 → btipc/transport 校验 → 建窗 → 翻译       │
│  btipc/{crc16,framer,window,transport}.js:                          │
│     帧编解码(16B/帧,载荷 10B)+ 窗口表 + 轮次语义 + GC               │
│     GET /btipc/dl:按 (w,r) 幂等发帧;**逐面板**回第 p 位(200/404)   │
│  providers/*: bing(免Key)/microsoft/openai/deepl/google + 回退链    │
│  glossary / dictionary: 术语表注入 + 自适应词典 + 结果缓存          │
│  steamid_enrich.js: 赛后按公开 API 回填整局 SteamID                 │
│  HTTP 监听 127.0.0.1:8791                                          │
│   /btipc/dl  /api/v1/translate|test|config|health|quickchat|…      │
│   /api/v1/overlay/messages|translate(悬浮窗,legacy)               │
└────────────────────────────┬────────────────────────────────────────┘
                             │ HTTP(仅本机)
                             ▼
┌──────────── 游戏外悬浮窗(scripts/overlay_window.ps1,legacy)────────┐
│ 原生 WPF:面板窗 + 字幕浮层(鼠标穿透);轮询 /api/v1/overlay/messages │
│ 出站:输入中文 → /api/v1/overlay/translate → 写剪贴板 → 手动粘贴     │
│ 保留可用,但不再是主显示路径                                        │
└────────────────────────────────────────────────────────────────────┘
```

## 2. 消息流(收)—— BTIPC 双向

1. `lingua_chat.js` 扫描聊天行(0.2s / 0.8s 两档),签名去重、写过缓存、跳过自己的消息与
   已目标语言的消息。
2. 入队(串行,`MAX_ACTIVE_REQUESTS = 1`)→ `dispatchJob` → `dispatchViaBtipc`。
3. **上行**:按信封拼请求(见 [btipc-v1.md §4.1](btipc-v1.md)),`$.Msg` 出一行
   `[LCT] BTIPC REQ w=<6hex> id=<4hex> len=<字节> crc=<hex4> b64=<payload>`;payload ≤ 680 字节。
4. 桥端 `overlay.js` 增量 tail 该文件(记录字节偏移 + 尾部指纹,检测游戏重写日志),
   把 `BTIPC REQ` 行交给 `btipc/transport` 做六项校验(行长 / 行尾锚定 / w / id / len / crc / b64),
   全过才建窗并开始翻译;任一不过**静默 drop**。
5. **翻译链**:词典直译 → 结果缓存(10 分钟)→ 服务商(注入术语表)→ 失败按
   `fallbackProviders` 回退。桥侧最终**总有一个字符串**(翻译失败则回原文)。
6. 桥把结果 `framer.encode()` 成 16 字节/帧的队列。`T_CLOSE`(600ms)后游戏侧闭合一轮:
   128 位 → 16 字节 → CRC 校验 seq/id/VALID/LEN → 按 `seq` 拼装;`END=1` 即完成。
7. `injectTranslation(row, sig, text)` 在聊天行下方建/更新一个 `Label`(浅蓝底斜体);
   聊天滚动回收后由 `restoreFromCache()` 按签名重建。

带宽现实:**有效载荷 ≈10 字节/轮(≈16 B/s)**,60B 译文约 4s。所以诊断、聊天日志镜像等
重复流量一律**不走**这条通道(见第 7 节)。

## 3. 消息流(发)—— 游戏内发送前翻译

- `chat.xml` 的输入框提交由 `LCTOnChatSubmit()` 接管;开启发送前翻译时先经 BTIPC 把中文
  译成目标语言(信封 `t=<target>`),再派发原版提交事件,由游戏自己的链路发出。
- 通道失败 / 超时 → **按原文发送**(不阻塞用户)。
- 悬浮窗的剪贴板路线(译好写剪贴板 → 用户回游戏 `Ctrl+V`)作为 legacy 备选保留。

## 4. 桥协议(受限,非通用代理)

| 端点 | 方法 | 说明 |
| --- | --- | --- |
| `/btipc/dl?w&r&p&t` | GET | **BTIPC 下行**。取窗口 `w` 第 `r` 轮的帧,**逐面板**回第 `p` 位:位=1 → `200`+PNG,位=0 → `404`。详见 [btipc-v1.md §6](btipc-v1.md) |
| `/api/v1/translate` | POST/GET | 通用翻译 `{text,sourceLanguage,targetLanguage,provider?}` |
| `/api/v1/test` | POST/GET | 用当前配置翻译固定文本,验证连通性/Key |
| `/api/v1/config` | GET/POST | 读(打码)/ 写(支持打码回传)配置 |
| `/api/v1/health` | GET | 健康检查(版本、当前服务商、回退链) |
| `/api/v1/quickchat` | GET | 快捷语音模板语料 |
| `/api/v1/gamenames` | GET | 英雄/装备名保护名单 |
| `/api/v1/log` | POST/GET | 写一条聊天日志(现由 `console.log` 通道主导) |
| `/api/v1/diag` | POST/GET | 游戏侧诊断信息写入桥日志 |
| `/api/v1/overlay/messages` | GET | 悬浮窗轮询:最近聊天 + 会话标识 + 目标语言(legacy) |
| `/api/v1/overlay/translate` | POST/GET | 悬浮窗出站:中文 → 英文(legacy) |
| `/overlay` | GET | 网页版悬浮窗(legacy) |
| `/bridge` | GET | 旧游戏内面板页面(已废弃,仅诊断用) |

**上行走 `console.log`,不走 HTTP**:游戏 → 桥没有请求端点。
安全:仅监听 `127.0.0.1`;请求体 ≤ 64KB;单文本 ≤ 4000 字符;无任意 URL 代理;
日志不含 apiKey;apiKey 只在本地 `config/config.json`(`.gitignore` 忽略)。

## 5. 配置

- **桥配置**(`config/config.json`,含 apiKey):由悬浮窗设置页经 `/api/v1/config` 写回
  (提交要包成 `{config:{...}}`,读取要解包 `{ok, config:{...}}`),或手动编辑。
  首次运行从 `config/config.example.json` 生成。
- **游戏侧 UI 偏好**(`enabled` / `displayMode` / `outgoing` / `outgoingTarget` / `force` /
  `timeoutMs` / `targetLanguage`):由 `lingua_chat.js` 从桥配置同步,不包含任何密钥。
- **悬浮窗 / 字幕偏好**:`overlay.*`(`view` / `edge` / `opacity` / `background` / `accent` /
  `subtitle.*` 等),同样落在 `config/config.json`(legacy)。
- **进程与开窗**:`watchGame`(默认 `false` = 桥常驻)、`overlay.autoOpen`。
- **`deadlockConsoleLog`**:游戏 `console.log` 路径,桥启动时自动探测;不存在即说明游戏
  没带 `-condebug`。

## 6. 游戏内身份采集(SteamID)

- 顶栏条目本身不含 steamid,steamid 只存在于悬停资料卡;主动模拟悬停会抢鼠标控制,已移除。
- 被动采集:ESC 玩家行(`players_list_entry.xml` 隐藏 `{i:r:account_id}`)、
  资料卡(`profile_card.xml` / `citadel_db_page_profile.xml`),零交互。
- 桥端 `steamid_enrich.js` 在赛后按公开 API 补全整局 roster,写 `identity_cache.json`;
  本机身份由桥端从 `console.log` 连接行回填。

## 7. 复用与扩展

- 新增翻译服务商:`core/providers/` 新增文件并在 `registry.js` 注册即可,游戏侧无需改动。
- 术语表:`core/glossary.js`(英雄中英名 / 商店装备 / 战术术语),注入每次翻译提示词。
- 多语言:改 `targetLanguage` 即可。
- **改 BTIPC 任一侧必须同步另一侧**:游戏侧把 crc16 / 位序 / UTF-8 / base64 都内联了一份副本
  (Panorama 无模块系统)。改完跑 `tests/btipc/*` 与 `scripts/lingua_chat_simtest.js`。
- **不要把窄带通道当通用管道用**:位信道 ≈16 B/s,诊断 / 日志镜像 / 大配置同步这类流量
  要保持走 `console.log` 或按需触发,否则单槽队列会被堵死(第六十五轮实测踩过)。

## 8. 历史与 legacy

### 8.1 已废弃的通道

- **隐藏 HTML 面板 + 轮询 `panel.title`**:用隐藏 HTML 面板加载 `/bridge` 页面,页面内 JS
  同源调用受限 API,再把结果写回 `document.title`,Panorama 轮询读回。2026-10-01 更新后
  对 `http://` / `data:` / `file://` 均不加载(桥端 `/bridge` 请求计数为 0)。
  ⚠️ 旧表述"面板不再创建浏览器实例"已于 2026-10-24 更正,见第 10 节。
- **`$.AsyncWebRequest` 直连**:同版本调用即同步抛错,已移除。

### 8.2 游戏外悬浮窗(v2.0.x 主路径,自 v2.0.1 起 legacy)

**代码保留、可用,但不再是主显示路径**:`core/overlay.js`、`core/overlay_page.html`、
`scripts/overlay_window.ps1` 及配套启动脚本。

原管道:游戏侧 `pushEntry()` 里 `$.Msg("[LCT-CHAT]" + 单行 JSON)` → 桥 `overlay.js` 增量 tail
→ 去重 → 翻译链 → 环形缓冲(最近 300 条)→ 悬浮窗轮询 `/api/v1/overlay/messages` 显示;
出站走"译好写剪贴板 + 用户 `Ctrl+V`"。会话标识 `session` 在桥重启 / 进新一局 / 游戏退出时变化,
悬浮窗据此清屏。

这条线仍被复用:桥端 **聊天日志落盘**(`logs/chat/<matchId>.jsonl`)与 **`[diag]` 回收**
都挂在同一个 `console.log` tail 上(见第 1 节)。

### 8.3 探针退役

`lingua_chat.js` 的 `probeInboundChannels()` 曾用运行时创建的 `<HTML>` 面板 + `SetURL` 判断
"游戏内还能不能收到外部数据"。它有两个问题:每次启动都建一个真会被渲染的面板;以及**覆盖有
盲区**(漏了 Image 位信道)却给出否定答案。第六十五轮已退役其面板/文件探针,只留一行
`$` 成员表。

## 9. 更正:入站通道并未被穷尽(2026-10-09)

v2.0.0 写下的结论「游戏内不存在任何可用的入站通道,在游戏内显示译文在架构上不可能」
**不成立**。那轮探针只覆盖了「Panorama JS 能主动发起」这一类入口
(`$.AsyncWebRequest` / HTML 面板 `SetURL` / 剪贴板 / `BImageFileExists`),
漏了另一类:**引擎为了渲染会自己去取什么**。

`<Image>` 面板的**加载状态**可以当 1 bit 用:

| 桥返回 | 游戏侧观察 | 位值 |
| --- | --- | --- |
| `200` + PNG | `ImageLoaded` 事件触发 | **1** |
| `404` 空体 | `T_CLOSE`(600ms)内静默 | **0** |

**为什么能成立**:图片加载由引擎在**渲染管线里自行发起**,不走 Panorama JS 的 HTTP API,
所以 `AsyncWebRequest` 被移除不影响它。入站不需要 JS 原语,只需要一个"引擎会去取网络的
声明式入口"。

- 上行仍复用现成通道:`console.log` 结构化单行,**硬依赖 `-condebug`**。
- 完整规格(帧格式 / 轮次状态机 / CRC / 重试 / 风暴模式 / 参数表)见 **[btipc-v1.md](btipc-v1.md)**。

## 10. 更正(2026-10-24):面板通道"彻底失效"只对 http/data/file 成立

§8.1 与 §9 的旧口径("引擎不再为 HTML 面板创建浏览器实例")**不成立**。上游 BabelTower
2026-10-15 实车证实:引擎在 LoadPage 之前按**证书链**拒绝未受信任的页面(实机 neterror
`error:-202` = `ERR_CERT_AUTHORITY_INVALID`);把本机自签证书(CN=BabelTower-localhost,
SAN=`DNS:localhost` + `IP:127.0.0.1` + `IP:::1`)写入 `CurrentUser\Root` 并**完全退出重启
Steam** 后,隐藏 HTML 面板可加载 `https://localhost:8792`,由页面同源 fetch 取整条译文再写
`document.title` 回读 —— 下行 **<1s**(位泵 3.0–27.4s)。

桥侧为此需要:独立 TLS 终结进程(8792 → 转发 8791;证书缺失 `exit(3)`,不得连带 BTIPC)、
证书生成/信任/撤销脚本、mod 侧开机探针(1.2s 一次,判死整局退 BTIPC)与三级降级。

**本仓库 2026-10-24 起已实现**(待实车验收):`core/bridge_https.js`(8792 TLS 终结,独立进程;
证书缺失 `exit(3)`,上游不通 502 不退出)、`scripts/gen_bridge_cert.ps1`(生成/信任/撤销)、
`config.https`(enabled/port/pfx/passFile)、桥端 `op=ui` 的 `httpsPanel`/`httpsPort` 能力位、
游戏侧 `lingua_chat.js` 的 `HTTPS_PANEL_*`(开机探针一次定生死、硬失败交回 BTIPC、
连续 3 次硬失败整局退位泵)。设计与排障见 [https-panel.md](https-panel.md)。

上游证据链:该文档 §2.4(结论修正史)、§4.1(Steam 信任缓存双向实测)、§8.1(同局 1 秒闭环)。
https://github.com/c1375rick/BabelTower/blob/main/docs/btipc-https-v1.md
