# Babel Tower Fork (Deadlock 聊天翻译) — 项目速查

本文件供 AI 代理每次对话自动加载,避免重复探索路径/环境。默认语言:中文。

## 1. 项目一句话

Deadlock 游戏聊天翻译 mod = **Panorama(Source 2 原生 UI)模组 + 本地 Node.js 桥**。
不是 MelonLoader / BepInEx / Source2Mod / Overwolf / 内存读取。

## 2. 关键路径(写死,不用再搜)

- 项目根:`F:\agents\deadlockfanyi\BabelTower-fork`
- CSDK12(编译 SDK):`E:\dealoc-mod\Reduced_CSDK_12`
  - `resourcecompiler.exe`:`E:\dealoc-mod\Reduced_CSDK_12\game\bin_cs2\win64\resourcecompiler.exe`
- Deadlock 安装:`E:\Steam\steamapps\common\Deadlock`
  - mod 部署目录(addons):`E:\Steam\steamapps\common\Deadlock\game\citadel\addons`
  - 游戏原始 pak01(勿动):`E:\Steam\steamapps\common\Deadlock\game\citadel\pak01_dir.vpk`(6.9MB)
- VPK 打包工具:`F:\agents\deadlockfanyi\BabelTower-fork\tools\vpkeditcli.exe`
- 编译产物:`F:\agents\deadlockfanyi\BabelTower-fork\dist\pak22_dir.vpk`
- 桥日志:`F:\agents\deadlockfanyi\BabelTower-fork\logs\bridge.log`
- 聊天日志:`F:\agents\deadlockfanyi\BabelTower-fork\logs\chat\<matchId>.jsonl`
- 翻译悬浮窗(游戏外,默认):`scripts\overlay_window.ps1` —— 原生 WPF 透明窗口,桥检测到 deadlock.exe 会自拉起
  - **手动打开(不必开游戏)**:双击 `ShowOverlay.bat`,或 `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\overlay_window.ps1`
  - 脚本内有具名互斥锁 `Local\DeadlockLinguaOverlay`,重复启动会直接退出,不会开出第二个窗口
  - 网页版(回退):`http://127.0.0.1:8791/overlay`(把 `config.json` 的 `overlay.mode` 改成 `"web"`)
- 配置:`F:\agents\deadlockfanyi\BabelTower-fork\config\config.json`(provider 当前 openai→DeepSeek)

## 3. 构建 + 部署(最重要流程)

构建(产物固定输出为 `dist\pak01_dir.vpk`):

```powershell
powershell -ExecutionPolicy Bypass -File F:\agents\deadlockfanyi\BabelTower-fork\scripts\build.ps1 -Csdk12Root "E:\dealoc-mod\Reduced_CSDK_12"
```

⚠️ **必须把产物改名为 pak22 再部署**(pak01 是游戏资源名,不要覆盖):

```powershell
Copy-Item F:\agents\deadlockfanyi\BabelTower-fork\dist\pak01_dir.vpk F:\agents\deadlockfanyi\BabelTower-fork\dist\pak22_dir.vpk -Force
Copy-Item F:\agents\deadlockfanyi\BabelTower-fork\dist\pak22_dir.vpk "E:\Steam\steamapps\common\Deadlock\game\citadel\addons\pak22_dir.vpk" -Force
```

- 部署后需重启 Deadlock 才生效
- addons 里的 `pak01_dir.vpk` 是旧构建产物,应删除,不要保留

## 4. 架构

