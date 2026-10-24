# LCTNative 设计文档

> **状态：设计 + 工程骨架，未编译、未实机验证（2026-10-24）。**
> 本文写清楚"哪些是已定的设计、哪些是待验证的假设"，未验证项集中在第 8 节。
> 背景与动机来自本仓库既有文档：`docs/from-scratch-architectures.md`（架构 B）、
> `docs/architecture.md`、`docs/btipc-v1.md`、`LICENSE_NOTICE.md`。

---

## 1. 背景与目标

### 1.1 现状（架构 C：Panorama + 位信道）

2026-10-01 的 Deadlock 更新移除了 `$.AsyncWebRequest`（调用即抛），隐藏 HTML 面板对
`http://` 等未受信任页面不再加载。能"把译文送进游戏"的通路有两条：
①`<Image>` 加载状态当 1 bit 用（BTIPC：**≈16 B/s、60 字节译文要 2~4 秒**，端到端 5~7 秒）；
②**受信任 https 面板通道**（上游 BabelTower 2026-10-15 实车：自签证书 + `CurrentUser\Root` +
完全重启 Steam，页面同源 fetch 整条结果，下行 <1s）——**本仓库 2.1.0 未移植 ②**。

### 1.2 本项目的目标（架构 B：原生 mod）

在游戏进程内直接做三件事：

1. 从 `console.log` 的 `[LCT-CHAT]` 行拿到聊天（现有 mod 已经免费写出来了）；
2. 用进程内 **WinHTTP** 调本机桥 `127.0.0.1:8791`，绕开被移除的 Panorama HTTP；
3. 用 **Direct2D/DWrite** 把译文画在游戏窗口的聊天区域上。

端到端延迟从"翻译 + 位信道"降到"翻译 + 一次本机 HTTP"，即 **≈0.7~2.3 秒**
（取决于 provider 本身耗时），代价是反作弊风险与每次游戏更新后的维护。

### 1.3 先明确：本设计的"成功"是什么

成功 = **译文稳定、低延迟地出现在本地玩家屏幕上，且游戏不崩、不因它被检测**。
不追求"译文进入游戏自己的聊天记录、可滚动、可翻历史"——那是 Tier 2 的目标，
Tier 1 刻意不做（见 4.1）。

---

## 2. Tier 划分

| Tier | 内容 | 本次交付 | 价值 | 风险/成本 |
| --- | --- | --- | --- | --- |
| **1** | 进程内 DX 覆盖层：tail `console.log` → WinHTTP → D2D/DWrite 画在窗口上 | **可落地骨架** | 延迟回到 ≈1s，不碰 16 B/s 位信道 | 注入 + 渲染 hook；反作弊风险由用户承担 |
| **2** | hook Panorama，把译文作为 `Label` 插入聊天行 | **只设计，不实现** | 译文进入聊天记录，可滚动/保留历史 | 需要 sigscan + 引擎内部结构；维护成本 ×5~10 |
| **3** | 出站：把中文输入译文写回输入框/触发发送 | **只设计，不实现** | 不用手动复制粘贴 | 输入注入，可能被反作弊视为自动化 |

Tier 之间是**递进**关系：Tier 1 的 console.log、翻译客户端、配置、日志都可以被 Tier 2/3 复用；
Tier 2/3 各自独立决策，任一失败都不影响 Tier 1 继续可用。

---

## 3. Tier 1：进程内 DirectX 覆盖层

### 3.1 数据路径

```
┌──────────────────────── 游戏进程（deadlock.exe） ─────────────────────────┐
│  Panorama mod（现有 lingua_chat.js，未改动）                              │
│    pushEntry() → $.Msg("[LCT-CHAT]{...}")                                 │
│                          │ console.log（需 -condebug）                    │
│                          ▼                                                │
│  LCTNative.dll ── LogTail 增量读文件（250ms 轮询，半行缓冲，重写检测）    │
│      │  解析 [LCT-CHAT]{"o","n","t"} → ChatLine                           │
│      ├─ 过滤：自己发的 / 已是中文 / 空                                     │
│      ├─ D3D11Overlay.AddLine()  ← 先画原文 + "…"（pending）               │
│      └─ TranslateClient.Submit() → 有界队列 → worker 线程                 │
│                                    │ WinHTTP POST 127.0.0.1:8791          │
│                                    │ {"text":"...","targetLanguage":...}  │
│                                    ▼                                      │
│                          本机桥 Node（现有 core/bridge_server.js）         │
│                                    │ provider 翻译（≈0.7s）               │
│                                    ▼                                      │
│                          {"ok":true,"translation":"..."}                  │
│      callback → D3D11Overlay.UpdateTranslation(seq, 译文)                 │
│                                    │                                      │
│  Present 钩子（游戏每帧调用）→ D2D/DWrite 把最近 N 条画在 chatRect 上     │
└───────────────────────────────────────────────────────────────────────────┘
```

