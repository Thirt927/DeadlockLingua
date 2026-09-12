# DeadlockLingua

> Deadlock 游戏内聊天实时翻译 Mod，fork 自 [BabelTower](https://github.com/c1375rick/BabelTower)，由 [Thirt927](https://github.com/Thirt927) 继续维护和优化。

把《Deadlock》聊天里的外语消息实时翻译成你的语言，译文直接显示在原消息下方；也可以把你发送的内容先翻译成目标语言再发出。

## 功能亮点

- 多翻译服务商：Bing（免 Key）、Microsoft、OpenAI 兼容、DeepL、Google Cloud
- 主服务商失败自动回退到已配置的备用服务商
- 发送前翻译：中文等本地语言 -> 英文等目标语言
- 聊天日志：按比赛 ID 写入 JSONL，便于赛后复盘
- SteamID 回填：聊天昵称自动补 SteamID64
- 整局玩家缓存：比赛结束 6 小时后拉取 12 人名单，按 `account_id` 去重
- 后台运行：桥进程可无窗口启动，关闭终端窗口不会中断

## 安装

推荐直接下载最新 Release：

```text
https://github.com/Thirt927/DeadlockLingua/releases/latest
```

1. 解压 `DeadlockLingua-<版本>-win64.zip` 到无空格路径，例如 `D:\DeadlockLingua`。
2. 安装 `pak01_dir.vpk` 到 Deadlock addons：
   - 推荐使用 Deadlock Mod Manager 导入。
   - 或手动复制到 `<Steam 库>\steamapps\common\Deadlock\game\citadel\addons\`。
3. 双击 `install-autostart.bat` 安装开机自启；或双击 `StartBridgeSilent.vbs` 临时后台启动桥。
4. 重启 Deadlock，进入对局后按 `Enter` 打开聊天，输入 `/tr` 打开设置面板。

源码用户：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/build.ps1 -Csdk12Root "<CSDK_DIR>"
```

## 使用

### 启动桥

推荐后台启动：

```bat
StartBridgeSilent.vbs
```

也可以从终端启动：

```bat
StartDeadlock.bat
```

停止桥：

```bat
StopBridge.bat
```

### 设置

游戏内输入 `/tr` 打开设置面板。首次运行会生成 `config/config.json`；也可以复制 `config/config.example.json` 手动配置。

`config/config.json` 包含 API Key，已被 `.gitignore` 忽略，不要提交到 Git。

## 更新说明

### v1.0.0

- 项目名改为 `DeadlockLingua`，公开仓库地址为 `https://github.com/Thirt927/DeadlockLingua`
- 清理 GameBanana 发布内容及仅用于 GameBanana 的脚本和 `puppeteer` 依赖
- 内置后台桥启动、自动重试、SteamID 回填与整局 roster 去重
- 修复自启被 Windows 任务管理器/联想电脑管家禁用后无法重新启用的问题

更新方法：

1. 备份现有 `config/config.json`，下载并解压新版本。
2. 删除旧 VPK，重新导入新 `pak01_dir.vpk`。
3. 将备份的 `config/config.json` 复制到新目录。
4. 双击 `StopBridge.bat` 停止旧桥，再双击 `StartBridgeSilent.vbs` 启动新桥。
5. 完全重启 Deadlock 后进对局，用 `/tr` 测试保存。

更详细的历史变更见 `CHANGELOG.md`。

## 聊天日志与 SteamID

聊天日志默认写入：

```text
logs/chat/<matchId>.jsonl
```

身份缓存：

```text
logs/chat/identity_cache.json
```

缓存中包含两类键：

- 昵称键：用于聊天消息回填 SteamID
- `account:<account_id>` 键：整局玩家权威记录，避免重名和改名冲突

SteamID 处理策略：

- 聊天消息中的具名玩家会在文件写入 3 分钟后尝试按昵称回填。
- 整局 12 人 roster 会在比赛文件写入 6 小时后首次请求公开 API。
- 首次 roster 请求后若未成功，每 1 小时自动重试一次。
- 同一账号跨多局遇到时 `matchCount` 递增，但不会生成重复缓存记录。

## 构建

需要 Reduced CSDK 12 和 VPKEdit CLI：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/build.ps1 -Csdk12Root "<CSDK_DIR>"
```

构建后按项目部署约定重命名 VPK，再复制到 Deadlock addons。

## 测试

```powershell
node scripts/lingua_chat_simtest.js
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
powershell -ExecutionPolicy Bypass -File scripts/package_release.ps1 -Version 1.0.0
```

发布包会包含桥、内置 Node、启动/停止脚本和文档。

## 目录结构

```text
DeadlockLingua/
├── mod/                          Panorama UI 源码
│   ├── panorama/layout/          布局覆盖
│   ├── panorama/scripts/         聊天扫描与桥接逻辑
│   └── panorama/styles/          译文与设置面板样式
├── core/                         本地 Node.js 桥
│   ├── bridge_server.js          HTTP 服务与隐藏面板页面
│   ├── config.js                 本地配置管理
│   ├── dictionary.js             自适应学习词典
│   ├── glossary.js               游戏术语表
│   ├── hero_names.js             英雄译名
│   ├── steamid_enrich.js         SteamID 回填与整局 roster
│   └── providers/                翻译服务商
├── config/                       配置与词典
├── scripts/                      构建、打包与测试脚本
├── docs/                         架构、优化日志与参考资料
├── StartBridgeSilent.vbs         无窗口后台启动
├── StartDeadlock.bat             终端/带游戏启动
├── StopBridge.bat                停止桥
├── RestartBridge.bat             重启桥
└── LICENSE / LICENSE_NOTICE.md
```

运行时目录不进入 Git：

- `config/config.json`：本地密钥
- `logs/`：桥日志和聊天日志
- `dist/`：构建产物
- `portable-node/`：本地 Node 运行时
- `tools/`：本地打包工具

## 许可证

- 本项目代码：GNU GPL v3，见 `LICENSE`
- 第三方协议说明：`LICENSE_NOTICE.md`
- 游戏内 Valve 布局素材仅用于兼容性，版权归 Valve
