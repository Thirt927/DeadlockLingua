# 2026-10-01 更新后「最初版」(v1.0.x) 失效 —— 事因分析

> 分析对象：本仓库 `v1.0.0` 标签（2026-09-12 发布）那一版 mod，以及 2026-10-01 前后 Steam 推送的两轮
> Deadlock 更新。
> 依据：本仓库的代码 / 日志 / 历史记录（一手）+ 社区与官方 patch notes（二手）。
> 结论性质：**引擎层能力被移除**，不是配置、端口、防火墙或代码 bug。

---

## 0. 一句话结论

v1.0.x 的全部通信都建立在「Panorama 能发 HTTP、能收 HTTP」这一条上：

```
游戏内 LinguaChat ──$.AsyncWebRequest──▶ 本地桥 127.0.0.1:8791
                 └─隐藏 <HTML> 面板 SetURL──▶ /bridge 页面 ──写回 document.title──▶ 游戏读取
```

2026-10-01 16:00 的构建把这条链**两端同时拆掉**了：

- 出站：`$.AsyncWebRequest` 调用即抛 `AsyncWebRequest has been removed.`，新 `panorama.dll` 里连
  `"Make a web request (disabled)"` 这种字符串都有；
- 入站：隐藏 `<HTML>` 面板不再创建浏览器实例，`SetURL` 不报错但永远不发请求（桥端 `/bridge`
  请求计数为 **0**）。

同一时间窗内还出现 `gameinfo.gi` 被重置、HUD 布局被改写。所以旧版是三重打击叠加：
**mod 先加载不上 → 加载上了也发不出请求 → 发得出也收不回来**。代码层面无解，只能换传输层
（v2.0.0 悬浮窗 → v2.1.0 BTIPC）。

---

## 1. 时间线（本机可验证）

