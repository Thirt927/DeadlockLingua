# 优化日志

> 记录规则：当用户说“优化好了”时写入本日志；或者用户没说，但功能确实实现了的优化也写入本日志。

## 2026-08-16 聊天昵称 / 英雄 / SteamID 采集改造

- **背景**：旧方案在聊天行和全局 API 中查找玩家信息，但聊天布局脚本上下文中没有 `Game` / `Players` 全局 API，导致昵称、英雄和 SteamID 均无法稳定读取。
- **参考来源**：`F:\agents\deadlockfanyi\deadlock参考资料\Deadlock-mods-collection-main\showrank_barebones`
- **改动文件**
  - `mod/panorama/scripts/lingua_chat.js`
  - `mod/panorama/layout/players_list_entry.xml`
  - `mod/panorama/layout/profile_card.xml`
  - `mod/panorama/layout/citadel_db_page_profile.xml`
- **实现内容**
  - TopBar 身份扫描：`refreshTopbarIdentity()` 读取 `PlayerName` / `HeroName`，建立昵称与英雄双向映射。
  - 聊天日志回填：`resolveSender()` / `resolveHero()` 用 TopBar 映射补齐昵称和英雄；HUD 气泡优先从 `HeroImage` 读英雄并反查昵称。
  - SteamID 采集：在玩家列表行和 ProfileCard 中增加隐藏 `account_id` Label，由 `snapshotProfileAccounts()` / `scanSteamIdRows()` / `probeNextSteamIdRow()` 在 ESC 玩家列表激活 ProfileCard 时采集，`resolveSteamId()` 按英雄名或昵称回查 SteamID64。
- **验证方式**
  - `node --check` 已通过。
  - `scripts/build.ps1` 编译 7 个文件成功。
  - 已重新部署 `dist/pak22_dir.vpk` 到 `E:\Steam\steamapps\common\Deadlock\game\citadel\addons`。
- **仍需用户测试**
  - 重启 Deadlock。
  - 局内按 ESC，让玩家列表 / ProfileCard 流程跑一次。
  - 查看 `logs/chat/<matchId>.jsonl` 的 `steamid` 是否填充。
  - `logs/bridge.log` 搜索 `topbar identity scan`、`steamid roster collected`、`steamid roster pass incomplete`。

## 2026-08-17 第二轮修复:聊天日志身份字段(hero/heroId/steamid)仍未生效的根因修复

- **背景**:2026-08-16 部署的新代码在 23:13 重启后的两局对局中仍未写入 hero/steamid,且桥日志里完全没有 `topbar identity scan` / `steamid roster` 标记。
- **根因(均已从游戏 pak 与日志验证)**
  1. 顶栏玩家面板类型名错误:`TOPBAR_PLAYER_TYPE` 写成了 `CitadelHudTopBarPlayer`,游戏原版 `citadel_hud_top_bar_player.vxml` 根类型是 `HudTopBarPlayer`(resourcecompiler 不校验未定义标识符,构建不报错,运行时静默返回 0)。
  2. 新增的 SteamID 采集代码引用了 9 个从未定义的常量(`ESCAPE_MENU_TYPE`/`PLAYER_ROW_TYPE`/`PROFILE_CARD_TYPE`/`STEAMID_ROW_DELAYS` 等),运行时抛 ReferenceError 被 try/catch 吞掉,ESC 采集流程完全失效。
  3. 对话框变量读取用了 `GetDialogVariableString`(游戏/参考 mod 实际是 `GetDialogVariable`),导致行内 hero_id/hero_name 等对话框变量全部读不到。
- **改动文件**
  - `mod/panorama/scripts/lingua_chat.js`:补全 9 个缺失常量;顶栏类型改为 `HudTopBarPlayer`(保留旧名兜底);`panelDialogString`/`profileString` 增加 `GetDialogVariable`/`GetDialogVariableInt`;`readHeroFromRow` 新增隐藏 `LCTRowHero` 宏 label、`readHeroFromHeroImage`(对话框变量/英雄 class/头像文件名映射);`scanSteamIdRows`/`inspectSteamIdRow` 支持直接读行内 steamid;`resolveHero`/`resolveHeroId` 互查;顶栏扫描补全 0 面板/0 英雄的诊断日志。
  - `mod/panorama/layout/chat.xml`:聊天行内加隐藏 `<Label id="LCTRowHero" text="{g:citadel_hero_name:hero_id}">`,若引擎在行内绑定 hero_id 则直接渲染英雄名。
- **验证方式**
  - `node --check` 通过;`scripts/lingua_chat_simtest.js` 45/45 通过。
  - `scripts/build.ps1` 编译 7 个文件成功,已重新部署 `dist/pak22_dir.vpk` 到 addons(190787 字节)。
- **仍需用户测试**:重启 Deadlock → 打一局 → 看 `logs/chat/<matchId>.jsonl` 是否填充 hero;桥日志搜索 `topbar identity scan players=`、`steamid roster collected`、`rowdiag ... dlg={hero_id=...}`。局内按 ESC 让玩家列表跑一次以采集 steamid。

## 2026-08-18 第三轮修复:顶栏遍历深度限制 + 本地化英雄名 + 快捷发言标记

- **背景**:第二轮部署后(08/17 23:38 局)hero/steamid 仍为空。桥日志持续输出 `topbar identity scan: no HudTopBarPlayer panels`,且无 `steamid roster` 标记;聊天行内 `CitadelHeroImage id=HeroImage` 的 attrs/dlg 全空。用户同时澄清:`<unknown>` 发言是游戏快捷指令(聊天轮盘),不是玩家主动输入,不应视为识别失败。
- **根因(本轮已从安装的 mod 与日志验证)**
  1. 顶栏玩家类型名其实没错:addons 里已安装的 `656390_Show-Nicknames-In-TopBar.vpk` 其 `citadel_hud_top_bar_player.vxml` 根类型正是 `HudTopBarPlayer`。真正问题是 `findAllPanelsByType` 的遍历上限(深度 32 / 4000 节点)——顶栏在全局 HUD 树中的层级远超 32,type 扫描静默返回 0;而 `Team1Chat`/`Team2Chat` 一直能找到,是因为 `FindChildTraverse` 是引擎原生遍历、无深度限制(桥日志 `watching HUD top bar chat (2)` 证实)。
  2. 同样的深度限制导致 ESC 菜单 / 玩家行 / ProfileCard 的 type 扫描全部失败(局内 GC 日志显示玩家确实按了 ESC 打开了资料卡,但桥端从未触发采集)。
  3. 游戏渲染的英雄名是本地化文案(中文客户端如 `灵魅`/`魔液`),需要反向映射为英文键,否则日志 hero 字段不一致。
- **改动文件**
  - `mod/panorama/scripts/lingua_chat.js`
- **实现内容**
  - 顶栏扫描改为结构优先:`findTopbarPlayerEntries()` 用 `FindChildTraverse("CitadelHudTopBar"/"TeamsContainer"/"TopBarPlayer0..23")` + `HeroName`/`PlayerName` class 反查条目容器,type 扫描仅作兜底;`findAllPanelsByType` 深度上限 32→80、节点上限 6000→20000。
  - `readTopbarIdentity` 扩展英雄来源:`HeroName` class → 对话框变量 → `HeroBadge`/`HeroImage`(走 `readHeroFromHeroImage`)。
  - `readHeroFromHeroImage` 增加属性/方法探测:`GetAttributeString/GetAttributeUInt32/GetAttributeInt`、`GetHeroName/GetHeroID/GetHero/GetHeroId/GetHeroIndex` 等 C++ 方法,`panelDialogIntString` 读 `hero_id`。
  - 新增 `ZH_HERO_TO_EN`(中文英雄名→英文键)与 `normalizeHeroName()`,统一 `readHeroFromRow`/`readProfileHero`/`readPlayerRowHero`/`resolveHero`/顶栏读到的英雄名为英文。
  - ESC 菜单:`findEscapeMenuRoot()` 增加 alt 类型列表 + 固定 id(`PlayersTab`/`EscapeBackground`/`ContextualMenu`)反查;玩家行/ProfileCard 增加 alt 类型列表。
  - 日志条目新增 `kind` 字段:`quick`(快捷发言/Ping/HUD 气泡)/`hud`/`lobby`/`chat`,区分非玩家主动发言。
  - 新增一次性诊断:`topbar entry[i] id/name/hero/account`、`heroimg probe ownKeys/proto/方法返回值`、`steamid roster: escape menu found/not found`,用于下一局直接定位剩余问题。
- **验证方式**
  - `node --check` 通过;`scripts/lingua_chat_simtest.js` 45/45 通过。
  - `scripts/build.ps1` 编译 7 个文件成功,已部署 `dist/pak22_dir.vpk` 到 addons(204187 字节)。
- **仍需用户测试**:重启 Deadlock → 打一局 → 查看 `logs/bridge.log` 的 `topbar identity scan players=`/`topbar entry[i]`/`steamid roster:`/`heroimg probe` 输出,以及 `logs/chat/<matchId>.jsonl` 的 `hero`/`steamid`/`kind` 字段。局内按 ESC 触发一次玩家列表采集。
## 2026-08-18 第四轮修复:顶栏条目扫描目标错位(新版动态条目)+ ESC 玩家行 class 化 + 场景侦察

- **背景**:第三轮部署后(08/18 0:0x 局)hero/steamid 仍全空;用户澄清 `<unknown>` 发言是快捷指令(正常,`kind:quick` 已标记)。桥日志显示 `watching HUD top bar chat (2)`(`Team1Chat` 能找到),但顶栏玩家条目扫描返回 0。
- **根因(已从解包布局与已安装 pak 验证)**
  1. 当前游戏版本 `citadel_hud_top_bar.vxml` 根类型是 `HudTopBar`,没有 `TeamsContainer`/`TeamFriendly`/`TopBarPlayer0-23`——玩家条目由游戏 JS 动态创建,旧的结构反查(`TopBarPlayerN`/`TeamsContainer`)全部落空;玩家条目布局 `citadel_hud_top_bar_player.vxml`(当前 pak 5040 字节,与 `temp_extract` 一致)无 `HeroName`/`PlayerName` id,昵称显示靠 Show-Nicknames 样式 `.AlwaysPlayerName`(用 `{s:player_name}` 渲染),英雄名靠条目内 `HeroBadge`(通常带 `{g:citadel_hero_name:hero_id}` 宏)。
  2. ESC 菜单根找得到(`CitadelHudEscapeMenu`/`PlayersTab`/`EscapeBackground`/`ContextualMenu`),但玩家行由 `players_list_entry` 动态实例化,type 扫描不一定命中;行内隐藏 `LCTRowHero`(`{g:citadel_hero_name:hero_id}`)是英雄名真正来源。
- **改动文件**
  - `mod/panorama/scripts/lingua_chat.js`
  - `mod/panorama/layout/players_list_entry.xml`(根加 `class="LCTPlayerRow"`)
  - `mod/panorama/layout/profile_card.xml`(根加 `class="LCTProfileCard"`)
- **实现内容**
  - `findTopbarPlayerEntries()` 新增两条新版路径:昵称/英雄名 Label(`AlwaysPlayerName`/`PlayerName`/`HeroName` 等 class)`FindChildrenWithClassTraverse` 全树收集后反查祖先条目容器;`HeroBadge`/`HeroImage` id 反查祖先条目容器;type 扫描仅兜底。
  - `findAllPanelsByType` 重构为 `scanPanelsByType(root,type,maxDepth,maxNodes)`(带统计),保留旧包装。
  - `scanSteamIdRows()` 优先按 `LCTPlayerRow` class 找玩家行(不依赖 paneltype);`findVisibleProfilePanels()`/`scanProfileCardsOnce()` 优先按 `LCTProfileCard` class。
  - ESC 菜单:`isEscapeMenuOpen(escapeRoot, root)` 增加 `ShowEscapeMenu` class 判断(`hudHasEscapeClass`);`findEscapeMenuRoot()` 增加 class 反查与 `Hud.ShowEscapeMenu` root 兜底;会话内三处检查改为 `isSteamIdSessionOpen(session)`。
  - 换局重采:`rowRosterSignature()`(hero|name 组合)代替原签名,`startSteamIdRosterPass` 在阵容变化时清空 `steamIdRosterCollected` 重新采集,`finishSteamIdRoster` 空名单时重置签名。
  - 一次性场景侦察 `reconScene()`(启动 6s 后):dump root 链、`Team1Chat`/`Hud`/`HudTopBar`/ESC 关键子树 id/type/class/文本/对话框变量,以及顶栏玩家条目识别结果,用于下一局直接定位。
  - `probeHeroImage` 增加 `GetDialogVariables`/`data`/`layoutfile`/`paneltype` 探测。
- **验证方式**
  - `node --check` 通过;`scripts/lingua_chat_simtest.js` 45/45 通过。
  - `scripts/build.ps1` 编译 7 个文件成功,已部署 `dist/pak22_dir.vpk` 到 addons(215201 字节,旧版备份为 `pak22_dir.vpk.bak_round4`)。
- **仍需用户测试**:重启 Deadlock → 打一局 → 桥日志搜 `recon root`/`recon target`/`recon player[i]`/`topbar identity scan players=`;局内按 ESC 打开 PlayersTab 并逐个点击几行玩家(ProfileCard 需行点击才实例化,是采集 steamid 的必经路径);确认 `logs/chat/<matchId>.jsonl` 的 `hero`/`steamid`/`kind`。
## 2026-08-18 第五轮修复:全树扫描风暴导致黑屏/卡顿(降频节流)

- **背景**:第四轮部署后游戏启动黑屏无响应(实测);回滚到第三轮能进但"两秒卡一次"。两现象同根因:mod 的周期扫描太重。
- **根因**
  1. `FAST_POLL_SECONDS=0.2` / `SLOW_POLL_SECONDS=0.8`,而每轮 `scanChatMessages` 都调用 `refreshTopbarIdentity()`(每 1s)+ `pollSteamIdRoster()`(无节流,每 0.8s/0.2s 都做 `findEscapeMenuRoot` 的 4 次全树 type 扫描)。
  2. `scanProfileCardsLoop` 每 1s 一次,`captureVisibleProfileAccounts` 每 1s 一次,每次都做多轮 `findAllPanelsByType`(深度 80 / 节点 2 万)。
  3. 综合最坏情况:每 0.8s 内最多 ~9 次、每次 2 万节点的 JS 全树递归遍历;翻译进行时 0.2s 一轮更糟——主线程被占死,UI 不渲染,表现为黑屏无响应(第四轮扫描更多)或周期性卡顿(第三轮)。
- **改动文件**
  - `mod/panorama/scripts/lingua_chat.js`
- **实现内容**
  - 新增节流常量:`TOPBAR_REFRESH_MS=5000`(顶栏身份扫描 1s→5s)、`ROSTER_POLL_MS=3000`(ESC 菜单轮询独立节流,不再随聊天轮询每轮跑)、`PROFILE_LOOP_SECONDS=5.0`(ProfileCard 周期扫描 1s→5s)。
  - `pollSteamIdRoster` 增加 `rosterNextPoll` 时间节流(3s)。
  - `findTopbarPlayerEntries` 的 type 扫描兜底仅在 class/id 反查无结果时执行(避免无谓的 5×2 万节点遍历)。
  - `captureVisibleProfileAccounts` 节流 1s→3s。
  - 功能零变化:翻译、快捷发言 kind、hero/steamid 采集路径全部保留。
- **验证方式**
  - `node --check` 通过;simtest 偶发 44/45(stash 回 HEAD 对照同样偶发 44/45,确认是测试固有异步抖动,与本次改动无关)。
  - `scripts/build.ps1` 编译 7 个文件成功,已部署 `dist/pak22_dir.vpk` 到 addons(215865 字节)。
- **仍需用户测试**:重启 Deadlock → 确认不再黑屏、不卡顿;然后按 ESC 打开 PlayersTab 点几行玩家采集 steamid;桥日志搜 `recon player[i]`/`topbar identity scan players=`。
## 2026-08-19 第六轮修复:steamid(好友代码)恢复采集 + 免手动操作

- **背景**:上一轮给 4 个隐藏标签加 `style="visibility: collapse;"` 后,引擎跳过面板布局,`{i:r:account_id}` / `{g:citadel_hero_name:hero_id}` 宏不再求值,steamid 与行内英雄全部读不到,界面回到游戏原样。用户确认之前(仅 `visible="false"`)那一版 ESC 悬停能拿到好友代码。
- **字段确认(两版差异)**:好友代码字段 = **`account_id`**(Steam 账号短数字,9-10 位),来源是 `profile_card.xml` / `citadel_db_page_profile.xml` 里的 `<Label text="{i:r:account_id}">` 绑定;两版唯一的布局差异就是 collapse 样式。`normalizeSteamValue` 会把短数字换算成 SteamID64(7656119...)写入日志。
- **改动文件**
  - `mod/panorama/layout/{chat,players_list_entry,profile_card,citadel_db_page_profile}.xml`
  - `mod/panorama/scripts/lingua_chat.js`
- **实现内容**
  - 4 个隐藏标签:`visibility: collapse` → `opacity: 0; width: 0px; height: 0px; overflow: clip;`(参与布局、宏正常求值、肉眼不可见、不占位)。
  - `players_list_entry.xml` / `chat.xml` 各新增 `<Label id="LCTRowAccount" text="{i:r:account_id}">`——ESC 玩家列表行渲染时引擎按行绑定 account_id,打开一次 ESC 即可自动采集全部玩家,无需逐行点击/hover。
  - `readSteamIdFromRow()` 优先读 `LCTRowAccount` 标签文本并 `normalizeSteamValue`。
  - `probeNextSteamIdRow()` 行内已有 steamid 时直接写入 `accountByHero`/`accountByName`,跳过"派发 Activated 打开资料卡"的流程(免点击、无卡片闪动)。
  - `probeEscapeTooltip()` 正则补 9-10 位短账号匹配(`\b\d{9,10}\b`),便于诊断日志识别好友代码文本。
- **验证方式**
  - `node --check` 通过;4 个 XML 解析通过;simtest 44/45(固有异步抖动,与本次无关)。
  - `scripts/build.ps1` 编译 7 个文件成功;`dist/pak01_dir.vpk` 已部署为 addons 的 `pak22_dir.vpk`(221900 字节,旧版备份 `pak22_dir.vpk.bak_round6`)。
- **仍需用户测试**:重启 Deadlock → 进局按一次 ESC 打开玩家列表(无需点任何人)→ 看 `logs/chat/<matchId>.jsonl` 的 `steamid` 是否填充为 7656119...;桥进程需要重启一次(上一轮 `kind` 字段在 `core/bridge_server.js`)。


## 2026-08-19 第六轮b:matchId 兜底失效 + steamid 采集路径增强

- **背景**:第六轮部署后用户实测:steamid 仍为空,且 matchId 退化为 session_。日志证据:
  - `matchId diagnostic: (no match-related API found)` —— Panorama 脚本拿不到比赛 API,只能靠桥读游戏 console.log 兜底。
  - 实测 console.log 1.92MB 里 `Lobby ... for Match <matchId> created` 在字节偏移 561733(29%)处,旧实现只读尾部 512KB,比赛打几分钟该行就被刷出窗口,兜底失效。
  - `profile card identity: ... steamid=[redacted-steamid]` —— 资料卡路径已能拿到 account_id(布局 opacity 修复生效),但 hero/name 为空,无法归属到玩家。
  - `steamid roster pass incomplete rows=0` 反复出现 —— 主菜单/大厅的 CitadelHudEscapeMenu 面板 visible=true,isEscapeMenuOpen 误判为打开,比赛内未开 ESC 时也反复空扫。

- **改动文件**
  - `core/bridge_server.js`
  - `mod/panorama/scripts/lingua_chat.js`

- **实现内容**
  - 桥:matchId 兜底改为**增量扫描** console.log(记录字节偏移,每次只读新增行;兼容日志轮转/清空),`Lobby ... for Match N created` 无论日志多大都能抓到;端到端验证:`session_xxx` 入参写出 `<matchId>.jsonl`。
  - 桥:从连接行 `steamid:<id>@<ip> '昵称'` 解析**本机玩家**昵称+steamid(排除 9 开头服务器账号),写日志时按 isOwn 或昵称匹配回填 steamid —— 自己的发言零交互就能带 steamid;端到端验证 `<玩家> -> [redacted-steamid]`。
  - 全景:isEscapeMenuOpen 改为**严格要求 Hud 根挂 ShowEscapeMenu class** 才算打开,消除主菜单/比赛内未打开时的空扫。
  - 全景:scanSteamIdRows 增加**结构兜底** —— 在 ESC 子树内按 PlayerName 标签反查玩家行(兼容游戏未加载我们的布局覆盖时),行内直读 steamid,不再依赖点击开卡。
  - 全景:readProfileName 补 profileString 兜底,资料卡悬停捕获的 account 尽量归属到昵称。
  - 全景:ESC 一次性侦察 dump 改为整个 CitadelHudEscapeMenu 根(深度3),下局可看到比赛内玩家行真实结构。

- **验证方式**
  - `node --check` 通过;simtest 45/45 通过。
  - 桥端到端:POST /api/v1/log 带 session_<accountId> → 写出 <matchId>.jsonl 且 steamid=[redacted-steamid](测试记录已删除)。
  - build.ps1 编译 7 个文件成功;已部署 pak22_dir.vpk(223438 字节,旧版备份 bak_round6b);桥已重启(健康检查 200)。

- **仍需用户测试**:重启 Deadlock 打一局;自己的发言 steamid 应立即有值(桥回填);对局中按一次 ESC 打开玩家列表(自然查看计分板即可),看 teammate 的 steamid 是否填充;桥日志搜 escRoot / `steamid roster: structural rows=` 确认行结构。



## 2026-08-19 第六轮c:matchId 增量读取重写 bug 修复 + 顶栏零交互被动采集

- **背景**:用户反馈"为什么只拿到了我自己的 id"。第六轮b 实测日志证据:
  - 今天的日志文件被写成了旧 matchId `<matchId>.jsonl`,实际比赛是 `<matchId>` —— 增量读取器 bug 实锤:console.log 每次游戏启动被清空重写,旧实现只判断 `stat.size >= offset` 不重置,从错位字节开始读,永远拿不到本次比赛的 created 行。
  - 队友 steamid 全空(hero 已填充:<玩家>=celeste、<玩家>=vyper 等);本机 steamid=[redacted-steamid](桥回填已生效)。
  - console.log 里只有本机连接行 `steamid:<id>@<ip> '昵称'` 和服务器账号,没有队友 steamid,无法靠日志兜底队友。
  - 比赛内无 escRoot dump:用户未按 ESC(或检测未触发),ESC 采集依赖用户主动开菜单,不现实。

- **改动文件**
  - `core/bridge_server.js`
  - `mod/panorama/scripts/lingua_chat.js`

- **实现内容**
  - 桥:增量读取器加**边界指纹**重写检测 —— 记录上次扫描结束时文件尾部 256 字节,下次先校验同位置字节,不一致(清空重写/截断)则从头全扫,保留已解析的本机身份;单次读取超过 8MB 分块处理。已用临时文件模拟验证:比赛进行中能拿到 `<matchId>`;重写变大/截断变小都能检测并重置。
  - 全景(顶栏被动采集,零交互):`readTopbarIdentity` 扩展账号字段读取 —— 新增 `TOPBAR_ACCOUNT_KEYS`(account_id/steamid/player_id/m_playerID/m_unAccountID 等 23 个候选名),并探测 HeroBadge/HeroImage 子面板;新增 `looksLikeSteamAccount()` 只接受 17 位 SteamID64 / 32 位账号ID / U:1: 格式,避免把 0-11 玩家槽位号误当 steamid;命中即写入 `accountByHero`/`accountByName`,聊天日志自动回填。
  - 全景(字段侦察):新增 `probeTopbarPanel()` 每局一次 dump 顶栏条目的可枚举属性、对话框变量、常见 id 属性(`topbar probe` 前缀),用于下局确认代表好友代码的字段名。
  - 全景(ESC 检测对齐 showrank):`hudHasEscapeClass`/`isEscapeMenuOpen` 增加沿父链找 `paneltype=CitadelHud && id=Hud` 祖先再 `BHasClass(ShowEscapeMenu)`,兼容 getRoot 顶点差异。
  - 全景(性能):`pollSteamIdRoster` 改为**先查 ShowEscapeMenu class(原生、快),没开菜单就不做任何整树 type 扫描** —— 平时零扫描,不影响帧率。
  - 全景:换局/阵容变化时重置 `steamIdFoundLogged`/`steamIdDiagLogged`,保证每局都有 escRoot dump 与状态日志,方便核对。

- **验证方式**
  - `node --check` 桥与 JS 均通过;临时文件模拟增量读取 3 场景全部通过(active/rewrite/truncate)。
  - simtest 44/45,唯一失败项 `original collapsed (translation_only)` 在改动前基线同样失败(异步抖动,与本次改动无关)。
  - build.ps1 编译 7 个文件成功;已部署 pak22_dir.vpk(228592 字节,旧版备份 bak_round6c);桥已重启(健康检查 /api/v1/health 200,POST /api/v1/log 写出验证通过,测试记录已删除)。

- **仍需用户测试**:重启 Deadlock 打一局即可,不需要按 ESC。看 `logs/chat/<matchId>.jsonl` 队友 steamid 是否填充;桥日志搜 `topbar probe`(本局一次,告诉我们顶栏有没有账号字段)、`topbar entry[...] account=`;如果按过 ESC,再看 `escRoot` dump 与 `steamid roster collected`。
## 2026-08-21 第七轮:SteamID 差异发现自动采集 + 日志精简(去重复字段) + 赛后比赛摘要

- **背景**:用户反馈两条:① 日志里许多字段(steamid)抓取不到,之前"不断尝试字段名"效率太低;② 日志太繁杂,每条消息都重复带 steamid/matchId/heroId 等字段。用户提议:ESC 界面悬停玩家时资料卡会显示 steamid,可以通过**对比两个玩家的资料卡差异**自动识别账号字段,而不是盲试字段名。
- **改动文件**
  - `mod/panorama/scripts/lingua_chat.js`
  - `core/bridge_server.js`
- **实现内容**
  - **差异发现(核心,按用户思路实现)**:新增 `dumpProfileFingerprint()`(资料卡全量指纹:全部 Label 文本 id/class、宽候选对话框变量/属性/自有属性)与 `discoverAccountFromFingerprints()`(对比两份指纹,找出"随玩家变化且像账号"的字段,优先 17 位 SteamID64、字段名带 account/steam/xuid)。`rememberProfileIdentity()` 每次扫到资料卡都保存指纹,同局内连续出现两张不同玩家的卡时自动 diff 并登记 `State.discoveredAccount`;`readProfileAccount()`/`readSteamIdFromRow()` 按发现结果读取,不再盲试固定字段。另补:`readAccountFromLabelIds()` 直接读原版 ProfileCard 的 `AccountID` Label(已从游戏 pak 验证原版布局确实有 AccountID Label);`readAccountFromAnyLabelText()` 兜底扫 17 位 SteamID64 文本(唯一性强不会误判)。
  - **ESC 采集增强**:`scanSteamIdRows()` 增加 HeroBadge 反查玩家行;`probeNextSteamIdRow()` 悬停模拟优先 `MouseOver`(资料卡由 hover 触发),失败退 `Activated`;`inspectSteamIdRow()` 跨行对比资料卡指纹做差异学习。
  - **日志精简(桥端统一处理,游戏端零改动)**:`appendChatLog()` 重写——新文件首行写 `{"type":"meta","matchId","startedAt"}`,matchId 不再逐行重复;消息行精简为 `{type:"msg",t,kind,sender,hero,channel,isOwn,text}`(去掉 matchId/heroId/steamid);玩家身份抽离成一次性 `{"type":"player",name,hero,heroId,steamid}` 记录(按昵称去重,带 matchLogRoster 内存上限 24 场);摘要/玩家记录透传。
  - **比赛摘要(日志末尾补充战绩)**:参考 deadlock 战绩站(如 tracklock/deadlocktracker)的字段,新增赛后记分板扫描 `scanPostGameScoreboard()`——从游戏 pak 提取并分析了 `citadel_db_post_game_scoreboard_new.vxml/vcss`,按 `#Team1/#Team2`、`.Player` 行、`#PlayerName/#HeroBadge/#KillsValue/#DeathsValue/#AssistsValue/#SoulsValue/#PlayerDmgValue/#ObjDmgValue/#HealingValue`、`#MatchID`、`.TimeLabel`、`.IsWinningTeam/.IsLocalPlayer` 采集全员 KDA/灵魂/伤害/治疗/胜负/时长,生成 `{"type":"summary",...}` 追加到日志末尾。顶栏 `readTopbarStats()` 顺带读 `#KDAContainer` 实时 KDA 存 `State.liveStats`(备用)。