- **游戏内**:`mod/panorama/*` — `chat.xml` / `hudchat.xml` 覆盖原版布局,注入 `lingua_chat.js`(扫描聊天 DOM、翻译、日志)
- **本地桥**:`core/bridge_server.js`,监听 `127.0.0.1:8791`(Node.js HTTP)
- **通信通道(重要变更 2026/10/01)**:游戏 **2026-10-01 16:00 的更新移除了 Panorama 全部 HTTP 能力** —— `$.AsyncWebRequest` 调用即抛 `AsyncWebRequest has been removed.`,隐藏 HTML 面板 `SetURL` 不报错但引擎不再为其创建浏览器实例(`panel.title` 永远 `undefined`,桥端 `/bridge` 请求计数为 0)。**游戏内收发网络已不可能**,不要再走 panel / AsyncWebRequest 路线。
- **当前可用通道**:单向 `游戏 → console.log`。mod 每落档一条聊天就 `$.Msg("[LCT-CHAT]" + JSON 单行)`(`lingua_chat.js` 的 `emitOverlayChat`,埋点在 `pushEntry()`),桥端 `core/overlay.js` 增量 tail `console.log` 解析,翻译后由游戏外悬浮窗显示;发消息走剪贴板(`/api/v1/overlay/translate` 出英文 → 用户回游戏 Ctrl+V)。
- **入站通道已定论(2026/10/01 探针实测,不要再重复排查)**:游戏内**不存在任何**可用的入站通道,"游戏内显示译文"在架构上不可能。硬证据:①`$.` 只有 29 个成员(`Msg/AssertHelper/Warning/DispatchEvent/DispatchEventAsync/RegisterEventHandler/RegisterForUnhandledEvent/UnregisterForUnhandledEvent/FindChildInContext/AsyncWebRequest/CreatePanel/CreatePanelWithProperties/CanLocalize/Localize/ConstructString/ConstructMFString/Language/Schedule/CancelScheduled/FrameTime/GetContextPanel/RegisterKeyBind/Each/DbgIsReloadingScript/HTMLEscape/LogChannel/BImageFileExists/MousePosition/CreatePanelWithCurrentContext`),没有任何读文件/读剪贴板/执行控制台命令的原语;②`globalThis` 上只有 5 个引擎全局(`PlayUISoundEvent/StopUISoundEvent/IsUISoundEventPlaying/PlayLocalHeroSound/StopLocalHeroSound`);③`Game/Players/GameStateAPI/GameInterfaceAPI/GameUI/Citadel/...` 15 个命名空间实测 `present=(none)`;④动态 `<HTML>` 面板设成会渲染的形态后,`SetURL` 到 `http://` / `data:` / `file://` 三者 `panel.title` **全为空**,桥端 `/bridge load` **零条** → 引擎根本不为面板创建 CEF 实例;⑤`BImageFileExists` 对 addons 目录里**实际存在**的文件也返回 `false` → 资源系统看不见松散文件。
  - 渲染能力本身没丢(`Label.text` 一直可用,mod 照样能往聊天行插字),缺的**只是数据来源**,不要再往"恢复游戏内翻译"的方向投入。`probeInboundChannels()` 保留在 `lingua_chat.js` 里当 canary,未来引擎若恢复 CEF 会立刻发现。