设计要点：

- **游戏侧零改动**：不重新打包 VPK、不依赖 BTIPC；`[LCT-CHAT]` 是现有 mod 已在写的通道。
- **桥侧零改动**：复用现有 `/api/v1/translate`，请求/响应格式与 `core/bridge_server.js`
  的 `handleApi` 一致（`{"text","targetLanguage"}` → `{"ok":true,"translation"}`）。
- **失败不阻塞**：翻译失败只把该行标记为"失败"，保留原文；队列满就丢行并限频告警。

### 3.2 线程模型

| 线程 | 谁创建 | 职责 | 安全边界 |
| --- | --- | --- | --- |
| init thread | `DllMain`（attach 时） | `EnsureStarted()`：日志、配置、装 hook、启动 worker | 不碰游戏状态；`DllMain` 里只做最小工作 |
| tick thread | `EnsureStarted` | 250ms tail、1s 配置热重载、100ms 热键轮询 | 唯一写 `config_` 的线程 |
| translate worker | `TranslateClient` | 串行 WinHTTP 请求 + 回调 | 队列有界（64），超时（resolve 2s / connect 2s / send 4s / receive 8s） |
| render thread | 游戏自己的 Present 线程 | D2D 绘制 | 只读快照；所有绘制失败只关覆盖层 |

共享数据只有三处，均有锁：

- `D3D11Overlay::lines_ / settings_`（`stateMutex_`）：tick 线程写、render 线程读快照；
- `D3D11Overlay` 的 D2D 资源（`resourceMutex_`）：render 线程 + `Uninstall()`；
- `TranslateClient` 的队列/配置（`mutex_` + condition variable）。

### 3.3 关键决策：为什么 Tier 1 用 Present vtable hook，而不是引擎 hook？

| 方案 | 依赖 | 游戏更新后存活 | 能进聊天记录 | 风险 |
| --- | --- | --- | --- | --- |
| **DXGI Present vtable hook（选它）** | 只依赖 DXGI 公共 COM vtable | **高**（DXGI 是系统/稳定 ABI） | 否 | 低：不改游戏代码，只换函数指针且可还原 |
| 引擎函数 inline hook（Tier 2） | 每次更新重找签名/偏移 | 低 | 是 | 高：改代码段、引用计数/对象生命周期都要对 |
| Panorama 脚本注入（Tier 2 路线） | 引擎内部结构 + 脚本 VM | 低 | 是 | 高 |

结论：

1. Tier 1 的目标只是"低延迟可见"，**不需要**钻进游戏 UI；
2. Present 是所有 D3D11/12 渲染的必经之路，hook 点稳定、实现小；
3. 纯 vtable 指针替换是**可逆**的（保存原指针 → 还原），天然满足"可安全 detach"；
4. 不动游戏代码段/堆数据，出问题的最坏情况是"覆盖层不显示"，不是"游戏被改坏"。

"译文进聊天记录"是 Tier 2 的独有价值，不能用 Tier 1 的复杂度去换。

### 3.4 Hook 机制与可卸载性

```
Install():
  1. 创建 2×2 隐藏窗口 + 临时 D3D11 设备/交换链（仅用于拿到 DXGI vtable）
  2. 收集 vtable：IDXGISwapChain + QI 到的 IDXGISwapChain1..4（去重）
  3. 对每个 vtable：
       slot[8]  = Present        → D3D11Overlay::PresentDetour
       slot[13] = ResizeBuffers  → D3D11Overlay::ResizeBuffersDetour
     （VirtualProtect 改可写 → 写入 → 恢复原保护）
  4. 释放临时对象，g_activeOverlay = this

PresentDetour():
  inFlight++
  try { OnPresent(swapChain); }            // /EHa：catch(...) 连 SEH 一起兜
  catch (...) { 记录一次日志，跳过本帧 }
  inFlight--
  return g_originalPresent(swapChain, ...) // 无论如何都要转发

Uninstall():
  1. g_activeOverlay = nullptr（新调用直接转发，不再进我们的逻辑）
  2. 还原所有 vtable slot 的原指针
  3. 等 inFlight == 0（最多 2s）
  4. 释放 D2D 资源
```

- **vtable 索引依据**：DXGI 头文件中 `IDXGISwapChain : IDXGIObject` 的声明顺序，
  Present 是第 8 项、ResizeBuffers 是第 13 项（0-based）。**未实测**（见第 8 节）。
- **为什么连 IDXGISwapChain1..4 一起 patch**：COM 接口继承在 vtbl 里是"复制一份基类槽位"，
  游戏若通过 `IDXGISwapChain3*` 调 Present，只 patch 基类 vtable 会被绕过。
  每个派生接口 QI 一次、按 vtable 指针去重后全部 patch。