- **验证方式**
  - `node --check` 桥与 JS 均通过;simtest 45/45 通过。
  - 桥端单测(提取 appendChatLog 桩测):meta 首行 / msg 行无 steamid/heroId/matchId / player 记录去重(Dege 只出现一次)/ summary 透传,全部通过。
  - 全景模拟测试(独立 mock 面板树):资料卡 steamid 捕获 + 双卡 diff 发现 `{"labelIds":["LCTProfileAccount"]}` 通过;赛后记分板摘要(KDA/灵魂/伤害/胜负/时长/双队)通过。
  - build.ps1 编译 7 个文件成功;已部署 pak22_dir.vpk(248550 字节)到 addons;桥已重启(健康检查 200)。
- **仍需用户测试**:重启 Deadlock 打一局。① 对局中按一次 ESC 打开玩家列表(自然翻看即可),或悬停两个不同玩家,桥日志应出现 `steamid field discovered via diff` 与 `profile card identity ... steamid=`;② 看 `logs/chat/<matchId>.jsonl` 新格式:首行 meta、消息行无 steamid、玩家身份在 player 记录里;③ 赛后等记分板出现,日志末尾应追加 `type:"summary"`(含全员 KDA/英雄/胜负)。

- **补充(重建部署后)**:在第七轮基础上收紧赛后记分板判定 `findScoreboardRoot`(只认 paneltype=CitadelPostGameScoreboardNew 或树内存在 MatchID 标签,删除 TimeLabel 弱信号),避免局内 Tab 计分板误发摘要;已重新构建并部署 pak22_dir.vpk(248601 字节)。回归验证:node --check 通过;simtest 45/45;定向模拟 13/13(赛后记分板命中 / 局内 Tab 不误报 / 仅 MatchID 兜底命中)。

## 2026-08-22 第八轮:翻译术语表+截断修复、日志漏写/双文件修复、SteamID 无 ESC 采集

- **背景**:用户反馈 5 个问题:① AI 翻译把游戏专有名词直译(“女巫”应译 Vindicta);② steamid 仍抓取不到;
  ③ 同一局日志出现 session_ 与真实比赛 id 两个文件;④ 部分日志没写入日志文件;⑤ 翻译输出被截断(“doesn’t fire her”断句)。
- **改动文件**:core/glossary.js(新增)、core/providers/openai.js、core/bridge_server.js、mod/panorama/scripts/lingua_chat.js
- **实现内容**
  - **术语表(新增 core/glossary.js)**:46 个英雄官方英文名 + 48 个中文英雄昵称映射(含“女巫→Vindicta”“老七→Seven”)+ 25 个常用术语(兵线/推塔/回城/大招等)。
    buildHint() 注入 system 提示(英雄/技能/装备名保留英文、完整翻译不截断);fixHeroTerms() 中文→英文时把 witch/ghost 等泛指词替换回官方英雄名。
    实测:“还有个一点枪不出的女巫这个真的神” → “There’s also a Vindicta who never shoots at all, truly godlike.”。
  - **截断修复(openai.js)**:buildPayload 显式 max_tokens:1024(模型不支持时 400 重试去掉);finish_reason==“length” 时用完整翻译专用提示重试一次。
  - **日志漏写(lingua_chat.js pushChatLog)**:去掉 identityReady 门槛,非 HUD 行 hero/steamid 未就绪也立即落盘(resolve 系列在 buildLogEntry 补全,宁留 <unknown> 不丢行)。
  - **双文件(bridge_server.js appendChatLog)**:桥端一旦从 console.log 兜底到真实比赛 id,把 session 文件行合并进真实文件(meta 不迁移,summary/player 的 matchId 改写真实 id)并删除 session 文件。隔离桩测通过。
  - **SteamID 采集放宽(lingua_chat.js)**:pollSteamIdRoster 去掉 hudHasEscapeClass 硬 gate;isEscapeMenuOpen 放宽(比赛中且有顶栏英雄数据时 ESC 面板可见即视为打开);
    readProfileName/readProfileHero 补 class 扫描兜底;rememberProfileIdentity 的 diff 触发放宽为英雄/昵称不同即对比指纹。
- **验证方式**
  - node --check 桥与 JS 均通过;simtest 45/45(偶发 44/45,失败项 original collapsed 为既有异步抖动)。
  - 桥端端到端 POST /api/v1/translate 实测术语表+完整翻译生效;session 合并隔离桩测通过。
  - build.ps1 编译 7 个文件成功;已部署 pak22_dir.vpk(248796 字节,旧版备份 bak_round8);桥已重启(健康检查 200)。
- **仍需用户测试**:重启 Deadlock 打一局。① 看日志是否只剩一个 <比赛id>.jsonl;② 之前漏掉的迟到行是否补上;③ 对局中按 ESC 或悬停两个玩家,桥日志出现 profile card identity / discovered via diff,steamid 填充到 player 记录;
  ④ 翻译长句不再截断,女巫/老七等英雄名不再直译。

## 2026-08-22 第八轮补充:修复“游戏内不断打开别人资料”

- **背景**:第八轮放宽了 isEscapeMenuOpen(比赛中有顶栏英雄数据即返 true),而 CitadelHudEscapeMenu 面板常驻树中、自身 visible 不一定 false,导致每 5 秒轮询都误判“ESC 打开”,触发 startSteamIdRosterPass 悬停模拟反复打开别人资料卡。
- **修复(仅 lingua_chat.js)**
  - isEscapeMenuOpen 重写:先用 BIsVisible()(整链可见性)或逐父链查 visible,任一不可见即返 false;先流 class 检测不到时,要求 ESC 玩家列表标签页 PlayersTab 真实可见才认为打开;不再以“有顶栏数据”无条件认定。
  - pollSteamIdRoster 拆分主动/被动:被动路径(captureVisibleProfileAccounts)不论 ESC 是否打开都跑——只在用户自己悬停已开出资料卡时扫描+差异学习,不做悬停模拟;主动悬停模拟仅在真实检测到 ESC 打开时执行。
  - startSteamIdRosterPass 加每局轮次上限(STEAMID_ROSTER_MAX_ATTEMPTS=3):阵容/局次变化重置计数,超过上限后本局不再主动悬停模拟(保险网)。
- **验证**:node --check 通过;simtest 仍 45/45(偶发 44/45,失败项 original collapsed 为既有异步抖动);已重建并部署 pak22_dir.vpk(250147 字节,旧版备份 bak_round8b),桥不需重启(本次仅游戏端改动)。
- **仍需用户测试**:重启 Deadlock 打一局,确认游戏内不再自动开别人资料卡;自己悬停玩家时,桥日志仍应出现 profile card identity / discovered via diff。

## 2026-08-22 第八轮补充b:彻底去除主动悬停模拟(不再自动点开资料卡)

- **背景**:用户反馈“为什么会自动点开玩家资料卡?点开后控制会卡住,必须再按 ESC 推出”。原因:startSteamIdRosterPass 的悬停模拟(MouseOver 逐行点开)会抢走控制权,且此前上一轮加的开关版本尚未部署。
- **修复(仅 lingua_chat.js / chat.xml)**
  - pollSteamIdRoster 彻底移除 startSteamIdRosterPass 调用:任何场景都不再模拟 MouseOver/Activated 点开资料卡。
  - SteamID 采集仅依赖被动路径:用户自己悬停弹出资料卡时 captureVisibleProfileAccounts 扫描+差异学习(readProfileAccount/readProfileName/readProfileHero/dumpProfileFingerprint),以及 ESC 打开时 probeEscapeTooltip 只读扫描 tooltip 文本。
  - 移除上一轮新增的 steamIdAutoProbe 设置开关(chat.xml 行 + UI_DEFAULTS + LCTOnToggle 分支 + 同步),避免 UI 困扰。
  - 修复过程中引入的 LCTOnToggle 语法缺口(translateOwn 分支缺闭合 等号),已恢复。
- **验证**:node --check 通过;simtest 45/45;已重建并部署 pak22_dir.vpk(250256 字节,旧版备份 bak_round8c),桥不需重启。
- **仍需用户测试**:重启 Deadlock 打一局,确认任何情况下都不会自动弹出别人资料卡;自己悬停玩家时桥日志仍出现 profile card identity / discovered via diff,双卡差异学习继续生效。

## 2026-08-22 第九轮:SteamID 来源按版本差异确认(非盲试字段)+ 悬停配对 + 日志收尾修复

- **SteamID 来源确认(用户要求的"对比代码差异")**:比对旧版(ESC 英雄翻译版,悬停能显示 steamid)与当前代码,结论:
  账号字段来自**资料卡面板的对话框变量 `r:account_id`**(游戏原生填充),旧版通过隐藏 Label `text="{i:r:account_id}"` 读到的;
  `showrank_barebones` 参考 mod 用的是同一个绑定 + 根面板 `accountid`/`steamid` 属性读取。因此**不再盲试字段**。
- **改动(lingua_chat.js)**
  - `readProfileAccount` 优先级重排:64 位完整对话框变量(accountid/steamid/steam_id/xuid)→ 隐藏 Label `{i:r:account_id}` → 根面板属性 → 已发现字段/兜底。
  - `readProfileHero` 支持数值 hero id(资料卡 HeroName 对话框变量)→ 英雄名映射(HERO_ID_TO_NAME)。
  - **悬停配对**:`players_list_entry.xml`(ESC 玩家行)与新增的 `citadel_hud_top_bar_player.xml`(顶栏玩家)根节点加
    `onmouseover="LCTRowHovered(this)"` / `onmouseout="LCTRowUnhovered(this)"`,记录最近悬停行的英雄/昵称;
    资料卡出现账号时在 3 秒窗口内配对到该行(accountByHero/accountByName),不再依赖资料卡自身文本。
  - 移除被动差异学习的主动调用(不再对比两张卡指纹猜字段),保留只读路径。
  - `readHeroFromRow` 增加 HeroName 标签文本读取(顶栏 `{s:hero_name}` 场景)。
- **日志收尾(bridge_server.js / lingua_chat.js / openai.js)**
  - session 双文件:`migrateLatestSessionFile()` 每次拿到真实比赛 id 就把最新 `session_*.jsonl` 并入真实文件并删除,一场比赛只留一个文件。
  - 末尾漏日志:赛后记分板摘要捕获时先 `flushChatLog()` 立即冲刷未落盘消息行再发 summary。
  - 翻译截断:`max_tokens` 1024→2048;新增 `looksTruncated()` 启发式(以半截英文词结尾且缺句末标点)在服务商不返回 finish_reason=length 时也触发完整翻译重试。
- **验证**:node --check 全部通过;simtest 44/45(唯一失败项 original collapsed 为既有异步抖动);build.ps1 编译 8 个文件成功(新增 citadel_hud_top_bar_player.vxml_c);
  已部署 pak22_dir.vpk(258330 字节,旧版备份 bak_round9);桥已重启(health 200)。
- **仍需用户测试**:重启 Deadlock 打一局,ESC 玩家列表/顶栏悬停玩家或右键查看资料后,
  桥日志出现 `steamid paired via hover`,`logs/chat/<比赛id>.jsonl` 的 player 记录 steamid 填充;比赛结束日志只留一个真实 id 文件。

## 2026-08-23 第十轮:修复“出站消息偶尔原文发出”

- **背景**:用户反馈“有时候会原文发出”。排查游戏 console.log + 桥日志确认根因:
  - 出站翻译(中文->英文)走 OpenAI 兼容(DeepSeek),高峰期单次请求超过 20s 触发 provider_timeout;
  - 模组出站超时兜底(OUTGOING_TIMEOUT_MS=20s)按设计发原文;
  - 另外聊天繁忙时单槽队列(MAX_ACTIVE_REQUESTS=1)被入站翻译占满,出站任务排队超过 15s 也会被丢弃发原文(实测 23:27:44 “塔爆了再吸取人不都走了”)。
  - 快捷指令轮盘消息(撤退/谢了/往黄路走了 等 kind=quick)不经出站翻译是正常设计,游戏按客户端本地化,不算 bug。
- **修复**
  - 桥端 runTranslate:主服务商单次超时上限 20s(primaryTimeoutMs),给回退链留时间;失败自动回退。
  - 配置:fallbackProviders 增加 bing(免 Key),DeepSeek 超时/报错时秒回退。
  - 模组:OUTGOING_TIMEOUT_MS 20s->30s(主服务商 20s + bing 回退余量);
    出站任务插队优先(queue.unshift),不被入站翻译洪流饿死;排队丢弃阈值 15s->25s。
- **验证**
  - 桥端隔离测试:伪造无效 DeepSeek Key -> 主服务商 401 -> 自动回退 bing 返回译文(viaFallback=true),scripts/test_bridge_fallback.js PASS。
  - 实测 bing 单条翻译约 1.8s(“你可以放弃1塔” -> “You can give up 1 tower”)。
  - simtest 44/45(唯一失败项 original collapsed 为既有异步抖动);node --check 通过。
  - 已重建部署 pak22_dir.vpk(258447 字节,旧版备份 bak_round10);桥已重启,health 200,fallbackProviders=[“bing”] 生效。
- **仍需用户测试**:重启 Deadlock 打一局,DeepSeek 高峰超时时出站消息应自动走 bing 译文发出,不再发原文。

## 2026-08-23 第十一轮:发现 DeepSeek v4 默认开思考模式,导致翻译十几秒延迟(已关闭)

- **背景**:用户质疑"难道 ai 做不到几秒之内翻译吗?还是说开了思考模式调用的。这是简单的翻译任务啊" 。实测与排查:
  - A/B 测试:提示词 2231 字节 vs 精简 324 字节,DeepSeek 都需 1.3s~17s(精简版甚至超时),**提示词不是瓶颈**。
  - 检查响应体:模型 deepseek-v4-flash 的 message 带 reasoning_content = **服务端默认开思考(链式推理)**。
  - 参数对比:默认 3.5s+;enable_thinking:false 无效(仍 reasoning);thinking:{type:"disabled"} -> 0.94s 且无 reasoning;deepseek-chat 0.77s。
  - 支持的模型名:deepseek-v4-pro / deepseek-v4-flash / deepseek-v4-flash-vision-exp(传 deepseek-v3 报 400)。
- **修复(仅桥端,VPK 不需重建)**
  - core/providers/openai.js:buildPayload 新增 disableThinking 参数,配置开启时发送 thinking:{type:"disabled"};400 错误含 "thinking" 时去掉该参数重试。
  - core/bridge_server.js:runTranslate 把 providerCfg.disableThinking 传给 openai provider。
  - config/config.json:openai.disableThinking=true。
- **验证**:桥重启后实测 4 条短译均 634~1008ms(从原来 1.3s~17s/超时),英雄名正确(女巫->Vindicta、老七->Seven、火男->Infernus);health 200。
  陪同还保留了第十轮的 bing 回退(主服务商 20s 上限),双保险。
- **仍需用户测试**:重启 Deadlock 打一局感受翻译速度;高峰时段若 DeepSeek 仍慢,应自动回退 bing。

## 2026-08-23 第十二轮:修复比赛日志"一场两文件/张冠李戴"问题(赛后 flush 归错文件)

- **背景**:检验 2026-08-23 02:53 结束的日志 <matchId>.jsonl 时发现:
  - 真实文件头部被污染:前 3 行是上一场(<matchId>)16:29 UTC 的旧消息(<玩家>/<玩家>),matchId 被改写为 <matchId>;
  - 真实文件尾部丢失:赛后最后 4 条(<聊天原文>,02:53:39~45)写进了 session_<sessionId>.jsonl,没有并入真实文件。
- **根因**:OnGameStateChanged:PostGame(02:53:36)与 Lobby destroyed(02:53:38)之后,桥端 readLatestGameMatchId 立即把 matchId 清空;
  赛后最后一批 flush(02:53:45)拿不到真实 id 只能写新 session 文件;下一场比赛开始时,这个残留 session 文件被 migrateLatestSessionFile 当作"最新"误并入新比赛文件。
- **修复(core/bridge_server.js,仅桥端,VPK 不需重建)**
  - 赛后宽限期:destroyed 时保留 retainedId 并记 idRetainedAt=Date.now(),MATCH_ID_GRACE_MS=120s 内 readLatestGameMatchId 仍返回旧 id,覆盖赛后 flush;超时后清空;新比赛 id 出现时自动覆盖(测试验证)。
  - 迁移新鲜度守卫:migrateLatestSessionFile 只迁移最近 5 分钟内写入的 session 文件(MIGRATE_SESSION_FRESH_MS),防止上一场残留被误并入新比赛。
  - 迁移一致性:迁移的 msg/player 记录删除 matchId(与正常写入一致,不再出现"每条都带重复字段");迁移时按 name+steamid+hero 去重 player 记录,避免重复身份行。
- **数据修复**:<matchId>.jsonl 剔除 meta 之前的 3 行旧消息;session_<sessionId>.jsonl 的 4 条结束消息(<聊天原文>)按时间序并入文件末尾,新增 <玩家>/<玩家> 两条 player 记录(<玩家>/<玩家>已有,去重);session 文件已删除(均保留 .bak_before_fix 备份)。
- **验证**:隔离测试 13/13 PASS(宽限期/超时/新 id 覆盖/新鲜度守卫/去重/matchId 清理/appendChatLog 端到端);node --check 通过;数据修复后 41 行、6 个 player 无重复、msg 无 matchId 残留;桥已重启 health 200。
- **仍需用户测试**:下次打完一局,检查真实日志文件应包含赛后 gg 等消息,且不再出现上一场的旧行;新局开始后上一场残留 session 不应被并入。
## 2026-08-23 第十三轮:SteamID 采集诊断与链路修复(hero 回填/资料卡识别/诊断增强)

- **背景**:用户追问"还是获取不到steamid吗"。检验最新日志(<matchId> 场)与 console.log 后确认:除本机(<玩家>,桥端从 console.log 连接行回填)外,所有玩家 steamid 为空;且 rowdiag 里连 hero 都是空的。
- **诊断结论(console.log 证据)**
  - 顶栏扫描 10:20:10 成功过一次(训练场 3 条目,<玩家>/dynamo、<英雄>/infernus、<英雄>/abrams),但 account= 空:mod 注入的隐藏 Label 绑定的 {i:r:account_id} 对话框变量在顶栏条目上不存在;probe 显示条目没有任何 accountid/steamid 属性或对话框变量 —— 顶栏本身不含 steamid,盲试字段无效(印证用户"对比差异"判断)。
  - 比赛期间(10:24-10:53)无任何 profile card 采集输出:采集已改为纯被动(按用户要求去掉自动悬停),但 captureVisibleProfileAccounts 的快速路径只按 id "ProfileCard"/"ProfilePage" 找,游戏资料卡 id/结构对不上就直接 return,class/type 兜底扫描永远走不到。
  - 消息行 hero 全空:聊天行构建只读行面板(readHeroFromRow),HeroImage 的 hero_id 对话框变量为空(heroimg probe hero_id=0/-1/-1),且没有用顶栏昵称->英雄映射回填。
- **修复(mod/panorama/scripts/lingua_chat.js,需重建 VPK)**
  - 消息行 hero 兜底:新增 fallbackHeroForSender(sender),行面板读不到英雄时用 topbarHeroByName/heroByName(顶栏/资料卡映射)回填;三条消息路径(lobby/hud/普通)统一生效。
  - 资料卡快速路径放宽:captureVisibleProfileAccounts 找不到 ProfileCard/ProfilePage id 时,用新增 findFirstProfilePanel(class LCTProfileCard + paneltype 兜底)继续,不再静默跳过。
  - 悬停配对增强:LCTRowHovered 读不到 hero 时用 fallbackHeroForSender(name) 回填,保证悬停配对(资料卡账号 -> 行昵称/英雄)可配对。
  - 诊断增强:顶栏 0 条目/英雄读不到时每 30s 打一次 diag;资料卡可见但账号为空时每 10s 打一次 diag —— 下局可直接从 console.log 判断断点。
- **部署**:scripts\build.ps1 构建成功(8 文件编译),dist\pak22_dir.vpk 与 addons 均更新为 260785 字节(旧版备份 .bak_round13);桥 health 200(本轮未改桥端)。
- **仍需用户测试**:重启 Deadlock 打一局,期间悬停几次顶栏/ESC 玩家行;打完把 console.log 的 [LCT] 日志发我,重点看:topbar scan 0 entries / heroes=0、profile card visible、steamid paired via hover、rowdiag hero 是否有值。
## 2026-08-23 第十四轮:资料页 steamid 直读链路 + 跨局身份缓存(基于用户新发现)

- **背景**:用户发现"点击查看资料,左上角玩家昵称下面就是 steamid"。日志(20:42:03)证实资料卡识别已生效并读到完整 17 位 steamid([redacted-steamid]),但昵称/英雄为空——CitadelUserName 是特殊面板,safeText 读不到内部文本。
- **验证结果(20:13-20:42 场)**:出站翻译正常(<聊天原文> -> <聊天译文>、<聊天原文> -> <聊天译文>);profile card identity 首次出现(资料卡识别生效,steamid=本机);比赛期间无 topbar 0 entries 诊断(顶栏扫描正常或未触发)。
- **修复(mod lingua_chat.js + 桥 bridge_server.js)**
  - readProfileName:SelfName/UserName(CitadelUserName)改用 collectText 递归读内部子 Label,资料页昵称可读。
  - 配对增强:资料页昵称读到后,若英雄为空,用顶栏昵称->英雄映射补全,再挂 accountByHero。
  - 消息行 steamid 回填:新增 steamIdByName(sender),行面板读不到时用 accountByName 补齐(三条消息路径)。
  - 资料页识别:findFirstProfilePanel 增加 PROFILE_PAGE_TYPE_ALTS(CitadelProfilePage)兜底。
  - 桥端跨局缓存:identity_cache.json(昵称->steamid),player 记录写盘时补齐缺失账号/更新缓存,跨比赛累积(隔离测试 5/5 PASS)。
- **部署**:VPK 重建(261858 字节),桥重启 health 200。
- **仍需用户测试**:打一局,期间点击查看玩家资料(自己或别人);打完看 logs/chat 的 player 记录 steamid 是否有值、identity_cache.json 是否累积;console.log 看 profile card identity type/hero/name/steamid。
## 2026-08-23 第十五轮:修复"最新比赛没有聊天日志"(扫描循环静默死亡)

- **背景**:用户反馈 20:13-20:42 那局桥日志有 translate ok(<聊天原文>/<聊天原文>等出站翻译),但 logs/chat 没有任何新文件(最新仍是上午的 <matchId>.jsonl)。
- **根因(证据链)**
  - bridge.log 12:13-12:42 UTC 只有出站 translate ok 与 12:42:03 的 profile card identity(steamid=[redacted-steamid],资料页直读已生效),**零 rowdiag、零 chat log 落盘** —— 整局 mod 端没采到任何一条聊天行,桥端自然无可写。
  - console.log 19:41 加载正常(loaded v0.1.2; watching ChatMessages / HUD top bar chat (2) / bridge online),19:42:25 与 20:42:00 出现 LCTRowHovered is not defined(悬停事件处理器,独立于扫描,已由第十四轮修复并部署)。
  - 关键缺陷:scanChatMessages 整段没有 try/catch,`$.Schedule` 重排是最后一条语句 —— 任一子调用抛异常,循环就永久中断;且 Panorama 对调度回调异常不打印(console.log 只有事件处理器异常),所以是**静默死亡**。资料卡循环(scanProfileCardsLoop)与出站提交(LCTOnChatSubmit)独立调度,所以它们照常工作,造成"翻译正常但日志全无"的假象。
- **修复(mod/panorama/scripts/lingua_chat.js,需重建 VPK)**
  - scanChatMessages 整段 try/catch,异常时仍以 SLOW_POLL_SECONDS 重排,循环永不中断。
  - 三个子扫描(scanChatMessagesOnce/scanHudTopBarOnce/scanLobbyOnce)各自独立 try/catch,异常归属到具体函数名。
  - 新增 pollScanError:首次错误同时写 diagLog(桥日志)与 log(console.log),同错误每 20 次再打一次,扫描恢复后清除标记 —— 下局若再异常,桥日志直接可见错误与函数归属。
  - scanHudTopBarOnce 每代容器首次见行打一次 diag("hud scan: rows present"),resolveHudMessages 重建容器时重置标记 —— 下局可据此确认扫描循环存活且能看到 HUD 行。
- **部署**:scripts\build.ps1 构建成功,dist\pak22_dir.vpk 与 addons\pak22_dir.vpk 更新为 265514 字节;桥进程 20:47:48 启动、已加载最新 bridge_server.js(20:47:12),health 200,无需重启。
- **仍需用户测试**:重启 Deadlock 打一局。看桥日志是否出现 "hud scan: rows present" 与 rowdiag;若出现 "poll error in xxx: ..." 行,把那行发我即可定位具体异常;logs/chat 应有新比赛文件。

## 2026-08-24 第十六轮:恢复 ESC 玩家列表零交互 steamid 采集(只读,不抢控制权)

- **背景**:steamid 仍获取不到。排查发现 Round 8b"彻底去除主动悬停模拟"时把唯一入口 `startSteamIdRosterPass` 整个删掉,连带 **Round 6 设计的零交互采集也一起死了**:`players_list_entry.xml` 里 `LCTRowAccount`(`{i:r:account_id}`)隐藏 Label 只在 ESC 玩家行渲染时绑定,而唯一读它的 `scanSteamIdRows → readSteamIdFromRow` 链路整段成为死代码(入口已移除、从未调用)。当前只剩两条被动路径:① 桥端从 console.log 回填本机 steamid(仅自己);② 用户手动悬停/查看资料时 `captureVisibleProfileAccounts` 扫资料卡(验证过能拿 steamid,但需要用户逐个点)。因此比赛内队友 steamid 实际几乎拿不到。
- **改动文件**
  - `mod/panorama/scripts/lingua_chat.js`
  - `scripts/test_steamid_roster.js`(新增定向回归测试)
- **实现内容**
  - **恢复零交互采集(只读)**:新增 `captureEscapeRosterAccounts(root, escapeRoot)`,在 `pollSteamIdRoster` 的 ESC 打开分支调用。打开 ESC 时玩家行即绑定 `{i:r:account_id}`,函数直接读行内 `LCTRowAccount`/`LCTRowHero`/`PlayerName`,映射进 `accountByName`/`accountByHero`/`heroByName`/`nameByHero`。**只读不派发任何 MouseOver/Activated 事件**,彻底规避 Round 8b 用户反馈的"自动点开资料卡抢控制权"问题。2.5s 节流,仅在 ESC 真实打开时扫描。
  - **scanSteamIdRows 放宽**:行只保留条件从 `hero && mainContents` 改为 `(hero || steamid)`,账号绑定正常但英雄读不到的行也保留;并补读行内昵称,供凭昵称归属账号。
  - **防伪造**:`readSteamIdFromRow` 读 `LCTRowAccount` 时先过 `looksLikeSteamAccount`,拒绝槽位号(0-11)等误绑定值,避免 `normalizeSteamValue` 把 `7` 这类槽位号换算成假 steam64。
