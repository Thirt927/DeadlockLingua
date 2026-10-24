# LCTNative — Deadlock 聊天翻译原生覆盖层（DLL 骨架）

> **状态：工程骨架 + 设计文档。本机没有 C++ 工具链，代码尚未编译、也未实机验证。**
> 所有"未验证"项在 [docs/DESIGN.md](docs/DESIGN.md) 第 8 节逐条列出。

LCTNative 是一个 **Windows x64 DLL**，注入 Deadlock 游戏进程后：

1. 增量 tail 游戏 `console.log` 里的 `[LCT-CHAT]` 行（现有 Panorama mod 已经在写）；
2. 用 **WinHTTP** 直接 POST 本机桥 `http://127.0.0.1:8791/api/v1/translate`，把译文拿回来；
3. 用 **Direct2D / DirectWrite** 画在游戏窗口的聊天区域上（默认左下角，位置/字号/行数可配）。

它**不是**替代现有 Panorama mod 的方案，而是一条并行实验路线：把"游戏 → 桥"的服务端往返从
位信道（≈16 B/s，6 秒级）换回普通 HTTP（延迟回到翻译本身的 ≈0.7s）。

> 注（2026-10-24）：上游 BabelTower 已实车验证「受信任本机证书 + 隐藏 HTML 面板 https」通道
> （下行 <1s），**本 fork 2.1.0 尚未移植**。因此"原生 mod 是唯一低延迟方案"**不成立**；
> 三条路线（BTIPC / https 面板 / 原生 DLL）的对比见
> [docs/DESIGN.md](docs/DESIGN.md) 的 §1.1 与 §6.1。本 DLL 的价值是**不依赖 Panorama/CEF、
> 也不需要向系统信任库安装根证书**，代价是注入带来的反作弊风险。

---

## ⚠️ 风险警告（务必先读）

- **反作弊 / 封号风险**：向游戏进程注入 DLL、hook 渲染是 Valve 反作弊会关注的行为。
  使用它意味着**你接受账号被 VAC / 其它反作弊处罚的可能**。本项目不做任何隐藏、对抗或绕过。
- **仅限本地自用**：不要打包分发、不要用于商业用途、不要在你不拥有的账号上尝试。
- **可能随时失效**：游戏更新可能改变 DXGI 行为、`console.log` 格式或反作弊策略，
  每次更新后都要重新验证，甚至可能永久不可用。
- **不保证不崩游戏**：设计上所有失败路径都只关闭覆盖层（见 DESIGN 第 7 节），
  但 hook 类代码天然有风险，且本骨架**尚未经过实机验证**。
- 本项目与 Valve 无关，未经 Valve 认可。仓库整体为 GPL-3.0（见根目录 `LICENSE`），
  第三方组件为 0：只用 Windows SDK（Win32 / D3D11 / D2D1 / DWrite / WinHTTP）。

## 目录结构

```
native/
├── CMakeLists.txt          # C++17 / x64 / SHARED → build/LCTNative.dll
├── build.ps1               # 检测 cmake + VS，配置并编译
├── README.md               # 本文件
├── docs/DESIGN.md          # 设计文档（Tier 1/2/3、取舍、安全、未验证项）
├── .gitignore
└── src/
    ├── dllmain.cpp         # DllMain（只做最小工作）+ 导出 LCTNativeInit/Shutdown
    ├── app.h / app.cpp     # 生命周期、配置、1s 主循环（tail / 配置热重载 / 热键）
    ├── core/
    │   ├── log.h/.cpp      # %TEMP%\lct-native.log
    │   ├── util.h/.cpp     # UTF-8/UTF-16、极简 JSON 取值（无第三方库）
    │   ├── config.h/.cpp   # 读 DLL 同目录 native.json
    │   ├── log_tail.h/.cpp # 增量 tail console.log + 解析 [LCT-CHAT]
    │   └── translate_client.h/.cpp  # WinHTTP worker + 有界队列 + 超时
    ├── overlay/
    │   └── d3d11_overlay.h/.cpp     # IDXGISwapChain Present/ResizeBuffers vtable hook
    └── hooks/
        └── sigscan.h/.cpp  # 模式扫描工具（Tier 2 预留，**当前未被调用**）
```

## 构建

### 工具链要求

- Windows 10/11 x64
- **Visual Studio 2022 Build Tools**（或 Community）并勾选工作负载
  **「使用 C++ 的桌面开发」**（提供 MSVC v143 + Windows 10/11 SDK）
- **CMake 3.21+**（PATH 里有，或用 Visual Studio 自带的；3.21 才支持 VS2022 生成器）
- 无需任何第三方库（不依赖 vcpkg / Conan / 包管理器）

### 命令

在仓库根目录：

```powershell
cmake -B native/build -A x64
cmake --build native/build --config Release
```

或直接用脚本（会自动检测工具链并给出中文错误提示）：

```powershell
powershell -ExecutionPolicy Bypass -File native\build.ps1
```

成功后的产物：**`native/build/LCTNative.dll`**（以及同名 `.pdb`，Release 也会生成符号便于排查）。

> 本仓库作者当前机器**没有** C++ 工具链，因此以上命令尚未在本机跑通；
> 代码按 MSVC / Visual Studio 生成器的要求编写，请以第一次真实构建的错误为准。

## 安装

1. **启动本地桥**（现有 Node 桥即可，仓库根目录的 `StartBridgeSilent.vbs` / `RestartBridge.bat`）。
   确认 `http://127.0.0.1:8791/api/v1/health` 能访问。