- **ResizeBuffers 为什么也要 hook**：我们缓存了后缓冲的 `IDXGISurface` 引用；
  持有它会让游戏的 `ResizeBuffers` 返回 `DXGI_ERROR_INVALID_CALL`。detour 里先
  `ReleaseTarget()` 再转发，保证全屏切换/改分辨率/窗口拖拽不因我们而失败。
- **失败即降级**：probe 交换链创建失败、patch 失败、拿不到原指针 → `Install()` 返回 false，
  DLL 继续运行但**不绘制、不翻译**，游戏完全不受影响。

### 3.5 渲染（D2D1 / DWrite）

- 用 `IDXGISwapChain::GetBuffer(0)` 取当前后缓冲的 `IDXGISurface`，用
  `ID2D1DeviceContext::CreateBitmapFromDxgiSurface` 建 target bitmap。
- 翻页交换链（flip model）下每帧的 back buffer 可能不同：缓存"surface 指针 → bitmap"，
  指针变化就重建；`ResizeBuffers` 时先释放。
- DPI 固定为 96（1 DIP = 1 像素），所以 `chatRect` 和 `fontSize` 都是**后缓冲像素**语义，
  不随 Windows 缩放变化。这是 Tier 1 的简化（见 6.4）。
- 每行两条文本：
  - 第一行（暗色）：`昵称: 原文`；
  - 第二行（亮色）：译文；未到时画 `…`，失败则留空只显示原文。
- 行高按字号估算（`1.15×` / `1.5×`），超出矩形的行不画（底部对齐最新的行）。
  没有做文本测量/自适应换行，长译文会被 `D2D1_DRAW_TEXT_OPTIONS_CLIP` 截断。
- 后台有一个半透明圆角矩形，避免亮色地图上看不清字。
- 字体：`Segoe UI`，locale `zh-Hans`，由 DWrite 做缺字回退；**中文回退效果未验证**。
- 绘制异常（访问冲突等）由 SEH 兜住（该文件以 `/EHa` 编译，`catch (...)` 同时覆盖
  C++ 异常与结构化异常），只记一次日志；极端情况下覆盖层不显示，
  游戏照常渲染（原始 Present 始终被执行）。

### 3.6 聊天来源：`console.log` tail

现有 mod 的 `pushEntry()` 会写一行（见 `core/overlay.js` 顶部注释）：

```
<时间戳> [PanoramaScript] [LCT-CHAT]{"o":0,"n":"Alice","c":"chat","h":"","k":"chat","t":"hello"}
```

`LogTail` 的行为：

- **硬依赖 `-condebug`**：没有它游戏不写 `console.log`，本方案收不到任何东西（与 BTIPC 相同）。
- **路径**：`native.json` 的 `consoleLogPath` 优先；为空时从**当前进程映像路径**向上找
  `<dir>\game\citadel\console.log` 与 `<dir>\citadel\console.log`（最多 6 层），
  再加一次当前工作目录。**不硬编码任何本机绝对路径**。
- **增量**：记录字节偏移 + 末尾 256 字节指纹；文件变短或指纹不匹配 → 判定被游戏重写，
  从 0 重新读（与 `core/overlay.js` 同一思路）。
- **半行缓冲**：只处理 `\n` 结尾的完整行；最后一段残行留到下次。
- **截断保护**：单行超过 64 KB 直接丢弃并计数，避免内存无限增长。
- **解析**：`[LCT-CHAT]` 之后按 JSON 取 `t`（正文）、`n`（昵称）、`o`（是否自己）；
  用自研的极简 JSON 取值（`JsonFindMember`，不是完整解析器），不引第三方库。
- 首帧行为：**注入时从文件末尾开始**，不回放注入前的历史（避免一上来翻译整局旧聊天）。

### 3.7 翻译客户端

- 端点：`<bridgeUrl>/api/v1/translate`（默认 `http://127.0.0.1:8791/api/v1/translate`）。
- 请求体：`{"text":"<原文 UTF-8 转义>","targetLanguage":"zh-Hans"}`。
- 响应：`{"ok":true,"translation":"..."}`；`ok:false` 时读 `error` 字段作为原因。
- WinHTTP：`WINHTTP_ACCESS_TYPE_NO_PROXY`（本地桥不需要代理），
  超时 resolve 2s / connect 2s / send 4s / receive 8s。
- **单 worker 串行**：provider 通常有速率限制，串行最简单也最稳；
  队列上限 64，满了直接丢新行（退化为"这句不翻译"），**绝不阻塞游戏线程**。
- 失败处理：回调收到 `ok=false` → 覆盖层该行标记失败（只显示原文），不做重试
  （重试会把队列越堆越长；需要重试的话应由桥端 provider 回退链负责）。
