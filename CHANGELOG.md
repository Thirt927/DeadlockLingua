# Changelog

所有重要变更都会记录在此文件。

## v2.0.0 - 2026-10-01

**游戏在 2026-10-01 的更新中移除了 Panorama 的全部 HTTP 能力**，游戏内收发网络已不可能。本次更新把翻译显示整体迁移到**游戏外的原生悬浮窗**，并补齐游戏术语表。

### 重大变更

- 游戏内翻译不再可用：`$.AsyncWebRequest` 调用即抛 `AsyncWebRequest has been removed.`；隐藏 HTML 面板 `SetURL` 不报错，但引擎不再为其创建浏览器实例。
- 经一次性探针实测（`$` 的全部 29 个成员、15 个引擎命名空间、HTML 面板的 `http:` / `data:` / `file:` 三种协议），确认**游戏内不存在任何可用的入站通道**，「在游戏内显示译文」在架构上不可行。
- 唯一可用的通道变为单向的 `游戏 → console.log`：mod 在聊天落档点输出 `[LCT-CHAT]` 单行 JSON，本地桥增量 tail 解析并翻译。

### 新增

- **游戏外翻译悬浮窗**（原生 WPF，`scripts/overlay_window.ps1`；双击 `ShowOverlay.bat` 即可打开，不必先启动游戏）
  - 真透明 + 始终置顶：浏览器小窗有不透明底板，改用 WPF 的 `AllowsTransparency` 实现
  - 贴边自动收起：拖到任意屏幕边缘即吸附，平时只留一条 12px 细条，鼠标扫过自动展开
  - 面板不透明度、背景色、圆角、主题色可调，并预留自定义背景图
- **字幕浮层**：角落堆叠的聊天胶囊（发言者色牌 + 昵称 + 原文 + 译文），全屏游戏时不挡视野
  - 鼠标完全穿透，不影响游戏操作
  - 位置直接拖拽放置，存为相对工作区的比例，换分辨率不会跑偏
  - 支持「一直留存」模式：不按时间消失，只保留最近 N 条，超出才挤掉最旧的
  - 留存时间、淡入淡出时长、字号、三种文字颜色、同屏条数均可调
- **设置面板**：在悬浮窗内即可配置翻译服务商、API Key、目标语言、显示模式、发送模式、超时等（原 `/tr` 面板内容），以及上述悬浮窗与字幕设置
- **术语表补全**：新增 194 条商店装备的官方中英文对照，英雄表核对为 46 个可玩英雄（与官方数据一致）；数据源与刷新流程见 `AGENTS.md`
- 发消息走剪贴板：悬浮窗输入中文 → 译成英文 → 自动复制 → 回游戏 `Ctrl+V` 发送

### 修复

- 游戏内聊天行不再出现红色的 `翻译失败: bridge_panel_unavailable`（通道永久不可用，重试与报错标签均无意义）
- 设置页的输入框 / 勾选框 / 下拉框此前沿用 WPF 系统浅色模板，与深色面板割裂，现统一到深色主题

### 界面

- 视觉重排：取游戏自身世界观（1930 年代纽约的氧化黄铜、铜绿、羊皮纸）定色，颜色按功能分配而非装饰
- 拉丁字母改用 Bahnschrift SemiCondensed：外文原文呈现为工业压缩体、中文译文为人文无衬线，两者视觉上自然分层

### 说明

- 游戏内显示译文**无法恢复**，除非游戏后续更新改回 HTTP 能力。`probeInboundChannels()` 保留在 mod 中作为探针，若引擎恢复会立刻发现。
- 运行环境：Windows 10/11 自带的 PowerShell 5.1 与 WPF，无需额外运行时。

## v1.0.1 - 2026-10-01

修复 Deadlock 更新后 mod 完全不被加载的问题，并加固本地桥的稳定性。

### 修复

- 修复游戏更新后 addon 不被挂载：`gameinfo.gi` 的 `SearchPaths` 丢失 `Game citadel/addons`，需在 Deadlock Mod Manager 中重新应用一次补丁（该文件不要手改，手改会触发 `Failed to parse KeyValues`）
- 本地桥新增 `uncaughtException` / `unhandledRejection` 全局兜底：未捕获异常与未处理的 Promise 拒绝只记日志，不再让桥进程静默退出
- 顶栏布局按 2026-09-30 版原版重基线：补回根节点 `hittest="false"`、移除 `PlayerDetailsContainer` 上已废弃的 `hittest="false"`、更新连杀文案 token、补回新增的 `PlayerHeroReleaseVote` 面板
- 聊天布局 `ChatMessageContents_Ping` 片段补回 `TargetHeroImage` 与 `PingLabel` 的 `html="true"`，恢复 ping 目标英雄头像

### 其他

- 新增英文 README（`README_EN.md`）
- 用户本地学习词典 `config/dictionary.json` 不再入库，改为首次运行自动生成

## v1.0.0 - 2026-09-12

首个公开 1.0 版本，项目更名为 `DeadlockLingua`。

### 新增

- 多翻译服务商回退：Bing、Microsoft、OpenAI 兼容、DeepL、Google Cloud
- 发送前翻译，支持双语/仅译文发送
- 聊天日志按比赛 ID 写入 `logs/chat/<matchId>.jsonl`
- SteamID 自动回填与 `identity_cache.json` 缓存
- 整局玩家 roster 拉取，按 `account_id` 去重
- 桥后台无窗口启动与开机自启

### 优化

- 修复聊天扫描循环静默死亡、HUD 行 TDZ、ESC 菜单误扫描等稳定性问题
- SteamID roster 首次请求延迟到比赛文件写入 6 小时后，避免过早请求
- 清理 GameBanana 发布内容和仅用于 GameBanana 的脚本及依赖
- 修复 Windows 任务管理器/联想电脑管家禁用自启后无法重新启用的问题

### 破坏性变更

- 项目品牌由 `BabelTower` 改为 `DeadlockLingua`
- 发布包名称改为 `DeadlockLingua-<版本>-win64.zip`