- **验证方式**
  - `node --check` 通过;simtest 基线对比:改动前后同为 PASS 31 / FAIL 14(14 个失败均为本机未起 8791 翻译桥导致,与本次改动无关,零回归)。
  - 新增 `scripts/test_steamid_roster.js` 3/3 PASS(mock 面板树 + 真实模块加载):
    ① ESC roster 采集映射 3 个玩家(gainedHero=2 gainedName=3);② Alice 聊天行 steamid 回填为 `[redacted-steamid]`(32位 <accountId> 正确换算 64 位,hero 同步回填);③ 槽位号 7 被拒绝、不伪造。
- **仍需用户测试**:重启 Deadlock 打一局,对局中按一次 ESC 打开玩家列表(自然翻看即可,无需点任何人);看 `logs/chat/<比赛id>.jsonl` 的 player 记录/消息行 steamid 是否填充为 7656119...;桥日志搜 `steamid roster rows=` 确认采集行数与 gained 计数。若玩家列表行本身不绑定 account_id(行内拿不到),桥日志不会出现 gained 行,则需继续走资料卡悬停路径。

## 2026-08-24 第十六轮:修复掉帧(悬停扫描每轮全树遍历拖慢主线程)

- **背景**:用户反馈最新 mod 掉帧严重。排查 lingua_chat.js 轮询路径发现根因:
  - pollSteamIdRoster 在节流检查**之前**无条件调用 detectHoverRow(),而 scanChatMessages 忙时以 FAST_POLL_SECONDS=0.2s 轮询 → detectHoverRow 每 0.2s 执行一次(5Hz)。
  - 单次 detectHoverRow 开销极大:findTopbarPlayerEntries(24 次 FindChildTraverse 全树遍历 + collectPanelsByIds 每节点 FindChildTraverse 的 O(N²) 递归 + 多次 class 遍历)+ findEscapeMenuRoot(4 次 type 扫描×2000 节点 + class 扫描)+ ESC 行 3 次 type 扫描 —— 一次调用可达数十毫秒主线程 JS,5Hz 下必然严重掉帧。
- **修复(mod/panorama/scripts/lingua_chat.js,需重建 VPK)**
  - detectHoverRow 增加 HOVER_SCAN_MS=1000ms 节流(悬停状态变化慢,1s 一次足够);资料卡出现时 captureVisibleProfileAccounts 改调 detectHoverRow(true) 强制立即刷新,配对不失效。
  - ESC 行不再每轮 findEscapeMenuRoot 全树重找:改用 pollSteamIdRoster(5s 轮询)缓存的 State.escRoot,且面板不可见(BIsVisible=false)时跳过;class 命中后跳过 3 次 type 兜底扫描。
  - findTopbarPlayerEntries:固定 id 前缀 TopBarPlayer0..23 先探测 TopBarPlayer0 存在再循环(新版无此 id,省 24 次全树遍历);HeroBadge/HeroImage 反查优先用单次原生 FindChildrenWithAttributeTraverse(旧 collectPanelsByIds 是每节点 FindChildTraverse 的 O(N²)),不可用时回退旧实现。
- **验证**:node --check 通过;scripts/test_steamid_roster.js 回归 3/3 PASS;VPK 重建部署(270021 字节,22:55),已确认含 HOVER_SCAN_MS/detectHoverRow(force)/hasLegacyIds。
- **仍需用户测试**:重启 Deadlock 打一局感受帧数;悬停 ESC 玩家行→查看资料,steamid 配对应仍生效(桥日志 profile card identity / steamid roster rows 行)。

## 2026-08-24 第十七轮:掉帧实锤——HUD 行 TDZ 异常每 0.2s 抛一次 + pollScanError 节流被同轮清空

- **背景**:用户反馈掉帧严重并追问"steamid 抓到没、为什么要一直扫描"。检查更新前(<matchId> 场,14:45-14:51 UTC)日志:
  - 桥日志 766 条 `poll error in scanHudTopBarOnce: Cannot access 'sender' before initialization`(14:44:22 起每 0.2s 一条刷屏)。
  - 该场聊天日志完整落盘(<matchId>.jsonl),steamid 只有本机<玩家>([redacted-steamid],console.log 连接行回填),<玩家>/<玩家>/<玩家> 全空;14:51:22/14:51:27 两次 `steamid roster: structural rows=12` 但零 gainedHero/gainedName —— ESC 结构行找到 12 个玩家,但 LCTRowAccount 读不到账号(布局覆盖未生效或对话框变量为空),身份缓存 identity_cache.json 从未创建。
- **根因一(TDZ ReferenceError)**:readMessageRow 的 HUD 行分支在函数内 `const sender` 声明之前就引用 `sender`(fallbackHeroForSender(sender)/steamIdByName(sender)),HUD 快捷消息一出现即抛 TDZ;scanHudTopBarOnce 每轮处理 HUD 行 → 每 0.2s 抛一次 → 掉帧主因 + 日志刷屏主因(此异常在 f692488 加 pollScanError 之前会直接杀死扫描循环,也是 8/23"无日志"的根因之一)。
- **根因二(节流失效)**:scanChatMessages 里"扫描恢复后清除 pollErrMsg/pollErrCount"无条件执行,与 pollScanError 同轮设置相互抵消 → 同错误每轮都打 diagLog(网络请求),节流形同虚设。
- **修复(mod/panorama/scripts/lingua_chat.js,需重建 VPK)**
  - HUD 行分支改用 UNKNOWN_NAME:HUD 行本无 sender,`fallbackHeroForSender(UNKNOWN_NAME)/steamIdByName(UNKNOWN_NAME)` 直接返回空,消除 TDZ。
  - scanChatMessages 增加 pollHadError 标志,仅本轮无错误时清除 pollErrMsg/pollErrCount(节流真正生效:同错误只打第 1/21/41… 次)。
  - 补回被误删的 touchedChat/touchedHud/touchedLobby 声明(补丁过程失误,回归测试当场抓到)。
- **验证**:node --check 通过;test_steamid_roster.js 3/3 PASS(修复后无 poll error 输出);VPK 重建部署(270353 字节,23:27)。
- **待办**:ESC 结构行有 12 个玩家但账号读不到 —— 下轮需查 players_list_entry.xml 覆盖是否生效/{i:r:account_id} 是否仍绑定;这是"队友 steamid 抓不到"的核心。
- **仍需用户测试**:重启 Deadlock 打一局,掉帧应消失、桥日志不再刷 poll error;HUD 快捷消息应正常翻译(此前被 TDZ 吞掉)。

## 2026-08-25 第十八轮:剩余卡顿——ESC 菜单误判打开导致持续全树扫描(已修,待部署)

- **背景**:用户反馈上一轮(TDZ 修复)后"还是有些卡"。检查 8/24 23:58 起的对局日志(<matchId>):
  - TDZ poll error 已消失 ✅,聊天/HUD 消息正常落盘。
  - 但 `steamid roster: structural rows=12` 每 5s 一条持续刷屏(16:20-16:25 UTC 全程),`topbar scan: 0 entries (match ongoing)` 每 30s 一条。
- **根因**
  - isEscapeMenuOpen 的兜底判定 `tab.visible !== false` 误判:常驻 ESC 面板在菜单关闭时 tab.visible 为 undefined(undefined !== false 恒真)→ 判定"ESC 一直打开"。
  - 误判导致 captureEscapeRosterAccounts(每 2.5-5s)+ probeEscapeTooltip(每 1s,6000 节点递归+safeText)+ scanSteamIdRows(全树 class 遍历 + 3×3000 节点 type 扫描 + 结构反查)在整个比赛期间持续运行 —— 剩余卡顿主因,也是日志刷屏主因。
  - 另:findTopbarPlayerEntries 找不到顶栏条目时每 1s 跑 5 类型×2000 节点全树兜底扫描;captureVisibleProfileAccounts 每 5s 找不到资料卡时跑 findFirstProfilePanel(5×1200 节点)。
- **修复(mod/panorama/scripts/lingua_chat.js,需重建 VPK)**
  - isEscapeMenuOpen 删除 PlayersTab.visible 兜底:ESC 打开状态只以 ShowEscapeMenu class 为准,检测不到 class 的版本按关闭处理(宁可少采不卡)。
  - detectHoverRow 的 ESC 行门控改用 isEscapeMenuOpen;顶栏 0 条目时下次扫描延至 3s。
  - findTopbarPlayerEntries 全树 type 兜底加 10s 节流(找不到时 10s 才重试一次)。
  - probeEscapeTooltip 节点预算 6000→2000。
  - captureEscapeRosterAccounts 节流 2.5s→5s;structural rows 日志只在行数变化时打。
  - captureVisibleProfileAccounts 未找到资料卡时 15s 负缓存,不再每 5s 全树兜底。
- **验证**:node --check 通过;test_steamid_roster.js 3/3 PASS;VPK 构建完成。
- **部署状态**:构建完成但**未能覆盖 addons VPK(游戏运行中文件被占用,仍跑 8/24 23:27 的 e988c29)**;待用户退出游戏后复制 dist/pak22_dir.vpk 到 addons。
- **仍需用户测试**:退出游戏→部署→重进打一局:桥日志应不再出现 structural rows/topbar 0 entries 刷屏,掉帧消失;ESC 零交互采集与资料卡路径功能不受影响(资料卡路径与 ESC class 无关)。

## 2026-08-25 第十九轮:聊天日志去重 / 排序 / 顶栏身份扫描修复(已部署)

- **背景**:用户反馈日志记录仍有问题。检查 `logs/chat/*.jsonl` 与 `logs/bridge.log` 发现三类问题:
  - 重复日志:同一句话在左下聊天(带 sender)和 HUD 顶栏气泡(无 sender,记 `<unknown>`)各落一条;15s 去重窗口过期后 HUD 占位行重扫又补一条(例 `<matchId>.jsonl` 中“干得漂亮!”两条)。
  - 时间乱序:挂起条目超时兜底晚于后到达的完整行落盘(例 `<matchId>.jsonl` 中 16:05:52 消息排在 16:05:55 meta 之后)。
  - hero 大量为空:顶栏身份映射失败(`topbar scan: 0 entries`);`findTopbarPlayerEntries` 的类型兜底扫描过浅(深度 32/2000 节点),深层树扫不到;`refreshTopbarIdentity` 只查单个类型。
- **改动文件**
  - `mod/panorama/scripts/lingua_chat.js`
  - `core/bridge_server.js`
  - `scripts/test_bridge_dedup.js`(新增乱序排序回归断言)
- **实现内容**
  - 日志去重:`HUD_SATISFIED_WINDOW_MS=90000` 长去重窗口 + `hudSatisfied` 状态;`dropPending` 删除 HUD 占位时登记,之后同一文本的 HUD 行在窗口内不再挂起,解决 15s 窗口过期后 HUD 重扫补 `<unknown>` 重复条目。
  - 普通行 sender 为空时也走 `deferLog` 挂起,不再直接落 `<unknown>`,避免与晚到的完整行重复。
  - 时间排序:客户端 `flushChatLog` 发送前按 ISO `t` 排序;桥端 `appendChatLog` 写文件前对批内 `type==="msg"` 行按 `t` 排序(meta/player 记录保持原位置)。修复排序作用在 JSON 字符串数组上(`r.type` 恒为 undefined)导致排序失效的 bug。
  - 顶栏身份:`refreshTopbarIdentity` 对全部候选类型做 `findAllPanelsByType` 深度兜底(10s 节流 `topbarDeepNextScan`);`findTopbarPlayerEntries` 类型扫描深度 32→80、节点 2000→3000。
- **验证方式**
  - `node --check` 两个 JS 均通过。
  - `scripts/lingua_chat_simtest.js`:PASS 45/45(注:[3] 的“original collapsed”断言在 HEAD 上同样存在偶发时序失败,非本轮引入,重跑即绿)。
  - `scripts/test_steamid_roster.js`:PASS 3/3;`scripts/test_bridge_dedup.js`:PASS(含新增乱序排序断言)。
  - `scripts/build.ps1` 编译 8 个文件成功;新 `dist/pak22_dir.vpk`(273819 字节)已部署到 addons,旧版备份为 `pak22_dir.vpk.bak_round14`;桥已重启(新 PID,健康检查 OK)。
- **仍需用户测试**:重启 Deadlock 打一局,检查 `logs/chat/<matchId>.jsonl` 是否无同文本重复、时间顺序正确、`hero` 有值;桥日志搜索 `topbar identity scan` 应能看到条目数而非 0。

## 2026-08-26 第二十轮:聊天 sender 回填(气泡/未知行) + 去空 player 噪音 + msg 携带 steamid(已部署)

- **背景**:用户反馈三条问题:
  - 日志里部分消息有 sender、部分显示 `<unknown>`(HUD 顶栏气泡行本身不带 sender,左下聊天完整行又晚到/漏扫,导致归属丢失)。
  - 日志里出现空的噪音记录 `{"type":"player","name":"<玩家>","hero":"","heroId":"","steamid":"[redacted-steamid]"}`,是本地玩家昵称与 steamid 已回填、但 hero 解析失败时 player 记录照常落盘造成的。
  - msg 记录里想拿到 sender 的 steamid;`isOwn` 字段不需要。
- **改动文件**
  - `mod/panorama/scripts/lingua_chat.js`
  - `core/bridge_server.js`
  - `scripts/test_sender_backfill.js`(新增回归测试)
  - `scripts/test_bridge_dedup.js`(扩展断言)
- **实现内容**
  - sender 回填:`State.recentRows` 缓存最近 30s 内已知 sender 的完整行(上限 48 条);`normalizeQuickText()` 归一化文本(去尾部 `!` `?` 等标点,解决气泡 "撤退!" 与完整行 "撤退" 无法匹配);HUD 气泡/普通未知行先按归一化文本回填 sender/hero/steamid,回填后 `recentRowHit()` 去重,不再落 `<unknown>` 重复条目。
  - 兜底去重:`recentLogHit()` 增加 sender 参数,`<unknown>` 兜底条目不再拦住晚到的带 sender 完整行;`flushPendingLogs()` 超时落盘前先查 `recentRowHit()/recentLogHit()`,丢弃已被完整行替换的占位。
  - 自己的消息仍可回填本地昵称(`localPlayerName()`)。
  - 桥端 player 记录:拒绝 `<unknown>` 昵称;仅 `hero`/`heroId` 非空才写 player 记录(消除空 hero 噪音记录)。
  - 桥端 msg 输出:删除 `isOwn` 字段,新增 `steamid` 字段(本机 steamid 继续由桥端 console.log 连接行回填,他人由客户端 roster 采集回填)。
- **验证方式**
  - `node --check` 两个 JS 均通过。
  - `scripts/test_sender_backfill.js`:PASS 11/11(含"气泡先、完整行后"去重回归,断言只落 1 条且 sender 解析正确)。
  - `scripts/test_bridge_dedup.js`:PASS(断言 msg 无 `isOwn`、有 `steamid`;空 hero 不写 player 记录)。
  - `scripts/test_steamid_roster.js`:PASS 3/3;`scripts/lingua_chat_simtest.js`:PASS 45/45。
  - 已重建 `dist/pak22_dir.vpk`(281620 字节)并部署到 addons(旧版备份 `pak22_dir.vpk.bak_round16`);桥已重启,健康检查 OK。
- **仍需用户测试**:重启 Deadlock 打一局,检查 `logs/chat/<matchId>.jsonl`:气泡消息不再以 `<unknown>` 重复落盘、sender 能正确回填;msg 记录带 `steamid` 且无 `isOwn`;不再出现 hero 为空的 player 噪音记录。

## 2026-08-28 第二十一轮:修复主界面(顶栏)意外显示玩家名字(已构建,待部署)

- **背景**:用户反馈主界面显示了玩家名字,不该显示。
- **排查过程**
  - 检查 addons 目录与 `.dmm.json`:用户已于 8/28 15:08 用 Deadlock Mod Manager 禁用了第三方 `Show-Nicknames-In-TopBar.vpk`(656390)及其依赖 `656352_pak51_dir.vpk`,但顶栏仍显示玩家名。
  - 逐一检查启用中 mod 的文件树:只有 BabelTower 的 `pak22_dir.vpk` 覆盖 `panorama/layout/citadel_hud_top_bar_player.vxml_c`(启用的 pak01/pak02/pak03 均不覆盖顶栏布局)。
  - 定位根因:重建自原版的 `mod/panorama/layout/citadel_hud_top_bar_player.xml` 中,顶层有一个 `<Label class="AlwaysPlayerName" text="{s:player_name}" />`,该 Label 未加任何隐藏属性,会直接渲染每个玩家的昵称(原版布局中该 Label 处于隐藏上下文,重建时丢失;此前一直显示被 Show-Nicknames mod 的"顶栏显示昵称"功能掩盖,禁用该 mod 后暴露)。
- **改动文件**
  - `mod/panorama/layout/citadel_hud_top_bar_player.xml`
- **实现内容**
  - 给 `AlwaysPlayerName` Label 加 `visible="false"` + `hittest="false"` + `opacity:0;width:0;height:0;overflow:clip` 隐藏样式(与 `LCTTopBarAccount` 一致),顶栏不再显示玩家昵称。
  - 不影响身份采集:`TOPBAR_PLAYER_NAME_CLASSES` 仍包含 `AlwaysPlayerName` 作为文本读取候选(隐藏面板的 text 属性仍可读)。
- **验证方式**
  - `scripts/build.ps1` 编译 8 个文件成功;新 `dist/pak22_dir.vpk`(281631 字节)内容校验含 `citadel_hud_top_bar_player.vxml_c`(4.62kb)。
  - 旧版已备份为 addons `pak22_dir.vpk.bak_round17`。
- **部署状态**:游戏 8/28 19:37 仍在运行,addons `pak22_dir.vpk` 被占用,未能覆盖;待用户退出游戏后部署新 vpk 并重启游戏生效。
- **仍需用户测试**:退出游戏 → 部署新 vpk → 重进游戏:顶栏(主界面)不再显示玩家昵称,原翻译/聊天日志功能不变。
## 2026-08-28 第二十二轮:kind=quick 消息 sender/hero/steamid 解析(跨实例身份共享,已构建,待部署)

- **背景**:用户反馈 `kind:"quick"` 的消息 `sender:"<unknown>"`,hero、steamid 均获取不到;同时确认上一轮顶栏显示玩家名问题已修复但待部署。
- **排查过程**
  - 根因 1(身份不共享):`chat.xml` 与 `hudchat.xml` 各自 include 一份 `lingua_chat.vjs_c`,脚本是严格 IIFE,两份实例的 `State` 完全独立。顶栏/ESC roster/资料卡身份采集主要发生在 HUD 树实例,而写聊天日志的是聊天树实例——聊天侧解析 hero/steamid 时看不到 HUD 侧采集到的映射,导致 `kind:quick` 行(本身只带 hero 图/无 sender 字段)全部落 `<unknown>` 且 hero 为空。
  - 根因 2(顶栏扫描 0 entries):正式局顶栏扫描日志持续 `topbar scan: 0 entries`;ESC roster 行结构能识别 12 行,但 `captureEscapeRosterAccounts` 循环首行 `if (!row.steamid || ...) continue;` 把 hero-only 行直接丢弃,nick<->hero 映射没进 `State`,聊天侧无从按昵称补 hero。
- **改动文件**
  - `mod/panorama/scripts/lingua_chat.js`
- **实现内容**
  - 跨实例身份共享:`sharedIdentityStore()` + `syncSharedIdentity()`,通过 `globalThis.__LCT_SHARED_IDENTITY__` 在 chat/hudchat 两个实例间双向合并 `topbarHeroByName`/`topbarNameByHero`/`accountByName`/`accountByHero`/`heroByName`/`nameByHero`/`selfName`;`resolveSteamId()`/`resolveHero()`/`resolveSender()` 开头先合并,顶栏与资料卡任一路径采集到的身份,聊天侧立即可用。
  - 顶栏 0 entries 时每 90s 周期 `reconScene()`(节流 `State.reconNext`),持续侦察新版游戏顶栏结构,避免 `findTopbarPlayerEntries` 找不到条目后一直盲扫。
  - `captureEscapeRosterAccounts()`:hero-only 行不再被 steamid 检查丢弃,先写 `nameByHero`/`heroByName`(nick<->hero 足够聊天日志补 hero);有 steamid 再写 `accountByHero`/`accountByName`;成功后 `syncSharedIdentity()`;rows=0 时每 15s 打印 `escapeRoot` 面板诊断(`rosterRowsLogged`)。
  - `rememberProfileIdentity()` 落库后 `syncSharedIdentity()`;`refreshTopbarIdentity()` 顶栏成功扫描后也同步。
- **验证方式**
  - `node --check mod/panorama/scripts/lingua_chat.js` 通过。
  - `scripts/lingua_chat_simtest.js`:PASS 45/45。
  - `scripts/build.ps1` 编译 8 个文件成功;新 `dist/pak22_dir.vpk`(284591 字节)。
- **部署状态**:已部署(8/29 用户退出游戏后完成):addons `pak22_dir.vpk` = `dist/pak22_dir.vpk`(284591 字节,SHA256 一致);桥 health 200(PID 25168,端口 8791)。本轮仅改游戏端,桥无需重启。
- **仍需用户测试**:退出游戏 → 部署新 vpk → 重进游戏打一局:顶栏不再显示玩家昵称;`logs/chat/<matchId>.jsonl` 中 `kind:quick` 行 sender 有昵称、hero 非空,msg 带 steamid 且无 isOwn。
## 2026-08-29 第二十三轮:顶栏/ESC 采集修复(PlayerName 原生路径 + ShowEscapeMenu 向下搜索,已构建,待部署)

- **背景**:用户打完一局反馈日志仍有问题:112 条 msg 中 53 条 sender=<unknown>(47%,hud 气泡行 79%),他人 hero/steamid 全空,同文本标点变体重复落盘,个别时间乱序。
- **排查过程**(基于 <matchId>.jsonl + bridge.log)
  - 顶栏:整局 `topbar scan: 0 entries`;但 recon 侦察证明结构存在——`FindChildrenWithClassTraverse("PlayerName")` 能列出 10 个玩家的 PlayerName Label(祖先链含 `CitadelHudTopBarPlayer`/`CitadelHudTopBarTeam`)。根因:`findTopbarPlayerEntries` 只依赖固定 id/class 和全树 type 扫描(`scanPanelsByType` 3000 节点预算,遍历到顶栏前剪枝),没用 recon 验证有效的 PlayerName 原生路径。
  - ESC roster:整局无任何 `steamid roster` 输出。根因:`hudHasEscapeClass` 只沿**父链**找 `ShowEscapeMenu` class,但本脚本 `getRoot()` 走到最顶层 Panel,`CitadelHud`(挂 class)是它的**子孙**,永远匹配不到 → `isEscapeMenuOpen` 恒 false → 采集分支不执行。
  - 气泡行 sender:56 条 hud 行 44 条 <unknown>。`readMessageRow` HUD 分支直接置 UNKNOWN_NAME,未尝试行内 SenderName;且顶栏 hero->name 映射因顶栏采集失败而缺失,hero 反查回填无从谈起。
- **改动文件**
  - `mod/panorama/scripts/lingua_chat.js`
- **实现内容**
  - `findTopbarPlayerEntries`:新增 PlayerName class 反查路径(entryScope 内原生 `FindChildrenWithClassTraverse`,反查 paneltype 祖先,上限 24 条);type 扫描兜底作用域改为顶栏根优先(小树 20000 节点预算),整树兜底保留 3000。
  - `hudHasEscapeClass`:增加**向下**原生遍历 `ShowEscapeMenu` class(root 可能是比 CitadelHud 更顶层的容器)。
  - `captureEscapeRosterAccounts`:class 判据失效时用 `escapeRoot.BIsVisible()` 兜底(常驻面板关闭时不可见)。
  - `readMessageRow` HUD 分支:先尝试行内 `SenderName` class(有则直接归属);并一次性打印气泡行结构诊断(hudRowDiagLogged),确认新版气泡是否有 sender/英雄信息源。
  - `hudSatisfiedHit/Remember`:去重 key 改用 `normalizeQuickText`(归一化去尾标点),拦截 "我们去蓝路吧！" 与 "我们去蓝路吧！！！" 这类同文本标点变体重复。
- **验证方式**
  - `node --check mod/panorama/scripts/lingua_chat.js` 通过。
  - `scripts/lingua_chat_simtest.js`:PASS 45/45。
  - `scripts/build.ps1` 编译 8 个文件成功;新 `dist/pak22_dir.vpk`(SHA256 65F302E1...)。
- **部署状态**:游戏 8/29 15:00 运行中,addons `pak22_dir.vpk` 被占用,未能覆盖;待用户退出游戏后复制 `dist/pak22_dir.vpk` 到 addons 再启动游戏。
- **仍需用户测试**:退出游戏 → 部署 → 重进游戏打一局:桥日志应出现 `topbar identity scan players=N`(顶栏映射建立)、`steamid roster: escape menu found`(ESC 采集)、`hud row diag`(气泡行结构);聊天日志他人消息 hero 应有值,quick 消息 sender 减少 <unknown>,不再有标点变体重复。
## 2026-08-29 第二十四轮:完全被动 steamid 采集(赛后记分板 + 顶栏变量探测,已部署)

- **背景**:用户要求"尽量不要用主动收集"——不希望依赖打开 ESC 菜单/悬停资料卡才能采集 steamid。
- **被动路径盘点**(基于代码 + 日志证据)
  - Players API:桥日志 `player ns present=(none)`、`player localId=-1`——当前版本 Panorama 脚本上下文 `Game`/`Players` 命名空间不存在,API 路径不可用(死路)。
  - 顶栏条目:每局常驻、零操作,可拿 name+hero;steamid 需 account 变量——布局已埋 `LCTTopBarAccount`(`{i:r:account_id}`)但读不到值,疑似变量名不匹配,需多变量探测。
  - 赛后记分板:每局结束自动出现,`scanPostGameScoreboard` 已在跑,12 人 name+hero 已能读——补读 steamid 即完全被动全量采集。
  - 桥端 `identity_cache.json`:客户端发 player 记录即跨局累积(昵称->steamid),一次采集永久复用。
- **改动文件**
  - `mod/panorama/layout/citadel_hud_top_bar_player.xml`
  - `mod/panorama/scripts/lingua_chat.js`
- **实现内容**
  - 顶栏候选变量探测:新增 `LCTTopBarAccount2..6` 隐藏 Label(`{i:r:player_id}`/`{s:steam_id}`/`{i:account_id}`/`{s:account_id}`/`{i:player_id}`);`readTopbarIdentity` 逐个读取,命中即用,并一次性输出 `topbar account probe` 诊断(各变量值),下一局即可确认哪个变量有值。
  - 赛后记分板 steamid:`readScoreboardPlayer` 加 `steamid = readProfileAccount(row)`(引擎属性/对话框变量/隐藏 Label 全路径探测);`scanPostGameScoreboard` 收集后把带 steamid 的玩家以 `type=player` 记录发给桥(按昵称去重),桥端写入 identity_cache 跨局复用。
  - ESC 玩家列表保留为被动兜底(打开菜单即自动读,零点击/悬停),不再作为主力。
- **验证方式**
  - `node --check` 通过;`scripts/lingua_chat_simtest.js` PASS 45/45。
  - `scripts/build.ps1` 编译 8 个文件成功;`dist/pak22_dir.vpk`(289118 字节,SHA256 D9A3AB4E...)已部署到 addons,哈希一致。