- 日志只记录 `seq + 错误码`，**不记录聊天正文**。

### 3.8 配置（`native.json`，DLL 同目录）

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `bridgeUrl` | `http://127.0.0.1:8791` | 本机桥地址 |
| `consoleLogPath` | `""`（自动） | 显式路径，支持 `%ENV%` |
| `targetLanguage` | `zh-Hans` | 透传桥 |
| `chatRect` | `{x:0.01,y:0.61,w:0.30,h:0.36}` | 相对后缓冲的比例 |
| `fontSize` | `16` | 像素 |
| `maxLines` | `6` | 1~32 |
| `hotkey` | `F8` | 单键切换显示；空 = 关闭 |
| `enabled` | `true` | 总开关 |

- 加载策略：缺文件/缺字段用默认值；数值 clamp；坏字段记 WARN 并跳过。
- **热重载**：tick 每秒比较一次文件时间戳+大小，变化即重新加载（无需重启游戏）。
- 热键：tick 里 `GetAsyncKeyState` 轮询（100ms 去抖），只切换"显示/隐藏"，不改配置文件。

### 3.9 延迟预算（诚实数字）

| 环节 | 量级 | 说明 |
| --- | --- | --- |
| 游戏写 `console.log` | 未知（假设 ≤100ms） | Source 2 的 flush 行为未验证 |
| tail 轮询 | 0~250ms | 250ms 一拍 |
| 本机 WinHTTP 往返 | ~1~10ms | 127.0.0.1 |
| 桥翻译 | **0.5~2s** | provider 决定，与现有悬浮窗相同 |
| 队列等待 | 通常 0；突发时线性增长 | 串行 + 上限 64 |
| 下一帧绘制 | ≤16ms（60fps） | Present 钩子 |
| **端到端** | **≈0.7~2.3s** | 对比 BTIPC 现状 2.5~6s |

> 这里的"≈0.7s"是**翻译耗时本身**；加上 tail 轮询后现实值约 1s。
> 把它压到 0.7s 需要更快的 tail（`ReadDirectoryChangesW`/定时 100ms），Tier 1 未做。

### 3.10 Tier 1 刻意不做的

- 不把译文写进聊天记录（Tier 2）；
- 不做消息去重（现有 mod 一般一条聊天只写一次；顶栏气泡副本可能导致重复，未验证）；
- 不做历史回填；
- 不做文本测量/自动换行/滚动同步；
- 不做多显示器 DPI 自适应、HDR 色彩管理；
- 不做 Vulkan / D3D12 绘制；
- 不做 DLL 自注入/加载器（仓库不附带注入器）。

---

## 4. Tier 2：hook Panorama，把译文插进聊天行（只设计，不实现）

### 4.1 目标与复用的东西

目标：译文成为**聊天面板里真实存在的 UI 节点**（聊天行下方/上方的 `Label`），
随聊天滚动、随历史保留，与 `mod/panorama/scripts/lingua_chat.js` 现在的
`injectTranslation()` 效果一致。

可复用：console.log 通道可以退役（不再需要 BTIPC 双向）、翻译客户端、配置、日志。
不可复用：Tier 1 的 Present hook（绘制平面不同）。

### 4.2 需要的能力（全部是"待验证假设"）

1. 一个**进程内执行 Panorama 脚本**的入口（类似 `CPanoramaUIEngine::RunScript`），
   或者一个能**创建/修改 UI 面板**的引擎 API（`CPanel2D::Create` / `SetProperty` 等）；
2. 找到**聊天面板的句柄**（或聊天消息创建路径），能把 `Label` 挂到正确位置；
3. 引擎的字符串/数组结构布局（`CUtlString` / `CUtlVector` / JS 值）——否则参数传不对；
4. 一个**稳定的签名锚点**，每次游戏更新能重新定位上述函数（这正是 `hooks/sigscan.*` 的用途）。

> 名称来自 Source 2 逆向/社区资料，本仓库**未验证** Deadlock 当前版本存在这些符号。

### 4.3 两条候选路线

**路线 A：脚本注入（推荐先评估）**

- 找 Panorama 脚本执行入口，调用一次注入的 JS：
  让 JS 注册一个全局函数（或把桥数据塞进 `State`），由现有 `lingua_chat.js` 的
  渲染逻辑消费；数据仍由 DLL 通过共享内存/命名管道喂给注入的 JS。
- 优点：UI 操作全部在 JS 侧完成，不需要理解面板 C++ 结构；
- 难点：**怎么把 DLL 的数据交给 JS**（Panorama JS 没有文件/网络原语）；
  需要在脚本 VM 里注册一个 native 函数，或让 JS 轮询一个由 DLL 修改的引擎对象。
  这一步没有公开接口，大概率要 hook JS 绑定层。

