# DeadlockLingua · 原生 mod 实验分支（`feat/native-mod`）

> **这是另一套架构，不是主线的新版本。** 主线 [`main`](https://github.com/Thirt927/DeadlockLingua/tree/main) 是
> 「Panorama 模组 + 本地桥」；本分支在同样的桥之上，额外做了一份**原生 DLL**：注入游戏进程，
> 在进程内直接 WinHTTP 调桥、Direct2D 画译文。
>
> ⚠️ **未编译、未实机验证**；向游戏进程注入 DLL 有**反作弊/封号风险**。仅供实验，不要当发行版用。

[简体中文](README.md) · [English](README_EN.md) · [返回 main](https://github.com/Thirt927/DeadlockLingua/tree/main)

## 1. 一句话说清区别

| | 主线 `main` | 本分支 `feat/native-mod` |
|---|---|---|
| 译文**显示**在哪 | 游戏内聊天行下方的 `Label`（**进聊天记录**，能滚动/翻历史） | 进程内 D2D **覆盖层**，画在聊天区上方（**不进聊天记录**） |
| 译文**怎么进游戏** | 隐藏 HTML 面板 https（<1s）或 BTIPC 位信道（兜底） | DLL 在进程内用 **WinHTTP 直连**本地桥，**没有任何"回传通道"** |
| 需要什么 | VPK + 桥 + `-condebug`（证书可选） | 同样要 VPK + 桥 + `-condebug`，**再加一个注入的 DLL** |
| 反作弊风险 | 无注入 | **有**（未知，可能封号） |
| 更新后存活 | 依赖引擎行为 | 依赖 DXGI/vtable 与游戏版本 |
| 代表作 | 已实车验收 | 只有骨架 + 设计 |

> 关键点：**聊天采集和翻译是共用的**——两条架构都靠主线 mod 把聊天写进 `console.log`（`[LCT-CHAT]` 行），
> 都靠桥的 `/api/v1/translate` 翻译。真正不同的是**最后一段**：主线把译文"送回"游戏（面板/位泵），
> 本分支在游戏进程内直接拿到译文并自己画出来，不需要回传通道。

## 2. 两种架构的数据流

```text
主线 main:
  聊天 DOM ──(Panorama mod)──> console.log ──tail──> 桥 ──/api/v1/translate──> provider
                                                        │
                          https 面板 / BTIPC 位泵 <──────┘
                                   │
                                   ▼
                          游戏内 Label（聊天行下方）

本分支 native（Tier 1）:
  聊天 DOM ──(同一个 Panorama mod)──> console.log ──tail──> 桥 ──/api/v1/translate──> provider
                                                                  ▲
                             DLL 进程内 WinHTTP（worker 线程）──────┘
                                   │
                                   ▼
                     Direct2D 覆盖层（D3D11 Present hook）
```

对普通用户来说，**主线更快、更安全、更"像原版"**；本分支的意义是"不走 Panorama/CEF、不需要证书，
且译文可以完全按自己的排版画"——代价是注入风险，以及译文不在聊天记录里。

## 3. 本分支里有什么

本分支已合并主线最新代码（`8a25049`），**主线代码未改**，只多了一个目录和这份 README：

```text
native/
├── README.md              本目录的构建/安装/配置/排障
├── docs/DESIGN.md         设计文档：Tier 1 实现、Tier 2 仅设计、取舍、未验证清单
├── CMakeLists.txt         C++17 / x64 / SHARED → LCTNative.dll
├── build.ps1              检测 VS + CMake 并构建
└── src/
    ├── dllmain.cpp        DllMain 只做最小工作 + 导出 LCTNativeInit/Shutdown
    ├── app.cpp            生命周期、配置热重载、tick 循环
    ├── core/              日志、UTF-8/JSON 小工具、配置、console.log tail、WinHTTP 客户端
    ├── overlay/           IDXGISwapChain Present/ResizeBuffers vtable hook + D2D/DWrite
    └── hooks/             sigscan（Tier 2 预留，当前未使用）
```

三个 Tier（详见 [`native/docs/DESIGN.md`](native/docs/DESIGN.md)）：

- **Tier 1（有代码）**：进程内覆盖层。`<DLL 目录>\native.json` 配坐标/字号/热键，`F8` 开关。
- **Tier 2（只有设计）**：hook Panorama，把译文直接插进聊天行——这才是"原生也能进聊天记录"的路，
  但需要反向引擎结构 + 每次更新重做偏移，风险和维护成本都高一个量级。
- **Tier 3（只有设计）**：出站（把译文写回输入框/模拟发送）与输入注入风险。

## 4. 状态（诚实版）

- **未编译**：开发机没有任何 C++ 工具链（无 `cl` / `cmake` / VS / Windows SDK），
  代码按 MSVC / VS2022 生成器写，首次构建可能还要修 1～2 轮编译错误。
- **未实机**：没有注入测试，`vtable` 索引、D3D 版本、HDR/10-bit 后缓冲、字体回退、全屏/resize、
  多显示器、DPI 全部**未验证**。
- **未验证反作弊行为**：完全未知，这也是它不该被分发给普通用户的原因。
- 已知限制：只支持 **D3D11**（D3D12 能 hook 到但拿不到 `ID3D11Device`，会自动不绘制；Vulkan 不支持）；
  译文在覆盖层而不在聊天记录；翻页交换链下可能每帧重建 D2D 位图；无去重/无历史回填。

## 5. 构建

工具链：Windows 10/11 x64 + **VS2022 Build Tools**（工作负载"使用 C++ 的桌面开发"）+ **CMake 3.21+**。
零第三方依赖（只用 Windows SDK）。

```powershell
# 在仓库根目录
cmake -B native/build -A x64
cmake --build native/build --config Release
# 或
powershell -ExecutionPolicy Bypass -File native\build.ps1
```

产物：`native/build/LCTNative.dll`（Release 也带 `.pdb`，便于排障）。

## 6. 安装 / 运行 / 卸载

1. 主线那套照常装好：VPK 在 `addons/`、桥在跑、游戏带 `-condebug`（`StartDeadlock.bat` 已带）。
2. 把 `LCTNative.dll` 与可选的 `native.json` 放在同一目录。
3. **用你自己信任的注入器加载 DLL**（本仓库不附带注入器，也不含任何绕过反作弊的手段）。
4. 进对局：聊天区左下角应出现"昵称: 原文 / 中文译文"；`F8`（可配）开关覆盖层。
5. 日志：`%TEMP%\lct-native.log`。

卸载：先按 `F8` 隐藏，正常退出游戏即可。**不要运行中直接 `FreeLibrary`**（DllMain 不处理 detach，
可能崩游戏）；删除 DLL 与 `native.json` 即完成卸载。

`native.json` 示例与字段表见 [`native/README.md`](native/README.md#配置-nativejson)：
`bridgeUrl` / `consoleLogPath` / `targetLanguage` / `chatRect` / `fontSize` / `maxLines` / `hotkey` / `enabled`，
支持约 1 秒热重载。

## 7. 为什么你很可能不需要它

主线已经用**受信任 https 面板**把下行做到了 **<1 秒**（见 [`docs/https-panel.md`](docs/https-panel.md)），
而且零注入、译文进聊天记录。本分支只在下面几种情况下有意义：

- 你**不愿意**往系统信任库装自签证书，又嫌 BTIPC 位泵慢；
- 你想要**自定义排版**的覆盖层（字号/位置/样式完全可控），而不是聊天行里的 Label；
- 你在做注入/覆盖层的技术研究，接受风险。

反过来，如果目标是"普通玩家能稳定用"，**留在 main**。这也是本分支没有并入主线的理由。

## 8. 风险声明

- 注入 DLL、hook 渲染是反作弊会关注的行为；**可能导致账号被封**，风险自负。
- 游戏更新可能让 DXGI/vtable/日志格式失效，本分支不承诺维护节奏。
- 本仓库与 Valve 无关，未经 Valve 认可；不分发注入器，不做任何隐藏/对抗。

## 9. 许可

- 仓库整体 GPL-3.0，见 [`LICENSE`](LICENSE)。
- 零第三方代码；设计依据主线文档 [`docs/from-scratch-architectures.md`](docs/from-scratch-architectures.md)（架构 B）
  与 [`native/docs/DESIGN.md`](native/docs/DESIGN.md)。
