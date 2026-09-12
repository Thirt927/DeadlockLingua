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