- **部署状态**:已部署(8/29 17:32,游戏已退出)。
- **仍需用户测试**:重进游戏打一局(正常打完即可,无需开 ESC):桥日志应出现 `topbar account probe`(顶栏各变量值)与 `post-game scoreboard identities captured=N`(赛后自动采集人数);下一局起他人消息 steamid 应能补全(identity_cache 生效)。

## 2026-09-01 第二十五轮:修复 scanChatMessagesOnce 轮询崩溃(hudSatisfied 未声明,已构建部署)

- **背景**:9/1 局后检查 logs/bridge.log,发现自 8/25 起反复出现 poll error in scanChatMessagesOnce: Cannot read properties of undefined (reading set)(9/1 仍有 2 次),该轮询路径一直在抛异常。
- **根因**:commit 1e03eda 引入 HUD 占位长窗口去重(pruneHudSatisfied/hudSatisfiedHit/hudSatisfiedRemember)时,hudSatisfiedRemember 直接调用 State.hudSatisfied.set(...),但 State 对象从未声明 hudSatisfied: new Map()。dropPending() 移除挂起占位时触发,异常向上抛出中断整轮 scanChatMessagesOnce(该轮后续行处理被跳过,State.scannedCount 不推进)。
- **改动文件**
  - mod/panorama/scripts/lingua_chat.js:State 增加 hudSatisfied: new Map()(CRLF 行尾保持)。
  - scripts/lingua_chat_simtest.js:新增 test0 静态检查(State 字段使用即声明或赋值),防同类遗漏复发。
- **验证方式**:node --check 通过;scripts/lingua_chat_simtest.js PASS 46/46(含新增 test0);scripts/build.ps1 编译 8 文件成功;新 dist/pak22_dir.vpk(SHA256 E5BC0FA621A33F2C96181686D213E267323C8CC7D8C6A8363DEF94743C94D3C4)已部署到 addons,哈希一致。
- **部署状态**:已部署(9/1,游戏未运行,addons pak22_dir.vpk 已覆盖)。
- **仍需用户测试**:重进游戏打一局,桥日志不应再出现 poll error in scanChatMessagesOnce;HUD 占位被完整行顶掉后的 90s 长去重窗口生效,<unknown> 重复条目应减少。

## 2026-09-12 第二十六轮:审查修复——发布包完整性 / CORS 收紧 / 队列重试延迟 / 隐私快照治理(未部署)

