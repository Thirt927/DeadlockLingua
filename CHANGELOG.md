# Changelog

所有重要变更都会记录在此文件。

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

