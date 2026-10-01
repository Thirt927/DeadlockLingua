# DeadlockLingua

**简体中文** | [English](README_EN.md)

> 《Deadlock》聊天实时翻译工具，基于 [BabelTower](https://github.com/c1375rick/BabelTower) 二次开发，由 [Thirt927](https://github.com/Thirt927) 维护。

把《Deadlock》里队友和对手的外语聊天实时翻译成中文，显示在**游戏外的悬浮窗**上；你要说的话也可以先译成英文，一键复制回游戏发送。

---

## ⚠️ 先读这段：v2.0.0 起译文不再显示在游戏内

《Deadlock》**2026-10-01 的更新移除了游戏的全部网络能力**，Mod 已经无法在游戏里接收任何数据。因此从 v2.0.0 起：

- ❌ **游戏内的聊天行不再显示译文**（游戏内输入框、`/tr` 面板也不再能保存设置）
- ✅ 译文改在**游戏外的悬浮窗**里显示，这是目前唯一可行的方式

这不是本项目的选择，而是游戏引擎层面的限制。如果游戏后续更新恢复网络能力，游戏内翻译会自动具备恢复条件。

---

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

> 打不开悬浮窗？双击 `ShowOverlay.bat` 即可手动打开，**不需要先启动游戏**。

---

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

### 设置

点悬浮窗标题栏的「**设置**」。可配置：

- **翻译**：服务商、API Key、目标语言、显示模式、发送模式、超时
- **悬浮窗**：显示形态、不透明度、背景色、圆角、主题色、贴边方向
- **字幕浮层**：一直留存、留存时间、淡入淡出、字号、文字颜色、同屏条数、每条宽度

配置保存在 `config/config.json`，首次运行自动生成。该文件含 API Key，已被 `.gitignore` 忽略，**不要提交到 Git**。

> 游戏内的 `/tr` 面板仍然能打开，但**保存无效**（游戏已移除网络能力），请用悬浮窗里的设置。

---

## 更新说明

### v2.0.0 — 2026-10-01

**重大变更**

- 游戏更新移除了全部网络能力，游戏内翻译不再可用，译文改为在**游戏外悬浮窗**显示
- 唯一可用通道变为单向的 `游戏 → console.log`

**新增**

- 游戏外翻译悬浮窗（原生 WPF）：真透明、始终置顶、贴边自动收起、可拖动
- 字幕浮层：角落聊天胶囊，鼠标穿透，位置可拖拽，支持「一直留存」
- 悬浮窗内置设置面板（原 `/tr` 面板内容 + 悬浮窗/字幕设置）
- 术语表补全：新增 194 件装备的官方中英文对照
- `ShowOverlay.bat`：不开游戏也能打开悬浮窗

**修复**

- 游戏内不再出现 `翻译失败: bridge_panel_unavailable` 刷屏
- 设置页控件统一为深色主题（此前沿用系统浅色模板）

**界面**

- 按游戏世界观重新定色（氧化黄铜 / 铜绿 / 羊皮纸），颜色按功能分配
- 拉丁字母改用 Bahnschrift SemiCondensed，外文原文与中文译文视觉分层

### v1.0.1 — 2026-10-01

- 修复游戏更新后 addon 不被挂载：需在 Deadlock Mod Manager 中重新应用一次补丁
- 本地桥增加未捕获异常兜底，不再静默退出
- 顶栏布局按新版本原版重基线

### 更新方法

1. 备份 `config/config.json`
2. 解压新版本，删除 addons 里的旧 VPK，导入新 VPK（同样是先改成不重名的名字）
3. 把备份的配置复制回新目录
4. 运行 `RestartBridge.bat`
5. **完全重启 Deadlock**

完整历史见 [`CHANGELOG.md`](CHANGELOG.md)。

---

## 常见问题

**Q：游戏里怎么不显示译文了？**
A：游戏更新移除了网络能力，游戏内已无法接收数据。请用悬浮窗看译文。

**Q：悬浮窗没出现 / 显示「桥离线」？**
A：桥没启动。双击 `StartBridgeSilent.vbs`，或检查任务管理器里有没有 `node.exe`。

**Q：游戏内 `/tr` 改了设置不生效？**
A：同上，游戏内保存通道已失效。请在悬浮窗的「设置」里改。

**Q：自动复制失败？**
A：部分浏览器/系统策略会拦截复制。此时英文会被自动选中，按 `Ctrl+C` 再回游戏粘贴即可。

**Q：翻译偶尔变慢或失败？**
A：可在设置里调大「翻译超时」，或配置备用服务商（`fallbackProviders`）做自动回退。

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

## 构建（源码用户）

需要 Reduced CSDK 12：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/build.ps1 -Csdk12Root "<CSDK_DIR>"
```

产物为 `dist/pak01_dir.vpk`。**部署前要先改成不与 addons 现有文件重名的名字**（推荐 `pak22_dir.vpk`），再复制到 Deadlock 的 `game/citadel/addons/`。

> 别用裸的 `pak01_dir.vpk`：`pak01` 是游戏本体的 pak 组名，同名会冲突。

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
│       ├── scripts/              聊天扫描与桥接逻辑
│       └── styles/               设置面板样式
├── core/                         本地 Node.js 桥
│   ├── bridge_server.js          HTTP 服务与配置接口
│   ├── config.js                 本地配置管理
│   ├── glossary.js               游戏术语表（英雄/装备/战术）
│   ├── hero_names.js             英雄译名与缩写
│   ├── dictionary.js             自适应学习词典
│   ├── overlay.js                悬浮窗数据源（tail console.log）
│   ├── steamid_enrich.js         SteamID 回填与整局名单
│   └── providers/                翻译服务商
├── scripts/
│   ├── overlay_window.ps1        游戏外悬浮窗（原生 WPF）
│   ├── build.ps1                 构建
│   ├── package_release.ps1       发布打包
│   └── *_test.js / *simtest.js   测试
├── config/                       配置与词典
├── docs/                         架构说明与优化日志
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

## 许可证

- 本项目代码：GNU GPL v3，见 [`LICENSE`](LICENSE)
- 第三方协议说明：见 [`LICENSE_NOTICE.md`](LICENSE_NOTICE.md)
- 游戏内 Valve 布局素材仅用于兼容性，版权归 Valve