- **背景**:重新审查项目后,发现发布包缺依赖、本地 API CORS 过宽、ESC roster 回归测试失败、重试延迟未生效、仓库误提交含玩家昵称的日志快照等。
- **改动文件**
  - scripts/package_release.ps1:补复制 core/glossary.js、core/hero_names.js、config/dictionary.builtin.json。
  - core/bridge_server.js:移除 /api 与 /bridge 的 Access-Control-Allow-Origin:*;保存配置后刷新 activeConfig;翻译缓存 key 不再截断前 200 字符。
  - mod/panorama/scripts/lingua_chat.js:修复 collectStructuralRosterRows 对 MainContents 自身的误判;重试队列增加 retryAt,真正遵守 RETRY_DELAY_SECONDS / 0.6s 延迟。
  - scripts/test_steamid_roster.js:同步最新英雄映射计数期望(gainedHero=8),并验证 rows 去重后为 4。
  - StopBridge.bat:端口匹配改为 /c:":8791 ",避免误杀 18791 等端口。
  - .gitignore:忽略 analysis_logs/*.log 与 analysis_logs/*.jsonl。
  - analysis_logs/bridge_tail_3000.log、analysis_logs/chat_<matchId>.jsonl:git rm --cached,保留本地文件但不再纳入版本控制。
- **原因/效果**
  - 发布包此前会在桥启动时 MODULE_NOT_FOUND(缺 glossary/hero_names),且内置词典不生效;现已补齐。
  - CORS * 允许任意网页操作本机桥;移除后游戏内 HTML 面板与 AsyncWebRequest 不受影响。
  - ESC 结构扫描不再把 MainContents 与玩家根行重复计数;重试不再被 finishJob 的立即 pumpQueue 提前触发。
  - 已提交日志快照含真实玩家昵称/聊天内容,已从 Git 跟踪移除(历史版本仍存在,如需彻底清理需 history rewrite)。
- **验证方式**
  - node --check 全部 JS 通过;6 个 XML 布局解析通过;package_release.ps1/build.ps1 PowerShell 语法解析通过。
  - scripts/lingua_chat_simtest.js:PASS 46/0。
  - scripts/test_sender_backfill.js:PASS 11/0。
  - scripts/test_steamid_roster.js:PASS 3/0。
  - scripts/test_bridge_dedup.js:PASS。
  - scripts/test_bridge_fallback.js:PASS。
- **仍需用户测试**:重建并部署 pak22_dir.vpk 后进游戏打一局,确认翻译、日志、ESC 被动采集无回归;运行一次发布打包流程,确认 zip 内桥可启动。


## 2026-09-12 第二十七轮:聊天日志 SteamID 在线回填(Deadlock 公开数据 API)

- **背景**:当前游戏版本 Panorama 上下文 `Game`/`Players` 命名空间均不存在(`player ns present=(none)`, `Game namespace missing`), 其他玩家的 SteamID 无法通过聊天行/顶栏/ESC 自动采集; 只有本机玩家能从 `console.log` 连接行回填。
- **发散思路与结论**:
  - 本地 demo/replay: `addons/replays` 有 `.dem`, 但最新一场仍停在 8/5, 不适合自动回填当前聊天日志。
  - Steam 客户端本地缓存: `localconfig.vdf` 只有好友/最近游戏 app 信息, 没有“最近同局玩家 -> SteamID”。
  - Panorama 绑定盲试: `{i:r:account_id}`、`{s:steam_id}` 等当前均取不到其他玩家的 account 字段。
  - 可行路径: 桥端联网调用 `api.deadlock-api.com` 的公开 Steam 搜索接口, 用聊天日志里的昵称精确匹配 `personaname`, 再转 SteamID64; 歧义昵称用本局 `matchId + heroId` 查候选人的 match-history 验证。
- **改动文件**
  - `core/steamid_enrich.js`: 新增模块; 提供昵称搜索、精确匹配、match-history 验证、原子回写 jsonl、identity_cache 累积。
  - `core/bridge_server.js`: 引入模块并在桥启动后启动周期回填任务。
  - `core/config.js`: 新增 `steamIdEnrichment` 配置块与数值归一化。
  - `config/config.example.json`: 增加默认关闭的 `steamIdEnrichment` 示例。
  - `config/config.json`: 当前启用 `steamIdEnrichment.enabled = true`。
  - `scripts/package_release.ps1`: 发布包补复制 `core/steamid_enrich.js`。
- **实现细节**
  - 只处理 `logs/chat/<matchId>.jsonl`, 跳过 `session_*` 与近 3 分钟内仍活跃写入的文件, 避免和 `appendChatLog` 竞争。
  - 每场最多解析 12 个未知名, 每次运行最多扫描 10 个文件; 精确匹配到唯一候选人即回填, 歧义时最多验证 3 个候选人的 match-history。
  - 回填后同时更新消息行和 `player` 记录, 并写入 `identity_cache.json` 供后续比赛复用。
- **验证方式**
  - `node --check` 全部通过。
  - 临时文件冒烟测试: 当前局 `<matchId>.jsonl` 的 7 个未知名全部回填成功。
  - 实际回填: 最近 7 个文件全部改写, 共解析 24 个玩家昵称, 无 API Key 写入日志。
  - `GET /api/v1/health` 正常; 桥已重启, PID 12340 监听 `127.0.0.1:8791`。
- **仍需用户测试**: 下局正常游玩后等待约 3 分钟(周期任务触发), 再打开 `logs/chat/<matchId>.jsonl` 确认其他玩家 `steamid` 已自动出现; 若某昵称仍未回填, 优先看该昵称是否在 Steam 搜索里不是唯一精确匹配。


## 2026-09-12 第二十八轮:identity_cache 全量 roster 入库

- **背景**:用户希望不只是“聊过天的人”, 而是每局所有一起玩过的玩家都进入 `identity_cache.json`, 并且跨局去重。
- **方案**
  - 使用 `/v1/matches/metadata?match_ids=<id>&include_player_info=true` 拉取整局 12 人的 `account_id` / `hero_id`。
  - 使用 `/v1/players/steam?account_ids=...` 批量获取 `personaname`, 一次性补齐昵称。
  - `account_id` 转 SteamID64 后写入 `account:<account_id>` 键, 避免昵称重名/改名冲突; 昵称键只作为方便回填聊天消息的别名。
- **改动文件**
  - `core/steamid_enrich.js`:新增 roster 拉取、批量 Steam 档案、按 account_id/昵称双键合并去重;`matchCount` / `lastMatchId` 记录同玩家重复遇到次数。
  - `core/config.js` / `config/config.example.json` / `config/config.json`:新增 `rosterEnabled`、`rosterRequestTimeoutMs`、`steamProfileRequestTimeoutMs`。
- **去重规则**
  - 同一 `account_id` 只保留一条 `account:<id>` 记录。
  - 同一局重复扫描时 `lastMatchId` 不变, 不重复累加 `matchCount`; 下局再遇到同一玩家时 `matchCount` 才 +1。
  - 昵称冲突(两个 account 同名)不覆盖已有 SteamID, 以 `account:<id>` 为准。
- **验证方式**
  - `node --check` 通过。
  - `scripts/test_steamid_roster.js` PASS 3/0。
  - `scripts/test_sender_backfill.js` PASS 11/0。
  - 实际回填 `<matchId>.jsonl`: 12 人全部进入缓存, 新增 12 条 account 记录; 重复运行 `added=0`。
  - 桥已重启, `/api/v1/health` 返回 200。
- **仍需用户测试**: 下一局结束后等待约 3 分钟, 检查 `logs/chat/identity_cache.json` 是否新增 `account:<id>` 条目; 若该局刚结束 API 尚返回 404, 周期任务会在后续几轮自动重试。


## 2026-09-12 第二十九轮:桥后台无窗口运行

- **背景**:用户手动启动桥时会出现最小化 `LinguaChatBridge` 窗口, 点窗口关闭按钮会把桥进程一起关掉。
- **改动文件**
  - `StartDeadlock.bat`:桥进程改用 PowerShell `Start-Process -WindowStyle Hidden` 后台启动, 不再创建可见窗口。
  - `StartBridgeSilent.vbs`:新增双击启动器, 用 `WshShell.Run(..., 0, False)` 隐藏整个启动过程; 适合直接从桌面/文件夹双击启动。
- **验证方式**
  - 停止旧桥后通过 `StartBridgeSilent.vbs` 启动, `/api/v1/health` 返回 200。
  - `node.exe` 进程 `MainWindowHandle=0`, 无可见窗口。
- **使用方式**
  - 后台启动: 双击 `StartBridgeSilent.vbs`; 停止: 双击 `StopBridge.bat`。
  - 原 `StartDeadlock.bat` 仍可用于终端/带游戏启动场景, 但桥进程本身已隐藏。


## 2026-09-12 第三十轮:新对局 roster 首次延迟 6 小时

- **背景**:用户认为 10 分钟轮询太短, 希望新对局建立后 6 小时再开始重试整局 roster。
- **方案**:采用“文件年龄门槛 + 小时级扫描”, 而不是把全局任务简单改成 6 小时一次。
  - `minFileAgeMs` 保持 180000(3 分钟), 让聊天昵称回填仍可较早运行。
  - 新增 `rosterMinFileAgeMs = 21600000`(6 小时), 只有聊天文件满 6 小时后才首次请求整局名单。
  - `intervalMs` 改为 3600000(1 小时), 首次成功后每小时重试一次, 避免 6 小时请求恰好失败后需要再等 6 小时。
- **改动文件**
  - `core/steamid_enrich.js`: `enrichFile` 中 roster 分支按 `rosterMinFileAgeMs` 延迟; 未到期返回 `waiting_roster_delay`。
  - `core/config.js` / `config/config.example.json` / `config/config.json`: 增加 `rosterMinFileAgeMs`, 并将 `intervalMs` 调整为 1 小时。
- **验证方式**
  - `node --check` 通过。
  - `scripts/test_steamid_roster.js` PASS 3/0。
  - 桥通过 `StartBridgeSilent.vbs` 重启, `/api/v1/health` 200, `node.exe` 无可见窗口。


## 2026-09-12 第三十一轮:公开仓库 1.0 发布准备

- **背景**:公开仓库已从 `Thirt927/BabelTower` 更名为 `Thirt927/DeadlockLingua`, 需要把当前 `optimizations` 分支整理为可发布的 1.0.0。
- **改动文件**
  - `VERSION` / `mod/panorama/scripts/lingua_chat.js` / `core/bridge_server.js`: 版本号统一为 `1.0.0`。
  - `scripts/autostart.ps1`: 合并并保留 `StartupApproved` 禁用标记清理逻辑; 避免任务管理器/联想电脑管家禁用自启后无法重新启用。
  - `README.md`: 重写为 `DeadlockLingua` 使用、更新、构建、发布说明。
  - `CHANGELOG.md`: 新增 v1.0.0 变更记录。
  - `安装使用说明.txt` / `LICENSE_NOTICE.md` / `scripts/package_release.ps1` / `scripts/build.ps1`: 品牌与发布包名更新。
- **原因/效果**
  - 公开仓库呈现为独立项目, 不再暴露 GameBanana 专用内容。
  - 发布包统一命名 `DeadlockLingua-<版本>-win64.zip`。
  - 后续用户可按 README 更新说明完成升级。
- **验证方式**
  - `git diff --check` 无空白错误。
  - 版本相关 `rg "0\\.1\\.2|0\\.2\\.0|BabelTower-<版本>"` 复查。
  - 构建和发布包脚本待执行验证。
- **仍需用户测试**: 安装发布包后, 确认 `/tr` 设置面板显示版本/桥健康检查正常。


## 2026-10-01 第三十二轮:Deadlock 更新后 mod 失效修复(桥静默退出 + 陈旧布局覆盖对齐新版)

- **背景**: Deadlock 更新后用户反馈"翻译 / 设置 / 日志在游戏里全部失效"。
- **根因**(两条, 均有实证)
  - mod VPK 被 Deadlock Mod Manager 置为禁用: 文件被改名为 `local-162ee955-..._pak22_dir.vpk`, `.dmm.json` 为 `enabled:false`; 游戏里连聊天栏的"译"按钮都不存在。
  - 本地桥进程未运行: `logs/bridge.log` 最后一条停在 12:07:57, `127.0.0.1:8791` 拒连。`config.json` 里 `watchGame:false` 已排除"游戏退出自动关桥", 疑为未捕获异常静默退出。
  - 兼容性已排除: `panorama/layout/chat.vxml_c` 新旧同为 2485 B(聊天布局本身未改动), 且编译产物块签名一致, 新引擎可加载旧编译产物。
- **改动文件**
  - `core/bridge_server.js`: 新增 `uncaughtException` / `unhandledRejection` 全局兜底 —— 未捕获异常与未处理 Promise 拒绝只记日志, 不再让进程静默退出。
  - `mod/panorama/layout/citadel_hud_top_bar_player.xml`: 按新版原版重基线。根节点补回 `hittest="false"`; 移除 `PlayerDetailsContainer` 上陈旧的 `hittest="false"`(新版原版已删除该属性, 留着会让玩家详情悬浮失效); 连杀文案 `#kill_hype_KillStreak` → `#kill_hype_KillStreak:f`; 补回新版新增的 `PlayerHeroReleaseVote` 面板。隐藏探针 `LCTTopBarAccount`~`LCTTopBarAccount6` 全部保留。
  - `mod/panorama/layout/chat.xml`: `ChatMessageContents_Ping` 片段按原版补回 `<Image id="TargetHeroImage" />` 与 `PingLabel` 的 `html="true"`; 设置按钮 / 设置面板 / 隐藏桥面板保持不变。
- **原因/效果**
  - 桥不再因一次未捕获异常(例如定时任务里的单次失败)整体退出, 避免"日志停在某时刻后再无输出"。
  - 顶栏覆盖不再回退新版 HUD 元素(英雄投票贴纸、玩家详情悬浮、连杀文案)。
  - Ping 消息恢复显示目标英雄头像, ping 文本按富文本渲染。
  - 用 Source 2 Viewer 反编译新版原版逐一比对后确认: `profile_card.xml` / `players_list_entry.xml` / `citadel_db_page_profile.xml` 与新版原版结构完全一致, **无需改动**。
  - `hudchat.xml` 予以保留: 新版 `pak01` 已不含 `hudchat.vxml_c`, 该覆盖目前是惰性文件; 暂不删除以免影响可能存在的大厅聊天加载路径。
- **验证方式**
  - `scripts/build.ps1 -Csdk12Root "E:\dealoc-mod\Reduced_CSDK_12"` 重建: 8 个资源全部 ok。
  - 部署 `dist/pak22_dir.vpk` → `addons/pak22_dir.vpk`(289854 B); `vpkeditcli --file-tree` 校验含 6 个 layout 的 `vxml_c` + `lingua_chat.vjs_c` + `lingua_chat.vcss_c`。
  - 反编译自建的 `pak22_dir.vpk` 做回环校验: 确认 `hittest="false"`、`PlayerHeroReleaseVote`、`TargetHeroImage`、`LCTTopBarAccount6`、`LCTSettingsButton`、`LCTBridgePanel` 均存在于编译产物。
  - 桥: `/api/v1/health` 返回 200; `POST /api/v1/test {"text":"gg wp","targetLanguage":"zh-Hans"}` 返回译文。
- **仍需用户测试**
  - 在 Deadlock Mod Manager 界面把该本地 mod 重新"启用"(否则 DMM 下次应用配置会再次把它改名禁用), 然后重启 Deadlock。
  - 确认聊天栏出现"译"按钮、翻译生效、`logs/chat` 有新日志; 顶栏英雄投票贴纸与玩家详情悬浮正常。


## 2026-10-01 第三十三轮:mod 完全不被加载的真因(gameinfo.gi addons 搜索路径丢失)

- **背景**: 启动游戏后聊天栏没有"译"按钮、`/tr` 无反应、翻译全失效。`console.log` 中搜索 `LCT` **零命中**, 说明 `lingua_chat.vjs_c` 根本没被执行 —— 不是脚本报错, 是 mod 压根没挂载。
- **根因**(有实证)
  - `game/citadel/gameinfo.gi` 的 `SearchPaths` 里**没有 `Game citadel/addons`**, 游戏因此完全不挂载 `addons/` 下任何 VPK。`console.log` 的 `[Filesystem]` 搜索路径列表里没有任何 addon, 关卡加载行始终是 `addons ()`。
  - 该文件在故障当天被还原过一次(旧版本 DMM / Steam 校验文件都会覆盖它), 把原先的 addons 搜索路径一并抹掉。这是"更新后所有 mod 一起失效"的通用原因, 与项目自身布局覆盖无关。
  - 附带根因(单独记录): 若同时启用打包了旧版 `scripts/abilities.vdata_c` 的第三方 addon, 会触发 `FATAL ERROR: ... m_eLosCheck: Error parsing string 'ELOSCheck_...' as int` 启动崩溃。经 `vpkeditcli --file-tree` 逐个确认, 含该文件的 mod 为 601444(Always Show Passive Items and Actives Icons)、664142(Graves Shirt)、681831(Monochrome Haze), 作者更新前不要启用。
- **修复方式**(结论: **不要手改这个文件**)
  - 手改被证伪: 在 `gameinfo.gi` 里直接加 `Game citadel/addons`(或再加 `AddonRoot` / `OfficialAddonRoot`)会让引擎 `FATAL ERROR: Application unable to load gameinfo.gi file from directory "citadel" Failed to parse KeyValues`, 两种写法都失败。
  - 正确做法: 交给 **Deadlock Mod Manager** 自己重新应用补丁。它在 DMM 里重置后重新写入的标准格式(`SearchPaths` 内含 `Game citadel/addons` + `Mod citadel` / `Write citadel` / `Mod core` / `Write core`)能被引擎接受。
  - 游戏侧文件(不在仓库内): `E:\Steam\...\Deadlock\game\citadel\gameinfo.gi`(最终由 DMM 写入, 14864 B)。
- **原因/效果**
  - 游戏重新挂载 `addons/` 下的 `pakNN_dir.vpk`, `pak22_dir.vpk`(本 mod)才会被加载, 聊天栏"译"按钮 / `/tr` 设置面板 / 翻译 / 聊天日志随之恢复。
- **验证方式**(端到端已通过)
  - `console.log`: `[LCT] loaded v1.0.0; watching ChatMessages`、`[LCT] bridge online`; `[Filesystem] GAME ... addons\pak22.vpk` 已挂载; 无 FATAL。
  - `logs/bridge.log`: `translate ok: hello`; 新增聊天日志 `logs/chat/session_*.jsonl`; `/api/v1/health` 返回 200。
  - 顶栏身份读取正常: 昵称/英雄/steamid 均解析成功。
- **备注**
  - 游戏更新或 Steam"验证文件完整性"会再次还原 `gameinfo.gi`, 补丁会丢, 需在 DMM 里重新应用一次。
  - 排查过程中在本机留了一个 `gameinfo.gi.lct-bak`(非 DMM 那版格式的文件), 已无用途, 可删。


## 2026-10-01 第三十四轮:桥面板僵死自愈(不用再重开游戏)

- **现象**: 游戏先开着、桥后起来(或桥中途重启)后, 局内一直显示"桥离线", **重启桥完全无效**; 只有重开游戏才恢复。
- **根因**(有实证, 见 `E:\Steam\...\Deadlock\game\citadel\console.log` 与 `logs/bridge.log`)
  - 本版游戏已移除 `$.AsyncWebRequest`, 桥通信只剩隐藏 HTML 面板通道(`panel.SetURL` 导航 `/bridge`, 页面把结果写回 `document.title` 供 Panorama 读回)。
  - 16:04:57 游戏启动时桥未运行 -> 面板首次导航失败(连接被拒)。此后**面板彻底僵死**: `SetURL` 不再抛错、也不再发出任何 HTTP 请求, `HTMLChangedTitle` 永不触发。
  - 证据链: 桥在 16:47 / 16:49 两次起来后, `bridge.log` 在 16:47-16:52 期间**零请求**(正常情况下 `[diag] PANORAMA:` 与 `translate ok:` 会持续出现); `console.log` 里 `bridge online` 一次都没出现过, 只有 `bridge_offline` 反复重试。所以"重启桥"从原理上就不可能生效。
  - 也就是说这不是随机故障: 只要**面板第一次导航时桥不可达**, 整个这局游戏就废了。
- **改动文件**
  - `mod/panorama/scripts/lingua_chat.js`: 新增桥面板自愈(`SetURL("about:blank")` 重置 + 自动重新探测); 健康探测/日志/配置类桥操作改用 8s 短超时; 桥已确认离线时出站翻译直接按原文发送, 避免回车被吞。
  - `scripts/lingua_chat_simtest.js`: 新增 `test17_bridgePanelSelfHeal`(模拟面板僵死 -> 自愈 -> 恢复), 并在 mock 里记录运行时创建的 HTML 面板以断言自愈从不重建面板。
  - `core/bridge_server.js`: `/bridge` 路由加载时记一条日志, 用于区分"面板没导航"和"导航了但读不回 title"。
- **实现细节**
  - `notePanelFailure()`: 仅在"页面连 `lct-alive` 都没回"时计数(真正导航没发生); 连续 2 次触发 `resetBridgeChannel()`。触发点是 `pollTitle` 超时和 8s 健康探测失败。
  - `resetBridgeChannel()` 只做一件事: 把面板 `SetURL("about:blank")` 清掉错误文档, 0.6s 后清计数并重新探测/重试队列。**禁止重建面板** —— 运行时用 `$.CreatePanel("HTML", ...)` 建的面板在本版引擎不可用, 一旦替换或删除原面板就会把唯一可用的面板弄丢, 反而永久弄坏通道(早期实现里的"新建备用面板/删除重建"已全部删除)。连续失败时重置间隔放宽到 45s, 避免长期刷屏。
  - 通道恢复后(`markBridgeUp` / 健康探测成功)自愈计数归零。
  - `jobTimeoutMs()`: `health / diag / log / config` 这些桥侧即时返回的操作超时从 15s 降到 8s —— 否则断线时在途请求会卡住十几秒, 健康探测每 5s 一轮全被 pending 挡掉, 要等好几个周期才发现面板已僵死。取 8s 而非更短, 是为了不让首次导航稍慢就被误判离线。
  - 出站兜底: 桥已确认离线时不再等翻译回调, 直接按原文发送并清 `outgoingPending`; 否则 `outgoing dedupe` 会把之后每一次回车全部吞掉(现象就是"打 hello 按回车发不出去")。
- **验证方式**
  - `node --check` 通过。
  - `scripts/lingua_chat_simtest.js`: **PASS 51 / FAIL 0**(含 5 条自愈断言: 僵死被检测到并重置、重置有节流不刷屏、自愈从不重建面板、面板恢复后会重新探测、恢复后翻译正常)。
  - 已重建 VPK(8 个资源全 `ok`)并部署为 `addons\pak22_dir.vpk`。
- **仍需用户测试**: 关闭桥 -> 打开游戏(复现僵死) -> 再启动桥, 期望**几十秒内**自动恢复(局内出现"桥在线", 翻译可用), 无需重开游戏。若仍不恢复, 说明本版引擎可能已把面板通道一起废掉(见第三十六轮), 需要换传输方式。

## 2026-10-01 第三十五轮:开机自启动失效(启动项被禁用 + Node 版本不一致)

- **现象**: 用户反馈"我的桥不是开机自启动吗", 实际开机后桥并没有起来, 每次都要手动点 `RestartBridge.bat`。
- **根因**
  - 启动项本身存在: `HKCU\...\CurrentVersion\Run` 的 `BabelTowerBridge` 指向 `wscript.exe ...\scripts\babel_bridge_autostart.vbs`。
  - 但 `HKCU\...\Explorer\StartupApproved\Run` 里该值是 `03 00 00 00 ...`(首字节 `0x03` = 在任务管理器"启动应用"里被**禁用**)。
  - 旁证: 当日开机时间 15:11:38, 而 `logs/bridge.log` 当日只有 16:47 / 16:49 两条 listening 记录(正好是用户手动点重启的两次)。
  - 附带问题: 自动启动脚本用的是裸 `node`, 会跑到 `D:\nodejs\node.exe`(v24.13.0), 与手动启动 `StartDeadlock.bat` 用的 `portable-node\node.exe`(v26.1.0)不是同一个 Node, 且不切换工作目录。
- **改动文件**(该文件被 `.gitignore` 忽略, 不入库)
  - `scripts/babel_bridge_autostart.vbs`: 改为 `cd` 到项目根 + 优先使用 `portable-node\node.exe`(取不到才回退 `node`), 与 `StartDeadlock.bat` 行为一致。
  - 注册表(本机环境): 把 `BabelTowerBridge` 的 StartupApproved 值写回 `02 00 00 00 ...` 重新启用。
- **验证方式**
  - 回读注册表: Run 项不变, StartupApproved 已是 `02 00 00 00 00 00 00 00 00 00 00 00`。
  - `GET /api/v1/health` 返回 200, 桥进程为 `portable-node\node.exe`。
- **仍需用户测试**: 下次开机(或本次会话先停桥再双击该 vbs)确认 `logs/bridge.log` 自动出现新的 listening 行。

## 2026-10-01 第三十六轮:游戏更新导致桥传输通道失效(诊断, 未解决)

- **现象**: 用户反馈"昨天晚上我实验了能翻译啊, 怎么今天就不行了"。
- **根因**(已定性)
  - Steam 于 **2026-10-01 16:00:56** 推送 Deadlock 更新(`deadlock.exe` / `pak01_dir.vpk` mtime = 2026/10/1 16:00:56; `appmanifest_1422450.acf` 的 `LastUpdated` 同值, `buildid=25639407`)。
  - 新构建 `panorama.dll` 内含字符串 `"Make a web request (disabled)"` 与 `"ERROR: AsyncWebRequest has been removed"` —— 引擎禁用了 Panorama 发 HTTP 的能力。
  - 昨天(9/30)是旧构建, 走 `$.AsyncWebRequest` 直连桥, 所以正常; 今天调用即抛 `AsyncWebRequest has been removed`。
  - 仅剩的隐藏 HTML 面板通道**零送达**: 桥端已加 `/bridge` 加载日志(`[panel] /bridge load`), 在用户重启游戏后的整局里该行一次都没出现, `bridge.log` 此后也无任何 `[diag] PANORAMA:` / `translate ok` 记录。
- **结论/状态**: 游戏 → 桥目前**没有任何可用传输通道**。不是用户操作或随机故障, 是引擎行为变更。
- **待办**: 若面板通道确实不可用, 需换传输方式或等 Valve 恢复; 暂无 mod 侧解法。

## 2026-10-01 第三十七轮:设置面板关闭后键盘焦点未释放(退出界面无法移动)

- **现象**: 在设置面板改"超时(ms)"(延迟时间)后关闭面板, 键盘仍被当文本读, 人物无法用 WASD 移动。
- **根因**: `closeSettingsPanel()` 只把面板移除 `LCTVisible` class, **没有释放输入焦点**; `LCTTimeout` 是 `TextEntry`, 面板隐藏后仍持焦, 键盘事件继续进入该输入框。
- **改动文件**: `mod/panorama/scripts/lingua_chat.js`
  - 抽出 `dropInputFocus()`(`DropInputFocus()` / `$.DispatchEvent("DropInputFocus")` 兜底), `closePlayerCards()` 与 `closeSettingsPanel()` 共用。
  - `closeSettingsPanel()` 隐藏面板后调用 `dropInputFocus()`。
  - `openSettingsPanel()` 异步配置回调里的 `SetFocus()` 增加"面板仍可见"判断, 避免用户已关闭设置后焦点被抢回隐藏面板。
- **验证方式**
  - `node --check` 通过; `scripts/lingua_chat_simtest.js` **PASS 51 / FAIL 0**。
  - 已重建 VPK(8 个资源全 `ok`)并部署 `addons\pak22_dir.vpk`(2026/10/1 17:43:58)。
- **仍需用户测试**: 重启游戏 -> 打开设置改超时 -> 关闭面板 -> 确认 WASD 能立刻移动。

## 2026-10-01 第三十八轮:设置里的"超时(ms)"对出站翻译不生效

- **现象**: 用户反馈"修改延迟时间不生效"。
- **根因**: 出站翻译超时被写死成常量 `OUTGOING_TIMEOUT_MS = 30000`, 全部 5 处用法(构建面板 URL、构建直连 URL、`jobTimeoutMs`、`setTimeout`、`$.Schedule` 兜底)都直接引用常量, **从不读 `State.cfg.timeoutMs`**; 用户改"超时(ms)"只影响普通(入站)翻译, 所以看起来完全没效果。
- **改动文件**: `mod/panorama/scripts/lingua_chat.js`
  - 新增 `outgoingTimeoutMs()`: 优先返回设置面板的 `timeoutMs`(限制在 `[3000, 120000]` 之间, 防止填 0/1 掐死正常翻译), 未配置才回退 `OUTGOING_TIMEOUT_MS`。
  - 上述 5 处引用全部改为 `outgoingTimeoutMs()`; `setTimeout` / `$.Schedule` 两处改为先取一次 `const otm = outgoingTimeoutMs()` 保证同一任务用同一超时。
- **验证方式**
  - `node --check` 通过; `scripts/lingua_chat_simtest.js` **PASS 51 / FAIL 0**。
  - 已重建 VPK(8 个资源全 `ok`)并部署 `addons\pak22_dir.vpk`(2026/10/1 17:53:25)。
- **仍需用户测试**: 重启游戏 -> 设置里把"超时(ms)"改成明显不同的值(如 5000)并保存 -> 发一条消息, 确认等待/放弃时间随之变化。

## 2026-10-01 第三十九轮:HTML 面板通道被引擎废除(定性) + 收敛空转逻辑

- **背景**: 承第三十六轮。用户在两个方案里选择了"暂不做替代, 先收敛现状"。
- **最终定性**: 游戏侧已**完全丧失 HTTP 能力**, 两条通道全废。HTML 面板通道的死因经实测确认——
  - 面板**确实会被渲染**(对局中带聊天框时实测 `bridge panel geom: layout 3x3`, 不再是 0x0), 但引擎不再为 HTML 面板创建浏览器实例: `SetURL` 不报错、`panel.title` 永远 `undefined`。
  - `logs/bridge.log` 里面板导航请求 `/bridge` 的**历史计数为 0**(全量扫描), 即 SetURL 从未真正发出过一次请求。
  - 该结论推翻了"面板不渲染所以没有浏览器"的假设 —— 把面板挪到常驻容器也不会有用。
  - 同一版本 `$.AsyncWebRequest` 调用即抛 `AsyncWebRequest has been removed.`, 且无相关 convar 可打开。
- **连锁现象**(被本次改动修正): 通道全废后 mod 判定桥离线, 触发 `bridge self-heal #N [blank]` 每 6s 刷日志 + 每 4s 一次重新导航的探针空转; 且用户进对局后第一次发消息会先空等一次出站超时(默认 15s)才发原文。
- **改动文件**
  - `mod/panorama/scripts/lingua_chat.js`
    - 新增开关常量 `PANEL_CHANNEL_ENABLED = false`(带完整死因注释): `ensurePanel()` 在其为 false 时直接返回 null, 面板通道整体旁路; 引擎若恢复该能力改回 `true` 即可。
    - 删除无限重试探针 `probePanelBrowser` 及其 `panelProbe*` 状态; 删除面板 `chain` / `geom` 诊断日志。
    - `notePanelFailure()` 在通道关闭时直接 return, 停掉 `resetBridgeChannel` 的 about:blank 自愈与日志刷屏。
    - 修正 `translateOutgoing()`: 原来只判断 `ensurePanel()`, 面板通道关闭后会**连可用的 `$.AsyncWebRequest` 直连也一起废掉**(出站永远发原文); 改为 `detectAsyncWebRequest() || !!ensurePanel()`, 与 `dispatchJob` 的判定保持一致。
    - 状态文案改为属实描述(原先显示"本地桥未运行/请先运行 StartDeadlock.bat"会误导): "翻译通道不可用:游戏已移除 HTTP 能力" / "翻译通道不可用,已按原文发送"。
  - `scripts/lingua_chat_simtest.js`
    - test15 重写为 `test15_asyncWebRequestRemovedNoChannel`: 断言"死通道下有限时间内失败并注入错误标签、且不做任何面板导航"。旧断言是**假通过** —— 错误标签也带 `LCTTranslation` class, 旧断言只看"有标签且不含 hello", 会把 `翻译失败: bridge_panel_unavailable` 当成翻译成功。
    - test17 重写为 `test17_panelChannelDisabledNoSpinning`: 断言无 about:blank 自愈、无面板导航、不运行时重建面板。
- **验证方式**
  - `node --check` 通过; `scripts/lingua_chat_simtest.js` **PASS 49 / FAIL 0**(断言数由 51 变为 49 是 test15/17 重写所致)。
  - 已重建 VPK(8 个资源全 `ok`)并部署 `addons\pak22_dir.vpk`(2026/10/1 19:51:58, 296014 字节); 桥 `GET /api/v1/health` = 200。
- **仍需用户测试**: 重启游戏确认三件事 —— ①进对局第一次发消息**立刻**发出(不再先卡 15s); ②状态栏文案为"游戏已移除 HTTP"而非"桥未运行"; ③`logs/bridge.log` 不再出现 `bridge self-heal` 刷屏。
- **未解决(已知限制)**: 游戏 → 桥方向本身没有任何可用通道, **翻译功能在本版游戏下不可用**; 唯一活着的通道是单向的"游戏 `console.log` → 桥"(matchId / 玩家身份识别仍在用)。后续可选项:外部悬浮窗 + 剪贴板助手、或悬浮窗 + 键盘代打字, 待用户决定后再做。

## 2026-10-01 第四十轮:游戏外翻译悬浮窗 + 剪贴板助手(HTTP 全废后的可行方案)

- **背景**: 承第三十九轮 —— 本版游戏移除了 Panorama 的全部 HTTP 能力(游戏内既发不出请求也读不回响应), 游戏内显示译文已不可能。用户选定方案:**游戏外置顶悬浮窗显示他人发言的中文译文;自己发消息走"输入中文 → 译成英文 → 自动复制到剪贴板 → 游戏内 Ctrl+V"**(不采用键盘代打字, 避免抢焦点)。
- **架构**: 复用唯一活着的通道(单向 `游戏 → console.log → 桥`), 反向用剪贴板人工接力。
  - 出向(看别人说什么): mod 落档 → `[LCT-CHAT]{json}` 写入 `console.log` → 桥增量 tail → 翻译 → 环形缓冲 → 浏览器悬浮窗轮询显示。
  - 入向(自己要发什么): 悬浮窗输入中文 → `POST /api/v1/overlay/translate` → 英文 → `navigator.clipboard` 写入剪贴板 → 用户回游戏 Ctrl+V。
- **改动文件**
  - `mod/panorama/scripts/lingua_chat.js`
    - 新增 `OVERLAY_CHAT_MARKER = "[LCT-CHAT]"` 与 `emitOverlayChat(entry)`: 用 `JSON.stringify` 保证单行(换行会被转义), 字段 `o`(是否自己)/`n`(昵称)/`c`(频道)/`h`(英雄)/`t`(原文, 截断 400 字符)。
    - 埋点选在 `pushEntry()`(聊天日志的唯一落档点)与 `flushPendingLogs()` 的超时兜底分支 —— 复用既有的去重与 sender 解析, 避免在扫描热路径上重复做一次去重, 同时天然规避"左下聊天行 + 顶栏气泡副本"的重复。
  - `core/overlay.js`(新增): 增量 tail 游戏 `console.log`(边界指纹检测日志重写, 与桥的 matchId 扫描同思路), 解析 `[LCT-CHAT]` 行 → 同文本 10 分钟内去重 → 翻译(限并发 4, 队列上限 80)→ 环形缓冲(300 条)。`start()` 首次接触时**从当前文件末尾开始**, 桥重启不会把历史聊天全刷出来。
  - `core/overlay_page.html`(新增): 悬浮窗页面。消息卡片(昵称/英雄/原文/译文, 自己与他人左侧色条区分)、底部输入框(Enter 翻译并复制, Shift+Enter 换行)、输出区自动复制 + 手动"复制"按钮、"置顶"按钮走 **Document Picture-in-Picture**(真正的 always-on-top 窗口; 关闭置顶时把节点搬回原窗口)。`http://127.0.0.1` 属 secure context, 故 `navigator.clipboard` 可用(带 `execCommand("copy")` 兜底)。
    - **剪贴板健壮性**(浏览器实测踩到): 置顶(PiP)后原窗口会被隐藏并失焦, 此时用 `window.navigator.clipboard` 会以 "Document is not focused" 被拒 —— 改为取"当前聚焦的那个窗口"的 clipboard(PiP 开启时用 PiP 窗口), 兜底 `execCommand` 也在该窗口的 document 里建临时 textarea。
    - 若浏览器策略仍然拦截自动复制(自动化测试环境下确实两条路径都被拦), 页面会把英文**自动选中**并提示"按 Ctrl+C 复制", 用户只需多按一次快捷键, 不会卡住流程。
  - `core/bridge_server.js`
    - 新增路由: `GET /overlay`(悬浮窗页面)、`GET /api/v1/overlay/messages?after=N`(轮询, 返回增量 + `latest` 游标 + provider)、`POST /api/v1/overlay/translate`(复用 `runTranslate`, 目标语言取 `ui.outgoingTarget` 默认 `en`, 因此同样享受词典/缓存/回退链)。
    - 新增 `checkOverlayGame()` / `startOverlayWatch()`: 检测到 `deadlock.exe` 启动时用 Edge/Chrome `--app` 拉起无地址栏小窗口(**独立 `--user-data-dir`, 否则已运行实例会把它合并成标签页**; profile 放 `os.tmpdir()`, 不污染项目)。该监视器独立于 `watchGame`(后者只管"游戏退出时关桥", 且用户配置里为 `false`), 由 `overlay.autoOpen` 控制; 支持 `--no-overlay` 启动参数。
  - `core/config.js` + `config/config.json` + `config/config.example.json`: 新增 `overlay: { enabled: true, autoOpen: true }`。
  - `scripts/package_release.ps1`: 发布包补上 `core/overlay.js` 与 `core/overlay_page.html`(原先逐文件复制, 不加会漏)。
- **验证方式**
  - `node --check` 全部通过(overlay.js / bridge_server.js / config.js / lingua_chat.js / 两个测试脚本)。
  - `scripts/overlay_test.js`(新增单测, 用临时日志文件跑整条链路)**PASS 9 / FAIL 0**: 只识别 `[LCT-CHAT]` 噪声行忽略、英文翻译/中文跳过、顶栏副本去重、增量不重复投递、日志被重写后从头 re-tail、`after` 游标语义。
  - `scripts/lingua_chat_simtest.js` 新增 test18(捕获 `console.log` 断言 `[LCT-CHAT]` 行与 payload 字段)**PASS 52 / FAIL 0**。
  - 端到端实测: 重启桥后向真实 `console.log` 追加一条 `[LCT-CHAT]` 行 → `GET /api/v1/overlay/messages` 返回 `{"sender":"Alice","text":"push mid now","translation":"现在推中路"}`, 随后把日志长度还原。
  - `GET /overlay` = 200(11897 字节); `POST /api/v1/overlay/translate` `"中路有人,小心gank"` → `"Someone's in the mid lane, watch out for a gank."`。
  - 已重建 VPK(8 个资源全 `ok`)并部署 `addons\pak22_dir.vpk`(2026/10/1 20:09:37, 297421 字节)。
  - 悬浮窗页面用浏览器实测: 页面正常渲染、状态点显示"桥在线 · openai"、消息卡片能显示 tail 到的聊天、输入中文点"翻译并复制"返回 `撤退,对面要开团了` → `Retreat, the enemy is about to start a team fight.`、控制台无报错、`/api/v1/overlay/messages` 轮询与 `/api/v1/overlay/translate` POST 均正常。
- **真机验证(2026/10/01 20:40)**: 游戏于 20:27 重启加载新 pak22 后, mod 侧 `[LCT] loaded v1.0.1; watching ChatMessages` 确认加载, 桥日志 `检测到 deadlock.exe,打开翻译悬浮窗` 确认自动开窗生效; mod 真实输出的 `[LCT-CHAT]` 行(用户本人发的 `hello`)被桥 tail 到并翻译为 `你好`, 证明 `游戏 → console.log → 桥 → 悬浮窗` 全链路可用。**注意 `--app` 小窗默认不置顶, 游戏全屏会完全盖住它, 必须先在窗口内点"置顶"才能始终可见。**
- **仍需用户测试**: ①别人发一句英文, 确认悬浮窗出现该条并显示中文译文; ②在悬浮窗输入中文点"翻译并复制"(或按 Enter), 回游戏按 Ctrl+V 确认粘贴出英文(**若浏览器拦截自动复制, 英文会被自动选中, 按 Ctrl+C 再回游戏粘贴**); ③点"置顶"确认窗口可保持在其他窗口之上(需 Chrome/Edge); ④确认进对局时窗口能自动弹出(不需要可把 `config.json` 的 `overlay.autoOpen` 改 `false`)。
- **已知限制**: 悬浮窗只能**显示**聊天与生成要发的译文, 无法自动把英文送进游戏输入框(需人工 Ctrl+V); 桥关闭期间新聊天不会补发(重新启动后从当前日志末尾开始)。

## 2026-10-01 第四十一轮:悬浮窗游戏友好化(缩小 + 平时淡出, 新消息才浮现)

- **背景**: 用户反馈第四十轮的悬浮窗"挡视野", 希望改成适合游戏环境的形态。经确认用户选择:**保留现有卡片排版但整体缩小**, 以及**平时几乎透明、收到新聊天才浮现**。
- **改动文件**
  - `core/overlay_page.html`
    - 尺寸与字号整体收缩: 基准字号 13→12px, 译文 14→12.5px, 原文/昵称 12→11px, 卡片内边距 7/9→5/7px、圆角 8→6px, 输入框高 58→40px, 按钮 5/9→3/7px。
    - 新增淡出机制: `body { opacity: .18; transition: opacity .35s ease }`, `body.awake, body:hover { opacity: 1 }`。`wake()` 全亮并在 `FADE_MS = 6000` 后自动淡回; 仅在 **`seq` 真正新增**时触发(`fresh` 标记), 避免轮询回看最近 40 条时反复唤醒导致永不淡出。
    - 页面加载即刻 `wake()`(避免重演"窗口太淡找不到"); 输入框 `focus` 与所有 `hint()` 反馈也会 `wake()`。
    - 置顶改为 `requestWindow({width:320,height:440})`; `setAwake` 同步把 `awake` class 镜像到 PiP body(PiP 时子节点被搬走, 原 body 的 class 不会作用于 PiP), `pagehide` 搬回后再 `wake()`。
  - `core/bridge_server.js`: `openOverlayWindow` 启动参数 `--window-size=420,680` → `330,450`, `--window-position=60,80` → `40,60`。
- **原因/效果**: 悬浮窗占地面积约减少 55%(420×680 → 330×450), 平时透明度 0.18 只剩轮廓基本不干扰视野, 有新聊天时全亮 6 秒提示, 鼠标移入或输入时保持全亮保证可读可操作。
- **验证方式**: `node --check core/bridge_server.js` 通过; 重启桥后 `GET /overlay` = 200(15000 字节, 已含 `setAwake` 与 `opacity: .18`); 用新尺寸重开窗口成功(标题 `DeadlockLingua 悬浮窗`)。自动化浏览器实测: 页面无 JS 报错、`heading/footer/list` 高度正常、消息卡片正常渲染; 因自动化环境鼠标始终停在页面上(`body:hover` 命中), 观测到的 opacity 恒为 1, 但 9 秒后 `body.className` 已回到空串, 证明 6 秒计时器与 class 清除按预期工作。
- **仍需用户测试**: 进对局后确认 —— ①平时窗口是否淡到几乎看不清轮廓; ②别人发言时窗口是否立刻全亮、6 秒后自动淡回; ③鼠标移到窗口上是否恢复清晰、能否正常输入与点按钮; ④330×450 下头部(DeadlockLingua / 状态 / 置顶)与底部输入区是否都没有被裁切。
- **已知限制**: 淡出只用 CSS `opacity`, 并非窗口真透明 —— 浏览器窗口客户区底色仍在, 视觉上是"一块很淡的深色区域"而非完全透明; 真要透明背景需改用 Electron/无边框透明窗口。淡出时窗口仍会接收鼠标点击(占据 330×450 的命中区域)。

## 2026-10-01 第四十二轮:悬浮窗改为原生 WPF 窗口(真透明 + 贴边自动收起)

- **背景**: 用户指出第四十一轮"还是黑的、不透明", 要求做成**像虚拟键盘那样真正透明**的悬浮窗, 并且**能自动贴到屏幕一边收起来(像 QQ 贴边隐藏)**。经确认: 浏览器 `--app` 窗口的客户区永远有不透明底板, CSS `opacity`/`background: transparent` 只能让**页面**变淡, 无法让**窗口**透明, 因此必须换成原生窗口。
- **技术选型**: 用 **WPF**(`powershell.exe` 5.1 自带)而不是 Electron —— WPF 原生支持 `AllowsTransparency="True"` + `Background="Transparent"` + `Topmost="True"`, 零新增依赖、无需下载上百 MB 运行时, 与本项目的便携定位一致。实测本机 `powershell.exe` 为 **SYSTEM_AWARE**(150% 缩放), 文字按 144 DPI 原生渲染, 不糊。
- **改动文件**
  - `scripts/overlay_window.ps1`(新增, ~460 行): 原生悬浮窗。
    - 窗口: `WindowStyle=None` + `AllowsTransparency=True` + `Background=Transparent` + `Topmost=True` + `ShowInTaskbar=False`, 圆角半透明面板 `#D20D0F14` + 描边 `#55E0A34A` + 投影。**文件必须存为 UTF-8 with BOM**, 否则 PowerShell 5.1 按 ANSI 读取会把中文字符串读成乱码。
    - 数据: `System.Net.WebClient`(强制 `Encoding=UTF8`)轮询 `/api/v1/overlay/messages?after=`, `ConvertTo-Json -Compress` 把中文转义成 `\uXXXX` 后 POST `/api/v1/overlay/translate`, 彻底绕开 PowerShell 的编码坑。
    - 剪贴板: `[System.Windows.Clipboard]::SetText()`(原生进程, 不受浏览器剪贴板策略限制, 第四十一轮那个"自动复制被拦截"的问题在这一版消失)。
    - 贴边收起: 停靠主屏 `SystemParameters.WorkArea` 右边缘, 收起时 `Left = Right - TabWidth`(默认 8 DIP ≈ 12 物理像素), 展开 `Left = Right - Width`; `DispatcherTimer` 做 10 步 ease-out 位移补间。`Root.MouseEnter` 展开, `MouseLeave`/窗口失焦收起, 收到新聊天 `Wake-Window()` 自动滑出并在 6s 后收回。启动后有 8s 宽限期(`StartupGraceMs`), 否则 `Deactivated` 会在开窗瞬间就把它收走。
    - 互斥: 具名 Mutex `Local\DeadlockLinguaOverlay` 保证只有一个实例。
  - `core/bridge_server.js`: 新增 `openOverlayNative()`(拉起 `scripts\overlay_window.ps1`, `-WindowStyle Hidden` 不弹控制台) 与 `killOverlayNative()`(先杀掉旧窗口, 避免桥重启后堆叠多个); `openOverlayWindow()` 改为按 `overlay.mode` 分派, `native` 为默认, `web` 走原来的 Edge/Chrome 小窗。`killOverlayNative` 的过滤字符串用 `'*overlay_window' + '.ps1*'` 拼接, 否则这条 `-Command` 自身的 CommandLine 会命中条件把自己杀掉。
  - `core/config.js` / `config/config.example.json`: `overlay` 段新增 `mode: "native"`(可选 `"web"`)。
  - `scripts/package_release.ps1`: 打包时复制 `scripts\overlay_window.ps1`(缺了它会静默退回不透明的浏览器小窗)。
- **原因/效果**: 面板底色 `#D20D0F14`(约 82% 不透明) 可直接看到游戏画面, 不再是浏览器那种实心黑底; 平时自动收成屏幕右边缘一条 12px 细条, 鼠标扫过即展开, 移开或切回游戏自动收回, 基本不占视野。
- **验证方式**: `Parser::ParseFile` 语法检查通过、`node --check core/bridge_server.js` 通过; 进程退出码与 stderr 均为空; 用 `SetThreadDpiAwarenessContext(PER_MONITOR_AWARE_V2)` 实测窗口物理矩形 —— 收起时 `L=2548 R=3043`(屏宽 2560, 可见 12px), `SetCursorPos(2554,400)` 悬停后 `L=2065 R=2560`(完全展开且右边正好贴屏), 光标移开 2s 后回到 `L=2548`; 注入 `[LCT-CHAT]` 行后桥侧返回 `OverlayTest / they are pushing mid, fall back → 他们在推中路，撤退`; WebClient POST 中文实测 `中路有人，小心gank → There's someone in the mid lane, be careful of a gank.`。
- **仍需用户测试**: ①进游戏后确认窗口是否**真的能透出游戏画面**(不再是黑块); ②确认平时收成右边缘细条、鼠标扫过去能展开、移开能收回; ③点"固定"后是否保持常开、再点"自动收起"是否恢复贴边; ④输入中文按 Enter 后回游戏 Ctrl+V 能否粘出英文。
- **已知限制**: 仍**无法自动把英文打进游戏输入框**(游戏侧不接收任何网络数据), 最后一步必须人工 Ctrl+V; 窗口按主屏 `WorkArea` 停靠, 多显示器下只认主屏; 收起后细条仍占据屏幕最右侧 12px 的鼠标命中区域, 若游戏在该处有可点元素可能被轻微遮挡。

## 2026-10-01 第四十三轮:悬浮窗设置面板 + 四边吸附拖动 + 弹幕模式

- **背景**: 用户提出四点需求 —— ①加设置项(透明度等)并预留自定义背景; ②不要固定收到右边, 应支持拖动、拖到哪条边就在哪条边收起; ③把游戏内 `/tr` 的设置内容搬过来; ④增加"直播弹幕"式显示(只有文字、没有窗口边框)。用户要求先调研现有直播弹幕辅助工具的显示方式。
- **调研结论(实测来源见 docs 提交说明)**: ①**滚动**弹幕需要"轨道分配 + 宽度/速度差碰撞预测", 而移动中的文字显著更难读(ACM danmaku 研究); ②**堆叠 + 淡入淡出**实现最简单、可读性最好, 是字幕/聊天浮层的通行做法, 最适合"翻译"这种需要静下来读的场景; ③直播弹幕普遍用**白字 + 黑描边**而不是背景色块 —— 描边在任意背景上都保得住对比度(接近 21:1, 超过 WCAG AAA), 且几乎不占视觉面积; ④WPF 里描边要用 `FormattedText.BuildGeometry()` + `Path.Stroke`, 不能用 `DropShadowEffect`(官方明确说会关闭 ClearType 导致字糊)。**据此选定: 堆叠淡入淡出 + 黑描边白字**。
- **改动文件**
  - `scripts/overlay_window.ps1`(由 ~460 行重写为 ~1090 行)
    - **设置面板**: 新增"设置"按钮, 聊天页/设置页在同一个窗口内切换。设置行**由 spec 数组生成**(而不是手写 XAML), 控件类型 bool/enum/int/text/secret/color/file/range 各一个分支, 后续加选项只需加一行 spec。覆盖原 `/tr` 的全部可用项(启用翻译、服务商、API Key、Azure 区域、OpenAI Base/模型、目标语言、显示模式、发送模式、发送目标语言、超时、强制翻译、聊天日志), 另加悬浮窗专属项(显示形态、不透明度、背景色、背景图、圆角、主题色、面板字号、自动收起、弹出时长、贴哪条边)与弹幕项(字号、文字色、描边色、描边粗细、停留时长、同屏条数、位置、离边距离)。API Key 沿用"`********` 表示不改"的打码回传, 并额外提供"清除"按钮(置空 + `clearApiKey:true`)。
    - **透明度只作用于背景**: 把 `opacity` 与 `background` 合成 ARGB 画刷(`New-PanelBrush`), 而不是设 `Window.Opacity` —— 后者会把文字一起变淡导致读不清。
    - **拖动 + 四边吸附**: 标题栏 `DragMove()`, 松手后 `Snap-ToNearestEdge` 按窗口中心到四条边的距离选最近边, 贴边并 `POST /api/v1/config` 记住 `edge`。`Get-EdgeTarget` 支持 left/right/top/bottom 四个方向的展开/收起(收起时只露 8 DIP ≈ 12px 细条)。拖动期间暂停补间动画, 否则窗口会从光标下溜走。
    - **弹幕模式**: 独立的第二个 WPF 窗口, 全宽横幅(`WorkArea` 宽 × 按同屏条数算出的高), `Focusable=False` + `IsHitTestVisible=False`, 并在 `SourceInitialized` 里打上 `WS_EX_TRANSPARENT | WS_EX_LAYERED` 让它**完全鼠标穿透**(否则会挡住游戏点击)。每条消息用 `FormattedText.BuildGeometry()` 生成 `Path`, `Fill` = 文字色、`Stroke` + `StrokeThickness` = 描边。用 40ms 的 `DispatcherTimer` 做 250ms 淡入 → 停留 `lifeMs` → 420ms 淡出, 超出 `maxVisible` 时立刻淘汰最旧一条。
      - 切换方式(按用户选择): 设置里的"显示形态"切换。**不会被关死** —— 切到弹幕模式时面板窗仍然收在屏幕边缘, 鼠标扫过那条细条就能把面板召回来改设置。
    - 其余: 配置读取改为正确解包 `GET /api/v1/config` 的 `{ok, config:{...}}`, 保存改为正确的 `POST {config:{...}}`(平铺 body 会被桥静默忽略)。
  - `core/config.js`: `DEFAULTS.overlay` 扩展为完整悬浮窗配置(含嵌套 `danmaku`); `mask()` 把 `overlay` 原样回传(无敏感信息); `applyMaskedUpdate()` 新增 `overlay` 分支 —— **白名单字段 + 数值夹紧**(opacity 0.2–1、fontSize 8–40、lifeMs 1000–60000、maxVisible 1–20 等), 避免脏值写坏配置。
  - `config/config.example.json`: 同步完整 overlay 段。
- **原因/效果**: 悬浮窗从"只能改代码里的写死值"变成可视化配置; 面板可以拖到屏幕任意一边并自动吸附收起(用户可把常用边设成顶部, 像 QQ 那样); 新增的弹幕模式只有描边文字、没有窗口底板、鼠标完全穿透, 适合全屏游戏时看不挡视野的翻译字幕。
- **验证方式**:
  - `Parser::ParseFile` 语法检查通过; `node --check core/config.js` 通过; 真实启动后 stderr 为空。
  - 配置往返: `POST {config:{overlay:{edge:"bottom",opacity:0.6,danmaku:{fontSize:30,lifeMs:7000}}}}` → `GET` 回读 `edge=bottom opacity=0.6 dmFont=30 dmLife=7000`, 说明嵌套字段与夹紧生效; 随后已改回 `edge=right opacity=0.85 dmFont=26 dmLife=6000`。
  - 设置面板: 用临时副本把结尾的 `ShowDialog()` 换成直接调用 `Load-Config/Apply-Config/Build-SettingsUi/Read-SettingsPayload`, 结果 `rows=34`、`uiKeys=displayMode,enabled,force,outgoing,outgoingTarget,targetLanguage`、`ovKeys`12 项齐全、`dmKeys`8 项齐全、stderr 为空 —— 即面板能构建、提交负载结构正确。
  - 窗口几何(物理像素, 屏 2560×1600, 任务栏占下方 72px):
    - 弹幕层 `rect=0,0,2560,446 transparent=True`(全宽横幅 + 鼠标穿透已生效);
    - 面板 `edge=right` 收起 `L=2548`(可见 12px) → `SetCursorPos(2554,400)` 悬停 `L=2065`(可见 495px) → 移开 2s 回到 `L=2548`;
    - 面板 `edge=bottom` 收起 `T=1516 B=2191` —— 可见 12px 正好落在 `WorkArea.Bottom`(1528)之上、任务栏之上, 四边分支正确。
  - 翻译链路: 注入 `[LCT-CHAT]{"n":"DanmakuTest","t":"enemy team is grouping at mid, back off"}` → `敌方在集合中路，撤退`。
- **仍需用户测试**: ①点"设置"看面板是否正常滚动、改"不透明度/背景色"再点保存是否立刻生效; ②拖动标题栏到屏幕左侧/顶部松手, 确认是否吸附到该边并在该边收起; ③把"显示形态"改成"弹幕模式", 确认屏幕上只剩描边文字、没有窗口底板、鼠标能穿透点到游戏; ④切到弹幕模式后, 把鼠标扫到屏幕边缘那条细条上, 确认能把面板召回来改回"面板窗口"。
- **已知限制**: ①"背景图片"只支持本地图片路径(不打包、不联网), 属于预留能力; ②`/tr` 里**纯游戏内生效**的项(如游戏内显示模式、游戏内发送模式)由于本版游戏移除了 HTTP,**在游戏里已失效**, 现在这些项只影响桥与悬浮窗 —— 设置页底部已写明这一点; ③弹幕层是全宽窗口, 即使不显示文字时也占着顶部一段区域的鼠标命中区(但已设为完全穿透, 不影响点击); ④仍无法自动把英文打进游戏输入框。

## 2026-10-01 第四十四轮:可手动打开悬浮窗(不必启动游戏)

- **背景**: 用户问"我要怎么打开它呢,在不开游戏的情况下"。原实现只有桥检测到 `deadlock.exe` 才会拉起悬浮窗(`checkOverlayGame`), 不开游戏就没有任何入口。
- **改动文件**
  - `ShowOverlay.bat`(新增): 双击即用, `start "" powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0scripts\overlay_window.ps1"` —— `-WindowStyle Hidden` 让 powershell 的控制台不弹出来, `start` 让 bat 立刻退出不留黑窗。与项目既有的 `StartDeadlock.bat` / `RestartBridge.bat` 风格一致。
  - `scripts/package_release.ps1`: 打包时带上 `ShowOverlay.bat`。
  - `AGENTS.md`: 第 2 节补上手动打开方式与互斥锁说明。
- **原因/效果**: 不必开游戏也能随时调出悬浮窗改设置、试排版。窗口已有互斥锁保护, 重复启动只会静默退出, 不会开出第二个。桥没开时窗口仍能显示(状态点变红显示"桥离线"), 只是收不到聊天、也翻译不了。
- **验证方式**: 确认 `deadlock.exe` **未运行**的情况下执行 `ShowOverlay.bat` → 进程出现(pid 26304)、`EnumWindows` 实测窗口 `visible rect=2548,135 size=495x675`(已按 `edge=right` 自动收成 12px 细条)。
- **仍需用户测试**: 双击 `ShowOverlay.bat` 看窗口是否出现在屏幕右边缘(鼠标扫过去展开)。
- **已知限制**: 手动开的窗口在游戏启动后会被桥的 `killOverlayNative()` 关掉再重新拉起(会有一次闪烁), 这是为了避免堆叠出两个窗口。

## 2026-10-01 第四十五轮:去掉聊天行上"翻译失败: bridge_panel_unavailable"刷屏

- **背景**: 用户截图反馈: 游戏内聊天栏每条消息下面都挂着一行红色的 `翻译失败: bridge_panel_unavailable`。
- **原因**: 本版游戏移除了 Panorama 的全部 HTTP 能力, mod 在游戏内做的翻译**永远不可能成功**。所有聊天翻译任务都会走到 `dispatchJob` 的 `!panel && !canHttp` 分支, 直接以 `bridge_panel_unavailable` 失败; `failJob` 原本在重试耗尽后调 `injectError` 往该行插一个红色错误标签 —— 于是**每一行聊天**都会挂一个消不掉的报错。而译文其实已经在游戏外的悬浮窗里正常显示了。
- **改动文件**
  - `mod/panorama/scripts/lingua_chat.js`
    - 新增 `CHANNEL_GONE_ERRORS`(`bridge_panel_unavailable` / `bridge_offline` / `bridge_load_failed` / `no_asyncwebrequest` / `panel_reset` / `superseded`)与 `isChannelGone()`。
    - `failJob()` 开头加一条: `job.kind === "chat" && isChannelGone(error)` 时**直接 `finishJob()` 返回** —— 不重试、不注入错误标签, 且**保留 `State.seen` 去重**(不删 sig), 避免同一行被反复重扫。
    - 注意这里**只压掉"通道不存在"这一类**; 真正的翻译失败(如服务商 502、限流、面板存活但超时)仍会照常显示错误标签, 不会被误吞。
    - 通道问题仍然会通过 `warnBridgeOffline()` 在状态栏**一次性**提示("本版游戏已移除 HTTP 能力…")。
  - `scripts/lingua_chat_simtest.js`: test15 断言反转 —— 原来断言"必须注入错误标签", 现在断言"**不得**注入错误标签"; 同时不能再用"等标签出现"作为完成信号, 改为等待固定时间后检查行上始终干净。
- **原因/效果**: 游戏内聊天不再被一行行红色 `翻译失败: bridge_panel_unavailable` 刷屏; 译文照常由悬浮窗展示。
- **验证方式**: `node --check` 通过; `scripts/lingua_chat_simtest.js` **PASS 52 / FAIL 0**(含改后的 test15: `dead channel settles quickly` / `no error label injected on a permanently dead channel` / `no panel navigation attempted` 全 PASS); 已重建 VPK(8 个资源全 `ok`)。
- **仍需用户测试**: 重启 Deadlock 后确认聊天行下面**不再**出现红色 `翻译失败: bridge_panel_unavailable`; 同时悬浮窗里仍能看到该条消息的中文译文。
- **已知限制**: 游戏内不再有任何翻译提示是**刻意**的 —— 本版游戏下游戏内翻译已不可用, 唯一显示途径是游戏外悬浮窗。

## 2026-10-01 第四十六轮:入站通道探针 —— 定论「游戏内确实收不到任何外部数据」

- **背景**: 用户提出一个很关键的观察: 既然 mod 还能往聊天行上插"翻译失败: bridge_panel_unavailable"这种文字, 说明**游戏内渲染能力一直在**, 那为什么不能用同一套代码显示译文? 顺着这个思路复核: 渲染确实是现成的(同一个 `Label.text` 赋值), 卡住的只有"译文怎么送进游戏"这一半。此前"HTML 面板没有 CEF 实例"的结论是用 `data:` URL 间接测出来的, 不够硬, 于是加一次性探针做定性。
- **探针设计**(`lingua_chat.js` 的 `probeInboundChannels()`, 启动 4s 后跑一次)
  - 打印 `$.` 的完整成员列表(唯一可能的入站原语都在这里)。
  - `BImageFileExists` 三种路径形式各查"存在的文件 / 不存在的文件" —— 它是唯一一个"能查询游戏之外状态"的原语, 若能看到 addons 下的松散文件, 理论上可当 1bit 入站信道。
  - 动态建一个 `<HTML>` 面板并按已知要求设成"真会被渲染"的形态(`2x2px` + `opacity:0.01` + `position:0px 0px 0px`), 依次 `SetURL` 到 **`http://127.0.0.1:8791/bridge?op=probe`** → `data:` → `file://`, 每段等 2s 读 `panel.title`。
  - 关键判据: **只要 CEF 还活着, 桥端 `logs/bridge.log` 必然出现 `[panel] /bridge load op=probe`** —— 这是无法伪造的证据。
  - 配套在游戏 addons 目录放了 `lctprobe.html`(标题 `LCTPROBE_FILE_JS`)与 `lctprobe_yes.png`。
- **探针结果(游戏 21:36 启动, 新 VPK 已生效)**
  - `player $ keys(29)=Msg,AssertHelper,Warning,DispatchEvent,...,BImageFileExists,MousePosition,CreatePanelWithCurrentContext` —— 与本轮之前记录的一致, **29 个成员里没有任何"读文件 / 读剪贴板 / 执行控制台命令 / 收网络"的原语**。
  - `BImageFileExists yes=false no=false`, 三种形式(`lctprobe_yes.png` / `citadel/addons/...` / `file://{game}/...`)**全是 false** —— 连**实际存在**的那个文件也查不到。即游戏资源系统**看不见 addons 目录里的松散文件**, 1bit 信道方案同时出局。
  - 面板三段 `title` **全为空**: `http title=[]` / `data title=[]` / `file title=[]`。
  - 桥端 `logs/bridge.log` **零条 `/bridge load`** —— 游戏从未向桥发出过任何一个请求。
- **改动文件**: `mod/panorama/scripts/lingua_chat.js`(新增 `probeInboundChannels()` 与 boot 中的一次性调度, 保留作为"未来引擎若恢复 CEF 就能立刻发现"的 canary); 游戏 addons 目录临时放入 `lctprobe.html` / `lctprobe_yes.png`(探针用, 不在 VPK 内)。
- **结论(定论)**: 本版 Deadlock 下, **游戏内不存在任何可用的入站通道** —— 网络(AsyncWebRequest + HTML 面板 + CEF)、引擎命名空间、文件可见性, 三条路全部被硬证据封死。因此**"在游戏内显示译文"在架构上不可能**, 与渲染代码无关(渲染一直是好的)。游戏内翻译功能就此终止, 译文只由游戏外悬浮窗展示。
- **验证方式**: 已重建 VPK(8 个资源全 `ok`)并部署 `addons\pak22_dir.vpk`(2026/10/1 21:35:21, 302526 字节); 游戏 21:36 启动后探针输出如上, `deadlock.exe` 正常运行、聊天采集(`rowdiag`)正常。
- **仍需用户测试**: 无(这是诊断, 不改功能)。顺带确认了第四十五轮的修复: 游戏内聊天行不再出现红色 `翻译失败: bridge_panel_unavailable`。
- **已知限制**: 探针会随每次启动跑一次(约 6 秒、几条 diag 日志、建一个 2x2 隐藏面板后删除), 属刻意保留的 canary; 若要彻底去掉, 删除 `probeInboundChannels()` 及其 boot 调度即可。addons 目录里的 `lctprobe.html` / `lctprobe_yes.png` 可随手删掉(删掉后 `BImageFileExists` 那段的结果就只剩"两个都是 false", 但仍能反映文件不可见这一点)。

## 2026-10-01 第四十七轮:安装设计 skill + 弹幕层重做为「角落聊天浮层」(可拖拽定位)

- **背景**: 用户给出参考截图(直播聊天浮层:角落一列半透明圆角胶囊, 带昵称+正文), 要求字幕效果改成这种而不是"生硬的全宽居中描边字", 并且**要能直接拖动定位**(不想再靠填像素)。同时要求先安装几个设计 skill。确认结果: 胶囊内容=**昵称+原文+译文**; 旧的"全宽描边文字"模式**直接替掉**; 重设计范围=字幕浮层 + 悬浮窗面板 + 设置面板。
- **设计 skill 安装**: 装在 `<workspace>/.trae/skills/`(skill-creator 规定的路径), 并把 `.trae/` 加入 `.gitignore`(约 5MB, 属本机工具)。
  - `impeccable`(pbakaus/impeccable, 取它自带的 `.trae-cn/skills/impeccable`, 含 `reference/native.md` 等原生端参考)
  - `ui-ux-pro-max`(nextlevelbuilder/ui-ux-pro-max-skill, 明确覆盖 web/mobile/**desktop**)
  - `frontend-design`(anthropics/skills, 美学方向与排版)
  - `redesign-existing-projects`(Leonxlnx/taste-skill 的 `redesign-skill`)
  - **未装** `taste-skill` 本体: 它自我介绍明确排除 "dashboards / data tables / multi-step product UI", 而本项目界面正属此类。
  - 加载 `frontend-design` 后按它的清单自查, 发现旧悬浮窗正好命中它点名的两条"AI 模板感"特征(近黑底+单一强调色; 内容全切成同样的圆角卡片+同样的柔和阴影), 这是本轮重做的依据。
- **改动文件**
  - `scripts/overlay_window.ps1`
    - **`danmaku` → `subtitle`**: 全宽横幅的 `FormattedText` 描边字整体替换为**角落堆叠的聊天胶囊**。每条胶囊 = 发言者色块(圆形字母牌) + 昵称 + 原文 + 译文; 译文是唯一满对比度的元素, 原文与昵称降一级。
    - **发言者身份**: 回退用**首字母色牌**代替头像(Panorama 从未暴露头像)。昵称经哈希固定映射到 8 色调色板中的一色 —— 同一玩家永远同色, 换屏不串色; 用**精选调色板**而不是哈希生成连续色相, 避免出现脏色。
    - **可拖拽定位**: 位置存成相对工作区的比例 `xRatio/yRatio`(换分辨率不跑偏)。因为穿透窗口**收不到鼠标事件**, 所以设置页加了「调整字幕位置(拖动)」按钮 —— 点击后进入编辑模式(临时关掉 `WS_EX_TRANSPARENT`、显示虚线框与提示), 拖完点「完成放置」退出并落盘。
    - **后到的译文原地补**: 轮询会回看最近 40 条, 所以 `Add-Subtitle` 按 `seq` 复用节点(原地改文本), 并用 `SubSeen` 记录"已出现过"的 seq —— 否则每条过期消失的胶囊都会被下一轮轮询复活。
    - 弹幕模式的 `view` 值由 `"danmaku"` 改为 `"subtitle"`; 面板窗外仍收成边缘细条, 保证切到字幕形态后还能回来改设置。
    - **排障改进**: 轮询的 `catch` 原来把异常静默吞掉(只让状态变红), 现改为同时把异常写进 `%TEMP%\lct-overlay-error.log` —— 本轮就是靠它排除了"代码在抛异常"这个可能。
  - `core/config.js`: `DEFAULTS.overlay.danmaku` → `subtitle`(14 个字段: 位置比例/宽度/三级字号/底色与不透明度/圆角/间距/停留/同屏条数/显示昵称/显示原文); `mask()` 同步; `applyMaskedUpdate()` 的 `view` 白名单加入 `subtitle` 并把旧值 `danmaku` 迁移过去, 子对象按字段白名单 + 数值夹紧写入。
  - `config/config.example.json`: 同步为 `subtitle` 段。
- **原因/效果**: 字幕从"横贯屏幕的居中描边字"变成"角落里一列聊天胶囊", 贴合用户给的参考图; 位置直接拖着放, 不再需要试像素值; 每条能看出"谁说的 / 原文 / 译文"。
- **验证方式**:
  - `Parser::ParseFile` 通过(1269 行)、`node --check core/config.js` 通过、配置回读 `view=subtitle` 且 14 个 subtitle 字段齐全。
  - 用临时副本把结尾的 `ShowDialog()` 换成直接调用 `Load-Config/Apply-Config/Add-Subtitle`, 结果 `dmVisible=True`、`Add-Subtitle ok`、`dmList children=1` —— 说明建胶囊、入列、计数都正常。
  - **像素级实测**: 把胶囊底色临时改成不透明洋红(`#FF00FF` + `bgOpacity=1`)后注入聊天, `CopyFromScreen` 抓字幕窗区域并统计洋红像素 = **213,338 个**(窗口 570×459, 6 条胶囊几乎铺满), 证明胶囊真的渲染到屏幕上了; 随后已还原为 `#0A0C11` / 0.55。
  - 窗口几何: 字幕窗 `x=51 y=458 w=570 h=459`, 与 `xRatio=0.02 yRatio=0.30` 换算一致; `WS_EX_TRANSPARENT = true`(鼠标穿透生效)。
  - 排障记录: 第一次像素差分测试得出 91% 像素变化属**假阳性**(游戏画面本身在动); 第二次测出 0 像素是**测试时机错误**(等太久, 胶囊 9 秒寿命已过)。两者都不是代码问题。
- **仍需用户测试**: ①进游戏看字幕是否以"角落胶囊"形式出现在屏幕左上方; ②设置 → 「调整字幕位置」→ 拖动 → 「完成放置」, 确认能拖到任意位置并在重启后保留; ③调「胶囊不透明度 / 字号 / 同屏条数」看效果; ④确认字幕不挡点击(鼠标穿透)。
- **已知限制**: ①头像用首字母色牌代替(拿不到真实头像); ②胶囊宽度是固定值, 超长文本会换行撑高。

## 2026-10-01 第四十八轮:悬浮窗/设置面板视觉重排(设计令牌 + 统一排版语言)

- **背景**: 用户要求重排悬浮窗面板与设置面板的视觉, 并补充字幕设置(留存时间等)。按 `frontend-design` 的自查清单, 旧 UI 正好命中它点名的两条"AI 模板感"特征 —— ①近黑底 + 单一琥珀强调色; ②内容全切成同样的圆角卡片、同样的柔和阴影。
- **设计方向(取自游戏自身世界观)**: Deadlock 是 1930 年代奥术黑色电影风的纽约 —— 氧化黄铜、铜上的铜绿、湿石上的灯光。据此定色而不是走"近黑+一个亮色"的默认:
  - `Surface #131920`(冷调石油黑, 不是纯黑) / `Ink #E9E3D5`(暖羊皮纸白, 与冷底色形成冷暖张力)
  - 颜色**按功能分配**, 不做装饰: `Brass #C9A44E`=唯一强调(动作), `Patina #5FA08B`=别人, `Own #7EA9CC`=自己, `Danger #CB6A5F`=错误
- **排版**: 拉丁字母用 **Bahnschrift SemiCondensed**(Windows 自带、DIN 邻系, 贴合时代感), 中文回落 Microsoft YaHei UI。副作用是**有意义的**: 外文原文用工业压缩体、中文译文用人文无衬线, 两者在视觉上永不混淆。已实测字体在本机全部字重可用。
- **改动文件**
  - `scripts/overlay_window.ps1`(1398 行)
    - 新增 `$script:T` 设计令牌表 + `$script:F` 字体链, 两个窗口的 XAML 改为**插值 here-string**(`@"..."@`), 配色全部走令牌, 不再散落硬编码 hex。
    - **去掉"卡片套件"**: 按钮从 4 个填充方块改为**幽灵按钮**(透明底、悬停才浮起), 唯一的填充元素是"翻译并复制"—— 把胆量花在一个地方; 消息列表**取消每条的卡片背景与左边色条**, 改为**发丝线分隔 + 色牌 + 层级化文字**; 全窗只保留**一个**窗口级投影(功能性: 保证在杂乱游戏画面上可读), 不再每条一个。
    - **列表与字幕统一**: 面板消息列表改用与字幕浮层同一套"色牌 + 昵称 + 原文 + 译文"语言, 两个窗口看起来是同一个产品。
    - **设置面板**: 分组标题改为"黄铜小标 + 延伸到边缘的发丝线"(线是结构不是装饰, 用来在清一色相同行里划出分界); 控件列固定 150px 右对齐, 行距统一。
    - **新增字幕设置**: `fadeMs`(淡入/淡出时长, 原来写死 220/500)、`textColor` / `nameColor` / `origColor`(三级文字颜色), 连同已有的 `lifeMs`(留存时间)一起按"行为 → 排版 → 颜色"重新分组。
  - `core/config.js`: `DEFAULTS.overlay.subtitle` 增补 4 个字段; `applyMaskedUpdate` 加对应白名单与夹紧; **`DEFAULTS.overlay.background` / `accent` 同步为新令牌色 `#131920` / `#C9A44E`** —— `Apply-Config` 会用这两项覆写 XAML 令牌, 不同步的话新配色会被旧色盖掉(这是本轮踩到的坑)。
  - `config/config.json`、`config/config.example.json`: 同步新色值与新字段; 顺手删掉 `config.json` 里残留的旧 `danmaku` 段。
- **验证方式**: `Parser::ParseFile` 通过(1398 行)、`node --check core/config.js` 通过; 临时副本实测 `$T.Brass=#C9A44E`、`$T.Surface=#131920`、`Window.FontFamily=Bahnschrift SemiCondensed, Microsoft YaHei UI`、`Root.Background=#FF131920`、发送按钮前景 `#FF161A16`(黄铜底深字), XAML 解析无异常; 走完 `Load-Config → Apply-Config` 后 `Root.Background=#D9131920` / `Root.BorderBrush=#FFC9A44E`, 字幕 18 个字段齐全(含 `fadeMs=260` 与三个颜色); 真实启动 stderr 为空、运行时错误日志为空、桥 200; 两个窗口几何正常(字幕 570×459 穿透, 面板 510×705 可交互)。
- **仍需用户测试**: ①打开面板看整体观感(冷调深青绿底 + 黄铜 + 羊皮纸白字)是否比原来舒服; ②英文原文是否呈现为压缩工业体、中文译文为常规体; ③设置里调"留存时间 / 淡入淡出时长 / 三种颜色"看是否即时生效; ④「调整字幕位置」拖动是否正常。
- **已知限制**: ①`impeccable` skill 需要联网下载引擎(`github.com/pbakaus/impeccable/releases/...`), 本机下载失败, 已按该 skill 自身规定回退为"直接读现有上下文", 因此未产出 PRODUCT.md / DESIGN.md; ②令牌里 `Patina`/`Own` 目前只用于消息色牌与昵称, 面板其它部位仍是单强调色主导。

## 2026-10-01 第四十九轮:设置面板控件去白底(统一到深色模板) + 字幕拖拽链路复核

- **背景**: 用户反馈"设置里面的白色底的输入框很丑", 并要求确认字幕窗口的拖拽功能。
- **根因(两处, 都不是我以为的那样)**
  1. **WPF 原生模板的浅色控件**: `TextBox` / `CheckBox` / `ComboBox` / `Slider` 用的是系统默认模板 —— **无论窗口底色多深, 勾选框都是白方块、下拉框与输入井都是浅色**。设置页里 7 个下拉 + 6 个勾选框, 这才是"像从别的软件粘进来"的观感来源。
  2. **逐行样式盖掉全局样式**: `Build-SettingsUi` 里每个 TextBox 各自写了 `Background/Foreground/BorderBrush/Padding`, 用的还是**旧色**(`#9910151B` / `#E8ECF3`)。实测确证: 即使加了全局 `TextBox` 样式, 取值仍是 `bg=#9910151B fg=#FFE8ECF3`。只加全局样式而不删逐行覆盖是无效的。
- **改动文件**: `scripts/overlay_window.ps1`
  - `Window.Resources` 新增 5 个全局控件模板, 全部走设计令牌:
    - `TextBox` —— Surface2 底 / Ink 字 / Line2 描边 / **黄铜光标** / 圆角 4; 模板保留 `PART_ContentHost` 以维持多行滚动。
    - `CheckBox` —— 15×15 圆角方块, 未选中为 Surface2 底 + Line2 描边, **选中时画黄铜勾(Path)并把描边转黄铜**; 悬停也转黄铜。
    - `ComboBox` + `ComboBoxItem` —— 自绘 `ToggleButton`(Surface2 底 + Ink3 箭头) + `Popup`(Surface2 底、圆角、`MinWidth` 绑定 `ActualWidth`), 列表项高亮用 Line。
    - `Slider` —— 前景黄铜 / 背景 Line2。
  - 删除 `Build-SettingsUi` 里 `int` / `text` / `secret` / `color` / `file` 五种控件各自的 4 行颜色覆盖(共 5 处), 交回全局模板统一管辖。
- **字幕拖拽复核**: 拖拽功能在第四十七轮已实现(设置页「调整字幕位置(拖动)」→ 编辑模式摘掉 `WS_EX_TRANSPARENT` → 拖完「完成放置」)。本轮做了链路复核: `Set-SubtitleEditMode $true` 后 `editFrame=Visible`、提示文案正确; 把窗口移到 (300,200) 再 `Save-SubtitlePosition`, 落盘得 `xRatio=0.176 yRatio=0.196`, 与工作区 1706.67×1018.67 换算**完全一致**; 退出编辑后 `editFrame=Collapsed`。测试后已把位置还原为 `0.02 / 0.30`。
- **验证方式**: `Parser::ParseFile` 通过(1514 行); 临时副本实例化设置页控件并 `ApplyTemplate()` 实测 —— `TextBox bg=#FF1B222B fg=#FFE9E3D5`(全局令牌生效)、`CheckBox Tick=Visible Box背景=#FF1B222B`(不再是白块)、`ComboBox PART_Popup found=True`(自绘模板能正确解析出下拉弹层, 不会把下拉点坏)、`items=5 selIndex=2`; 真实启动 stderr 为空、运行时错误日志为空、桥 200。
- **用户实测确认(2026-10-01)**: ①**下拉框能正常展开** —— 自绘 `ComboBox` 模板的唯一残余风险点排除; ②**字幕拖拽在真实环境生效** —— 用户拖动后 `config.json` 落盘为 `subtitle.xRatio=0, yRatio=0.02`, 即拖到屏幕左上角并成功持久化, 编辑模式 → 拖动 → 完成放置 → 写配置整条链路验证通过。
- **已知限制**: 无(自绘 ComboBox 模板已确认真实可展开; 若未来 WPF 版本改动导致点不开, 回退方式是把 `ComboBox` 的 `Template` setter 整段删掉, 仅保留 `ComboBoxItem` 样式也能消掉最扎眼的白名单)。

### 附带发现:用户的 `timeoutMs` 被改成了 1500

- 排查上述确认时读到 `config/config.json` 顶层 `timeoutMs: 1500`(原为 15000)。1500ms 对 LLM 翻译过短(DeepSeek 单次通常 1~3s), 会导致大量请求超时、表现为长期"翻译中…"后失败。
- **未擅自改动**: 该值是用户本地配置, 已口头提示并询问是否改回 15000。

## 2026-10-01 第五十轮:短超时的可行性实测 + 加 Bing 兜底回退

- **背景**: 用户想保留 `timeoutMs=1500` 试试短超时, 并问"能不能靠提示词让翻译更快(比如关思考)、以及游戏专属名词/缩写能不能翻好"。
- **实测结论: 提示词不是瓶颈, 该做的用户已经做了**
  - 配置里 `disableThinking: true`(关思考)、`model: deepseek-v4-flash`(已是快档)均已就位。
  - `https.globalAgent.keepAlive = true` —— Node 19+ 默认开启连接复用, 所以**每次请求并没有重复 TLS 握手**(项目里 `bing.js` 显式建了 keep-alive Agent, `openai.js` 没建但也不需要在 v26 上补)。
  - 实测 4 条真实聊天翻译: **546 / 782 / 690 / 833 ms**, 全部成功。延迟主要来自网络往返 + 逐字生成; 系统提示词只占预填充几毫秒, **砍短提示词省不下多少, 反而有译文质量风险**。
- **改动**: `config/config.json` 增加 `"fallbackProviders": ["bing"]`(通过 `POST /api/v1/config` 写入, 避免手改 JSON 出错)。这样 DeepSeek 一旦超过 1500ms 会自动回退到免 Key 的 Bing(专用翻译 API, 通常 100~300ms), 短超时从"会翻车"变成"最坏约 3s 仍出译文"。
- **游戏术语能力核查(实测, 非推测)**: 项目已有 `core/glossary.js` + `core/hero_names.js` + `core/dictionary.js` 三层术语系统, `glossary.buildHint()` 会把术语表注入**每一次**翻译提示词:
  - **49 个英雄**官方英文名(要求"保持英文, 绝不按普通词翻译") + **49 条中文昵称映射**(灰爪=Grey Talon、沃督=Warden、蝰邪=Vyper、莫克双雄=Mo & Krill…)
  - **约 30 条战术术语**(兵线=creep wave、黄/蓝/绿/紫路、推塔、回城、大招、补刀、大野/小野、集合、撤退、守家…)
  - 末尾附规则: 英雄/技能/装备名保持英文、整句完整翻译不得截断
  - 另有 `fixHeroTerms()` 对输出做一次英雄名纠正
  - 实测 4 句: `Grey Talon is pushing yellow lane, need help` → `Grey Talon在推黄路，需要支援`; `b, omw mid. vyper no tp` → `马上，我在去中路。Vyper没传送`; `gg wp, their infernus is fed` → `gg wp，他们的Infernus发育起来了`; `care they are doing big jungle camp then gank bot` → `小心，他们正在打大野，然后会去下路抓人`。**全部正确**(英雄保英文、术语走词表、缩写 b/omw/tp/gg/fed/gank 也对)。
- **验证方式**: 配置回读 `fallbackProviders = bing`; 上述 4 条翻译实测延迟均 < 950ms; 术语表内容直接从 `require('./core/glossary').buildHint('zh-Hans')` 导出核对。
- **仍需用户测试**: ①游戏中留意超时时是否会自动用 Bing 兜底(表现为仍出译文但风格略有差异); ②遇到翻错的术语时记录下来, 可补进用户词典。
- **已知限制**: ①内置术语表是**静态**的 —— 游戏出新英雄/改装备名时需要更新 `core/glossary.js`; ②`openai.disableThinking` 目前**没有暴露在悬浮窗设置面板**(`config.js` 的 `mask()` 未回传该字段), 只能改配置文件; ③生僻新梗/极新缩写仍可能漏译。

## 2026-10-01 第五十一轮:补全装备术语(194 条官方中英对照) + 找到权威数据源

- **背景**: 用户要求更新 `glossary.js`, 补新英雄和装备名。此前结论是"拿不到权威数据、装备数据一条都没有"。
- **突破: 找到真正的公开数据源(需开启代理)**
  - 之前失败是因为**猜错了域名** —— `assets.deadlock-api.com` **根本不存在**(DNS 查不到), 真正可用的是 `https://api.deadlock-api.com/v1/assets/heroes` 与 `/v1/assets/items`。
  - 两者都支持 **`?language=english|schinese`**, 这正是用户说的"游戏里的中英文转换"。
  - 踩坑记录: `openapi.json` 约 443KB 且**经常被截断**(stall 在 69,632 字节 / JSON 半截), 必须用 `curl.exe -sS -L --compressed --max-time 300` 下载并**校验能 JSON.parse 后**再用; 直连 `Invoke-WebRequest` 会超时。
- **英雄: 结论是"一个都不缺", 无需补充**
  - API 返回 **65** 个英雄, 但 `player_selectable=true` 的只有 **46** 个 —— 与 `glossary.js` 的 46 个**完全一致**。
  - 多出的 20 个全部 `selectable=false`, 是未发布的开发中英雄: `Kai, Gunslinger, The Boss, Rutger, Thumper, Cadence, Bomber, Shield Guy(盾男), Vandal, Druid, Graf, Fortuna, Deadman Danny(空骨丹尼), Opera, hero_testhero, Rat King(鼠王), Solomon(所罗门), Violet(阿紫), Nurse Harrow(亥芮护士), Baba(婆婆)`(后 6 个已标 `pre_release`)。
  - **刻意不加**: 它们不可选, 加进去只会在每次提示词里塞 20 个永不出现的干扰项。
  - 这条也**修正了上一轮的说法** —— 之前说"无法验证英雄表是否与当前版本同步", 现在验证了: **是同步的**。
- **装备: 新增 194 条官方中英对照**
  - `/v1/assets/items` 返回 **729** 条, 按 `type` 分: `ability` 395 / `weapon` 84 / `upgrade` **250**。**商店装备就是 `upgrade`**。
  - 250 条里有 55 条 `name` 仍是 class_name(未本地化), 过滤后得 **194 条**有效中英对照。
  - `core/glossary.js` 新增 `itemEnToCn` 字段并接进 `buildHint()`(新增一条 Items 指引: "源文提到装备时使用其官方中文名")。样例: `Extended Magazine=扩容弹匣, Monster Rounds=猎怪弹, Tesla Bullets=特斯拉弹, Capsule=积雷电容, Counterspell=法术反制`。
- **关键验证: 提示词暴涨 3.8 倍, 但延迟没有变差**
  - `buildHint()` 从约 1.5k 字符涨到 **5665 字符**。考虑到用户正跑 `timeoutMs=1500`, 这是必须先验证的风险点。
  - 实测 4 条带装备名的翻译, **4/4 成功**: `942 / 683 / 824 / 578 ms` —— 与加术语表之前的基线(546~833ms)**基本持平**。说明预填充开销远小于生成开销, 且稳定的前缀能吃到服务端上下文缓存。
  - 译文质量实测: `buy extended magazine and monster rounds` → `买扩容弹匣和猎怪弹`; `get tesla bullets, their infernus is fed` → `出特斯拉弹，他们的炽焱被养肥了`; `Grey Talon is pushing yellow lane, buy counterspell` → `Grey Talon在推黄路，买法术反制`。**装备全部用官方中文名, 英雄保持英文**。
- **改动文件**: `core/glossary.js`(新增 `itemEnToCn` 194 条 + `buildHint()` 增加 Items 行); `AGENTS.md` 新增 4.5 节记录数据源与刷新流程。
- **验证方式**: `node --check core/glossary.js` 通过; `require('./core/glossary')` 读出 `heroNames=46 / itemEnToCn=194 / termsCnToEn=25`, `buildHint()` 长度 5665; 桥重启后 4 条翻译实测全部成功且延迟正常。
- **仍需用户测试**: 游戏里留意装备名是否按官方中文显示; 若有翻错的记下来补进用户词典。
- **已知限制**: ①`log` 里的 20 个未发布英雄**不在**表内(刻意); ②装备表是**快照**, 游戏改版后需按 `AGENTS.md` 4.5 节的流程重刷; ③`ability`(395 条技能)与 `weapon`(84 条武器)尚未纳入, 如需要可同样方式补。

## 2026-10-02 第五十二轮:修复「聊天日志功能失效」

- **背景**: 用户反馈日志功能失效, `logs/chat/` 没有新文件。
- **根因(与翻译失效同一个)**: 唯一的写日志入口是 `bridge_server.js` 的 `appendChatLog()`, 而它**只被 HTTP `/api/v1/log` 调用**。游戏 2026-10-01 更新移除 HTTP 能力后, mod 再也发不出这个请求。实测佐证: `logs/chat/` 最后一个真实日志文件停在 **2026/10/1 0:37**, 正好在游戏更新(16:00)之前。而唯一还活着的 `core/overlay.js`(tail `console.log`)**只把聊天喂给悬浮窗, 没有落盘**。
- **改动文件**
  - `core/overlay.js`: 新增 `writeChatLog` 依赖注入; 在 `ingest()` 里**去重之后**调用它, 把 `{t, kind:"chat", isOwn, sender, channel, hero, text}` 交出去。放在去重之后是刻意的 —— console.log 被游戏重写时会从头 re-tail, 不放在去重后面会导致重复落盘。
  - `core/bridge_server.js`: `overlay.start()` 传入 `writeChatLog`, 内部**复用原有的 `appendChatLog()`**(而不是新写一个写文件逻辑), 因此文件格式、`chatLog.enabled` 开关、以及 "session_ → 真实 matchId 迁移" 这些既有行为全部保持一致; 由 `steamid_enrich.js` 做的昵称→SteamID 回填也能继续作用在这些文件上。
- **原因/效果**: 聊天日志恢复落盘, 且**直接写到真实 matchId 的文件名**(不是 `session_`) —— 因为 `appendChatLog` 本来就会用 `readLatestGameMatchId()` 从 console.log 兜底解析真实比赛 ID。
- **验证方式**: `node --check` 两个文件均通过; 重启桥后向游戏 `console.log` 注入一条 `[LCT-CHAT]` → `logs/chat/` 立即出现新文件 **`<matchId>.jsonl`**(真实 matchId, 非 session_); 内容为标准的三种记录: `{"type":"meta","matchId":"<matchId>",...}` / `{"type":"player","name":"LogProbe","hero":"vyper",...}` / `{"type":"msg","t":"...","kind":"chat","sender":"LogProbe",...,"text":"chatlog restore probe message"}` —— 与旧格式完全一致。
- **仍需用户测试**: 打一局后看 `logs/chat/` 是否出现以本局真实 matchId 命名的 jsonl, 且内容随聊天增长。
- **已知限制**: ①日志只在**桥运行期间**采集(桥没开时的聊天不会补录); ②`steamIdEnrichment` 的昵称回填仍按原节奏(文件写入 3 分钟后)工作, 需保持开启。

## 2026-10-02 第五十三轮:与其他 mod 的干扰面最小化(布局覆盖审计 + 精简)

- **背景**: 用户装上 `v5_top_bar_plus` 后发现两个 mod 冲突。排查确认二者**覆盖同一条路径** `panorama/layout/citadel_hud_top_bar_player.vxml_c` —— VPK 是文件级覆盖**不会合并**, 只能有一个生效, 另一方对该文件的改动全部丢失。用户随后把问题上升为一般性诉求: **能否把 mod 对其他 mod 的干扰降到最低**。
- **判断标准**: 干扰面 = **覆盖了几个原版文件**。我们自己的 `lingua_chat.vjs_c` / `.vcss_c` 是独有路径, **永不冲突**; 而每一个被覆盖的原版 `.xml` 都是一次冲突机会。推论: 凡能放进 JS 的, 就不要动 XML。
- **审计结论(逐文件)**
  - `citadel_hud_top_bar_player.xml` —— ❌ **整个删除**。理由: 昵称/英雄读原版即可。关键证据: JS 的 `TOPBAR_PLAYER_NAME_CLASSES = ["PlayerName", "AlwaysPlayerName", ...]` 是**带回退的数组且 `PlayerName` 排第一**, 删掉自建的 `AlwaysPlayerName` 后自动回落原版同宏标签。SteamID 另有 3 个采集点。
  - `chat.xml` / `hudchat.xml` —— ❌ **删除其中的设置面板**(两者各背一份**完全相同**的面板, 合计约 300 行)。理由: 游戏移除 HTTP 后面板**保存不了任何设置**, 是纯死重量。保留: 脚本/样式 `include`(JS 的注入途径)、`LCTRowAccount`/`LCTRowHero` 采集标签、`LCTOnChatSubmit` 提交钩子、`LCTBridgePanel`。
  - `players_list_entry.xml` / `profile_card.xml` / `citadel_db_page_profile.xml` —— ✅ **保留**(各只改 1-3 行, 仅藏一个读宏的 `<Label>`)。这三个都是**冷门文件**(顶栏、聊天框才是 mod 作者最爱改的地方), 冲突面最小。
- **改动文件**
  - 删除 `mod/panorama/layout/citadel_hud_top_bar_player.xml`
  - `chat.xml`(229→80 行)、`hudchat.xml`(195→47 行): 用一次性脚本按标记精确删除设置面板(从面板注释到桥面板注释之间), 其余内容逐字节保留; 脚本用后即删。
- **安全性验证(动手前先查依赖, 非事后补救)**
  - 顶栏: 见上述 `TOPBAR_PLAYER_NAME_CLASSES` 回退数组证据。
  - 设置面板: 查得 JS 中 `SETTINGS_PANEL_ID` 的**全部 4 处用法都做了判空** —— `if (!panel) return` / `if (panel)` / `if (panel && ...)` / `panel ? findChild(panel,id) : null`, 因此面板缺失时这些函数**安静地变成空操作**, 不会每帧报错。**故本轮不需要为安全而剪枝 JS**。
- **验证方式**: `scripts/build.ps1` 构建通过, 资源数 **8 → 7**, 且 `chat.vxml_c` / `hudchat.vxml_c` 均 `ok` —— 由 `resourcecompiler` 实际解析通过, 证明删除未破坏 XML 结构(注: 用正则数 `<Panel>` 标签会得出"不平衡", 那是 `<PanelXxx>` 被误计入的假象, 应以编译器为准)。
- **仍需用户测试**: 重启游戏后确认 —— ①昵称/英雄映射仍正常(顶栏改读原版标签); ②ESC 名单的 SteamID 采集仍正常; ③游戏内 `/tr` 设置面板**已消失**(这是预期, 设置改在悬浮窗); ④与 `top_bar_plus` 的冲突消失, 二者可共存(其顶栏改动不再被我们还原)。
- **已知限制**: ①顶栏那个 SteamID 采集点随之失去, 靠 `players_list_entry`(ESC 名单)+ 两张资料卡兜底; ②**游戏内已无任何设置入口**, 全部设置只能改悬浮窗或 `config.json`。

## 2026-10-02 第五十四轮:修 /tr 被吞、关游戏后悬浮窗不退出、字幕顶部被裁;并修回被编辑剥掉的 BOM

- **背景**: 用户反馈 4 件事 —— ①`/tr` 打不出去了; ②关游戏后悬浮窗/字幕不退出; ③字幕最上面一条显示不全(被裁); ④字幕太宽想调。另有"快捷消息日志格式"疑点需核实。
- **① `/tr` 被吞(真 bug)**: 第五十三轮删掉设置面板时**漏删了命令拦截**。`LCTOnChatSubmit` 里原本有:
  `if (trimmed === "/tr" || trimmed.indexOf("/tr ") === 0) { clearInput(); openSettingsPanel(); return; }`
  面板删掉后 `openSettingsPanel()` 变成空操作, 于是这段的净效果是 **"清空用户输入 + 什么都不做 + 永不发送"**。
  修法: 整段删除, `/tr` 现在作为普通文本正常发送。
- **② 关游戏后悬浮窗不退出(真 bug)**: `checkOverlayGame()` 里游戏退出分支原本只写了 `overlayGameSeen = false;` —— **只重置标志, 从不关窗口**。改为 `else if (!running && overlayGameSeen)` 时调用新增的 `closeOverlayWindow()`(native 模式走 `killOverlayNative()`;web 模式桥拿不到浏览器进程句柄, 只记一条日志)。注意判断加了 `overlayGameSeen` 条件, 避免游戏从未运行过时也去执行关闭。
- **③ 字幕顶部被裁(真 bug)**: `Apply-SubtitleLayout()` 里高度是**估算**的 —— `maxVisible * fontSize * 3.4`。原文换行或译文较长时, 每条的**实际**高度超过该估算, 固定窗口高度装不下便裁切。
  修法: 改为 `DmWindow.SizeToContent = Height` 让窗口高度**紧跟 StackPanel 实际内容**, 任何条数/字数都不再被裁; 另设 `MaxHeight = min(760, 工作区高*0.9)` 兜住极端情况。定位用的高度改读 `ActualHeight`, 未布局时回退一个保守值。
- **④ 字幕宽度**: 核实后**已可在设置面板调整** —— `overlay.subtitle.width` 对应"每条宽度(px)"(设置 → 字幕浮层分组), 无需新增。
- **核实: "快捷消息日志格式有问题" 不是 bug(重要更正)**: 上轮我凭猜测认为 `channel:"hud"` + `sender:"<unknown>"` 的条目是主聊天的**重复副本**, 计划加去重。**实测证伪** —— 对当轮日志做跨 channel 文本比对, **零重复**; 那 3 条(`有超凡冷却`/`马上倒下了`/`有幸免于难`)是**独立的快捷喊话**, 主聊天列表里没有。若按错误判断去重, 会**误删 3 条合法消息**。真实情况只是: 游戏的快捷喊话本身不带发送者, 故 `sender` 落成 `<unknown>`。属显示层措辞问题, 非数据丢失。
- **⚠️ 附带修复(本轮最重要的发现): 编辑把 UTF-8 BOM 剥掉了**
  - 起因: 用 `[Parser]::ParseFile` 做语法检查时报出中文乱码(`妗ュ湪绾?`), 说明文件被按 GBK 读。
  - 实测: `overlay_window.ps1` 及**我改过的另外 5 个文件**的 BOM 全部丢失(文件头变成 `23 20 44`), 而 `git show HEAD:` 里的原版**都有 BOM**。
  - 影响: PowerShell 5.1 读无 BOM 的 UTF-8 会按 **ANSI/GBK** 解 → 内部所有中文(设置项标题、提示文案)**全部乱码**。这正是 `AGENTS.md` 里反复警告的坑, 而**工具链本身会静默剥掉 BOM**(编辑器改写与 `fs.writeFileSync(...,"utf8")` 都不写 BOM)。
  - 修法: 逐个用 `ReadAllText(UTF8)` + `WriteAllText(..., UTF8Encoding($true))` 补回, 并复查全部为 `EF BB BF`; 内容完整性抽查通过。
- **验证方式**: `build.ps1` 构建通过(7 资源全 `ok`); 已部署 `addons\pak22_dir.vpk`; 桥重启后 `GET /api/v1/health` = 200; 悬浮窗手动启动成功(pid 5112)且**错误日志为空**, 证明 BOM 修复与高度改动均正常加载; 6 个文件的 BOM 复查全部为 True。
- **仍需用户测试**: ①`/tr` 能作为普通聊天发出; ②**关闭游戏后悬浮窗自动消失**; ③字幕不再裁切(条数多、文案长时最上面一条也完整); ④设置里调"每条宽度(px)"看效果; ⑤确认设置面板中文不再乱码(若仍乱码说明 BOM 又被动过)。
- **已知限制**: ①web 模式下关游戏不会自动关窗(桥无浏览器进程句柄); ②快捷喊话仍显示为 `<unknown>`(游戏不提供发送者); ③工具链存在**静默剥 BOM** 的风险, 每次改完带中文的 `.ps1` 都应复查前三字节是否为 `EF BB BF`。

## 2026-10-02 第五十五轮:悬浮窗设置实时预览 + 胶囊随配置重建 + 松手才贴边 + 设置按钮样式

- **背景**: 用户一次提了 4 个体验问题 —— ①改透明度/字号应**实时看到变化**, 不该保存后才知道; ②改设置**不生效**(胶囊透明度、字号改了没反应); ③窗口**只能贴边**, 希望"靠近边才贴, 不靠近就不贴"; ④点保存后胶囊才变正常, 顺带修一下设置按钮的 UI。
- **②④ 根因(同一个, 真 bug)**: 字幕胶囊的底色/圆角/字号/间距/显隐是在 `New-SubtitleChip` **创建那一刻**从 `$script:Ov.subtitle` 读值固化的; `Apply-Config` 只重画了窗口/面板本身, **从不回写已存在的胶囊**。所以改配置对已出现的胶囊毫无效果, 只有**新来的**消息才用新值; 而点保存会触发 `Apply-Config` → `Apply-SubtitleLayout` 重算布局, 造成"保存后才变正常"的错觉 —— ④其实就是②的表现。
  - 前置障碍: `$script:DmItems` 原本只存 `{node,seq,born,life}`, **不留原始消息**, 配置一变就无从重建。
  - 修法: ①`Add-Subtitle` 在 DmItems 里**多存一份 `msg`**; ②新增 `Rebuild-Subtitles()`, 用存下的消息原地重建全部胶囊(并继承当前淡化进度, 不闪); ③`Apply-Config` 末尾在字幕形态下调用它。
- **① 实时预览(真缺失)**: 设置控件此前**只在点保存时**才读值写配置, 没有任何预览通路; 且滑块为了修崩溃已把 `Add_ValueChanged` 换成纯数据绑定, 连"拖动时做点什么"的入口都没有。
  - 修法: 新增 `Preview-Settings()` —— 读当前表单值**合并进内存配置**(不落盘)后重画; 新增 `Register-Preview($ctl,$kind)` 按控件类型挂回调(bool→Click、enum→SelectionChanged、range→ValueChanged、int→LostFocus、color→TextChanged)。处理器内**只调用具名函数、不引用建窗时的局部变量**, 并整段 `try/catch`, 规避上一轮"闭包捕获局部变量 → WPF 异步调度作用域解析失败 → 进程被带走"的老坑。另设 `$script:Building` 标志, 生成控件期间抑制预览, 避免读到半成品表单。
- **③ 只能贴边 → 靠近才贴(新能力)**: `Snap-ToNearestEdge` 原先是**无条件**吸附到最近边。
  - 修法: 改为按"窗口四边到对应工作区边的**间隙**"取最近一条, **间隙 ≤ `$script:SnapDist`(48px)才吸附**, 否则置 `edge="float"` 并**记住当前位置** `floatX/floatY`; `Get-EdgeTarget` 对 `float` 直接返回当前位置, 于是展开/收起/唤醒全部原地不动(即浮动时不自动收起)。配置层新增 `overlay.floatX/floatY`(DEFAULTS + `applyMaskedUpdate` 白名单), 并允许 `edge="float"`; 设置面板的"收起贴哪条边"下拉新增"自由(不贴边,不自动收起)"选项。
- **⑤ 设置按钮样式(真 bug, 根因意外)**: `KeyAct`/`SolidAct` 是**带 key 的样式却没有 `BasedOn`** —— WPF 里设了显式 Style 后**隐式 Button 样式整份失效**, 按钮回退成系统浅色模板。这正是"设置"按钮看起来像从别的程序贴进来的原因。修法: 两个 keyed 样式补 `BasedOn="{StaticResource {x:Type Button}}"`, 并给"设置"按钮加黄铜描边 + 深底 + 半粗(同时修好了"翻译并复制"/"保存"两个按钮)。
- **改动文件**: `scripts/overlay_window.ps1`(实时预览/重建/吸附/按钮样式); `core/config.js`(新增 `overlay.floatX/floatY` 与 `edge="float"` 支持)。
- **验证方式**: `Parser::ParseFile` 语法通过; 抽出两个窗口的 XAML 单独 `XamlReader::Parse` **通过**(证明新增 `BasedOn` 写法可解析); `node --check core/config.js` 通过; `overlay_window.ps1` 前三字节复查为 `EF BB BF`(BOM 未丢)。
- **仍需用户测试**: ①拖"胶囊不透明度"/改"译文字号"**当场**看到已显示胶囊变化(无需保存); ②把面板拖到屏幕中间松手 → **停住不贴边**; 拖到边附近松手 → 吸附; ③关闭再打开悬浮窗, 停在原位置(不再弹回边); ④点"保存"后效果与预览一致; ⑤"设置"按钮为黄铜描边样式, 不再是系统灰按钮。
- **已知限制**: ①实时预览只改**内存配置**, 不关闭设置页就退出的话本次预览不落盘(下次启动回到磁盘值); ②`overlay.fontSize`(面板字号)仍只影响继承, 聊天列表各行是显式字号, 故该项视觉变化有限(本轮未动); ③`edge="float"` 时贴边自动收起等于关闭(浮动窗口无法收成细条)。

## 2026-10-05 第五十六轮:修"残留聊天/桥不自启/重启桥前聊天不译"三处状态 bug;新增最小化到托盘

- **背景**: 用户反馈 4 件事 —— ①关游戏再开, 悬浮窗**残留上一局聊天**; ②关一次游戏后桥也退出了, 再次打开游戏**有时悬浮窗不自动出来**; ③**重启桥之后, 桥开启前的聊天不会被翻译**; ④窗口需要一个**最小化**功能, 给不想贴边的人用(贴边收起即使只有 8px 仍在画面上留痕)。
- **① 残留聊天(真 bug, 双端)**: 根因有两层 —— (a) 桥端在"console.log 被游戏重写(进新一局)"时只 `clearDedup()`, **不清环形缓冲 `ring`**, 上一局消息仍在; (b) 桥进程重启后 `seq` 归零, 而悬浮窗的轮询 `after` 基于**旧的 `LastSeq`**, 新序号永远追不上旧值 → 窗口**永久卡住不更新**(表现为"残留旧聊天")。
  - 修法: 引入**会话标识 `session`** —— 桥进程启动、日志重写、游戏退出清空三处都自增; `/api/v1/overlay/messages` 响应新增 `session` 字段; 悬浮窗(native + web 双版)轮询到 **`session` 变化**或 **`latest < LastSeq`** 时执行 `Reset-ChatView`/`resetView()` 清屏, 并以 `after=0` 重新拉取。新增 `beginNewSession()`(清 ring/queue/dedup)与 `clearMessages()`。
- **② 桥不自启 / 悬浮窗有时不出来(真 bug, 两个根因)**: (a) `DEFAULTS.watchGame=true` 时桥**随游戏退出**, 而开机自启只在登录时执行一次 → 重开游戏时**没人把桥拉回来**。修法: `watchGame` 默认改为 **`false`**(桥常驻, 由悬浮窗监视独立负责开关窗口)。(b) `openOverlayNative()` 原先是"发完 kill 命令等 600ms 就启动新窗口", 旧进程仍持有 `Local\DeadlockLinguaOverlay` 互斥锁 → 新进程 `WaitOne(0)` 失败直接 `exit 0`, 表现为"重开游戏后悬浮窗有时不出来"。修法: `killOverlayNative(onDone)` 增加回调, **等旧窗口真正关闭后**再 `launchOverlayNative()`。
- **③ 重启桥后先前聊天不译(真 bug)**: 根因: 悬浮窗首次接触 `console.log` 时**一律 seek 到文件末尾**, 于是"桥开启前"已写入本局的聊天全部被跳过。
  - 修法: 新增 `primeBackfill(file,size)` —— 若**游戏正在运行**(新增 `isGameRunningSync()` 同步探测 `deadlock.exe`), 则从文件尾回读最多 **4MB**、过滤 `[LCT-CHAT]`、**回填最近 60 条**(`ingest(l,{noLog:true})` → 不重复落盘聊天日志); 若游戏**不在运行**(那份日志是上一局遗留的), 才 seek 到末尾, 避免登录自启时翻译整局旧历史。
- **④ 最小化到托盘(新能力)**: Header 新增 `MinBtn`「最小化」; 新增系统托盘 `System.Windows.Forms.NotifyIcon`(右键菜单「显示面板/最小化到托盘/退出」, 双击恢复)。**给不想贴边留痕的人用** —— `Window.Hide()` 整个藏起来, 不留那 8px 细条。
  - 附带加固: 托盘创建失败时, 最小化**退回任务栏最小化**(`ShowInTaskbar=true` + `WindowState=Minimized`), 可点任务栏恢复 —— 原注释误以为"重开脚本靠互斥锁会复用窗口", 实际 `WaitOne(0)` 失败即 `exit 0`, **不会**恢复被隐藏的窗口, 已改为真实可恢复的降级路径。
- **改动文件**: `core/overlay.js`(session/beginNewSession/primeBackfill/clearMessages/sessionId + deps.isGameRunning); `core/bridge_server.js`(`isGameRunningSync`、kill→launch 回调链、`closeOverlayWindow` 里 `clearMessages`、`/messages` 加 `session`); `core/config.js`(`watchGame` 默认 false); `scripts/overlay_window.ps1`(最小化到托盘 + 会话感知轮询清屏 + 托盘降级); `core/overlay_page.html`(web 版同步会话清屏); `scripts/overlay_test.js`(更新断言 + 新增桥重启回填用例)。
- **验证方式**: `node scripts/overlay_test.js` → **PASS 13 / FAIL 0**(新增阶段 5: `gameRunning=true` + `overlay.reset()` 模拟桥重启 → 断言回填 2 条聊天且进入翻译队列; 阶段 3 断言新一局清空缓冲 + 会话标识变化; 阶段 4 期望由 `length===3` 改为 `===1`, 与新清屏行为一致)。`node --check` 对 4 个 js 文件全部通过。`overlay_window.ps1` 经 `Parser::ParseFile` 语法通过, 且前三字节复查为 `EF BB BF`(BOM 未丢)。
- **仍需用户测试**: ①关游戏再开 → 悬浮窗**不残留**上一局聊天; ②关游戏后桥**常驻**(任务管理器里 node 仍在), 重开游戏 5 秒内**自动出窗口**; ③先开游戏打两句、再重启桥 → **桥开启前的聊天被翻译出来**; ④点「最小化」→ 窗口进托盘(不留细条), 双击托盘图标或右键「显示面板」恢复, 右键「退出」正常退出。
- **已知限制**: ①web 回退模式关游戏仍不自动关窗(桥拿不到浏览器进程句柄); ②最小化只隐藏**面板窗口**, 字幕浮层是独立窗口、仍留在屏幕上(如需一起隐藏要另加); ③回填只取最近 **60 条**(避免一次把整局历史灌进翻译队列触发 API 洪峰); ④托盘图标为通用系统图标(未做品牌图标)。

## 2026-10-05 第五十七轮:最小化后加全局热键唤起;排查"弹幕消失"为误报并加防御性保持

- **背景**: 用户反馈 —— ①最小化后**无法快捷地重新唤起窗口**; ②最小化后**弹幕(字幕浮层)也会消失**。
- **排查(实测, 不靠猜)**: 用"注入式测试副本"(把原脚本复制到 temp 并追加一个 3 秒后自跑的 DispatcherTimer)实跑真实窗口, 结论:
  - `Minimize-ToTray` 后 `Window.IsVisible=False` 但 **`DmWindow.IsVisible=True`** —— **字幕浮层并未被代码隐藏**, 它是独立顶层窗口, 不随面板 `Hide()` 消失(也确认二者之间**没有** Owner 关系)。
  - 系统托盘 **创建成功**(`Tray=非空`, `Visible=True`), 说明 ① **不是**"托盘没建出来", 而是"恢复手段不够快捷/图标不显眼"。
  - 故 ② 的成因**不是代码隐藏字幕**, 而是①的连锁后果(面板唤不回来 → 用户以为弹幕也没了)或胶囊按 `subtitle.lifeMs` 自然过期(无新消息)。
- **修法**
  - 新增**全局热键 `Ctrl+Alt+L`**(`RegisterHotKey` + `HwndSource.AddHook` 处理 `WM_HOTKEY`), 在**任意时刻**(面板已最小化 / 游戏在前台)切换面板显示; 关闭窗口时 `UnregisterHotKey`。
  - 托盘图标**左键单击**也恢复(原来只有双击 + 右键菜单), 降低"唤不回来"的几率。
  - 最小化后**显式保持字幕浮层可见并置顶**(防御性: 若它在别的路径被隐藏则兜底恢复, 否则仅重申 Topmost), 确保"最小化面板"不会连带丢掉弹幕。
  - 「最小化」按钮 ToolTip 与托盘气泡提示补上热键说明。
- **改动文件**: `scripts/overlay_window.ps1`(全局热键 + 托盘左键 + 字幕保持 + 提示)。
- **验证方式**: `Parser::ParseFile` 语法通过、前三字节 `EF BB BF`; 注入测试实测 **`HotkeyOk=True`**、`HwndSrc` 就绪、`Toggle-PanelWindow` 隐藏/恢复正确且 `Dm.Vis` 始终为 `True`; 启动真实窗口 6 秒**无 `lct-overlay-error.log`**。
- **仍需用户测试**: ①最小化后按 **Ctrl+Alt+L** 能否立即恢复面板(游戏内也试一次); ②托盘图标**左键单击 / 双击 / 右键菜单**三种恢复方式; ③最小化后**弹幕(字幕)是否仍在**(若不在了, 请描述当时是否刚好一段时间没人说话 —— 那属于 `lifeMs` 自然过期)。
- **已知限制**: ①`Ctrl+Alt+L` 为**固定**热键, 未做成可配置(若与你的其它软件冲突请告知, 可换键); ②热键依赖 `RegisterHotKey`, 若被其它程序占用则注册失败(`HotkeyOk=False`, 静默降级, 托盘仍可用); ③托盘图标仍是通用系统图标。

## 2026-10-05 第五十八轮:修"热键/托盘一用就把悬浮窗进程带崩"——ShowDialog 主循环 + HwndSource 钩子 ref bool 两个真根因

- **背景**: 用户反馈 —— ①快捷键 `Ctrl+Alt+L` 无效; ②在系统托盘里也**看不到**本程序的图标。(上一轮刚加的热键 + 托盘, 用户实测等于没生效。)
- **排查(实测, 逐层插桩 + 事件日志, 不靠猜)**: 向 `%TEMP%\lct-overlay-diag.log` 打点、并合成 `keybd_event` 触发 `Ctrl+Alt+L`, 复现到**稳定结论**:
  - 单独按热键(面板可见 → `Minimize-ToTray`)后, 进程**直接消失**; 进程数从 1 变 0, 既没托盘也没热键 —— 这才是用户看到的"快捷键无效、看不到托盘"的真因(代码根本没跑起来, 不是热键/托盘本身没写对)。
  - 逐层加诊断后定位到**两个独立的致命 bug**, 都在"用 PowerShell + WPF 搭常驻窗口"的老坑上:
  - **① `ShowDialog()` 不能当主循环(致命)**: 脚本末尾用 `$script:Window.ShowDialog()` 撑住进程。实测打点显示 `Minimize-ToTray` 里一执行 `$script:Window.Hide()`, 紧接着 `ShowDialog()` **立即返回**, 脚本跑到文件末尾 → PowerShell 进程正常退出(无任何崩溃事件, 所以之前误判成"只是没恢复窗口")。→ 隐藏窗口 = 退出程序。
  - **② PowerShell 脚本块不能当 `HwndSource` 钩子(致命)**: 原热键用 `$script:HwndSrc.AddHook({ param($hwnd,$msg,$wParam,$lParam,$handled) ... $handled.Value = $true })`。`HwndSourceHook` 第 5 个参数是 `ref bool handled`, PowerShell 把它当**普通参数**绑定, 于是 `$handled` 拿到的是别的语义, 执行 `$handled.Value = $true` 抛 `PSInvalidCastException: 无法将值"True"转换为类型"System.IntPtr"`。该异常发生在**原生回调**里(栈: `HwndSource.PublicHooksFilterMessage` → `CallSite.Target` → `ConvertIConvertible`), 脚本块内的 `try/catch` **拦不住**, 由 `Dispatcher.add_UnhandledException` 才捕获到 → 进程终止。事件日志里历史上还有两条同源崩溃(`.NET Runtime 1026` + `Application Error 1000`, `PSInvalidOperationException` at `ScriptBlock.GetContextFromTLS`)。
- **修法**:
  - **主循环**: 把 `[void]$script:Window.ShowDialog()` 改为 `$script:Window.Show()` + `[System.Windows.Threading.Dispatcher]::Run()`; 窗口被隐藏不再结束程序。窗口**真正关闭**时(Closed 处理器)追加 `Dispatcher.CurrentDispatcher.InvokeShutdown()`, 让 `Run()` 返回、进程干净退出并释放互斥锁。
  - **热键**: 彻底不让 PowerShell 脚本块进原生回调。新增 C# 类型 `LCT.HotkeyBridge`(`Add-Type -TypeDefinition`, 引用 `PresentationCore`/`WindowsBase`): 由 **C# 的 `HwndSourceHook` 委托**接 `WM_HOTKEY`, 只置一个 `static bool Pending` 标志; PowerShell 侧用一个 **150ms `DispatcherTimer`** 轮询 `Pending`, 命中才调用 `Toggle-PanelWindow`。原生回调里不再有任何 PowerShell 代理解析, 从根上避开 `ref bool` 绑定问题。
  - `Register-ToggleHotkey`/`Unregister-ToggleHotkey` 改为包 `HotkeyBridge.Register/Unregister`, 并管理轮询定时器。
- **改动文件**: `scripts/overlay_window.ps1`(主循环改 Dispatcher.Run + Closed 里 InvokeShutdown; 热键改 C# 桥 + 轮询; 移除全部临时诊断点)。
- **验证方式**(全部实测): ① 复现旧行为: 按热键 → 进程死亡(diag 止于 `hide-after`), 事件日志证据见上; ② 修复后连续 **隐藏→显示→隐藏→显示** 四次热键, 进程**始终存活**、`tray=True hotkeyOk=True`、互斥锁持有; ③ 向面板窗发 `WM_CLOSE` → 进程**干净退出**且互斥锁释放; ④ `Parser::ParseFile` 语法通过、`overlay_window.ps1` 前三字节复查 `EF BB BF`(BOM 未丢)。
- **仍需用户测试**: ①打开悬浮窗后按 `Ctrl+Alt+L` 应能隐藏/显示, 且**托盘图标与热键继续有效**(不再一点就崩); ②托盘图标在 Win11 默认收进 `^` 溢出区, 点任务栏右下角 `^` 找到 `DeadlockLingua`(通用图标)可拖出固定; ③关闭窗口(右上角 ×)能正常退出、托盘图标消失。
- **附**: 同一轮发现 `ShowOverlay.bat` 存在两个启动期问题并已修 —— (a) **不杀旧实例**: 旧实例持有单实例互斥锁时, 新启动的窗体会 `WaitOne(0)` 失败静默 `exit 0`(表现为"双击没反应"); 现改为启动前用 CIM 匹配命令行(`overlay_window\.ps1`, 排除 `$PID` 自身)先清理旧实例。(b) **行尾是纯 LF**: cmd 批处理遇 LF 会错行解析(实测报 `'nul' 不是内部或外部命令`、`'w.ps1' ...`), 已统一为 **CRLF**(UTF-8 无 BOM), 注释改英文 ASCII 以规避 `rem` 行内特殊字符(跨行中文引号)的解析问题。
- **已知限制**: ①热键轮询间隔 150ms, 理论上有最多 0.15s 延迟(无感); ②`Ctrl+Alt+L` 仍为固定键, 冲突可改 `HotkeyBridge._id` 与 VK; ③托盘图标仍是通用系统图标。

---

## 2026-10-05 第五十九轮:按优先级修复多角度审查发现的 8 项(多屏错位 / 桥阻塞 / 托盘可发现性 / 单实例静默 / 错误不可见 / 吞消息)

- **背景**: 上一轮修完热键崩溃后, 对悬浮窗、桥、游戏侧脚本做了一轮功能性与多角度审查, 发现若干问题。用户要求"按优先级顺序修复", 本轮处理前 8 项(第 9 项有意保留, 见文末)。
- **改动(按优先级)**:
  1. **多显示器错位(真实缺陷)**: 窗口贴边吸附、字幕比例定位、float 复位原先把 `[System.Windows.SystemParameters]::WorkArea` 当工作区, 那**永远是主屏**的工作区 —— 拖到副屏后会跑到主屏或夹在错误边界。新增 `Get-ActiveWorkArea`(WinForms `Screen.FromHandle` 取窗口所在屏 + 用 `PresentationSource.CompositionTarget.TransformToDevice.M11` 把设备像素换算回 WPF 的 DIP 坐标系), 5 处调用点全部替换, 并保留 `SystemParameters.WorkArea` 作降级回退。
  2. **桥为一次检测阻塞事件循环(收紧)**: `isGameRunningSync` 的 `execFileSync("tasklist")` 超时 **4000ms → 1500ms**。保留同步实现是**有意的** —— 首轮 tail 必须当场知道"游戏是否在运行"才能正确决定 prime 回填, 改成异步会丢掉"桥重启前的聊天"(即上一轮刚修好的功能), 所以只收紧最坏情况的假死时长, 不重构该路径。
  3. **托盘图标可发现性**: 原来的 `SystemIcons.Application` 是系统通用图标, 在 Win11 任务栏 `^` 溢出区里毫无辨识度(用户原话"看不到托盘")。新增 `New-TrayIcon`: 用 `System.Drawing` 按设计令牌(深底 `#131920` + 氧化黄铜 `#C9A44E`)现画一个 32×32 的 "L" 标, 转成 `Icon`, 不引入额外 .ico 资源; 失败时回退系统图标。
  4. **热键注册失败可见**: 热键被其他程序占用时原来只写 diag 日志, 用户会一直以为"快捷键无效"。现在启动气泡会明确提示, 并把 `hotkeyOk` 一起写进 diag。
  5. **单实例冲突不再静默**: 新增 `-Silent` 开关。手动运行(`ShowOverlay.bat` / 直接跑 `.ps1`)遇到已有实例时弹 MessageBox 提示"已在运行, 用托盘或 Ctrl+Alt+L 唤起"; 桥自动拉起窗口时传 `-Silent`, 静默退出, **不在游戏画面上弹窗打断**。
  6. **启动可发现性气泡(每次进程一次)**: 就绪后弹一次托盘气泡 —— 热键正常时说明"图标在任务栏 ^ 溢出区可拖出固定 + Ctrl+Alt+L 切换"; 热键失败时改用警告文案引导走托盘恢复。这一条同时覆盖第 3、4 项的用户感知。
  7. **错误不再不可见**: 桥离线时把最后一次轮询异常摘要挂到状态文字的 `ToolTip`(鼠标悬停可见, 含 `%TEMP%\lct-overlay-error.log` 路径), 不再只有"桥离线"四个字。
  8. **去重窗口过长会吞消息**: `overlay.js` 的 `DEDUP_WINDOW_MS` **10 分钟 → 2 分钟**。跨面板副本(聊天行 + 顶栏气泡)几乎同时出现, 2 分钟足够覆盖; 原来的 10 分钟会把同一人重复说的同一句话(两次 "gg" / "push" / "1")当成副本吞掉第二条。
- **改动文件**: `scripts/overlay_window.ps1`(Get-ActiveWorkArea + 5 处替换; `-Silent` + 互斥冲突提示; New-TrayIcon; 启动气泡; Set-Status tooltip; 轮询 catch 记录 LastErrorDetail)、`core/overlay.js`(DEDUP_WINDOW_MS)、`core/bridge_server.js`(isGameRunningSync 超时 1500ms; 自动拉起窗口追加 `-Silent`)。
- **验证方式**(全部实测): ① `Parser::ParseFile` 语法 OK、前三字节复查 `EF BB BF`(BOM 未丢); ② `node --check` 两个 js 均 exit=0; ③ `overlay_test.js` **PASS 13 / FAIL 0**; ④ 重启新实例: `pid=30716 init tray=True hotkeyOk=True` → `ready`(说明 New-TrayIcon 与 Get-ActiveWorkArea 在 SourceInitialized/ContentRendered 均未报错), 合成 `Ctrl+Alt+L` 切换两次后进程**始终存活**, `%TEMP%\lct-overlay-error.log` 无新增。
- **仍需用户测试**: ① 若有多显示器, 把窗口拖到副屏后贴边/字幕定位是否正确; ② 托盘图标是否已变成黄铜 "L" 标、能否从 `^` 溢出区拖出固定; ③ 启动气泡的文案是否符合预期(每次开窗一次)。
- **未做(有意保留)**: ⑨ 把桥的 matchId 扫描与 overlay 的聊天 tail 合并成单一 tailer —— 两者共用同一份 `console.log`, 合并能省一半 I/O 且消除两套 offset/fingerprint 状态不一致的风险, 但会动到 matchId/玩家身份这条**已稳定**的管线, 风险明显高于收益, 建议单独一轮谨慎处理; 另外"每次轮询新建 `WebClient`"、"`Remove-OldNodes` 每 tick 排序"等微优化量级可忽略, 暂不动。

## 2026-10-05 第六十轮:清理游戏内设置面板的残留死代码("译"按钮 + 面板样式/脚本)

- **背景**: 用户注意到聊天输入框右侧的"译"设置按钮在游戏里**从未出现过**, 追问它到底在哪。排查发现第五十三轮删除游戏内设置面板时**漏删了按钮本身及其配套的样式/脚本**, 留下一批"点了也没反应"的死代码。
- **根因(第五十三轮清理不彻底)**:
  - `chat.xml` / `hudchat.xml` 里的 `LCTSettingsButton`(内嵌 `<Label text="译" />`)未删 —— 面板删了, 但**触发面板的按钮**还在。
  - `lingua_chat.css` 里 `.LCTSettingsButton` / `.LCTSettingsPanel` / `.LCTSettingsHeader` / `.LCTSettingsRow` / `.LCTInput` / `.LCTBtn` / `.LCTSelect` / `.LCTSelectMenu` / `.LCTStatusBar` / `.LCTBridgeStatus` 等约 280 行面板样式未删。
  - `lingua_chat.js` 里 `openSettingsPanel` / `closeSettingsPanel` / `LCTToggleSettings` / `collectPanelConfig` / `LCTSave` / `LCTTest` / `syncPanelFromConfig` / `setFieldText` / `setSelectText` / `setToggleText` / `syncProviderRows` / `LCTOnToggle` / `LCTCycle` / `LCTToggleMenu` / `LCTPickLang` / `LCTPickProvider` / `LCTPickOption` / `fieldValue` / `updateKeyStateLabel` / `markUiTouched` 等约 480 行面板函数未删, 以及 `PROVIDER_OPTIONS` / `LANGUAGE_OPTIONS` / `DISPLAY_MODES` / `OUTGOING_MODES` 四个只为面板服务的选项常量与 10 个 `exportGlobal` 导出。
  - 因 `openSettingsPanel()` 内 `findChild(root,"LCTSettingsPanel")` **对不存在的面板判空返回**, 按钮点击**静默无操作** —— 这正是用户"从没见过按钮、即便见到也没用"的解释(按钮存在与否取决于 VPK 里 `chat.vxml_c` 的版本)。
- **改动文件**
  - `mod/panorama/layout/chat.xml`、`hudchat.xml`: 各删 3 行 `LCTSettingsButton` 按钮(保留脚本/样式 include、`LCTRowAccount`/`LCTRowHero` 采集标签、`LCTBridgePanel`、`LCTOnChatSubmit` 提交钩子)。
  - `mod/panorama/styles/lingua_chat.css`: 删除全部设置面板样式(283 行, 422→129 行), 保留桥面板隐藏样式与译文气泡样式。
  - `mod/panorama/scripts/lingua_chat.js`: 删除设置面板 UI 函数、4 个选项常量、10 个 `exportGlobal`(5914→5336 行); `targetLanguage()` / `resolveOutgoingTarget()` 去掉对已删 `fieldValue()` 的引用 —— 游戏内面板移除后自定义语言只剩配置来源, `custom` 回退为默认值(`zh-Hans` / `en`)。
- **原因/效果**: 消除"点了没反应"的死按钮与全部不可达代码; **功能面零变化** —— 保留启动时的桥配置同步(`syncUiFromBridge` / `applyBridgeUiConfig` / `saveUiConfig`)、翻译队列、昵称/英雄/SteamID 采集等所有既有逻辑。
- **⚠️ 附带修复(本轮踩的坑): 工具链又一次静默剥掉了 BOM / 改了行尾**
  - 改动后 `git diff --numstat` 显示 4 个文件**首行都改动**(`@@ -1 +1 @@`), 经 `git cat-file -p HEAD:<file>` 对比确认: 原文件(`chat.xml` / `hudchat.xml` / `lingua_chat.js` / `lingua_chat.css`)**都有 UTF-8 BOM**, 而编辑后全部丢失; `lingua_chat.css` 的行尾还从 CRLF 变成了 LF。
  - 这正是 `AGENTS.md` 第 7 节与第五十四轮反复警告的坑:**项目文件约定 CRLF + BOM, 但编辑器/脚本工具会静默剥掉**。
  - 修法: 4 个文件统一用 `[System.IO.File]::ReadAllText` + `WriteAllText(..., UTF8Encoding($true))` 重写(先把 `\r\n`→`\n` 再 `\n`→`\r\n` 归一化行尾), 复查全部为 `EF BB BF` 且 CRLF 计数正常; 重写后 `git diff --numstat` 不再出现首行改动。
- **验证方式**: ① `node --check mod/panorama/scripts/lingua_chat.js` 通过; ② `git diff --numstat -- mod/panorama` 干净: `chat.xml 0/3`、`hudchat.xml 0/3`、`lingua_chat.js 6/479`、`lingua_chat.css 1/283`(删除全部落在设置面板区域, 无意外改动); ③ `scripts/build.ps1` 构建 7 个文件全部 `ok`(resourcecompiler 实际解析通过, 证明 XML/CSS 结构未破坏); ④ 已重命名为 `dist/pak22_dir.vpk` 并部署到 `E:\Steam\...\citadel\addons`(259583 字节, 2026/10/5 02:24)。
- **仍需用户测试**: 重启 Deadlock → ① 聊天输入框右侧**不再有"译"按钮**(预期); ② 聊天翻译 / 聊天日志 / 昵称·英雄·SteamID 采集等**既有功能无回归**。
- **已知限制**: 游戏内自此**没有任何设置入口**(与第五十三轮结论一致), 设置只能改悬浮窗或 `config/config.json`; 本轮的 BOM/CRLF 修复已覆盖本次改动的 4 个文件, 但工具链**仍存在静默剥 BOM 的风险**, 后续每次改完带中文的项目文件都应复查前三字节是否为 `EF BB BF`。

## 2026-10-05 第六十一轮:UI 图标审查后的改进(关闭按钮一致性 / 托盘图标高分辨率 / 中文色牌取两字)

- **背景**: 用户要求审查项目 UI 图标并给出提升空间。审查结论:项目在**零 emoji 当图标、设计令牌统一、状态有文字兜底**上做得很好; 可提升点集中在"一致性"(关闭按钮的 Unicode `✕` 与文字按钮割裂)、托盘图标的光栅清晰度、以及中文昵称 monogram 的碰撞率。
- **关键判断(先查依赖再动手)**: 头部 `PinBtn` 的文字是**动态切换**的(`固定` ⇄ `自动收起`, 见 `Apply-Config` 与 `Add_Click` 两处), 说明头部按钮本质是**文字驱动**; 强行改成图标会丢失"固定/自动收起"的状态语义, 也与窗口"文字承载信息"的设计哲学冲突。**故不引入图标, 只按"文字一致性"处理关闭按钮。**
- **改动文件**: `scripts/overlay_window.ps1`
  1. **关闭按钮 `✕`(U+2715)→ 文字"关闭"**: 头部 5 个按钮(设置/固定/收起/最小化)本全是文字, 唯一用 `&#x2715;` 的关闭按钮受字体 fallback 影响、观感与其余按钮割裂。改为"关闭"后整条头部**统一为文字**, 零字体依赖。
  2. **托盘图标改 64×64 高分辨率渲染**: `New-TrayIcon` 原按 32×32 绘制。托盘会按 DPI 选 16/20/24/32 的小图标尺寸, 在 150%/200% 缩放或大任务栏下直接画 32 会糊。改为按 64×64 绘制(描边 2→4、矩形内缩 2、字号 18→36 等比放大), 交给系统**下采样**(优于上采样)。设计不变(深底 `#131920` + 氧化黄铜描边 + "L")。
  3. **中文 monogram 取前两字 + 自适应字号**: 新增 `Get-Monogram()` —— 拉丁名取首字母(大写); CJK 等非拉丁名(首字符 ≥ `0x2E80`)取**前两字**并把字号从 12 收到 9 以适配 22px 圆。消息列表 `New-MessageNode` 与字幕胶囊 `New-SubtitleChip` 两处色牌均改用它, **降低"张/章/赵"等同姓玩家的色牌碰撞**。
- **未做(有意)**: 头部按钮加矢量图标锚点 —— 因 `PinBtn` 文字随状态切换(固定⇄自动收起), 图标无法表达该状态; 且保留**文字头部**更一致。同时, 原审查里"游戏内'译'按钮加 tooltip"一条已在第六十轮随按钮删除而作废。
- **验证方式**(全部实测, 用 AST 从文件本体提取函数求值/实例化, 非复制粘贴):
  - `Parser::ParseFile` 语法通过(1961 行, 0 error); 前三字节复查 `EF BB BF`、LF-only=0(CRLF)。
  - **XAML 实例化**: 提取 `$script:Xaml` 插值后 `XamlReader::Parse` 成功 → `Title='DeadlockLingua'`、`CloseBtn.Content='关闭'`、`FontFamily='Bahnschrift SemiCondensed, Microsoft YaHei UI'`。
  - **`Get-Monogram` 实测**: `张三→[张三]9`、`张→[张]12`、`Alice→[A]12`、`alice→[A]12`、`''→[?]12`、`木子李→[木子]9`、`José→[J]12`、`Xx_ProGamer→[X]12`。
  - **`New-TrayIcon` 实测**: 生成 `64×64` 图标、无异常。
- **仍需用户测试**: 重启悬浮窗(或重开 `ShowOverlay.bat`)→ ① 头部关闭按钮显示为文字"关闭"; ② 托盘图标比之前更清晰(尤其高缩放屏); ③ 中文昵称玩家在消息列表/字幕里的色牌显示**两字**(如"张三"), 拉丁名仍为首字母。
- **已知限制**: ① 头部仍为纯文字, 未引入图标(理由见"未做"); ② 色牌虽取两字, 极端情况(同姓且名首字相同)仍可能同色; ③ 托盘图标仍是单分辨率源(64), 未做多分辨率 `.ico`; ④ `overlay_window.ps1` 非 VPK 内容, 改动**无需重新构建 VPK**, 但**需重启悬浮窗进程**才生效。