- **悬浮窗(native,默认)**:`scripts/overlay_window.ps1` 是 **WPF** 原生窗口(`AllowsTransparency` + `Topmost`),所以能真透明并贴屏边自动收起。**改这个文件必须存成 UTF-8 with BOM**(`[System.IO.File]::WriteAllText($p,$c,(New-Object System.Text.UTF8Encoding $true))`),否则 PowerShell 5.1 按 ANSI 读会把中文读成乱码。它用 `WebClient`(强制 UTF8)+ `ConvertTo-Json -Compress` 调桥,用 `[System.Windows.Clipboard]::SetText()` 写剪贴板(原生进程,不受浏览器剪贴板策略限制)。想切回网页版把 `overlay.mode` 改成 `"web"`。
  - **两个窗口**:面板窗(聊天/输入/设置,可拖动,贴最近的一条屏边收起成 12px 细条)+ **字幕浮层**(角落堆叠的聊天胶囊 = 发言者色牌 + 昵称 + 原文 + 译文,`WS_EX_TRANSPARENT` 鼠标完全穿透)。
  - **字幕浮层(`view="subtitle"`,旧值 `danmaku` 已迁移)**:位置存成相对工作区的比例 `subtitle.xRatio/yRatio`(换分辨率不跑偏)。因为穿透窗收不到鼠标事件,拖拽定位靠设置页的「调整字幕位置(拖动)」按钮:进入编辑模式时临时摘掉 `WS_EX_TRANSPARENT` 才能拖动,拖完「完成放置」落盘。发言者身份用**昵称哈希 → 8 色精选调色板**的首字母色牌(没有真实头像可用)。`Add-Subtitle` 按 `seq` 复用节点以原地补后到的译文,并用 `SubSeen` 防止过期胶囊被轮询复活。
  - **设置面板**由 `$script:FieldSpec` 数组生成(支持 bool/enum/int/text/secret/color/file/range);加选项只需加一行 spec。提交走 `POST /api/v1/config` 的 **`{config:{...}}` 包装**,读取要解包 `GET` 的 **`{ok, config:{...}}`** —— 平铺 body 会被桥静默忽略。
  - **透明度只合成到背景色**(`New-PanelBrush` 生成 ARGB),不要用 `Window.Opacity`,否则文字一起变淡看不清。
  - **设计令牌**:配色集中在文件开头的 `$script:T`(取游戏自身世界观:1930s 纽约的氧化黄铜/铜绿/羊皮纸),字体在 `$script:F`(拉丁 Bahnschrift SemiCondensed + 中文回落雅黑;原文用工业压缩体、译文用人文无衬线,两者视觉分层)。两个窗口的 XAML 都是**插值 here-string**(`@"..."@`),直接引用 `$($T.Xxx)`。
  - ⚠️ **`overlay.background` / `overlay.accent` 会覆写令牌色**:`Apply-Config` 用配置里的这两项设置 `Root.Background` / `Root.BorderBrush`,所以改令牌时**必须同步** `core/config.js` 的 `DEFAULTS.overlay.background/accent`,否则新配色会被旧色盖掉。
- **API 端点**:`/api/v1/translate` `/log` `/config` `/health` `/diag` `/api/v1/overlay/messages` `/api/v1/overlay/translate`;页面 `/bridge`(面板用,已废) `/overlay`(网页版悬浮窗)
- **聊天内容来源**:扫描 UI DOM(`#ChatMessages` 子行、`Team1Chat/Team2Chat` 顶栏气泡、大厅 `ChatLinesPanel`)

## 4.5 术语表(glossary.js)与其数据源

- `core/glossary.js` 会把术语表注入**每一次**翻译提示词: `heroNames`(46 个可玩英雄的官方英文名) + `heroCnToEn`(中文昵称→英文) + `itemEnToCn`(**194 条商店装备官方中英对照**) + `termsCnToEn`(战术术语)。`fixHeroTerms()` 另对输出做英雄名纠正。注入后 `buildHint()` 约 5.6k 字符。
- **权威数据源(2026-10-01 实测可用,需代理)**:`https://api.deadlock-api.com/v1/assets/heroes` 与 `/v1/assets/items`,两者都支持 **`?language=english|schinese`**。注意:
  - `assets.deadlock-api.com` 这个域名**不存在**,别再用;真正的接口在 `api.deadlock-api.com/v1/assets/` 下。
  - `openapi.json` 很大(约 443KB)且常被截断,用 `curl.exe -sS -L --compressed --max-time 300 -o <file>` 下载并**校验 JSON 能 parse** 再使用。
  - items 返回 729 条,`type` 分 `ability`(395) / `weapon`(84) / `upgrade`(250)。**商店装备就是 `upgrade`**;其中 55 条 `name` 仍是 class_name(未本地化),要过滤掉。
  - heroes 返回 65 条,但只有 **46 条 `player_selectable=true`**;其余 20 条是未发布的开发中英雄(Kai / Gunslinger / Rat King / Nurse Harrow …),**不要加进术语表**。