**路线 B：直接 hook 聊天行创建，插 `Label`**

- 找"聊天消息被追加到 `ChatMessages` 面板"的路径（可能是 UI 消息 handler 或
  `CPanel2D` 的 `AddChild`），在消息创建后新建一个子 `Label` 写入译文；
- 优点：不依赖脚本 VM；
- 难点：面板对象生命周期/回收、样式属性、跨布局坐标、以及"译文行如何随聊天行一起被回收"。

两条路线都需要：**读输入框文本做预翻译**（Tier 3 的基础）和**滚动回收后重建**。

### 4.4 待验证点清单

| # | 要验证的东西 | 怎么验 | 成立判据 |
| --- | --- | --- | --- |
| 1 | 当前 Deadlock 是否仍加载 Panorama 脚本 VM | 查进程模块/字符串、`console.log` 里 `[PanoramaScript]` 行 | 能定位到脚本执行引擎，且能安全调用一个空函数 |
| 2 | 脚本执行入口的签名与调用约定 | sigscan 锚点 + 单机 bot 对局里调用 `$.Msg("x")` | 控制台出现 `x`，游戏不崩 |
| 3 | 能否从 native 注册可被 JS 调用的函数 | 在 VM 全局对象上挂钩子/反射 | JS 能调用并拿到返回值 |
| 4 | 聊天面板句柄/id 与创建路径 | UE 无关：遍历 `IUIPanel` 字段/`FindChildInContext` 等价物 | 能拿到 `ChatMessages` 面板对象 |
| 5 | 面板创建/属性设置 API 的结构体布局 | 对比多个版本的引擎头/逆向资料 + 单机验证 | 能创建一个 `Label` 并显示文字 |
| 6 | 稳定签名锚点数量 | 每次更新后跑 sigscan，统计命中 | 至少 2~3 个锚点跨更新存活 |
| 7 | 对象生命周期（聊天滚动回收） | 长对局反复滚动 | 译文不泄漏、不错位、不崩 |

### 4.5 风险

- 需要**改代码段/调用引擎内部函数**，一次参数错误就是崩溃，不是"覆盖层不显示"；
- 每次游戏更新可能全部失效，维护成本是 Tier 1 的 5~10 倍（与 `from-scratch-architectures.md`
  的判断一致）；
- 越深入引擎，越接近反作弊关注的行为（代码段修改、内部结构访问）；
- Panorama 的脚本/UI 线程模型未知，跨线程调用可能直接崩。

### 4.6 Kill criteria（任一成立就停止 Tier 2）

1. 2 周内找不到能安全调用（且能返回）的脚本执行入口；
2. 或找不到跨 2 个游戏版本的稳定签名锚点；
3. 或必须修改反作弊覆盖的内存/代码、或必须以 `-insecure` 启动才能工作；
4. 或单机 bot 对局中 20 次注入测试崩溃 >2 次；
5. 或工作量评估 >4 周（相对收益不值）。

停止后 Tier 1 保持现状；"译文进聊天记录"继续由 BTIPC（现状）承担。

---

## 5. Tier 3：出站（把译文写回输入框 / 触发发送）

### 5.1 目标

用户输入中文 → 翻译成英文 → 替用户填进聊天输入框（可选：替用户发送）。
现有 `overlay_window.ps1`（legacy）的做法是"译好写剪贴板 + 用户手动 Ctrl+V"，Tier 3 想省掉这一步。

### 5.2 候选方案

| 方案 | 原理 | 风险 | 依赖 |
| --- | --- | --- | --- |
| A. 剪贴板自动化 | 写剪贴板 + `SendInput` 模拟 `Ctrl+V`（可选再模拟 `Enter`） | 输入注入可能被反作弊视为自动化；与用户输入竞争；焦点/时序问题；可能误发 | 仅 Win32 |
| B. 引擎输入框（Tier 2 依赖） | 通过面板 API 设置 `ChatInput.text`，再派发原版提交事件 | 依赖 Tier 2 全部能力；仍然"代填"，但不需要模拟按键 | Tier 2 |
| C. 控制台/命令通道 | `-netconport` 等外部命令 | 需要额外启动参数、通道稳定性未知、安全面变大 | 外部进程 |

### 5.3 风险

- **反作弊**：模拟按键/自动发送属于自动化行为，比"只读渲染覆盖层"更接近外挂定义；
- **误操作**：Enter 时机不对可能把半成品发出去，或覆盖用户正在输入的内容；
- **竞态**：用户自己也在打字，剪贴板/焦点会被抢；
- **不可逆**：发出去的消息收不回。

### 5.4 Kill criteria

1. 若反作弊明确把输入注入视为违规（无法验证，但按最坏情况假设）→ 只保留"写剪贴板、用户手动粘贴"；
2. 若自动发送在 20 次测试中有任一次发错内容/发错频道 → 放弃自动发送，降级为"手动确认"；
3. 若实现需要修改游戏内存或 hook 输入链路 → 放弃（超出 Tier 1 风险预算）。

