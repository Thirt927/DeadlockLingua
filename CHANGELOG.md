# Changelog

所有重要变更都会记录在此文件。

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