| 时间（北京） | 事件 | 证据 |
| --- | --- | --- |
| 2026-09-12 | v1.0.0 公开发布，双通道（AsyncWebRequest 直连 + HTML 面板回退） | `git show v1.0.0`；`CHANGELOG.md#v100` |
| 2026-09-29 ~ 09-30 | **City Never Sleeps**：地图重做、6 个新英雄、HUD 更新，官方明写「Updated engine code to the latest version of Source 2」「Improved anti-cheat」 | [SteamDB patch notes](https://steamdb.com/deadlock/patches)、[VGtimes](https://vgtimes.com/gaming-news/169343-valves-deadlock-gets-its-biggest-update-yet-six-new-heroes-a-reworked-new-york-and-a-new-player-record.html) |
| 2026-09-30 20:44–20:58 | **仍然正常**：桥日志 14 分钟里 35 条 `translate ok`（UTC 12:44–12:58） | `logs/bridge.log` 现存最老片段 |
| 2026-10-01 16:00:56 | Steam 推送构建 `buildid=25639407`；`deadlock.exe` / `pak01_dir.vpk` / `appmanifest_1422450.acf LastUpdated` 同值 | `docs/OPTIMIZATION_LOG.md` 第三十六轮 |
| 2026-10-01 16:04 起 | 游戏启动后桥端**零请求**；`[LCT] bridge online` 再没出现过 | 同上 + 第三十四/三十九轮 |
| 2026-10-01 白天 | v1.0.1：修 addons 路径、按新版原版重基线 HUD 布局 | `CHANGELOG.md#v101` |
| 2026-10-01 夜间 | v2.0.0：承认游戏内收发不可能，改游戏外 WPF 悬浮窗 | `CHANGELOG.md#v200` |
| 2026-10-09 | BTIPC 双向信道落地：console.log 上行 + Image 位信道下行，游戏内译文恢复 | `docs/btipc-v1.md`、`docs/architecture.md` |
| 2026-10-16 | v2.1.0 发布（`/tr` 设置面板 + 游戏内译文） | `CHANGELOG.md#v210` |

> 时间线里有一个容易误判的点：9/29 的 City Never Sleeps **没有**当场杀掉 HTTP（9/30 晚上还能翻）。
> 真正让 `AsyncWebRequest` 抛错的是 10/1 那个构建。两者同属一次引擎升级的收尾，但**故障时刻**以
> 10/1 16:00 为准。

---

## 2. 四层失效，按致命程度排序

### L1（最先发生）addons 根本没被挂载 —— `gameinfo.gi` 被更新重置

- 现象：游戏里连「译」按钮都没有，`/tr` 无反应，`console.log` 里搜 `LCT` **零命中**
  → 不是脚本报错，是 `lingua_chat.vjs_c` 从未执行。
- 根因：`game/citadel/gameinfo.gi` 的 `SearchPaths` 里没有 `Game citadel/addons`；游戏因此不挂载
  `addons/` 下任何 VPK，日志里关卡加载行始终是 `addons ()`。
- **不要手改**：手工往 `gameinfo.gi` 塞 `Game citadel/addons` 会直接触发
  `FATAL ERROR: ... Failed to parse KeyValues`（两种写法都试过）。正确做法是让 Deadlock Mod Manager
  重新应用一次补丁，它会写入引擎能接受的完整 `SearchPaths` 块。
- 社区侧完全一致：每次大补丁都会用 Valve 的原版覆盖 `gameinfo.gi`，所有文件级 mod 一起消失
  （[DeadlockSkins 的说明](https://deadlockskins.gg/blog/deadlock-skins-not-working)、
  [deadlockmods.app 的排查文](https://deadlockmods.app/deadlock-mods-not-working)）。
- 附带坑：旧版第三方 mod 若打包了老的 `scripts/abilities.vdata_c`，新引擎解析会崩
  （`m_eLosCheck: Error parsing string ... as int`）。当时逐个开包确认过的三个 mod（601444 / 664142 /
  681831）在作者更新前都不能启用。

### L2（致命）出站 HTTP 被引擎删除

- `$.AsyncWebRequest` 函数还在，但**调用即同步抛** `AsyncWebRequest has been removed.`；
  只做 `typeof === "function"` 判断会误判为可用，然后每次请求都失败。
- 新 `panorama.dll` 内可见字符串：`"Make a web request (disabled)"`、
  `"ERROR: AsyncWebRequest has been removed"`（10/1 当天记录，见 `docs/OPTIMIZATION_LOG.md` 第三十六轮）。
- 没有相关 convar 能打开。`-unrestrictedwebrequests` 那类启动参数是**其它** Source 2 游戏给
  Panorama 白名单用的（[Momentum Mod 的更新日志](https://blog.momentum-mod.org/page/4/)），Deadlock 没有。
- v1.0.0 里所有桥调用都走它：`httpGetJson()`、`buildApiUrl()`、翻译/日志/配置/健康检查。

### L3（致命）入站 CEF 被引擎删除

- 隐藏 `<HTML id="LCTBridgePanel">`（`v1.0.0` 的 `chat.xml` 第 224–225 行声明）是旧版的回退通道：
  `SetURL("/bridge?...")` → 页面 JS 把结果写进 `document.title` → Panorama 轮询读回。
- 10/1 后：面板**确实会被渲染**（对局内实测 `geom 3x3`，不是 0×0），但 `SetURL` 不抛错、
  `panel.title` 永远 `undefined`、桥端 `/bridge` 加载**历史计数 0** —— 引擎不再为 HTML 面板建浏览器实例。
- 这条结论是通过「桥端有没有收到请求」这种无法伪造的证据确认的，不是靠面板属性猜的。

### L4（放大器）桥与面板的旧设计缺陷，让故障看起来像「随机」

- 桥进程没有 `uncaughtException` / `unhandledRejection` 兜底 → 定时任务里一次异常就静默退出，
  日志停在某一刻，用户只看到「昨天还好好的」。
- 开机自启项被任务管理器禁用（`StartupApproved` 首字节 `0x03`），且自启脚本用裸 `node`（版本与手动启动
  不一致）→ 表现为「桥没起来」。
- 旧面板通道有个硬缺陷：**只要面板第一次导航时桥不可达，这个面板在整局里就永久僵死**
  （之后 `SetURL` 不再发请求），重启桥完全无效，只能重开游戏。10/1 当天大量「重启桥没用」的抱怨都来自这里。

另有一条**用户环境**原因，不属于 Valve：Deadlock Mod Manager 把 mod 的 VPK 改名成
`local-..._pak22_dir.vpk` 并写 `.dmm.json {enabled:false}`，等于在 DMM 里被禁用。

---

## 3. 为什么「改代码」救不了 v1.0.x

| 想做的事 | 可用原语 | 结果 |
| --- | --- | --- |
| 游戏内发请求到本地桥 | `$.AsyncWebRequest`（已删）、HTML 面板（无 CEF） | ✗ |
| 读本地文件 / 剪贴板 / convar | `$` 只有 29 个成员，无此类原语 | ✗ |
| 用 `BImageFileExists` 做 1 bit 入站 | 对 addons 里**实际存在**的文件也返回 `false` | ✗ |
| 用引擎命名空间取数据 | `Game / Players / GameStateAPI / ...` 15 个命名空间实测 `present=(none)` | ✗ |

所以 10/1 当晚的结论（v2.0.0）是：**游戏内收发网络在架构上不可能**，只能把译文搬到游戏外。

⚠️ 这个结论后来被自己推翻了，原因值得记住：那轮探针只覆盖了「Panorama JS 能主动发起」的入口，
漏了「**引擎为了渲染会自己去取什么**」——`<Image>` 面板的加载状态。图片加载在渲染管线里发起，
不走 JS 的 HTTP API，所以 `AsyncWebRequest` 被删**不影响它**。这就是 v2.1.0 的 BTIPC 下行：

| 桥返回 | 游戏侧观察 | 位 |
| --- | --- | --- |
| `200` + PNG | `ImageLoaded` 触发 | 1 |
| `404` | 600ms 内静默 | 0 |

128 个 2×2 隐藏 Image = 128 bit = 16 字节/轮，有效载荷 10 字节/轮（≈16 B/s）。上行则退回
`console.log`（`[LCT] BTIPC REQ ...`，**硬依赖 `-condebug`**）。

---

## 4. 社区视角：这不是本 mod 的特例

- **同一周大量 mod 一起失效**，原因高度集中在同一批东西：`gameinfo.gi` 被重置、HUD 布局被改写、
  引擎内部行为变化。典型例子是 Jump School 作者 10/01 的公告：新补丁后无法再隐藏「依赖体力」的英雄，
  `m_bDisabled` 那套办法被 `m_eHeroDevelopmentState` 取代
  （[mod 页面](https://deadlockskins.gg/mods/jump-school-map-maps)、
  [论坛帖](https://forums.playdeadlock.com/threads/cant-hide-heroes-anymore-with-mods.167503/)）。
- 旧版健康条恢复技巧（`citadel_unit_status_use_v2`）在 City Never Sleeps 后也失效了
  （[esports.gg](https://esports.gg/guides/deadlock/how-to-get-updated-health-bars-in-deadlock/)），
  说明被改的是 UI/引擎层，而不是某个资源文件。
- HUD / 布局类 mod 在补丁后最常见的报错是 `Unable to load layout file 'panorama/layout/...'`
  —— 旧布局与新原版对不上（[deadlockmods.app](https://deadlockmods.app/deadlock-fatal-error-unable-to-load-layout-file)）。
  本仓库 10/1 的 v1.0.1 做的正是同一件事：按新版原版逐个文件重基线。
- 生态层面的应对也一致：**别手改 `gameinfo.gi`，交给 Deadlock Mod Manager 重新应用**；
  更新 DMM、检查冲突、重启整个客户端。
- 大背景：Deadlock **没有官方 mod API**，所有 mod 都是「把文件放到引擎会看的位置」。任何动到引擎配置
  或 UI 的补丁都可能一次性抹掉整套 setup —— 这是系统性风险，不是本项目独有的倒霉。

---

## 5. 项目后来怎么活的（对应仓库现状）

| 版本 | 传输层 | 状态 |
| --- | --- | --- |
| v1.0.0 | AsyncWebRequest 直连 + HTML 面板回退 | 10/1 起全废 |
| v1.0.1 | 同上 + 修 addons 路径 / 布局重基线 | 只能恢复「加载」，恢复不了「通信」 |
| v2.0.0 | 单向 `console.log → 桥 → 游戏外 WPF 悬浮窗` | 能用，但要另开窗、发消息靠剪贴板 |
| v2.0.1 | 同上，悬浮窗路线收官 | — |
| v2.1.0 | **BTIPC**：`console.log` 上行 + Image 位信道下行 | 译文回到游戏内聊天行；`-condebug` 必做 |

现仓库里旧通道代码**没有删**，而是关在 `PANEL_CHANNEL_ENABLED = false` 后面（`mod/panorama/scripts/lingua_chat.js`
第 3634 行附近），`chat.xml` 第 307–308 行那个 `<HTML id="LCTBridgePanel">` 也还留着。
这么做的理由：万一 Valve 哪天把 CEF / AsyncWebRequest 放回来，改一个常量就能当备用通道用；
代价是每次读代码都要知道它现在是死的。

---

## 6. 如果你（或用户）还停在 v1.0.x

1. **升级到 v2.1.0**（GitHub Release）。v1.0.x 在现行客户端上没有任何修复空间，不是配置问题。
2. 用 **Deadlock Mod Manager** 重新应用一次 addons 路径；**不要手改 `gameinfo.gi`**。
3. 启动参数必须有 **`-condebug`**（`StartDeadlock.bat` 已带）。没有它就看不到 `console.log`，
   表现是「装了完全没反应」。
4. 排查顺序：`console.log` 里有没有 `[LCT] loaded ...` → 桥 `http://127.0.0.1:8791/api/v1/health`
   → `logs/bridge.log` 里有没有 `BTIPC TRQ` / `BTIPC: r=.. seq=.. OK`。
5. 同时启用其它旧 mod 时，先确认它们没有打包旧的 `abilities.vdata_c` / 旧布局文件，否则会 FATAL 或
   互相覆盖。

---

## 7. 未解与风险

- **无法二次验证 DLL**：本文引用的 `panorama.dll` 字符串证据来自 10/1 当天的记录；当前这台机器上没有
  Deadlock 安装，无法复现取证。若要写进对外文档，建议保留「当时实测」的措辞。
- **窄带信道的物理上限**：BTIPC ≈16 B/s，一条 60 字节译文约 4 秒；诊断、日志镜像这类重复流量不能走它。
- **仍依赖 Valve 不动的两件事**：引擎继续为 `<Image>` 发请求；`console.log` 继续可写。任一改变，
  v2.1.0 也会像 v1.0.x 一样一夜失效 —— 这不是危言耸听，10/1 已经演过一次。
- **布局覆盖持续漂移**：每次 HUD 更新都要重新对基线（10/1、10/14 都做过），这是覆盖式 mod 的长期维护成本。

---

## 附录：证据索引

| 断言 | 证据 | 位置 |
| --- | --- | --- |
| 10/1 16:00:56 推送 build 25639407 | `deadlock.exe` / `pak01_dir.vpk` mtime + `appmanifest_1422450.acf` | `docs/OPTIMIZATION_LOG.md` 第三十六轮（约 766–775 行） |
| 新 dll 禁用了 web request | `panorama.dll` 字符串 + 调用即抛 | 同上 |
| HTML 面板不再建 CEF | 面板 `geom 3x3`、`title` 全空、桥端 `/bridge` 计数 0 | 第三十九 / 四十六轮 |
| addons 路径丢失与修法 | `gameinfo.gi` SearchPaths、手改触发 KeyValues FATAL | 第三十三轮 |
| 旧版依赖点 | `$.AsyncWebRequest`、`ensurePanel()`、`SetURL`、`document.title` 轮询 | `git show v1.0.0:mod/panorama/scripts/lingua_chat.js`（约 3494–3920 行） |
| 9/30 仍正常 | 35 条 `translate ok`（UTC 12:44–12:58） | `logs/bridge.log` |
| 新方案 | BTIPC 规格与实现 | `docs/btipc-v1.md`、`docs/architecture.md` |
| 发布记录 | v1.0.1 / v2.0.0 / v2.1.0 | `CHANGELOG.md` |