**默认决策：Tier 3 不实现**，保持现有人工粘贴路线（写剪贴板是安全上限）。

---

## 6. 关键取舍

### 6.1 进程内覆盖 vs 外置 WPF 覆盖（架构 A）

| | 进程内（本设计） | 外置 WPF（`scripts/overlay_window.ps1`，legacy） |
| --- | --- | --- |
| 端到端延迟 | 翻译 + 一次本机 HTTP（≈1s） | 翻译 + 桥轮询 + 窗口重绘（≈1~1.5s） |
| 反作弊风险 | **高（注入）** | 低（不注入） |
| 是否在游戏窗口内 | 是（能精确贴聊天区） | 否（独立窗口，需手动对齐/跟随） |
| 独占全屏 | 能画（Present 在渲染管线内） | 会被盖住 |
| 多显示器/DPI | 坐标相对后缓冲，简单 | 需要窗口坐标换算 |
| 更新存活率 | 中高（只依赖 DXGI） | 高（只依赖 console.log + 窗口） |
| 额外进程 | 无 | 有（PowerShell/WPF） |
| 结论 | 想要"低延迟 + 贴聊天区"选它，接受注入风险 | 想要"零注入风险"继续用它 |

#### 6.1.1 与 BTIPC / 受信任 https 面板的三方对比

本设计**不是**唯一低延迟方案。当前仓库/上游存在三条路：

| 方案 | 下行延迟 | 注入风险 | 需装本机根证书 | 备注 |
| --- | --- | --- | --- | --- |
| BTIPC 位信道（本 fork 已落地） | 3~27s | 无 | 否 | 合规性最好，带宽是硬伤 |
| 受信任 https 隐藏面板（上游 2026-10-15 实车，本 fork 未移植） | <1s | 无 | **是**（`CurrentUser\Root`，需完全重启 Steam） | 依赖 CEF/面板行为，Valve 可能再改；证书是安全边界 |
| 原生 DLL（本设计） | 翻译耗时 ≈0.7~2.3s | **高** | 否 | 不依赖 Panorama/CEF；能做窗口绘制与输入框读取 |

所以 Tier 1 的价值主张应表述为：**"不想向系统信任库装证书、或想脱离 Panorama/CEF 依赖时，
用注入换低延迟"**。如果 fork 移植了 https 面板通道并实车稳定，Tier 1 的独特性会明显下降
（届时本项目的主要价值转移到 Tier 2/3 的进程内能力）。

### 6.2 DX11 / DX12 / Vulkan

- **DXGI Present hook 对 D3D11 与 D3D12 都可见**（两者都通过 `IDXGISwapChain::Present`）；
- 但 D2D1 只能基于 **D3D11 设备**建 `ID2D1Device`，拿不到 D3D12 设备的 D2D 设备：
  - D3D11 → 完整绘制；
  - D3D12 → hook 会装上、Present 会被转发，但 `GetDevice(ID3D11Device)` 失败，
    覆盖层自动禁用（日志一行，游戏无感）。若将来要支持 D3D12，需要改为
    "D3D12 命令列表 + 自绘字体/纹理"，工作量另算；
  - Vulkan（Deadlock 支持 Vulkan 启动）→ 没有 DXGI，**本方案完全不覆盖**。若游戏用 Vulkan，
    需要 Vulkan `vkQueuePresentKHR` hook，属于另一套实现。
- 本次骨架**只承诺 D3D11**；D3D12/Vulkan 是明确的未验证/不支持项。

### 6.3 独占全屏 vs 无边框

- 两者 Present 都会被调用，覆盖层理论上都可见；
- **独占全屏**：模式切换会走 `ResizeBuffers`/`SetFullscreenState`，也是 DXGI 最容易出
  兼容性问题的路径；且 alt-tab 体验差。我们 hook 了 `ResizeBuffers` 专门保住这条路径；
- **无边框**：DWM 合成，行为最接近普通窗口，开发期建议用它验证；
- **建议**：用户侧优先无边框；独占全屏作为 M4 稳定性测试项（见第 9 节）。

### 6.4 多显示器 / DPI / HDR

- **多显示器**：坐标是"后缓冲比例"，与显示器布局无关；窗口拖到另一屏、跨屏都不需要改代码。
  唯一的问题是不同屏 DPI 不同时窗口可能被系统缩放（见下）。
- **DPI**：本设计把 D2D 的 DPI 固定为 96，即 `fontSize` 是物理像素。
  在 Windows 缩放 150% 时，文字视觉大小会偏小（游戏 UI 本身是自绘的，不受系统缩放影响）。
  正确做法是读 `GetDpiForWindow` 并换算，或让用户调 `fontSize`——Tier 1 选后者（简单、可配）。