2. **让游戏带 `-condebug` 启动**：否则 Source 2 根本不写 `console.log`，
   本 DLL 收不到任何聊天（表现是"完全没有反应"）。现有 `StartDeadlock.bat` 已经加了这个参数。
3. **可选**：把 `native.json` 放到 **DLL 同目录**（见下节），不写则全部用默认值。
4. **用你信任的注入器加载 DLL**（例如任意标准 DLL 注入工具）。
   本仓库**不附带注入器**，也不包含任何绕过反作弊的手段。
5. 进入对局，聊天区左下角应出现"昵称: 原文 + 中文译文"。
   `F8`（可配）切换覆盖层显示/隐藏。

日志：`%TEMP%\lct-native.log`（每次进程启动会截断重写）。

## 配置 `native.json`

文件位置：**与 DLL 同目录**。全部字段可选；缺字段用默认值。支持运行时修改
（约 1 秒内自动热重载，无需重启游戏）。

```json
{
  "bridgeUrl": "http://127.0.0.1:8791",
  "consoleLogPath": "",
  "targetLanguage": "zh-Hans",
  "chatRect": { "x": 0.01, "y": 0.61, "w": 0.30, "h": 0.36 },
  "fontSize": 16,
  "maxLines": 6,
  "hotkey": "F8",
  "enabled": true
}
```

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `bridgeUrl` | string | `http://127.0.0.1:8791` | 本地桥地址；必须以 `http://` / `https://` 开头 |
| `consoleLogPath` | string | `""` | 空 = 自动探测（从游戏进程路径向上找 `<game>\game\citadel\console.log`）；支持 `%ENV%` 变量 |
| `targetLanguage` | string | `zh-Hans` | 透传给 `/api/v1/translate` 的 `targetLanguage` |
| `chatRect` | object | `x=0.01, y=0.61, w=0.30, h=0.36` | 相对游戏**后缓冲**的比例坐标（0~1），默认左下角 |
| `fontSize` | number | `16` | 字号（像素）；8~72 |
| `maxLines` | number | `6` | 最多显示多少条；1~32 |
| `hotkey` | string | `F8` | 单键：`F1`~`F24`、`A`~`Z`、`0`~`9`、`HOME`/`END`/`TAB`/`SPACE` 等；空字符串 = 关闭热键 |
| `enabled` | bool | `true` | `false` = 整个功能关闭（不 tail、不翻译、不绘制） |

> `native.json` 被视为本机配置：可能包含你机器的绝对路径，已加入 `native/.gitignore`，不要提交。

## 卸载

1. 游戏内按 `F8` 可以先把覆盖层隐藏；
2. 正常退出游戏即可（进程结束，DLL 与线程一并销毁）；
3. 若实现了加载器，请先调用导出函数 `LCTNativeShutdown()`，**再**考虑 `FreeLibrary`。
   本骨架的 `DllMain` 只处理 attach（见硬约束），**不处理 `DLL_PROCESS_DETACH`**，
   因此运行中直接 `FreeLibrary` 可能导致游戏崩溃。推荐让 DLL 常驻到进程退出。
4. 删除 DLL 与 `native.json` 即完成卸载（不写注册表、不装服务；除 `%TEMP%\lct-native.log` 日志外不落盘其它数据）。

## 故障排查

| 现象 | 排查 |
| --- | --- |
| 完全没反应 | ① 游戏是否带 `-condebug`？② `%TEMP%\lct-native.log` 是否存在、是否有 `console.log not found`？③ 对局中按 F8 看是否只是隐藏了 |
| 有日志但无译文 | 桥是否在跑？`http://127.0.0.1:8791/api/v1/health` 是否有返回？日志里是否有 `translate: request ... failed` |
| 只有原文没有译文 | 翻译失败会保留原文（只显示原文行）；看日志中的失败原因；确认桥的 provider 配置可用 |
| 不显示中文而是方块 | 字体回退问题（`Segoe UI` 缺中文时依赖系统字体回退）；见 DESIGN 第 4.5 节 |
| 覆盖层位置不对 | 调 `chatRect`；比例是相对**后缓冲像素**，不是屏幕分辨率（无边框全屏下两者一致） |
| 游戏更新后失效 | 先看日志里 overlay 是否安装成功；`GettingDesc` / `D2D cannot target` 等错误说明 DXGI 或格式变了 |

## 已知限制（Tier 1，详见 DESIGN）

- **只支持 Direct3D 11**：D3D12 的 swapchain 能被 hook 到，但我们拿不到 `ID3D11Device`，会**自动降级为不绘制**；Vulkan 完全不在覆盖范围内。
- 译文画在**游戏窗口之上**，不是聊天记录的一部分（不能随聊天滚动、不能翻历史）。
  把译文献进聊天行属于 Tier 2，本次只做设计。
- 每次绘制会重新取后缓冲并可能重建 D2D 位图（翻页交换链下），属于骨架级实现，未做性能优化。
- DPI 固定按 96 处理（1 DIP = 1 像素）；HDR / 10-bit 后缓冲格式不支持时自动不绘制。
- 不做消息去重（同一条聊天若被 mod 写两遍，覆盖层会显示两次）；不做历史回填（注入前已存在的聊天不显示）。
- 未做多显示器 / 独占全屏的专项验证。

## 许可与来源

- 仓库整体 GPL-3.0（`LICENSE`）；本目录代码同样适用。
- **无第三方代码**：全部只用 Windows SDK 头文件与系统库。
- 设计依据本仓库既有文档：`docs/from-scratch-architectures.md`（架构 B）、
  `docs/architecture.md`、`docs/btipc-v1.md`、`LICENSE_NOTICE.md`。
- 与 Valve 无关，未经 Valve 认可。