- **刷新流程**:下载两份 items(english + schinese) → 取 `type==='upgrade'` 且 `name` 不是 class_name 的条目 → 生成 `EN: CN` 对象写进 `glossary.js` 的 `itemEnToCn`。英雄同理(只取 `player_selectable=true`)。

## 5. 当前进行中(matchId / 玩家信息)

- **已解决(昵称/英雄)**:聊天日志的 `hero` 改用 TopBar 的 `PlayerName` / `HeroName` 读取;`lingua_chat.js` 中 `refreshTopbarIdentity()` 建立 `昵称<->英雄` 映射,HUD 气泡优先从 `HeroImage` 读英雄并反查昵称。
- **已验证**:聊天布局上下文里没有 `Game` / `Players` 全局 API,不要再走 `Players.GetPlayerInfo()` 路线。
- **SteamID(被动只读,不主动开卡)**:`players_list_entry.xml` / `profile_card.xml` / `citadel_db_page_profile.xml` 各加了隐藏 `<Label text="{i:r:account_id}">`(必须保持 `visible="false"` + `opacity:0;width:0;height:0`,不能用 `visibility:collapse`,否则宏不求值)。采集入口是 `pollSteamIdRoster()`:① ESC 打开时 `captureEscapeRosterAccounts()` 只读玩家行 `LCTRowAccount` 采集全部玩家(零交互);② 用户自己悬停/查看资料时 `captureVisibleProfileAccounts()` 扫资料卡。**任何场景都不派发 MouseOver/Activated 主动开卡**(会抢游戏控制权)。本机 steamid 由桥端从 console.log 连接行回填。改动后需重建 VPK 部署并重启游戏。
- **matchId**:`probeMatchId()` 全局 API 探测失败,目前 fallback `session_`;与玩家身份问题分开处理。

## 6. 优化日志规则

- 当用户说“优化好了”时，必须把该次优化写入 `docs/OPTIMIZATION_LOG.md`。
- 即使用户没说“优化好了”，只要功能确实实现并通过验证，也必须把该次优化写入 `docs/OPTIMIZATION_LOG.md`。
- 每次写入包含：日期、优化主题、改动文件、原因/效果、验证方式、是否需用户测试。

## 7. 经验教训(改代码时注意)


- 修改 `.js` 文件:**用 Python3 文本模式**(`open(path,"r"/"w",encoding="utf-8")`)读写;PowerShell 的 `$content.Replace()` 会因 CRLF/编码问题静默失败
- 通过 shell heredoc 传中文给 `python3` stdin 会损坏成 `?`:**代码注释用英文**,或单独用 PowerShell 写中文
- 文件行尾是 **CRLF**
- `config.json` 里的 apiKey 是 DeepSeek 的,日志输出**绝不能**包含 apiKey
- 默认语言中文,读取文件先试 UTF-8

## 8. 推送 GitHub 前的敏感信息检查(强制)

- 每次 `git commit` / `git push`(origin / public / upstream)之前必须自查一遍,不要图快直接 `git add -A` 整体提交。
- 必须排除:apiKey 与任何 `sk-` 开头的 Key(DeepSeek 等)、SteamID64 / `account_id` / 玩家昵称、`matchId` 与聊天原文片段、本机绝对路径(含 Windows 用户名)、`logs/`、`dist/`、`*.vpk`、`portable-node/`、`config/dictionary.json.bak`。
- 提交前逐行看:`git status` + `git diff --cached`;再用 `rg -n "apiKey|sk-|steamid|account_id|matchid" --glob "!logs/**"`(或 `git grep -n -I -E "<同上正则>"`)扫一遍待提交内容。
- 确认忽略规则仍然生效:`git check-ignore -v config/config.json logs/chat` 应有输出。
- 一旦发现敏感信息已经推送:立刻改写历史或撤销该提交,并轮换已泄露的 Key,不要只补一个“删除文件”的提交。