- **HDR**：HDR 交换链常用 `R10G10B10A2_UNORM` / `R16G16B16A16_FLOAT`；D2D 对这些格式的
  target 支持不完整，本骨架在 `CreateBitmapFromDxgiSurface` 失败时**自动不绘制**并记日志，
  不会崩。真要做 HDR 需要自己处理色彩空间/色调映射，Tier 1 不做。

---

## 7. 安全与合规

### 7.1 为什么它"不是外挂"

本设计的读写范围：

- **不读游戏内存**（除了 DXGI vtable 指针本身）；
- **不写游戏逻辑/代码**（只替换 DXGI 模块的 COM vtable 函数指针，且可还原）；
- **不自动操作**（Tier 3 默认不做；Tier 1 只显示）；
- **不提供隐藏信息**（只把本地玩家本来就能看到的聊天翻译成本地语言）；
- **不影响他人**（不注入聊天记录、不代发消息、不改游戏结果）。

### 7.2 如何避免影响他人

- 只做**本地显示**：覆盖层画在自己屏幕上，不向服务器发送任何东西；
- 不自动发言（Tier 3 不实现；即使将来实现也必须默认关闭、逐条人工确认）；
- 不修改游戏聊天记录（Tier 2 的 Label 是本地 UI，不会发给别人）；
- 不共享/上传聊天内容：唯一的网络目标是 `127.0.0.1:8791`。

### 7.3 崩溃隔离（"绝不能崩游戏"的具体措施）

1. `DllMain` 只做 `DisableThreadLibraryCalls` + 起 init 线程，不在 loader lock 里做重活；
2. 所有 hook 回调都用 SEH 兜底（`/EHa` + `catch (...)`），只记一次日志，**永远转发原始 Present**；
3. 任何绘制资源创建失败 → 停用覆盖层（`nextInitRetryMs_` 退避 5s 再试），不重试风暴；
4. `ResizeBuffers` detour 先释放我们持有的后缓冲引用再转发，避免让游戏的 resize 失败；
5. 卸载顺序：先停 tick → 停 worker → 还原 vtable → 等 in-flight 归零 → 释放 D2D；
6. 不做 inline hook（不改代码段），还原成本最低；
7. 已知边界：**运行中直接 `FreeLibrary` 不安全**（DllMain 按硬约束不处理 detach）。
   加载器应先调 `LCTNativeShutdown()`；推荐让 DLL 常驻到进程退出。

### 7.4 数据与隐私

- 聊天正文只存在于内存：不写磁盘、不进日志（日志只记 `seq`/错误码/计数）；
- `native.json` 是本机配置（可能含绝对路径），已加入 `.gitignore`；
- 无遥测、无外部网络请求（除了用户配置的 `bridgeUrl`，默认本机）。

### 7.5 反作弊现实（诚实声明）

- Valve 未公开 Deadlock 的具体反作弊实现；社区观察到相关更新强化过反作弊
  （见 `docs/from-scratch-architectures.md`）。
- 本设计**不做任何隐藏/对抗**（不混淆、不抹除痕迹、不检测反作弊进程）。
- 是否被处罚**无法在开发侧验证**，只能由使用者接受风险；作者建议仅在自己账号、单机/bot
  对局中试验，不要把风险暴露给正常对局。

---

## 8. 未验证项清单

> 本机没有 C++ 工具链，以下全部**未编译、未实机验证**。请把这张表当作"下一步工作清单"。

| # | 项 | 现状/假设 | 失败后果 | 验证方法 |
| --- | --- | --- | --- | --- |
| 1 | 能编译通过 | 未编译（本机无 cl/cmake/VS/Windows SDK） | 语法/链接错误 | 装 VS2022 Build Tools 后跑 `native/build.ps1` |
| 2 | vtable 索引 8 / 13 | 依据 DXGI 头文件声明顺序 | hook 到错误函数 → **崩溃** | 用 probe swapchain 打印各槽位地址，与 `dxgi.dll` 导出/符号对照；单机验证 |
| 3 | 派生 vtable 合并 patch | 依据 COM 继承实现 | 游戏经派生接口调用 → 未 hook | 在 detour 里打计数，实机看是否每帧命中 |
| 4 | 游戏用 D3D11 | 未验证（可能 D3D12/Vulkan） | 不绘制（安全降级） | 日志 `GetDevice` 结果；或 RenderDoc 看 API |
| 5 | D2D 支持游戏后缓冲格式 | 未验证（BGRA8 假设；HDR 会失败） | 不绘制（安全降级） | 日志 `CreateBitmapFromDxgiSurface` 失败 |
| 6 | `console.log` 路径探测 | 逻辑按现有 Node 实现推导 | 找不到 → 无聊天 | 实机看日志 `log tail: using ...` |
| 7 | `[LCT-CHAT]` 字段/编码 | 依据 `lingua_chat.js` 现有实现（UTF-8） | 解析失败 → 无聊天 | 对照 `%TEMP%\lct-native.log` 与游戏日志 |
| 8 | 半行/重写/截断处理 | 思路同 `core/overlay.js`，未实测 | 漏行/重复 | 连续多局观察 |
| 9 | WinHTTP ↔ 桥兼容 | 请求/响应格式已对照 `bridge_server.js`，未实测 | 无译文（保留原文） | 实机 + 桥日志 |
| 10 | 中文渲染/字体回退 | 未验证 | 方块/缺字 | 实机截图 |
| 11 | 热键在游戏内可用 | 未验证（焦点/独占） | 热键无效 | 实机按键 |
| 12 | resize/全屏切换 | 设计已处理，未实测 | 黑屏/渲染异常 | 切分辨率、切全屏、alt-tab |
| 13 | 卸载/重初始化安全 | 设计可逆，未实测 | 崩溃 | 反复 init/shutdown（需加载器） |
| 14 | 反作弊不触发 | **完全未知，无法验证** | 封号 | 无安全验证方法；只能接受风险 |
| 15 | 多显示器/DPI/HDR | 未验证，已知不支持 HDR | 位置/大小偏差 | 实机调整比例 |

---

## 9. 维护与更新策略

游戏更新后按顺序检查（10 分钟内可判断 Tier 1 是否还活着）：

1. 看 `%TEMP%\lct-native.log`：`overlay: hooked Present/ResizeBuffers ...` 是否出现；
2. 单机 bot 对局：`log tail: using ...` + `translate: request ... failed` 是否正常；
3. 覆盖层是否显示、是否随聊天更新；
4. 切换一次分辨率 / 全屏，确认 `ResizeBuffers` 不报错；
5. 若 DXGI 变了（概率低）：重新确认 vtable 索引；若游戏改用 Vulkan/D3D12：
   Tier 1 不支持，记录到本文第 8 节。

约定：

- **不自动更新偏移/签名**（没有这种东西）；Tier 2 的签名必须每次人工确认；
- 每个"已知可用"的游戏版本记录下来（版本号 + 日期 + 结论）；
- 出现崩溃时第一时间用"先不注入"复现，确认不是游戏本身的问题。

## 10. 里程碑与下一步

| 里程碑 | 内容 | 验收 |
| --- | --- | --- |
| M0（本次） | 工程骨架 + 设计文档 | 代码可被人眼 review；`native/README.md` 构建步骤完整 |
| M1 | 首次真实编译 | `native/build.ps1` 成功产出 `build/LCTNative.dll`，无链接错误 |
| M2 | 单机 bot 对局注入 | hook 安装成功、tail 命中、游戏连续 30 分钟不崩 |
| M3 | 与桥联调 | 译文渲染、翻译失败降级、配置热重载 |
| M4 | 稳定性 | 连续 2 局 + 切分辨率 + 切全屏 + 反复开关热键，无崩溃/无泄漏 |
| M5（可选） | Tier 2 考古 2 周 | 按 4.4 清单逐项出结论；按 4.6 决定继续/停止 |

下一步建议（给 Lead/后续 agent）：

1. 先在装好 VS2022 Build Tools 的机器上跑 M1，按编译错误修一轮（预期会有少量头文件/
   类型细节问题，因为本骨架未编译过）；
2. M2 之前先用一个最小 DLL（只装 hook + 打日志）确认 Present 命中，再启用 D2D；
3. Tier 2 只做"考古"（sigscan + 结构 dump + 空函数调用），**不要直接写注入逻辑**；
4. Tier 3 保持"写剪贴板 + 人工粘贴"，不引入输入注入。

---

## 11. 参考

> 以下路径均相对**仓库根目录**（本文件在 `native/docs/` 下）。

- `docs/from-scratch-architectures.md` §3（架构 B：原生 mod）与 §7（对照表）
- `docs/architecture.md`（现状、BTIPC 通道、桥端点）
- `docs/btipc-v1.md`（位信道协议，理解"为什么慢"）
- `AGENTS.md` §4（2026-10-24 更正：受信任 https 面板通道，上游已实车、本 fork 未移植）
- `core/bridge_server.js`（`/api/v1/translate` 的请求/响应格式）
- `core/overlay.js`、`mod/panorama/scripts/lingua_chat.js`（`[LCT-CHAT]` 行格式、tail 思路）
- `LICENSE_NOTICE.md`（许可与"独立实现"声明）
- Microsoft Docs：`IDXGISwapChain`、`ID2D1DeviceContext`、`IDWriteTextFormat`、WinHTTP
