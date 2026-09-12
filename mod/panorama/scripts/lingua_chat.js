// Babel Tower - Deadlock 聊天翻译 Panorama 脚本
// ------------------------------------------------------------------
// 独立实现(不复制任何现有 mod 代码),技术路线与 DLCT 一致:
//   扫描聊天行 -> 去重 -> 隐藏 HTML 面板桥接本地 Core -> 原文下方追加译文
// 约定:
//   - 严格 IIFE, UPPER_SNAKE_CASE 常量, camelCase 函数
//   - 所有 volatile 调用 try/catch 包裹
//   - 不假设浏览器 DOM API(fetch/setInterval/URLSearchParams 等不可用)
//   - $.Schedule 单位为秒
// 注意:
//   - 本脚本覆盖聊天布局后,TextEntry 提交由 LCTOnChatSubmit 接管,
//     命令/发送前翻译处理后,再派发 CitadelChatInputSubmitted 事件触发原版发送。
(() => {
  "use strict";

  const LOG_PREFIX = "[LCT]";
  const VERSION = "1.0.0";

  // ---- 原版聊天结构 ID(当前 Deadlock 版本稳定)----
  const CHAT_ROOT_ID = "Chat";
  const CHAT_MESSAGES_ID = "ChatMessages";
  const MESSAGE_SOURCE_ID = "MessageSource";
  const MESSAGE_CONTENTS_ID = "MessageContents";
  const MESSAGE_BODY_CLASS = "MessageBody";
  const CHAT_INPUT_ID = "ChatInput";
  const CHAT_TARGET_LABEL_ID = "ChatTargetLabel";
  const SENDER_NAME_CLASS = "SenderName";
  const CHANNEL_NAME_CLASS = "ChannelName";
  const LOCAL_CLIENT_ID = "SenderLocalClient";
  const TOPBAR_PLAYER_TYPE = "HudTopBarPlayer"; // original citadel_hud_top_bar_player.vxml root panel type
  const TOPBAR_PLAYER_TYPE_ALT = "CitadelHudTopBarPlayer";
  const TOPBAR_PLAYER_TYPE_ALTS = ["CitadelHudTopBarPlayer", "HudTopBarPlayer", "TopBarPlayer", "CitadelTopBarPlayer", "HudPlayerEntry"];
  const TOPBAR_ROOT_ID = "CitadelHudTopBar";
  const TOPBAR_ROOT_TYPE = "HudTopBar"; // current citadel_hud_top_bar.vxml root paneltype (no TeamsContainer; entries are JS-created)
  const RECON_TYPE_ALTS = ["Hud", "CitadelHudRoot", "HudTopBar", "CitadelHudTopBar", "Team1Chat", "CitadelHudTopBarChat"];
  const TOPBAR_TEAMS_ID = "TeamsContainer";
  const TOPBAR_PLAYER_NAME_CLASS = "PlayerName";
  const TOPBAR_PLAYER_NAME_CLASSES = ["PlayerName", "AlwaysPlayerName", "UserName", "PlayerNameLabel"];
  const TOPBAR_PLAYER_HERO_CLASS = "HeroName";
  const TOPBAR_PLAYER_HERO_CLASSES = ["HeroName", "PlayerHero", "HeroLabel", "HeroNameLabel"];
  const TOPBAR_SCAN_MAX_NODES = 20000;
  // 顶栏/玩家条目上可能的账号字段名(游戏版本不同命名不同;零交互被动读取)
  const TOPBAR_ACCOUNT_KEYS = ["account_id", "accountid", "accountID", "account", "steamid", "steam_id", "steamId", "steamID", "m_iSteamID", "m_steamID", "xuid", "playerid", "player_id", "playerId", "playerID", "m_playerID", "m_nPlayerID", "m_iPlayerID", "m_PlayerID", "m_PlayerId", "m_unAccountID", "m_accountID", "owner"];

  // ---- SteamID/identity collection panel types & ids (match original layouts) ----
  const ESCAPE_MENU_TYPE = "CitadelHudEscapeMenu";
  const ESCAPE_MENU_TYPE_ALTS = ["CitadelHudEscapeMenu", "HudEscapeMenu", "EscapeMenu", "CitadelEscapeMenu"];
  const ESCAPE_MENU_IDS = ["PlayersTab", "EscapeBackground", "ContextualMenu"];
  const PROFILE_CARD_TYPE = "CitadelProfileCard";
  const PROFILE_CARD_TYPE_ALTS = ["CitadelProfileCard", "ProfileCard", "CitadelMiniProfileCard"];
  const PROFILE_PAGE_TYPE = "CitadelProfilePage";
  const PROFILE_PAGE_TYPE_ALTS = ["CitadelProfilePage", "ProfilePage"];
  const PLAYER_ROW_TYPE = "CitadelPlayersListEntry";
  const PLAYER_ROW_TYPE_ALTS = ["CitadelPlayersListEntry", "PlayersListEntry", "CitadelPlayerRow"];
  const LCT_ROW_HERO_ID = "LCTRowHero";
  const LCT_ROW_ACCOUNT_ID = "LCTRowAccount";
  const LCT_PLAYER_ROW_CLASS = "LCTPlayerRow"; // root class added by our players_list_entry.xml override (type-independent)
  const LCT_PROFILE_CARD_CLASS = "LCTProfileCard"; // root class added by our profile_card.xml override
  const ESCAPE_OPEN_CLASS = "ShowEscapeMenu"; // class on Hud root while the ESC menu is open (same mechanism as showrank)
  const LCT_PROFILE_ACCOUNT_ID = "LCTProfileAccount";
  const LCT_PROFILE_PAGE_ACCOUNT_ID = "LCTProfilePageAccount";
  const STEAMID_ROW_DELAYS = [0.25, 1.0, 2.0, 4.0, 8.0];
  const STEAMID_PROBE_DELAYS = [0.05, 0.15, 0.3, 0.6, 1.0, 1.5, 2.0];
  const LCT_TOP_BAR_ACCOUNT_ID = "LCTTopBarAccount"; // topbar 覆盖版里的隐藏账号 Label
  const STEAMID_HOVER_PAIR_MS = 3000; // 资料卡账号与最近悬停玩家行配对的窗口
  const HOVER_SCAN_MS = 1000; // 悬停行轮询节流:1s 一次(悬停变化慢,避免每轮全树扫描拖慢主线程)

  // ---- ProfileCard 差异发现(自动识别 steamid/account 字段,不依赖固定字段名) ----
  // 原理:悬停两个不同玩家,资料卡上"随玩家变化"的字段里必有一个是账号;
  // 对比指纹差异即可发现字段名,之后直接按发现结果读取,不再盲试字段。
  const PROFILE_ACCOUNT_LABEL_IDS = ["AccountID", "AccountId", "AccountIDLabel", "AccountIdLabel", "AccountIDValue", "SteamID", "SteamId", "SteamIDLabel", "SteamIDValue", "PlayerID", "PlayerId", "Xuid", "XUID"];
  const PROFILE_DISCOVERY_MAX_LABELS = 60;
  const PROFILE_DISCOVERY_MAX_DEPTH = 8;
  // 差异发现时探测的候选字段名(比固定列表更广;命中后永久登记,后续直接读)
  const PROFILE_DISCOVERY_DLG_KEYS = ["account_id", "accountid", "accountID", "account", "steamid", "steam_id", "steamId", "steamID", "m_iSteamID", "m_steamID", "m_unAccountID", "m_accountID", "xuid", "player_id", "playerid", "playerId", "playerID", "m_playerID", "m_nPlayerID", "m_iPlayerID", "m_PlayerID", "owner", "player_slot", "slot", "team", "team_id", "teamid", "m_iTeam", "hero_id", "heroid", "heroId", "HeroID", "m_nHeroID", "hero_name", "heroName", "player_name", "playerName", "user_name", "username", "nickname", "display_name", "name"];
  const PROFILE_DISCOVERY_ATTR_KEYS = ["account_id", "accountid", "accountID", "account", "steamid", "steam_id", "steamId", "m_iSteamID", "m_steamID", "xuid", "player_id", "playerid", "playerId", "playerID", "m_playerID", "owner", "player_slot", "slot", "team", "team_id", "teamid", "hero_id", "heroid", "heroId", "HeroID", "m_nHeroID", "hero_name", "heroName", "player_name", "playerName", "user_name", "username", "name"];
  // ---- 顶栏 KDA / 赛后记分板(比赛摘要) ----
  const TOPBAR_KDA_CONTAINER_ID = "KDAContainer";
  const TOPBAR_KDA_STAT_CLASSES = ["KDAStats", "KDAStat", "KDAValue", "KDA_Kills", "KDA_Deaths", "KDA_Assists", "KillsValue", "DeathsValue", "AssistsValue"];
  const TOPBAR_SOULS_IDS = ["TotalSoulsContainer", "SoulsValue", "TotalSoulsValue"];
  const SCOREBOARD_TYPE = "CitadelPostGameScoreboardNew";
  const SCOREBOARD_TEAM_IDS = ["Team1", "Team2"];
  const SCOREBOARD_PLAYER_CLASS = "Player";
  const SCOREBOARD_LOCAL_CLASS = "IsLocalPlayer";
  const SCOREBOARD_WIN_CLASS = "IsWinningTeam";
  const SCOREBOARD_NAME_IDS = ["PlayerName", "UserName", "UserNickname"];
  const SCOREBOARD_STAT_IDS = {
    kills: ["KillsValue", "KDAKills", "KDA_Kills"],
    deaths: ["DeathsValue", "KDADeaths", "KDA_Deaths"],
    assists: ["AssistsValue", "KDAAssists", "KDA_Assists"],
    souls: ["SoulsValue", "TotalSoulsValue"],
    playerDmg: ["PlayerDmgValue", "DamageValue"],
    objDmg: ["ObjDmgValue"],
    healing: ["HealingValue"],
  };
  const SCOREBOARD_MATCH_ID = "MatchID";
  const SCOREBOARD_TIME_CLASS = "TimeLabel";
  const SCOREBOARD_SCAN_MS = 5000;

  // ---- Hero identification data (fallback for chat-row CitadelHeroImage) ----
  // hero image file stem (without .vtex) -> display hero name; legacy/internal stems included
  const HERO_IMAGE_TO_NAME = {
    "abrams": "abrams", "bebop": "bebop", "calico": "calico", "chrono": "chrono",
    "dynamo": "dynamo", "fathom": "fathom", "forge": "forge", "ghost": "ghost",
    "gunslinger": "gunslinger", "haze": "haze", "holliday": "holliday",
    "ivy": "ivy", "kelvin": "kelvin", "lash": "lash", "mcginnis": "mcginnis",
    "mirage": "mirage", "paradox": "paradox", "pocket": "pocket", "seven": "seven",
    "shiv": "shiv", "sinclair": "sinclair", "slork": "slork", "synth": "synth",
    "viscous": "viscous", "vyper": "vyper", "warden": "warden", "wraith": "wraith",
    "wrecker": "wrecker", "yamato": "yamato",
    // legacy/internal image stems -> current display name
    "bull": "abrams", "nano": "calico", "astro": "holliday", "archer": "grey talon",
    "digger": "mo & krill", "tengu": "ivy", "engineer": "mcginnis", "hornet": "vindicta",
    "spectre": "lady geist", "sumo": "dynamo", "gigawatt": "seven", "inferno": "infernus",
    "geist": "lady geist", "bookworm": "paige", "fencer": "apollo", "familiar": "rem",
    "magician": "sinclair", "necro": "graves", "operative": "raven", "priest": "venator",
    "punkgoat": "billy", "unicorn": "celeste", "vampirebat": "mina", "werewolf": "silver",
    "frank": "victor", "yakuza": "the boss", "kali": "vyper", "viper": "vyper",
    "doorman": "the doorman", "skyrunner": "skyrunner", "swan": "swan", "trapper": "trapper"
  };
  // localized (zh-Hans) hero display name -> English key. Game-rendered labels
  // (topbar HeroName / {g:citadel_hero_name} labels) are localized per client
  // language; reverse mapping keeps chat logs in English hero names.
  const ZH_HERO_TO_EN = {
    "沃督": "warden", "大和": "yamato", "炽焱": "infernus", "柒": "seven",
    "薇妲": "vindicta", "灰爪": "grey talon", "盖斯特夫人": "lady geist",
    "亚伯兰": "abrams", "灵魅": "wraith", "麦金妮": "mcginnis", "悖论": "paradox",
    "奇能": "dynamo", "开尔文": "kelvin", "魔液": "viscous", "岚梦": "haze",
    "哈雷黛": "holliday", "比波普": "bebop", "卡厉可": "calico", "莫克双雄": "mo & krill",
    "希弗": "shiv", "青藤": "ivy", "破坏王": "wrecker", "劳什": "lash",
    "阿金驳": "akimbo", "口袋": "pocket", "蜃景": "mirage", "海魇": "fathom",
    "蝰邪": "vyper", "无双魔术师": "sinclair", "陷阱师": "trapper", "渡鸦": "raven",
    "维克多": "victor", "米娜": "mina", "孤猎": "drifter", "诛邪者": "venator",
    "佩吉": "paige", "波米": "boho", "门侍": "the doorman", "天鹅舞伶": "swan",
    "御空行者": "skyrunner", "比利": "billy", "雷姆": "rem", "赛凌": "celeste",
    "阿波罗": "apollo", "格瑞墓": "graves", "西尔芙": "silver"
  };

  // best-effort hero id -> display name (ids from game hero prefab data; may grow)
  const HERO_ID_TO_NAME = {
    "1": "infernus", "2": "seven", "3": "vindicta", "4": "lady geist", "6": "abrams",
    "7": "wraith", "8": "mcginnis", "10": "paradox", "11": "dynamo", "12": "kelvin",
    "13": "haze", "14": "holliday", "15": "bebop", "16": "calico", "17": "grey talon",
    "18": "mo & krill", "19": "shiv", "20": "ivy", "25": "warden", "27": "yamato",
    "31": "lash", "35": "viscous", "50": "pocket", "52": "mirage", "58": "vyper",
    "60": "sinclair", "63": "mina", "64": "drifter", "65": "venator", "66": "victor",
    "67": "paige", "69": "the doorman", "72": "billy", "76": "graves", "77": "apollo",
    "79": "rem", "80": "silver", "81": "celeste"
  };
  const HERO_NAME_TO_ID = {};
  (function () {
    for (const hid of Object.keys(HERO_ID_TO_NAME)) HERO_NAME_TO_ID[HERO_ID_TO_NAME[hid]] = hid;
  })();
  const HERO_NAMES = [];
  (function () {
    const seen = {};
    for (const k of Object.keys(HERO_IMAGE_TO_NAME)) {
      const n = HERO_IMAGE_TO_NAME[k];
      if (!seen[n]) { seen[n] = true; HERO_NAMES.push(n); }
    }
  })();

  // ---- HUD 顶栏聊天结构(citadel_hud_top_bar_chat.vxml,与 QoL 类 HUD mod 兼容:不改布局只扫描)----
  const HUD_CHAT_CLASS = "CitadelHudTopBarChat"; // 面板类型(Team1Chat/Team2Chat 两个实例);type 不是 class,遍历不到,仅作兕底
  const HUD_CHAT_IDS = ["Team1Chat", "Team2Chat"]; // 布局写死的固定 id(主查找路径)
  const HUD_MESSAGES_ID = "Messages"; // 顶栏气泡容器
  const HUD_BUBBLE_CLASS = "ChatBubble"; // 气泡(区分 HUD 行与左下聊天行)
  const HUD_TEXT_ID = "MessageText"; // 气泡内文本 Label
  const TRANS_LABEL_HUD_CLASS = "LCTTranslationHud";
  const TRANS_LABEL_LOBBY_CLASS = "LCTTranslationLobby";

  // ---- 大厅聊天结构(hudchat.vxml:ChatLinesPanel 容器,行=ChatLineContainer)----
  const CHAT_LINES_PANEL_ID = "ChatLinesPanel";
  const LOBBY_ROW_CLASS = "ChatLineContainer";
  const LOBBY_LINE_CLASS = "ChatLine";
  const LOBBY_PERSONA_CLASS = "ChatPersona";
  const LOBBY_PREFIX_CLASS = "ChatLinePrefix";

  // ---- LinguaChat 自身 ID / class ----
  const SETTINGS_BUTTON_ID = "LCTSettingsButton";
  const SETTINGS_PANEL_ID = "LCTSettingsPanel";
  const SETTINGS_VISIBLE_CLASS = "LCTVisible";
  const STATUS_LABEL_ID = "LCTStatusLabel";
  const TRANS_LABEL_CLASS = "LCTTranslation";
  const TRANS_ERROR_CLASS = "LCTTranslationError";
  const BRIDGE_PANEL_ID = "LCTBridgePanel";
  const BRIDGE_PANEL_CLASS = "LCTBridgePanel";

  // ---- 轮询节奏 ----
  const FAST_POLL_SECONDS = 0.2;
  // ---- 扫描节流:身份/菜单扫描是整棵 HUD 树遍历,绝不能随聊天轮询每轮执行 ----
  const TOPBAR_REFRESH_MS = 20000; // 顶栏身份扫描:20s 一次(昵称/英雄映射基本不变,实时性只属于翻译)
  const ROSTER_POLL_MS = 5000; // ESC 菜单轮询:5s 一次
const STEAMID_ROSTER_MAX_ATTEMPTS = 3; // 每局主动采集轮次上限(防异常误判反复开卡)
  const PROFILE_LOOP_SECONDS = 15.0; // ProfileCard 周期扫描:15s 一次(且只在卡片存在时真扫)
  const SLOW_POLL_SECONDS = 0.8;
  const BOOTSTRAP_TAIL_SCAN_LIMIT = 24; // 首次只扫末尾,避免翻历史
  const LOW_LATENCY_TAIL_SCAN_LIMIT = 6; // 每次额外扫末尾,保证低延迟
  const TITLE_POLL_SECONDS = 0.1;
  const BRIDGE_ALIVE_SECONDS = 1.5; // 桥页面存活标记的等待上限
  const RETRY_LIMIT = 2; // 每条消息最多尝试次数(含首次)
  const RETRY_DELAY_SECONDS = 0.4;
  const OUTGOING_TIMEOUT_MS = 30000; // 出站翻译超时:超过则按原文发送,避免卡住重复按键。8s 覆盖 DeepSeek 等 API 服务商正常延迟(1-6s)及 Bing 冷启动;计时从任务开始处理算起(见 dispatchJob)
  const CACHE_LIMIT = 300;
  const SEEN_LIMIT = 500;
  const PLAYER_INFO_SCAN_LIMIT = 24; // Players.GetPlayerInfo 扫描上限(含自己)
  const LOG_DEDUP_WINDOW_MS = 15000; // HUD/未填充条目与完整条目的日志去重窗口
  const LOG_DEDUP_LIMIT = 128; // recentLogs 去重缓存上限
  const HUD_SATISFIED_WINDOW_MS = 90000; // 完整行顶掉 HUD 占位后的长去重窗口(防同文本 <unknown> 重复)
  const PENDING_LOG_TIMEOUT_MS = 6000; // 未填充完整条目的挂起等待窗口(超时才兜底落盘)
  const HUD_SENDER_MATCH_MS = 30000; // 气泡/未知行与已知完整行的文本回填窗口
  const RECENT_ROWS_LIMIT = 48; // 已知完整行缓存上限(sender 回填用)
  const MAX_ACTIVE_REQUESTS = 1; // 传输层单槽(HTML 面板+title 轮询),并发>1 会产生 supersede 竞争,保持串行
  const UNKNOWN_NAME = "<unknown>";

  // ---- 本地桥 ----
  const BRIDGE_HOST = "127.0.0.1";
  const BRIDGE_PORT = 8791; // 与 core/config.json 保持一致
  const TITLE_PREFIX = "LCT";
  const TITLE_ALIVE = "lct-alive";

  // ---- 语言启发式 ----
  const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff]/;

  // ---- 状态 ----
  const State = {
    chat: null,
    messages: null,
    input: null,
    targetLabel: null,
    scannedCount: 0,
    hudMessages: [], // HUD 顶栏聊天 Messages 容器列表(Team1Chat/Team2Chat)
    hudScanned: [], // 每个 HUD 容器已扫描的行数
    lobbyMessages: null, // 大厅聊天容器(ChatLinesPanel,hudchat)
    lobbyScanned: 0, // 大厅容器已扫描行数
    hudLogged: false,
    bootLogged: false,
    seen: new Set(), // 消息签名去重
    cache: new Map(), // 签名 -> { translation }
    queue: [], // 待翻译任务
    activeRequests: 0,
    requestSeq: 0,
    outgoingPending: null, // 发送翻译中的文本(去重:同文本重复按 Enter 忽略)
    panel: null, // 隐藏 HTML 桥面板(在 chat.xml 中用 <HTML> 标签声明)
    panelLogged: false,
    eventsRegistered: false,
    pending: null, // 统一在途桥请求 { id, onResult, deadline, sawAlive }
    bridgeUp: false,
    panelWarned: false,
    cfg: null, // 游戏侧 UI 配置
    bridgeUp: false, // 桥在线标记(health 探测维护)
    bridgeOfflineSince: 0,
    canHttp: null, // 直连通道(AsyncWebRequest)可用性,启动后探测一次;null=未探测
    logBuffer: [], // 聊天日志缓冲(批量推送到桥)
    logFlushing: false,
    matchId: null, // 当前比赛 ID(缓存)
    nickInfoCache: null, // 昵称 -> { hero, heroId, steamid }(Players API 匹配缓存)
    accountByHero: null, // hero -> SteamID64 captured from profile cards
    accountByName: null, // normalized nickname -> SteamID64 captured from profile cards
    heroByName: null, // normalized nickname -> hero captured from profile cards
    nameByHero: null, // normalized hero -> display name captured from profile cards
    topbarHeroByName: null, // current-match nickname -> hero from TopBar
    topbarNameByHero: null, // current-match hero -> nickname from TopBar
    selfName: "", // best-known local player nickname
    topbarScanned: false,
    topbarNextRefresh: 0,
    topbarDeepNextScan: 0, // 全树类型深度兜底节流(与 findTopbarPlayerEntries 内部策略分开,防双倍扫描)
    rosterNextPoll: 0,
    tooltipNextProbe: 0,
    profileScanNextRefresh: 0,
    steamIdEscape: null,
    steamIdRosterCollected: false,
    steamIdRosterSignature: "",
    steamIdDiagLogged: false,
    steamIdFoundLogged: false,
    heroImgProbed: false,
    steamIdRosterNextAttempt: 0,
    profileAccountSeen: null, // dedupe log for profile card diagnostics
    profileEmptyLogged: 0, // last diag time when a visible profile card had no account
    topbarEmptyLogged: 0, // last diag time when topbar had 0 entries
    topbarHeroLogged: 0, // last diag time when topbar entries had no hero
    hoverRow: null, // 最近悬停的玩家行 { panel, hero, name, t }(悬停配对用)
    discoveredAccount: null, // 差异发现结果:{ labelIds, labelClasses, dlgKeys, attrKeys, propKeys, via, accountA, accountB }
    lastProfileFingerprint: null, // 最近一次资料卡指纹 { hero, name, account, fp }
    liveStats: null, // 顶栏实时 KDA/灵魂:normName -> { kills, deaths, assists, souls, hero }
    scoreboardNextScan: 0,
    summarySent: false, // 本局赛后摘要已发送(去重)
    recentLogs: new Map(), // 最近完整日志文本(去重 HUD 重复/未填充条目)
    hudSatisfied: new Map(), // HUD placeholder long-window dedup
    recentRows: [], // 最近已知 sender 的完整行(归一化文本匹配,用于气泡/未知行回填)
    pendingLogs: {}, // 挂起的未填充完整日志:文本\x00isOwn\x00sender -> { entry, t }
  };

  // ---- cross-layout identity sharing -------------------------------------
  // chat.xml (in-match chat tree) and hudchat.xml (HUD tree) each load this
  // script with an independent State. The topbar identity maps are collected
  // by the HUD-tree instance; the chat-tree instance writes chat logs. Share
  // the maps through globalThis so chat logs can resolve hero/steamid.
  function sharedIdentityStore() {
    try {
      const g = globalThis || {};
      if (!g.__LCT_SHARED_IDENTITY__) {
        g.__LCT_SHARED_IDENTITY__ = {
          topbarHeroByName: null,
          topbarNameByHero: null,
          accountByName: null,
          accountByHero: null,
          heroByName: null,
          nameByHero: null,
          selfName: "",
        };
      }
      return g.__LCT_SHARED_IDENTITY__;
    } catch (e) {
      return null;
    }
  }

  // Merge identity maps between this instance's State and the shared store.
  // Object references are copied both ways so either instance's writes are
  // visible to the other on the next poll/message.
  function syncSharedIdentity() {
    try {
      const s = sharedIdentityStore();
      if (!s) return;
      const pairs = [["topbarHeroByName", "topbarNameByHero"], ["accountByName", "accountByHero"], ["heroByName", "nameByHero"]];
      for (let i = 0; i < pairs.length; i += 1) {
        const a = pairs[i][0];
        const b = pairs[i][1];
        if (s[a] && !State[a]) State[a] = s[a];
        if (s[b] && !State[b]) State[b] = s[b];
        if (State[a]) s[a] = State[a];
        if (State[b]) s[b] = State[b];
      }
      if (s.selfName && !State.selfName) State.selfName = s.selfName;
      if (State.selfName) s.selfName = State.selfName;
    } catch (e) {}
  }

  // ================= 工具函数 =================

  function nowMs() {
    return Date.now ? Date.now() : 0;
  }

  function isValid(panel) {
    return !!(panel && (!panel.IsValid || panel.IsValid()));
  }

  function safeText(panel) {
    try {
      return String((panel && panel.text) || "").replace(/\s+/g, " ").trim();
    } catch (e) {
      return "";
    }
  }

  function childCount(panel) {
    if (!isValid(panel) || typeof panel.GetChildCount !== "function") return 0;
    try {
      return panel.GetChildCount() || 0;
    } catch (e) {
      return 0;
    }
  }

  function childAt(panel, index) {
    if (!isValid(panel) || typeof panel.GetChild !== "function") return null;
    try {
      return panel.GetChild(index);
    } catch (e) {
      return null;
    }
  }

  function hasClass(panel, className) {
    if (!isValid(panel) || typeof panel.BHasClass !== "function") return false;
    try {
      return panel.BHasClass(className);
    } catch (e) {
      return false;
    }
  }

  function findChild(root, id) {
    if (!isValid(root) || typeof root.FindChildTraverse !== "function") return null;
    try {
      const found = root.FindChildTraverse(id);
      return isValid(found) ? found : null;
    } catch (e) {
      return null;
    }
  }

  function findClass(root, className) {
    if (!isValid(root)) return null;
    if (typeof root.FindChildrenWithClassTraverse === "function") {
      try {
        const matches = root.FindChildrenWithClassTraverse(className);
        if (matches && matches.length) {
          for (let i = 0; i < matches.length; i += 1) {
            if (isValid(matches[i])) return matches[i];
          }
        }
      } catch (e) {}
    }
    if (hasClass(root, className)) return root;
    // 兜底递归必须带节点预算:root 可能是整棵 HUD 树,无预算递归会卡死主线程(黑屏)
    const budget = { visited: 0 };
    const limit = 3000;
    function walk(panel) {
      if (!isValid(panel)) return null;
      budget.visited += 1;
      if (budget.visited > limit) return null;
      if (hasClass(panel, className)) return panel;
      const count = childCount(panel);
      for (let i = 0; i < count; i += 1) {
        const found = walk(childAt(panel, i));
        if (found) return found;
      }
      return null;
    }
    return walk(root);
  }

  function getRoot() {
    let root = $.GetContextPanel();
    while (root && root.GetParent && root.GetParent()) root = root.GetParent();
    return root;
  }

  function scanPanelsByType(root, type, maxDepth, maxNodes) {
    const out = [];
    const budget = { visited: 0 };
    const depthLimit = (maxDepth === undefined || maxDepth === null) ? 80 : maxDepth;
    const nodeLimit = (maxNodes === undefined || maxNodes === null) ? TOPBAR_SCAN_MAX_NODES : maxNodes;
    function visit(panel, depth) {
      if (!isValid(panel) || depth > depthLimit || budget.visited >= nodeLimit) return;
      budget.visited += 1;
      try {
        if (String(panel.paneltype || "") === type) out.push(panel);
      } catch (e) {}
      const count = childCount(panel);
      for (let i = 0; i < count; i += 1) visit(childAt(panel, i), depth + 1);
    }
    visit(root, 0);
    out.__visited = budget.visited;
    return out;
  }

  function findAllPanelsByType(root, type) {
    // 兜底扫描统一压预算:深度放宽但总节点 3000 封顶,避免任何轮询路径拖慢主线程
    return scanPanelsByType(root, type, 80, 3000);
  }

  function collectPanelsByIds(root, ids, maxDepth, out, budget) {
    if (!isValid(root) || maxDepth < 0) return;
    const st = budget || { nodes: 0 };
    st.nodes += 1;
    if (st.nodes > 4000) return;
    if (typeof root.FindChildTraverse === "function") {
      try {
        for (let i = 0; i < ids.length; i += 1) {
          const found = root.FindChildTraverse(ids[i]);
          if (isValid(found)) out.push(found);
        }
      } catch (e) {}
    }
    const count = childCount(root);
    for (let i = 0; i < count; i += 1) collectPanelsByIds(childAt(root, i), ids, maxDepth - 1, out, st);
  }

  function detectTopbarTeamSide(panel) {
    let current = panel;
    let depth = 0;
    while (isValid(current) && depth < 32) {
      try {
        const id = String(current.id || "");
        if (id === "TeamFriendly") return "friendly";
        if (id === "TeamEnemy") return "enemy";
        current = current.GetParent && current.GetParent();
      } catch (e) {
        current = null;
      }
      depth += 1;
    }
    return "";
  }

  function collectPanelsByClasses(root, classes, maxDepth, out, budget) {
    if (!isValid(root) || maxDepth < 0) return;
    const st = budget || { nodes: 0, hits: 0 };
    st.nodes += 1;
    if (st.nodes > 4000) return;
    if (typeof root.FindChildrenWithClassTraverse === "function") {
      try {
        for (let c = 0; c < classes.length; c += 1) {
          const matches = root.FindChildrenWithClassTraverse(classes[c]) || [];
          for (let i = 0; i < matches.length; i += 1) {
            if (!isValid(matches[i])) continue;
            out.push(matches[i]);
            st.hits += 1;
            if (st.hits >= 200) return;
          }
        }
        return;
      } catch (e) {}
    }
    for (let c = 0; c < classes.length; c += 1) {
      if (hasClass(root, classes[c])) {
        out.push(root);
        st.hits += 1;
        if (st.hits >= 200) return;
      }
    }
    const count = childCount(root);
    for (let i = 0; i < count; i += 1) collectPanelsByClasses(childAt(root, i), classes, maxDepth - 1, out, st);
  }

  // 结构兜底扫描:不依赖 paneltype(不同游戏版本差异大),用固定 id + class 定位玩家条目。
  function findTopbarPlayerEntries(root) {
    const out = [];
    if (!isValid(root)) return out;
    const seen = new Set();
    const add = function (entry) {
      if (!isValid(entry) || seen.has(entry)) return;
      seen.add(entry);
      out.push(entry);
    };
    // 定位条目容器:优先顶栏根,回退全树(新版顶栏根类型是 HudTopBar)
    let entryScope = root;
    try {
      const topBar = findChild(root, TOPBAR_ROOT_ID) || findChild(root, "HudTopBar");
      if (isValid(topBar)) entryScope = topBar;
    } catch (e) {}
    const isEntryType = function (panel) {
      try {
        return TOPBAR_PLAYER_TYPE_ALTS.indexOf(String(panel.paneltype || "")) >= 0;
      } catch (e) {
        return false;
      }
    };
    // 反查最近条目容器:Label/Badge -> 祖先中 paneltype 匹配的面板。
    // 只读 paneltype(属性访问,毫秒级);绝不在这里做 findClass 子树递归(会把主线程卡死)。
    const nearestEntry = function (panel) {
      for (let p = panel, d = 0; isValid(p) && d < 20; p = (p.GetParent ? p.GetParent() : null), d += 1) {
        if (p === entryScope || p === root) break;
        if (isEntryType(p)) return p;
      }
      return null;
    };
    // 1) 固定 id 前缀 TopBarPlayer0..23(旧版顶栏条目 id):
    //    先探测 TopBarPlayer0 是否存在,避免新版(无此 id)每轮白跑 24 次全树遍历
    try {
      const hasLegacyIds = !!(entryScope.FindChildTraverse && isValid(entryScope.FindChildTraverse("TopBarPlayer0")));
      if (hasLegacyIds) {
        for (let i = 0; i < 24; i += 1) {
          const p = entryScope.FindChildTraverse ? entryScope.FindChildTraverse("TopBarPlayer" + i) : null;
          if (isValid(p)) add(p);
        }
      }
    } catch (e) {}
    // 2) TeamsContainer 内按 HeroName 标签反查条目容器(玩家名+英雄名同容器,旧版)
    let scope = null;
    try {
      const topBar = findChild(root, TOPBAR_ROOT_ID);
      if (isValid(topBar)) scope = findChild(topBar, TOPBAR_TEAMS_ID);
    } catch (e) {}
    if (!isValid(scope)) scope = findChild(root, TOPBAR_TEAMS_ID);
    if (isValid(scope)) {
      const heroLabels = [];
      collectPanelsByClasses(scope, TOPBAR_PLAYER_HERO_CLASSES, 32, heroLabels);
      for (let i = 0; i < heroLabels.length; i += 1) {
        const hl = heroLabels[i];
        if (!isValid(hl) || !safeText(hl)) continue;
        let entry = hl;
        let foundName = false;
        for (let p = hl, d = 0; isValid(p) && d < 12; p = (p.GetParent ? p.GetParent() : null), d += 1) {
          if (p === scope) break;
          for (let k = 0; k < TOPBAR_PLAYER_NAME_CLASSES.length; k += 1) {
            const nl = findClass(p, TOPBAR_PLAYER_NAME_CLASSES[k]);
            if (isValid(nl) && safeText(nl)) { entry = p; foundName = true; break; }
          }
          if (foundName) break;
        }
        if (foundName) add(entry);
      }
    }
    // 4) HeroBadge/HeroImage id 反查(新版条目内英雄徽章):
    //    优先单次原生 FindChildrenWithAttributeTraverse(旧实现每节点 FindChildTraverse 是 O(N^2))
    const badges = [];
    if (entryScope.FindChildrenWithAttributeTraverse) {
      try {
        const m1 = entryScope.FindChildrenWithAttributeTraverse("id", "HeroBadge") || [];
        for (let i = 0; i < m1.length; i += 1) badges.push(m1[i]);
      } catch (e) {}
      try {
        const m2 = entryScope.FindChildrenWithAttributeTraverse("id", "HeroImage") || [];
        for (let i = 0; i < m2.length; i += 1) badges.push(m2[i]);
      } catch (e) {}
    } else {
      collectPanelsByIds(entryScope, ["HeroBadge", "HeroImage"], 80, badges);
    }
    for (let i = 0; i < badges.length; i += 1) {
      const badge = badges[i];
      if (!isValid(badge)) continue;
      const entry = nearestEntry(badge);
      if (isValid(entry)) add(entry);
    }
    // 4.5) PlayerName class 反查(原生 FindChildrenWithClassTraverse 无预算限制,recon 已验证):
    // 新版顶栏条目常无 HeroBadge/HeroImage id,但 PlayerName Label 一定存在
    try {
      if (root.FindChildrenWithClassTraverse) {
        const nameMatches = entryScope.FindChildrenWithClassTraverse
          ? (entryScope.FindChildrenWithClassTraverse("PlayerName") || [])
          : [];
        for (let n = 0; n < nameMatches.length && n < 24; n += 1) {
          const entry = nearestEntry(nameMatches[n]);
          if (isValid(entry)) add(entry);
        }
      }
    } catch (e) {}
    // 5) type 扫描兜底(版本回退):作用域优先顶栏根(小树,预算充足),找不到再回退整树
    if (out.length === 0) {
      if (!State.topbarTypeNextScan || nowMs() >= State.topbarTypeNextScan) {
        State.topbarTypeNextScan = nowMs() + 10000; // 全树 type 兑底很贵(5 类型×3000 节点):找不到时 10s 才重试
        const scopes = [];
        if (isValid(entryScope) && entryScope !== root) scopes.push(entryScope);
        scopes.push(root);
        for (let s = 0; s < scopes.length && out.length === 0; s += 1) {
          const isScope = scopes[s] === entryScope;
          for (let t = 0; t < TOPBAR_PLAYER_TYPE_ALTS.length; t += 1) {
            const typePlayers = scanPanelsByType(scopes[s], TOPBAR_PLAYER_TYPE_ALTS[t], 80, isScope ? 20000 : 3000);
            for (let i = 0; i < typePlayers.length; i += 1) add(typePlayers[i]);
          }
        }
      }
    }
    return out;
  }

  // ---- 场景侦察:启动后一次性 dump 顶栏/HUD/ESC 关键子树,定位玩家条目真实创建位置 ----
  function dumpReconTree(panel, label, depth, maxDepth) {
    if (!isValid(panel) || depth > maxDepth) return;
    const id = panelId(panel);
    const cls = panelClass(panel);
    const text = safeText(panel).slice(0, 60);
    const dlg = panelDialogSummary(panel);
    if (id || cls || text || dlg) {
      diagLog(label + " d=" + depth + " id=" + id + " type=" + String(panel.paneltype || "") + " class=" + cls + " text=" + text + (dlg ? " dlg={" + dlg + "}" : ""));
    }
    const count = childCount(panel);
    for (let i = 0; i < count && i < 14; i += 1) {
      dumpReconTree(childAt(panel, i), label + "." + i, depth + 1, maxDepth);
    }
  }

  function reconScene() {
    try {
      const root = getRoot();
      if (!isValid(root)) return;
      diagLog("recon root id=" + panelId(root) + " type=" + String(root.paneltype || "") + " class=" + panelClass(root) + " children=" + childCount(root));
      const chainParts = [];
      for (let p = root, d = 0; isValid(p) && d < 12; p = (p.GetParent ? p.GetParent() : null), d += 1) {
        chainParts.push(panelId(p) + "/" + String(p.paneltype || ""));
      }
      diagLog("recon rootChain=" + chainParts.join(" > "));
      // 线索侦察:全局定位玩家条目(PlayerName class / HeroBadge / HeroImage),打印完整祖先链,
      // 确定新版 UI 里条目到底建在哪个 paneltype 容器下(原生 API,只跑一次,毫秒级)
      const clues = [];
      const seenClues = new Set();
      const addClue = function (p, tag) {
        if (!isValid(p) || seenClues.has(p)) return;
        seenClues.add(p);
        clues.push({ p: p, tag: tag });
      };
      try {
        const nameMatches = root.FindChildrenWithClassTraverse ? root.FindChildrenWithClassTraverse("PlayerName") : [];
        for (let i = 0; i < nameMatches.length && i < 12; i += 1) addClue(nameMatches[i], "cls:PlayerName");
      } catch (e) {}
      try {
        const badgeMatches = root.FindChildrenWithAttributeTraverse ? root.FindChildrenWithAttributeTraverse("id", "HeroBadge") : [];
        for (let i = 0; i < badgeMatches.length && i < 12; i += 1) addClue(badgeMatches[i], "id:HeroBadge");
      } catch (e) {}
      try {
        const imgMatches = root.FindChildrenWithAttributeTraverse ? root.FindChildrenWithAttributeTraverse("id", "HeroImage") : [];
        for (let i = 0; i < imgMatches.length && i < 12; i += 1) addClue(imgMatches[i], "id:HeroImage");
      } catch (e) {}
      if (clues.length === 0) {
        diagLog("recon clue: no PlayerName/HeroBadge/HeroImage found in whole tree");
      }
      for (let i = 0; i < clues.length; i += 1) {
        const clue = clues[i];
        const chain = [];
        for (let p = clue.p, d = 0; isValid(p) && d < 16; p = (p.GetParent ? p.GetParent() : null), d += 1) {
          chain.push(panelId(p) + "|" + String(p.paneltype || "") + "|" + panelClass(p));
        }
        diagLog("recon clue " + clue.tag + " text=" + safeText(clue.p).slice(0, 40) + " chain=" + chain.join(" <- "));
      }
      // 只用原生 FindChildTraverse 定位关键子树(毫秒级),不做全树 type 扫描,避免启动卡顿
      const targets = [];
      const seen = new Set();
      const addTarget = function (p) { if (isValid(p) && !seen.has(p)) { seen.add(p); targets.push(p); } };
      for (const id of ["Team1Chat", "Team2Chat", "Hud", "HudTopBar", "CitadelHudTopBar", "PlayersTab", "PlayersTabContents"]) {
        addTarget(findChild(root, id));
      }
      for (let i = 0; i < targets.length; i += 1) {
        const panel = targets[i];
        diagLog("recon target id=" + panelId(panel) + " type=" + String(panel.paneltype || "") + " class=" + panelClass(panel) + " children=" + childCount(panel));
        dumpReconTree(panel, "recon", 0, 1);
      }
      const players = findTopbarPlayerEntries(root);
      diagLog("recon topbar players=" + players.length);
      for (let i = 0; i < players.length && i < 5; i += 1) {
        const info = readTopbarIdentity(players[i]);
        diagLog("recon player[" + i + "] id=" + panelId(players[i]) + " type=" + String(players[i].paneltype || "") + " class=" + panelClass(players[i]) + " name=" + String(info && info.name || "") + " hero=" + String(info && info.hero || ""));
      }
      // ESC 菜单:廉价 findChild 定位(不做 findEscapeMenuRoot 的全树 type 扫描)
      const escTab = findChild(root, "PlayersTab");
      diagLog("recon escapeRoot=" + (isValid(escTab) ? "PlayersTab-found" : "not-found"));
      if (isValid(escTab)) dumpReconTree(escTab, "reconESC", 0, 1);
    } catch (e) {
      diagLog("recon failed: " + (e && e.message ? e.message : String(e)));
    }
  }

  function readTopbarIdentity(panel) {
    if (!isValid(panel)) return null;
    let name = "";
    for (let i = 0; i < TOPBAR_PLAYER_NAME_CLASSES.length; i += 1) {
      const label = findClass(panel, TOPBAR_PLAYER_NAME_CLASSES[i]);
      const text = safeText(label);
      if (text) { name = text; break; }
    }
    if (!name) name = panelDialogString(panel, ["player_name", "user_name", "PlayerName", "name", "playerName"]);
    let hero = "";
    for (let i = 0; i < TOPBAR_PLAYER_HERO_CLASSES.length; i += 1) {
      const label = findClass(panel, TOPBAR_PLAYER_HERO_CLASSES[i]);
      const text = safeText(label);
      if (text) { hero = text; break; }
    }
    if (!hero) hero = panelDialogString(panel, ["hero_name", "hero", "heroName", "HeroName", "heroname"]);
    if (!hero) {
      const badge = findChild(panel, "HeroBadge");
      if (isValid(badge)) {
        hero = readHeroFromHeroImage(badge) ||
          panelAttrString(badge, ["hero", "hero_name", "heroName", "hero_id", "heroId", "HeroID"]) ||
          panelPropString(badge, ["hero", "hero_name", "hero_id", "heroId", "HeroID", "m_nHeroID", "m_iHeroID"]);
      }
    }
    if (!hero) {
      const img = findChild(panel, "HeroImage");
      if (isValid(img)) hero = readHeroFromHeroImage(img);
    }
    hero = normalizeHeroName(normName(hero));
    let account = readProfileAccount(panel);
    if (!account) {
      // 顶栏条目本身可能不带账号字段:再探测 HeroBadge/HeroImage 子面板
      const probes = [];
      const badge = findChild(panel, "HeroBadge");
      if (isValid(badge)) probes.push(badge);
      const img = findChild(panel, "HeroImage");
      if (isValid(img)) probes.push(img);
      for (let i = 0; i < probes.length; i += 1) {
        const v = profileString(probes[i], TOPBAR_ACCOUNT_KEYS);
        if (v && looksLikeSteamAccount(v)) {
          account = normalizeSteamValue(v);
          break;
        }
      }
    }
    if (!account) {
      // passive probe: candidate hidden labels with different binding variables
      const probeIds = ["LCTTopBarAccount", "LCTTopBarAccount2", "LCTTopBarAccount3", "LCTTopBarAccount4", "LCTTopBarAccount5", "LCTTopBarAccount6"];
      const probeVals = [];
      for (let pi = 0; pi < probeIds.length; pi += 1) {
        const lbl = findChild(panel, probeIds[pi]);
        const v = safeText(lbl);
        probeVals.push(String(v || ""));
        if (v && looksLikeSteamAccount(v)) {
          account = normalizeSteamValue(v);
          break;
        }
      }
      if (!State.topbarAccountProbeLogged) {
        State.topbarAccountProbeLogged = true;
        diagLog("topbar account probe: " + probeIds.map(function (id, i) { return id + "=" + probeVals[i]; }).join(" "));
      }
    }
    if (account && !looksLikeSteamAccount(account)) account = "";
    let local = false;
    try {
      local = hasClass(panel, "IsSelf") || (typeof panel.BAscendantHasClass === "function" && panel.BAscendantHasClass("IsSelf"));
    } catch (e) {}
    return { name: name, hero: hero, account: account, local: local, stats: readTopbarStats(panel) };
  }

  // 顶栏实时战绩:#KDAContainer 内 3 个数字(Kills/Deaths/Assists),灵魂取 TotalSoulsContainer
  function readTopbarStats(panel) {
    const stats = { kills: "", deaths: "", assists: "", souls: "" };
    try {
      const kda = findChild(panel, TOPBAR_KDA_CONTAINER_ID);
      if (isValid(kda)) {
        const nums = [];
        for (let i = 0; i < TOPBAR_KDA_STAT_CLASSES.length; i += 1) {
          const label = findClass(kda, TOPBAR_KDA_STAT_CLASSES[i]);
          const text = safeText(label);
          if (text && /^[0-9]+$/.test(text.trim())) nums.push(text.trim());
        }
        if (nums.length >= 3) {
          stats.kills = nums[0];
          stats.deaths = nums[1];
          stats.assists = nums[2];
        } else {
          // 单个合并文本 "12/5/9" 或 "12 / 5 / 9"
          const t = safeText(kda) || safeText(findClass(kda, TOPBAR_KDA_STAT_CLASSES[0]));
          const m = /([0-9]+)\s*\/\s*([0-9]+)\s*\/\s*([0-9]+)/.exec(t);
          if (m) { stats.kills = m[1]; stats.deaths = m[2]; stats.assists = m[3]; }
        }
      }
      for (let i = 0; i < TOPBAR_SOULS_IDS.length; i += 1) {
        const el = findChild(panel, TOPBAR_SOULS_IDS[i]);
        const text = safeText(el);
        if (text) {
          const t = String(text).replace(/,/g, "");
          const km = /([0-9.]+)\s*k/i.exec(t);
          const mm = /([0-9.]+)\s*m/i.exec(t);
          if (km) stats.souls = String(Math.round(parseFloat(km[1]) * 1000));
          else if (mm) stats.souls = String(Math.round(parseFloat(mm[1]) * 1000000));
          else stats.souls = String(t).replace(/[^0-9]/g, "");
          break;
        }
      }
    } catch (e) {}
    return stats;
  }


  // 顶栏条目字段侦察(每局 1 次,轻量):dump 可枚举属性/对话框变量/常见 id 属性,
  // 用于发现代表 account_id/steamid 的字段名,实现零交互被动采集。
  function probeTopbarPanel(panel, index) {
    try {
      if (!isValid(panel)) return;
      diagLog("topbar probe[" + index + "] type=" + String(panel.paneltype || "") + " class=" + panelClass(panel) + " id=" + panelId(panel) + " layout=" + String(panel.layoutfile || ""));
      try {
        const own = Object.keys(panel) || [];
        const vals = [];
        for (let i = 0; i < own.length && i < 60; i += 1) {
          const k = own[i];
          try {
            const v = panel[k];
            if (v !== undefined && v !== null && v !== "" && typeof v !== "function" && typeof v !== "object") vals.push(k + "=" + String(v).slice(0, 60));
          } catch (e) {}
        }
        diagLog("topbar probe keys=" + own.slice(0, 60).join(","));
        if (vals.length) diagLog("topbar probe vals=" + vals.join(" | ").slice(0, 500));
      } catch (e) {}
      try {
        if (panel.GetDialogVariables) {
          let s = "";
          try { s = JSON.stringify(panel.GetDialogVariables()); } catch (e) { s = String(panel.GetDialogVariables()); }
          diagLog("topbar probe dlg=" + String(s).slice(0, 500));
        }
      } catch (e) {}
      const ids = ["account_id", "accountid", "accountID", "account", "steamid", "steam_id", "steamId", "xuid", "player_id", "playerid", "playerId", "playerID", "m_playerID", "m_nPlayerID", "hero_id", "HeroID", "heroid", "heroId", "team", "team_id", "m_iSteamID", "m_steamID"];
      const attrHits = [];
      for (let i = 0; i < ids.length; i += 1) {
        try {
          if (panel.GetAttributeString) { const v = panel.GetAttributeString(ids[i], ""); if (v) attrHits.push(ids[i] + "=" + v); }
        } catch (e) {}
        try {
          if (panel.GetAttributeInt) { const v = panel.GetAttributeInt(ids[i], -1); if (v > 0) attrHits.push(ids[i] + "=i" + v); }
        } catch (e) {}
      }
      if (attrHits.length) diagLog("topbar probe attr=" + attrHits.join(" | "));
    } catch (e) {}
  }

  function refreshTopbarIdentity() {
    try {
      const root = getRoot();
      if (!isValid(root)) return;
      if (State.topbarNextRefresh && nowMs() < State.topbarNextRefresh) return;
      State.topbarNextRefresh = nowMs() + TOPBAR_REFRESH_MS;
      let players = findTopbarPlayerEntries(root);
      if (!players.length && (!State.topbarDeepNextScan || nowMs() >= State.topbarDeepNextScan)) {
        // 全树类型深度兜底:覆盖全部候选类型(运行时条目可能是 CitadelHudTopBarPlayer 等),
        // 与 findTopbarPlayerEntries 内部策略共享节流节奏,避免每 20s 刷新都做全树扫描
        State.topbarDeepNextScan = nowMs() + 10000;
        for (let t = 0; t < TOPBAR_PLAYER_TYPE_ALTS.length; t += 1) {
          players = findAllPanelsByType(root, TOPBAR_PLAYER_TYPE_ALTS[t]);
          if (players.length) break;
        }
      }
      if (!players.length) {
        if (!State.topbarScanned) diagLog("topbar identity scan: no player entries (root=" + panelId(root) + ")");
        else if (!State.topbarEmptyLogged || nowMs() - State.topbarEmptyLogged > 30000) {
          State.topbarEmptyLogged = nowMs();
          diagLog("topbar scan: 0 entries (match ongoing, root=" + panelId(root) + ")");
          // capture the current scene structure every 90s while the topbar
          // stays invisible, so we can adapt findTopbarPlayerEntries to new
          // game builds
          if (!State.reconNext || nowMs() >= State.reconNext) {
            State.reconNext = nowMs() + 90000;
            try { reconScene(); } catch (e) {}
          }
        }
        return;
      }
      const heroByName = {};
      const nameByHero = {};
      const accountByHero = {};
      const accountByName = {};
      let selfName = State.selfName || "";
      let validHeroes = 0;
      let validNames = 0;
      for (let i = 0; i < players.length; i += 1) {
        const info = readTopbarIdentity(players[i]);
        if (!info) continue;
        const nameKey = normName(info.name);
        const heroKey = info.hero;
        if (nameKey && heroKey) {
          heroByName[nameKey] = heroKey;
          nameByHero[heroKey] = info.name;
          validHeroes += 1;
          validNames += 1;
        } else if (heroKey) {
          validHeroes += 1;
        }
        if (info.account) {
          if (heroKey) accountByHero[heroKey] = info.account;
          if (nameKey) accountByName[nameKey] = info.account;
        }
        if (info.local && info.name) selfName = info.name;
        if (nameKey && info.stats && (info.stats.kills || info.stats.deaths || info.stats.assists || info.stats.souls)) {
          State.liveStats = State.liveStats || {};
          State.liveStats[nameKey] = { kills: info.stats.kills, deaths: info.stats.deaths, assists: info.stats.assists, souls: info.stats.souls, hero: heroKey };
        }
      }
      if (validHeroes === 0 && (!State.topbarHeroLogged || nowMs() - State.topbarHeroLogged > 30000)) {
        State.topbarHeroLogged = nowMs();
        diagLog("topbar scan: entries=" + players.length + " but heroes=0 (name/hero labels unreadable)");
      }
      if (validHeroes > 0) {
        State.topbarHeroByName = heroByName;
        State.topbarNameByHero = nameByHero;
        syncSharedIdentity();
        const rosterSig = currentRosterSignature();
        if (State.steamIdRosterCollected && State.steamIdRosterSignature && rosterSig !== State.steamIdRosterSignature) {
          State.steamIdRosterCollected = false;
          State.steamIdRosterNextAttempt = 0;
          State.steamIdFoundLogged = false;
          State.steamIdDiagLogged = false;
        }
      }
      if (Object.keys(accountByHero).length || Object.keys(accountByName).length) {
        State.accountByHero = Object.assign({}, State.accountByHero || {}, accountByHero);
        State.accountByName = Object.assign({}, State.accountByName || {}, accountByName);
      }
      if (selfName) State.selfName = selfName;
      if (!State.topbarScanned) {
        State.topbarScanned = true;
        diagOnce("topbar_scan", "topbar identity scan players=" + players.length + " heroes=" + validHeroes + " names=" + validNames + " self=" + (State.selfName || ""));
        for (let i = 0; i < players.length && i < 3; i += 1) {
          const info = readTopbarIdentity(players[i]);
          if (info) diagLog("topbar_entry", "topbar entry[" + i + "] id=" + panelId(players[i]) + " name=" + String(info.name || "") + " hero=" + String(info.hero || "") + " account=" + String(info.account || ""));
        }
        if (players.length) probeTopbarPanel(players[0], 0);
      }
    } catch (e) {
      if (!State.topbarScanned) diagLog("topbar identity scan failed: " + (e && e.message ? e.message : String(e)));
    }
  }


  function findFirstPanelByType(root, type) {
    const matches = findAllPanelsByType(root, type);
    return matches.length ? matches[0] : null;
  }

  // Hud 根上是否挂了 ShowEscapeMenu class(ESC 菜单打开标志,showrank 同款机制)。
  // 沿父链找 paneltype=CitadelHud 且 id=Hud 的祖先再 BHasClass,兼容 getRoot 顶点差异。
  function hudHasEscapeClass(root) {
    if (!isValid(root)) return false;
    try {
      if (typeof root.BHasClass === "function" && root.BHasClass(ESCAPE_OPEN_CLASS)) return true;
    } catch (e) {}
    try {
      if (typeof root.BAscendantHasClass === "function" && root.BAscendantHasClass(ESCAPE_OPEN_CLASS)) return true;
    } catch (e) {}
    for (let p = root, d = 0; isValid(p) && d < 24; p = (p.GetParent ? p.GetParent() : null), d += 1) {
      try {
        if (String(p.paneltype || "") === "CitadelHud" && (String(p.id || "") === "Hud" || panelId(p) === "Hud") &&
            typeof p.BHasClass === "function" && p.BHasClass(ESCAPE_OPEN_CLASS)) return true;
      } catch (e) {}
    }
    // getRoot() 可能走到比 CitadelHud 更顶层的容器(root=顶层 Panel,CitadelHud 是子孙):
    // 向下原生遍历 ShowEscapeMenu class(无预算限制,recon 验证 FindChildrenWithClassTraverse 可用)
    try {
      if (root.FindChildrenWithClassTraverse) {
        const m = root.FindChildrenWithClassTraverse(ESCAPE_OPEN_CLASS) || [];
        if (m.length > 0) return true;
      }
    } catch (e) {}
    return false;
  }

  function isEscapeMenuOpen(escapeRoot, root) {
    if (!isValid(escapeRoot)) return false;
    // 常驻面板由祖先链控制显示:整链任一不可见即视为关闭
    // (BIsVisible 优先,否则逐父链查 visible,避免只看自身导致误判开卡)
    try {
      if (typeof escapeRoot.BIsVisible === "function") {
        if (!escapeRoot.BIsVisible()) return false;
      } else {
        for (let p = escapeRoot, d = 0; isValid(p) && d < 16; p = (p.GetParent ? p.GetParent() : null), d += 1) {
          if (p.visible === false) return false;
        }
      }
    } catch (e) {}
    if (isValid(root) && hudHasEscapeClass(root)) return true;
    // showrank 同款:从 escapeRoot 沿父链找 CitadelHud/Hud 根再查 class
    for (let p = escapeRoot, d = 0; isValid(p) && d < 24; p = (p.GetParent ? p.GetParent() : null), d += 1) {
      try {
        if (String(p.paneltype || "") === "CitadelHud" && (String(p.id || "") === "Hud" || panelId(p) === "Hud") &&
            typeof p.BHasClass === "function" && p.BHasClass(ESCAPE_OPEN_CLASS)) return true;
      } catch (e) {}
    }
    // 不再用 PlayersTab.visible 兑底判定:常驻面板在菜单关闭时 visible 仍为 undefined(误判打开),
    // 导致 captureEscapeRosterAccounts/scanSteamIdRows/probeEscapeTooltip 持续全树扫描(掉帧+刷屏)
    // ESC 打开状态只以 ShowEscapeMenu class 为准;检测不到 class 的版本按关闭处理
    return false;
  }

  // ESC 采集会话打开状态(带 root class 增强判断)
  function isSteamIdSessionOpen(session) {
    if (!session || !isValid(session.escapeRoot)) return false;
    return isEscapeMenuOpen(session.escapeRoot, session.root);
  }

  // 轻量定位任一资料卡面板:class/type 兜底(快速路径 ProfileCard/ProfilePage id 找不到时用)
  function findFirstProfilePanel(root) {
    try {
      const clsPanels = [];
      collectPanelsByClasses(root, [LCT_PROFILE_CARD_CLASS], 40, clsPanels);
      if (clsPanels.length && isValid(clsPanels[0])) return clsPanels[0];
    } catch (e) {}
    for (let t = 0; t < PROFILE_CARD_TYPE_ALTS.length; t += 1) {
      const m = scanPanelsByType(root, PROFILE_CARD_TYPE_ALTS[t], 20, 1200);
      if (m.length && isValid(m[0])) return m[0];
    }
    for (let t = 0; t < PROFILE_PAGE_TYPE_ALTS.length; t += 1) {
      const m = scanPanelsByType(root, PROFILE_PAGE_TYPE_ALTS[t], 20, 1200);
      if (m.length && isValid(m[0])) return m[0];
    }
    return null;
  }

  function findVisibleProfilePanels(root) {
    const cards = [];
    const pages = [];
    const seen = new Set();
    const add = function (p) {
      if (isValid(p) && !seen.has(p)) { seen.add(p); cards.push(p); }
    };
    // 1) mod 覆盖的 profile_card.xml 根 class(最可靠)
    try {
      const clsPanels = [];
      collectPanelsByClasses(root, [LCT_PROFILE_CARD_CLASS], 40, clsPanels);
      for (let i = 0; i < clsPanels.length; i += 1) add(clsPanels[i]);
    } catch (e) {}
    // 2) type 扫描兜底(多版本兼容;预算收紧)
    for (let t = 0; t < PROFILE_CARD_TYPE_ALTS.length; t += 1) {
      const m = scanPanelsByType(root, PROFILE_CARD_TYPE_ALTS[t], 32, 2000);
      for (let i = 0; i < m.length; i += 1) add(m[i]);
    }
    for (let t = 0; t < PROFILE_PAGE_TYPE_ALTS.length; t += 1) {
      const m = scanPanelsByType(root, PROFILE_PAGE_TYPE_ALTS[t], 32, 2000);
      for (let i = 0; i < m.length; i += 1) pages.push(m[i]);
    }
    return cards.concat(pages);
  }


  function snapshotProfileAccounts(root) {
    const panels = findVisibleProfilePanels(root);
    const accounts = [];
    for (let i = 0; i < panels.length; i += 1) {
      const account = readProfileAccount(panels[i]);
      if (account) accounts.push(account);
    }
    return accounts;
  }

  function changedProfileAccount(root, before) {
    const after = snapshotProfileAccounts(root);
    const beforeSet = new Set(before);
    let found = null;
    let count = 0;
    for (let i = 0; i < after.length; i += 1) {
      if (!beforeSet.has(after[i])) {
        found = after[i];
        count += 1;
      }
    }
    return count === 1 ? found : null;
  }

  function closePlayerCards() {
    try {
      if (typeof DismissAllContextMenus === "function") {
        DismissAllContextMenus();
      } else {
        $.DispatchEvent("DismissAllContextMenus");
      }
    } catch (ignoreDismiss) {}
    try {
      if (typeof DropInputFocus === "function") {
        DropInputFocus();
      } else {
        $.DispatchEvent("DropInputFocus");
      }
    } catch (ignoreFocus) {}
  }

  function readPlayerRowHero(row) {
    if (!isValid(row)) return "";
    const hidden = findChild(row, LCT_ROW_HERO_ID);
    const hiddenText = safeText(hidden);
    if (hiddenText) return normalizeHeroName(normName(hiddenText));
    const name = safeText(findClass(row, TOPBAR_PLAYER_NAME_CLASS));
    const key = normName(name);
    if (key && State.topbarHeroByName && State.topbarHeroByName[key]) return State.topbarHeroByName[key];
    return "";
  }


  // 轮询检测当前悬停的玩家行(替代布局 onmouseover 事件——LCTRowHovered 跨布局上下文不可见,
  // 悬停会抛 ReferenceError)。BHasHoverStyle 是面板原生方法,任何布局上下文都能读,零跨上下文依赖。
  function detectHoverRow(force) {
    try {
      const root = getRoot();
      if (!isValid(root)) return;
      // 高频轮询节流:悬停状态不会瞬间变化,1s 一次足够;资料卡出现时 force 立即刷新
      if (!force && State.hoverNextScan && nowMs() < State.hoverNextScan) return;
      State.hoverNextScan = nowMs() + HOVER_SCAN_MS;
      const candidates = [];
      const seen = new Set();
      const add = function (p0) { if (isValid(p0) && !seen.has(p0)) { seen.add(p0); candidates.push(p0); } };
      const topbar = findTopbarPlayerEntries(root);
      for (let i = 0; i < topbar.length; i += 1) add(topbar[i]);
      // 顶栏找不到条目(比赛结构不匹配)时放慢到 3s,避免每 1s 全树兑底
      if (topbar.length === 0 && !force) State.hoverNextScan = nowMs() + 3000;
      // ESC 行:优先用 5s 轮询缓存的 escapeRoot;打开状态以 ShowEscapeMenu class 为准
      const escRoot = isValid(State.escRoot) ? State.escRoot : null;
      if (isValid(escRoot)) {
        let escOpen = false;
        try { escOpen = isEscapeMenuOpen(escRoot, root); } catch (e) {}
        if (escOpen) {
          const listRows = [];
          collectPanelsByClasses(escRoot, [LCT_PLAYER_ROW_CLASS], 40, listRows);
          for (let i = 0; i < listRows.length; i += 1) add(listRows[i]);
          // class 已命中则跳过 type 全树兑底(省 3 次扫描)
          if (listRows.length === 0) {
            for (let t = 0; t < PLAYER_ROW_TYPE_ALTS.length; t += 1) {
              const m = scanPanelsByType(escRoot, PLAYER_ROW_TYPE_ALTS[t], 24, 1500);
              for (let j = 0; j < m.length; j += 1) add(m[j]);
            }
          }
        }
      }
      for (let i = 0; i < candidates.length; i += 1) {
        const row = candidates[i];
        let hovered = false;
        try { hovered = !!(row.BHasHoverStyle && row.BHasHoverStyle()); } catch (e) {}
        if (!hovered) continue;
        let name = safeText(findClass(row, TOPBAR_PLAYER_NAME_CLASS));
        if (!name) name = safeText(findChild(row, "PlayerName")) || safeText(findChild(row, "UserName"));
        let hero = readPlayerRowHero(row) || readHeroFromRow(row);
        if (!hero) hero = readHeroFromHeroImage(findChild(row, "HeroBadge")) || readHeroFromHeroImage(findChild(row, "HeroImage"));
        if (!hero) hero = fallbackHeroForSender(name);
        State.hoverRow = { panel: row, hero: hero, name: name, t: nowMs() };
        break;
      }
    } catch (e) {}
  }

  // 名单签名:英雄|昵称 组合,换局(顶栏阵容变化)后强制重采 steamid
  function rowRosterSignature() {
    const heroes = Object.keys(State.topbarNameByHero || {}).sort();
    const names = Object.keys(State.topbarHeroByName || {}).sort();
    return "hero:" + heroes.join(",") + "|name:" + names.join(",");
  }

  function currentRosterSignature() {
    return rowRosterSignature();
  }

  function captureVisibleProfileAccounts(root) {
    try {
      if (!isValid(root)) return;
      // 快速路径:资料卡没打开就什么都不扫(原生 findChild 毫秒级,平时零开销)
      let quick = findChild(root, "ProfileCard") || findChild(root, "ProfilePage");
      if (!isValid(quick) && (!State.profileMissNextScan || nowMs() >= State.profileMissNextScan)) {
        quick = findFirstProfilePanel(root);
        State.profileMissNextScan = nowMs() + 15000; // 未找到时 15s 才再全树兑底,避免每 5s 白扫
      }
      if (!isValid(quick)) return;
      if (State.profileScanNextRefresh && nowMs() < State.profileScanNextRefresh) return;
      State.profileScanNextRefresh = nowMs() + 1000;
      detectHoverRow(true); // 资料卡出现时立即刷新悬停行,供配对使用(绕过节流)
      const panels = findVisibleProfilePanels(root);
      for (let i = 0; i < panels.length; i += 1) rememberProfileIdentity(panels[i]);
    } catch (e) {}
  }

  function finishSteamIdRoster(session, complete) {
    if (session) {
      const accounts = Object.keys(State.accountByHero || {}).length;
      if (complete && accounts > 0) {
        State.steamIdRosterCollected = true;
        State.steamIdRosterSignature = rowRosterSignature();
        State.steamIdRosterNextAttempt = 0;
        if (!State.steamIdDiagLogged) {
          State.steamIdDiagLogged = true;
          diagLog("steamid roster collected accounts=" + accounts + " rows=" + session.rows.length);
        }
      } else {
        State.steamIdRosterCollected = false;
        State.steamIdRosterSignature = "";
        State.steamIdRosterNextAttempt = nowMs() + 5000;
        if (!State.steamIdDiagLogged) {
          diagLog("steamid roster pass incomplete accounts=" + accounts + " rows=" + (session ? session.rows.length : 0));
        }
      }
    }
    State.steamIdEscape = null;
    closePlayerCards();
  }

  function inspectSteamIdRow(session, row, before, attempt) {
    if (!session || session !== State.steamIdEscape || session.finished) return;
    if (!isValid(session.escapeRoot) || !isSteamIdSessionOpen(session)) {
      State.steamIdEscape = null;
      return;
    }
    const account = changedProfileAccount(session.root, before) || row.steamid || "";
    if (account) {
      // 跨行差异学习:上一张资料卡指纹 vs 当前卡,自动发现账号字段名(不盲试字段)
      try {
        const cards = findVisibleProfilePanels(session.root);
        if (cards.length && session.lastCardFp) {
          const hits = discoverAccountFromFingerprints(session.lastCardFp, dumpProfileFingerprint(cards[0]));
          learnDiscoveredAccount(hits);
        }
        if (cards.length) session.lastCardFp = dumpProfileFingerprint(cards[0]);
      } catch (e) {}
      State.accountByHero = State.accountByHero || {};
      State.accountByHero[row.hero] = account;
      State.accountByName = State.accountByName || {};
      const name = State.topbarNameByHero && State.topbarNameByHero[row.hero];
      if (name) State.accountByName[normName(name)] = account;
      session.index += 1;
      probeNextSteamIdRow(session);
      return;
    }
    if (attempt < STEAMID_PROBE_DELAYS.length) {
      $.Schedule(STEAMID_PROBE_DELAYS[attempt], function () {
        inspectSteamIdRow(session, row, before, attempt + 1);
      });
    } else {
      session.index += 1;
      probeNextSteamIdRow(session);
    }
  }

  function probeNextSteamIdRow(session) {
    if (!session || session !== State.steamIdEscape) return;
    if (!isValid(session.escapeRoot) || !isSteamIdSessionOpen(session)) {
      State.steamIdEscape = null;
      return;
    }
    if (session.index >= session.rows.length) {
      finishSteamIdRoster(session, true);
      return;
    }
    const row = session.rows[session.index];
    if (!row || !isValid(row.mainContents)) {
      session.index += 1;
      probeNextSteamIdRow(session);
      return;
    }
    if (State.accountByHero && State.accountByHero[row.hero]) {
      session.index += 1;
      probeNextSteamIdRow(session);
      return;
    }
    if (row.steamid) {
      const norm = normalizeSteamValue(row.steamid);
      State.accountByHero = State.accountByHero || {};
      State.accountByHero[row.hero] = norm;
      const rname = State.topbarNameByHero && State.topbarNameByHero[row.hero];
      if (rname) {
        State.accountByName = State.accountByName || {};
        State.accountByName[normName(rname)] = norm;
      }
      session.index += 1;
      probeNextSteamIdRow(session);
      return;
    }
    const before = snapshotProfileAccounts(session.root);
    try {
      // 悬停模拟:MouseOver 优先(资料卡由 hover 触发),异常再退到 Activated
      try {
        $.DispatchEvent("MouseOver", row.mainContents, "mouse");
      } catch (eOver) {
        try {
          $.DispatchEvent("Activated", row.mainContents, "mouse");
        } catch (eAct) {
          session.index += 1;
          probeNextSteamIdRow(session);
          return;
        }
      }
    } catch (e) {
      session.index += 1;
      probeNextSteamIdRow(session);
      return;
    }
    $.Schedule(STEAMID_PROBE_DELAYS[0], function () {
      inspectSteamIdRow(session, row, before, 1);
    });
  }

  function collectStructuralRosterRows(scope) {
    const out = [];
    const seen = new Set();
    const addRow = function (p) {
      if (!isValid(p) || seen.has(p)) return;
      seen.add(p);
      out.push(p);
    };
    try {
      const nameLabels = [];
      collectPanelsByClasses(scope, TOPBAR_PLAYER_NAME_CLASSES, 60, nameLabels);
      for (const label of nameLabels) {
        if (!isValid(label)) continue;
        let row = label.GetParent ? label.GetParent() : null;
        let guard = 0;
        while (isValid(row) && guard < 8) {
          guard += 1;
          if (hasClass(row, LCT_PLAYER_ROW_CLASS)) { addRow(row); break; }
          if (String(row.paneltype || "") === PLAYER_ROW_TYPE) { addRow(row); break; }
          const mc = findChild(row, "MainContents");
          if (mc && mc !== row) { addRow(row); break; }
          row = row.GetParent ? row.GetParent() : null;
        }
      }
    } catch (e) {}
    return out;
  }

  function scanSteamIdRows(root, escapeRoot) {
    const panels = [];
    const seen = new Set();
    const addRowPanel = function (p) {
      if (!isValid(p) || seen.has(p)) return;
      seen.add(p);
      panels.push(p);
    };
    // 1) mod 覆盖的 players_list_entry.xml 根 class(最可靠,不依赖 paneltype)
    try {
      const clsPanels = [];
      collectPanelsByClasses(root, [LCT_PLAYER_ROW_CLASS], 60, clsPanels);
      for (let i = 0; i < clsPanels.length; i += 1) addRowPanel(clsPanels[i]);
    } catch (e) {}
    // 2) type 扫描兜底(多版本兼容)
    for (let t = 0; t < PLAYER_ROW_TYPE_ALTS.length; t += 1) {
      const m = findAllPanelsByType(root, PLAYER_ROW_TYPE_ALTS[t]);
      for (let i = 0; i < m.length; i += 1) addRowPanel(m[i]);
    }
    if (isValid(escapeRoot)) {
      // 结构兜底:ESC 菜单子树内按 PlayerName/HeroBadge 标签反查玩家行(不依赖我们的布局覆盖)
      const structural = collectStructuralRosterRows(escapeRoot);
      for (let s = 0; s < structural.length; s += 1) addRowPanel(structural[s]);
      // 行数变化才打(ESC 误判打开时每 5s 走到这里,不能每轮刷屏)
      if (structural.length && structural.length !== State.structuralRowsLogged) {
        State.structuralRowsLogged = structural.length;
        diagLog("steamid roster: structural rows=" + structural.length);
      }
      // 补充:HeroBadge 反查(部分版本玩家行没有 PlayerName class,但有 HeroBadge)
      try {
        const badgePanels = [];
        collectPanelsByClasses(escapeRoot, ["HeroBadge"], 60, badgePanels);
        for (let i = 0; i < badgePanels.length; i += 1) {
          if (!isValid(badgePanels[i])) continue;
          let cur = badgePanels[i].GetParent ? badgePanels[i].GetParent() : null;
          for (let d = 0; d < 6 && isValid(cur); d += 1) {
            if (findChild(cur, "MainContents") || hasClass(cur, "Controls")) { addRowPanel(cur); break; }
            if (String(cur.paneltype || "") === "CitadelPlayersListEntry") { addRowPanel(cur); break; }
            cur = cur.GetParent ? cur.GetParent() : null;
          }
        }
      } catch (e) {}
    }
    const rows = [];
    for (let i = 0; i < panels.length; i += 1) {
      const panel = panels[i];
      let hero = readPlayerRowHero(panel);
      if (!hero) hero = readHeroFromRow(panel);
      if (!hero) hero = readHeroFromHeroImage(findChild(panel, "HeroBadge")) || readHeroFromHeroImage(findChild(panel, "HeroImage"));
      const mainContents = findChild(panel, "MainContents") || panel;
      const steamid = readSteamIdFromRow(panel);
      // 英雄或账号任一可读即保留:账号绑定正常但英雄读不到时,可凭行内昵称归属账号
      if (isValid(mainContents) && (hero || steamid)) {
        let name = "";
        for (let ni = 0; ni < TOPBAR_PLAYER_NAME_CLASSES.length; ni += 1) {
          const nl = findClass(panel, TOPBAR_PLAYER_NAME_CLASSES[ni]);
          const nt = safeText(nl);
          if (nt) { name = nt; break; }
        }
        if (!name) name = safeText(findChild(panel, "PlayerName")) || safeText(findChild(panel, "UserName"));
        rows.push({ root: panel, mainContents: mainContents, hero: hero, steamid: steamid, name: name });
      }
    }
    return rows;
  }


  function collectSteamIdRows(session, attempt) {
    if (!session || session !== State.steamIdEscape) return;
    if (!isValid(session.escapeRoot) || !isSteamIdSessionOpen(session)) {
      State.steamIdEscape = null;
      return;
    }
    const rows = scanSteamIdRows(session.root, session.escapeRoot);
    if (rows.length === 0 && attempt < STEAMID_ROW_DELAYS.length) {
      $.Schedule(STEAMID_ROW_DELAYS[attempt], function () {
        collectSteamIdRows(session, attempt + 1);
      });
      return;
    }
    session.rows = rows;
    session.index = 0;
    session.finished = false;
    probeNextSteamIdRow(session);
  }

  function startSteamIdRosterPass(root, escapeRoot) {
    if (State.steamIdRosterCollected && State.steamIdRosterSignature === rowRosterSignature()) return;
    if (State.steamIdRosterNextAttempt && nowMs() < State.steamIdRosterNextAttempt) return;
    if (State.steamIdEscape && State.steamIdEscape.escapeRoot === escapeRoot && State.steamIdEscape.started) return;
    // 阵容/局次变化重置轮次计数;超过上限后本局不再主动悬停模拟(保险网,防止任何误判场景反复打开资料卡)
    if (State.steamIdRosterSignature !== rowRosterSignature()) State.steamIdRosterAttempts = 0;
    if ((State.steamIdRosterAttempts || 0) >= STEAMID_ROSTER_MAX_ATTEMPTS) {
      State.steamIdRosterCollected = true;
      State.steamIdRosterSignature = rowRosterSignature();
      return;
    }
    State.steamIdRosterAttempts = (State.steamIdRosterAttempts || 0) + 1;
    State.steamIdRosterCollected = false; // 换局/阵容变化后重新采集
    State.steamIdEscape = { root: root, escapeRoot: escapeRoot, rows: [], index: 0, started: true, finished: false };
    closePlayerCards();
    const playersTab = findChild(escapeRoot, "PlayersTab") || findChild(root, "PlayersTab");
    if (isValid(playersTab)) {
      try {
        $.DispatchEvent("Activated", playersTab);
      } catch (e) {}
    }
    $.Schedule(STEAMID_ROW_DELAYS[0], function () {
      collectSteamIdRows(State.steamIdEscape, 0);
    });
  }

  function findEscapeMenuRoot(root) {
    if (!isValid(root)) return null;
    // 1) type 扫描(多版本兼容;预算收紧,避免轮询拖慢主线程)
    for (let t = 0; t < ESCAPE_MENU_TYPE_ALTS.length; t += 1) {
      const matches = scanPanelsByType(root, ESCAPE_MENU_TYPE_ALTS[t], 32, 2000);
      for (let i = 0; i < matches.length; i += 1) {
        if (isValid(matches[i])) return matches[i];
      }
    }
    // 2) ShowEscapeMenu class 反查:带 class 面板的最近 ESC 类型祖先
    try {
      const clsPanels = [];
      collectPanelsByClasses(root, [ESCAPE_OPEN_CLASS], 40, clsPanels);
      for (let i = 0; i < clsPanels.length; i += 1) {
        let cur = clsPanels[i];
        for (let d = 0; d < 10 && isValid(cur); d += 1) {
          const t = String(cur.paneltype || "");
          if (ESCAPE_MENU_TYPE_ALTS.indexOf(t) >= 0) return cur;
          const parent = cur.GetParent ? cur.GetParent() : null;
          if (!isValid(parent)) break;
          cur = parent;
        }
      }
    } catch (e) {}
    // 3) id 兜底:ESC 菜单固定子元素反查根
    for (let i = 0; i < ESCAPE_MENU_IDS.length; i += 1) {
      const p = findChild(root, ESCAPE_MENU_IDS[i]);
      if (!isValid(p)) continue;
      let cur = p;
      let typed = null;
      for (let d = 0; d < 10 && isValid(cur); d += 1) {
        const t = String(cur.paneltype || "");
        if (ESCAPE_MENU_TYPE_ALTS.indexOf(t) >= 0) { typed = cur; break; }
        const parent = cur.GetParent ? cur.GetParent() : null;
        if (!isValid(parent)) break;
        cur = parent;
      }
      if (isValid(typed)) return typed;
      return cur;
    }
    // 4) root 兜底:Hud 根带 ShowEscapeMenu class 时,ESC 根可能是其子面板
    try {
      if (typeof root.BHasClass === "function" && root.BHasClass(ESCAPE_OPEN_CLASS)) return root;
    } catch (e) {}
    return null;
  }

  // ESC 打开期间低频侦察:捕捉 hover 玩家行时出现的 steamid tooltip 文本及其面板结构
  // (1s 节流;只扫 escapeRoot 子树,6000 节点预算,不影响帧率)
  function probeEscapeTooltip(root, escapeRoot) {
    try {
      if (!isValid(escapeRoot)) return;
      if (State.tooltipNextProbe && nowMs() < State.tooltipNextProbe) return;
      State.tooltipNextProbe = nowMs() + 1000;
      const scope = escapeRoot;
      const hits = [];
      const budget = { nodes: 0, hits: 0 };
      (function walk(panel, depth) {
        if (!isValid(panel) || depth > 24) return;
        budget.nodes += 1;
        if (budget.nodes > 2000 || budget.hits >= 6) return;
        const text = safeText(panel);
        if (text && text.length < 80 && (/STEAM_\d|7656119\d{10}|\b\d{9,10}\b/i.test(text))) {
          hits.push({ panel: panel, text: text, id: panelId(panel), cls: panelClass(panel) });
          budget.hits += 1;
        }
        const count = childCount(panel);
        for (let i = 0; i < count; i += 1) walk(childAt(panel, i), depth + 1);
      })(scope, 0);
      if (hits.length) {
        for (let i = 0; i < hits.length; i += 1) {
          const h = hits[i];
          const chain = [];
          for (let p = h.panel, d = 0; isValid(p) && d < 10; p = (p.GetParent ? p.GetParent() : null), d += 1) {
            chain.push(panelId(p) + "|" + String(p.paneltype || "") + "|" + panelClass(p));
          }
          diagLog("tooltip steamid text=" + h.text + " id=" + h.id + " class=" + h.cls + " chain=" + chain.join(" <- "));
        }
      }
    } catch (e) {}
  }

  // ESC 玩家列表被动采集(零交互,只读不派发事件):打开 ESC 时玩家行渲染即绑定
  // {i:r:account_id},直接读行内 LCTRowAccount 隐藏 Label 采集全部玩家账号,
  // 不再模拟悬停/点击(旧版主动开卡会抢走控制权)。行内昵称优先归属,英雄兜底。
  function captureEscapeRosterAccounts(root, escapeRoot) {
    try {
      if (!isValid(escapeRoot)) return;
      let escOpen = false;
      try { escOpen = isEscapeMenuOpen(escapeRoot, root); } catch (e) {}
      if (!escOpen) {
        // class 判据失效的版本兜底:BIsVisible 为真即视为 ESC 打开(常驻面板关闭时不可见)
        try {
          if (typeof escapeRoot.BIsVisible === "function" && escapeRoot.BIsVisible()) escOpen = true;
        } catch (e) {}
      }
      if (!escOpen) return;
      if (State.escRosterNextScan && nowMs() < State.escRosterNextScan) return;
      State.escRosterNextScan = nowMs() + 5000;
      const rows = scanSteamIdRows(root, escapeRoot);
      if (!rows.length) {
        if (!State.rosterRowsLogged || nowMs() - State.rosterRowsLogged > 15000) {
          State.rosterRowsLogged = nowMs();
          diagLog("steamid roster rows=0 (escapeRoot=" + panelId(escapeRoot) + " paneltype=" + String(escapeRoot.paneltype || "") + ")");
        }
        return;
      }
      let gainedHero = 0;
      let gainedName = 0;
      for (let i = 0; i < rows.length; i += 1) {
        const row = rows[i];
        const nameKey = row.name ? normName(row.name) : "";
        // hero mapping is kept even when steamid is not yet available:
        // nick <-> hero is enough for chat logs to fill the hero field.
        if (row.hero) {
          State.nameByHero = State.nameByHero || {};
          if (!State.nameByHero[row.hero]) gainedHero += 1;
          State.nameByHero[row.hero] = row.name || State.nameByHero[row.hero];
          if (nameKey) {
            State.heroByName = State.heroByName || {};
            if (!State.heroByName[nameKey]) gainedHero += 1;
            State.heroByName[nameKey] = row.hero;
          }
        }
        if (!row.steamid || !looksLikeSteamAccount(row.steamid)) continue;
        const norm = normalizeSteamValue(row.steamid);
        if (row.hero) {
          State.accountByHero = State.accountByHero || {};
          if (!State.accountByHero[row.hero]) gainedHero += 1;
          State.accountByHero[row.hero] = norm;
        }
        if (nameKey) {
          State.accountByName = State.accountByName || {};
          if (!State.accountByName[nameKey]) gainedName += 1;
          State.accountByName[nameKey] = norm;
        }
      }
      syncSharedIdentity();
      if (gainedHero || gainedName) {
        diagOnce("steamid_gained", "steamid roster rows=" + rows.length + " gainedHero=" + gainedHero + " gainedName=" + gainedName + " totalAccounts=" + Object.keys(State.accountByName || {}).length);
      }
    } catch (e) {}
  }

  function pollSteamIdRoster() {
    try {
      const root = getRoot();
      if (!isValid(root)) return;
      detectHoverRow(); // 每轮刷新悬停行(ESC 打开无资料卡时也记录,点击查看资料前必悬停)
      if (State.rosterNextPoll && nowMs() < State.rosterNextPoll) return;
      State.rosterNextPoll = nowMs() + ROSTER_POLL_MS;
      const escapeRoot = findEscapeMenuRoot(root);
      State.escRoot = isValid(escapeRoot) ? escapeRoot : null;
      // 被动路径:资料卡已打开(用户自己悬停/点击)时零成本扫描+差异学习,
      // 不做悬停模拟,不会主动打开任何人的资料卡
      captureVisibleProfileAccounts(root);
      if (isValid(escapeRoot) && isEscapeMenuOpen(escapeRoot, root)) {
        if (!State.steamIdFoundLogged) {
          State.steamIdFoundLogged = true;
          diagLog("steamid roster: escape menu found (" + panelId(escapeRoot) + "/" + String(escapeRoot.paneltype || "") + ")");
          // ESC 侦察(一次性):dump ESC 根子树(深度3),定位玩家行结构
          dumpReconTree(escapeRoot, "escRoot", 0, 3);
        }
        // 不再主动悬停模拟:主动点开资料卡会抢走控制权。
        // 被动路径 1:ESC 玩家行只读采集 {i:r:account_id}(零交互,打开 ESC 即自动采集全部玩家);
        // 被动路径 2:用户自己悬停时 captureVisibleProfileAccounts 扫描+差异学习。
        captureEscapeRosterAccounts(root, escapeRoot);
        probeEscapeTooltip(root, escapeRoot);
      } else if (State.steamIdEscape) {
        State.steamIdEscape = null;
      } else if (!State.steamIdDiagLogged) {
        State.steamIdDiagLogged = true;
        diagLog("steamid roster: escape menu not found yet");
      }
    } catch (e) {}
  }


  function profileString(panel, keys) {
    if (!isValid(panel)) return "";
    for (let i = 0; i < keys.length; i += 1) {
      try {
        if (panel.GetDialogVariableString) {
          const v = panel.GetDialogVariableString(keys[i], "");
          if (v) return String(v);
        }
      } catch (e) {}
      try {
        if (panel.GetDialogVariable) {
          const v = panel.GetDialogVariable(keys[i]);
          if (v !== undefined && v !== null && v !== "") return String(v);
        }
      } catch (e) {}
      try {
        if (panel.GetDialogVariableInt) {
          const v = panel.GetDialogVariableInt(keys[i], -1);
          if (v > 0) return String(v);
        }
      } catch (e) {}
      try {
        if (panel.GetAttributeString) {
          const v = panel.GetAttributeString(keys[i], "");
          if (v) return String(v);
        }
      } catch (e) {}
      try {
        const v = panel[keys[i]];
        if (v !== undefined && v !== null && v !== "" && typeof v !== "object") return String(v);
      } catch (e) {}
    }
    return "";
  }

  // 收集面板下所有 Label 文本指纹:id/class -> text(差异发现用)
  function collectLabelFingerprint(panel, depth, maxDepth, out, budget) {
    if (!isValid(panel) || depth > maxDepth || budget.labels >= PROFILE_DISCOVERY_MAX_LABELS) return;
    budget.visited += 1;
    if (budget.visited > 4000) return;
    const text = safeText(panel);
    if (text) {
      const id = panelId(panel);
      const cls = panelClass(panel);
      if (id && !out.byId[id]) out.byId[id] = text;
      if (cls && !out.byClass[cls]) out.byClass[cls] = text;
      out.texts.push(text);
    }
    const count = childCount(panel);
    for (let i = 0; i < count; i += 1) collectLabelFingerprint(childAt(panel, i), depth + 1, maxDepth, out, budget);
  }

  // 资料卡全量指纹:Label 文本 + 对话框变量 + 属性 + 自有属性(差异对比用)
  function dumpProfileFingerprint(panel) {
    const fp = { byId: {}, byClass: {}, texts: [], dlg: {}, attrs: {}, props: {} };
    try {
      collectLabelFingerprint(panel, 0, PROFILE_DISCOVERY_MAX_DEPTH, fp, { visited: 0, labels: 0 });
    } catch (e) {}
    for (let i = 0; i < PROFILE_DISCOVERY_DLG_KEYS.length; i += 1) {
      const k = PROFILE_DISCOVERY_DLG_KEYS[i];
      const v = profileString(panel, [k]);
      if (v) fp.dlg[k] = v;
    }
    for (let i = 0; i < PROFILE_DISCOVERY_ATTR_KEYS.length; i += 1) {
      const k = PROFILE_DISCOVERY_ATTR_KEYS[i];
      const v = panelAttrString(panel, [k]) || panelAttrIntString(panel, [k]);
      if (v) fp.attrs[k] = v;
    }
    try {
      const own = Object.keys(panel) || [];
      for (let i = 0; i < own.length && i < 120; i += 1) {
        const k = own[i];
        try {
          const v = panel[k];
          if (v !== undefined && v !== null && v !== "" && typeof v !== "function" && typeof v !== "object") fp.props[k] = String(v);
        } catch (e) {}
      }
    } catch (e) {}
    return fp;
  }

  // 从两份指纹差异中找出代表 steamid/account 的字段(值随玩家变化且像账号)
  function discoverAccountFromFingerprints(a, b) {
    const found = [];
    const tryVal = function (source, key, value) {
      const v = String(value || "").trim();
      if (!v || !looksLikeSteamAccount(v)) return;
      const norm = normalizeSteamValue(v);
      if (found.length < 8) found.push({ source: source, key: key, value: norm });
    };
    for (const k of Object.keys(a.byId || {})) {
      if (a.byId[k] !== b.byId[k]) tryVal("labelId", k, b.byId[k]);
    }
    for (const k of Object.keys(a.byClass || {})) {
      if (a.byClass[k] !== b.byClass[k]) tryVal("labelClass", k, b.byClass[k]);
    }
    for (const k of Object.keys(a.dlg || {})) {
      if (a.dlg[k] !== b.dlg[k]) tryVal("dlg", k, b.dlg[k]);
    }
    for (const k of Object.keys(a.attrs || {})) {
      if (a.attrs[k] !== b.attrs[k]) tryVal("attr", k, b.attrs[k]);
    }
    for (const k of Object.keys(a.props || {})) {
      if (a.props[k] !== b.props[k]) tryVal("prop", k, b.props[k]);
    }
    // 偏好排序:17 位 SteamID64 最可靠;字段名带 account/steam/xuid 其次;其余最后
    const score = function (h) {
      let s = 0;
      if (/^[0-9]{17}$/.test(h.value)) s += 100;
      if (/(account|steam|xuid|playerid|player_id)/i.test(h.key)) s += 50;
      if (h.source === "labelId" && /(account|steam|xuid)/i.test(h.key)) s += 30;
      return s;
    };
    found.sort(function (x, y) { return score(y) - score(x); });
    return found;
  }

  function learnDiscoveredAccount(hits) {
    if (!hits || !hits.length) return false;
    const cur = State.discoveredAccount || { labelIds: [], labelClasses: [], dlgKeys: [], attrKeys: [], propKeys: [] };
    let changed = false;
    for (let i = 0; i < hits.length; i += 1) {
      const h = hits[i];
      if (h.source === "labelId" && cur.labelIds.indexOf(h.key) < 0) { cur.labelIds.push(h.key); changed = true; }
      else if (h.source === "labelClass" && cur.labelClasses.indexOf(h.key) < 0) { cur.labelClasses.push(h.key); changed = true; }
      else if (h.source === "dlg" && cur.dlgKeys.indexOf(h.key) < 0) { cur.dlgKeys.push(h.key); changed = true; }
      else if (h.source === "attr" && cur.attrKeys.indexOf(h.key) < 0) { cur.attrKeys.push(h.key); changed = true; }
      else if (h.source === "prop" && cur.propKeys.indexOf(h.key) < 0) { cur.propKeys.push(h.key); changed = true; }
    }
    if (changed) {
      cur.via = "diff";
      State.discoveredAccount = cur;
      diagLog("steamid field discovered via diff: " + JSON.stringify(cur));
    }
    return changed;
  }

  // 先读隐藏宏 Label,再按已知/已发现账号标签 id 读取(原版 ProfileCard 有 AccountID Label)
  function readAccountFromLabelIds(panel, ids) {
    if (!isValid(panel)) return "";
    const label = findChild(panel, LCT_PROFILE_ACCOUNT_ID) || findChild(panel, LCT_PROFILE_PAGE_ACCOUNT_ID) || findChild(panel, LCT_TOP_BAR_ACCOUNT_ID);
    const labelText = safeText(label);
    if (labelText) return normalizeSteamValue(labelText);
    for (let i = 0; i < ids.length; i += 1) {
      const found = findChild(panel, ids[i]);
      const text = safeText(found);
      if (text && looksLikeSteamAccount(text)) return normalizeSteamValue(text);
    }
    return "";
  }

  // 按差异发现结果读取账号(标签 id/class、对话框变量、属性、自有属性)
  function readDiscoveredProfileAccount(panel) {
    const d = State.discoveredAccount;
    if (!d) return "";
    const fromLabels = readAccountFromLabelIds(panel, d.labelIds);
    if (fromLabels) return fromLabels;
    for (let i = 0; i < (d.labelClasses || []).length; i += 1) {
      const clsText = safeText(findClass(panel, d.labelClasses[i]));
      if (clsText && looksLikeSteamAccount(clsText)) return normalizeSteamValue(clsText);
    }
    const keys = (d.dlgKeys || []).concat(d.attrKeys || [], d.propKeys || []);
    for (let i = 0; i < keys.length; i += 1) {
      const v = profileString(panel, [keys[i]]);
      if (v && looksLikeSteamAccount(v)) return normalizeSteamValue(v);
    }
    return "";
  }

  // 兜底启发式:资料卡子树里扫 17 位 SteamID64 文本(唯一性强,不会误判为灵魂/等级)
  function readAccountFromAnyLabelText(panel) {
    if (!isValid(panel)) return "";
    const out = { texts: [] };
    try {
      collectLabelFingerprint(panel, 0, PROFILE_DISCOVERY_MAX_DEPTH, out, { visited: 0, labels: 0 });
    } catch (e) {}
    for (let i = 0; i < out.texts.length; i += 1) {
      const t = String(out.texts[i] || "").trim();
      if (/^7656119\d{10}$/.test(t)) return t;
      const m = /(?:^|\s)(7656119\d{10})(?:\s|$)/.exec(t);
      if (m) return m[1];
    }
    return "";
  }

  function readProfileAccount(panel) {
    if (!isValid(panel)) return "";
    // 1) showrank_barebones 同款:直接读引擎属性(accountid=32位,steamid=64位),不依赖对话框变量
    const attr = panelAttrString(panel, ["accountid", "steamid", "steam_id", "steamId", "account_id", "account"]);
    if (attr && looksLikeSteamAccount(attr)) return normalizeSteamValue(attr);
    const attrInt = panelAttrIntString(panel, ["accountid", "account_id", "account", "steamid"]);
    if (attrInt && looksLikeSteamAccount(attrInt)) return normalizeSteamValue(attrInt);
    // 2) 完整 SteamID 对话框变量(r:account_id 等,覆盖无隐藏 Label 的版本)
    const raw64 = profileString(panel, ["accountid", "steamid", "steam_id", "steamId", "steamID", "m_iSteamID", "m_steamID", "xuid"]);
    if (raw64 && looksLikeSteamAccount(raw64)) return normalizeSteamValue(raw64);
    // 3) 隐藏 Label {i:r:account_id}(32 位账号 ID,换算 64 位)
    const hidden = readAccountFromLabelIds(panel, PROFILE_ACCOUNT_LABEL_IDS);
    if (hidden) return hidden;
    // 4) 已发现字段(历史 diff 学习结果)与兜底文本标签
    const discovered = readDiscoveredProfileAccount(panel);
    if (discovered) return discovered;
    const raw = profileString(panel, ["account_id", "accountid", "accountID", "account", "steamid", "steam_id", "steamId", "m_iSteamID", "xuid"]);
    if (raw) return normalizeSteamValue(raw);
    return readAccountFromAnyLabelText(panel);
  }

  function readProfileHero(panel) {
    if (!isValid(panel)) return "";
    const label = findClass(panel, "HeroName") || findClass(panel, "heroName") || findChild(panel, "HeroName") || findChild(panel, "HeroNameLabel");
    const text = safeText(label);
    if (text) {
      // 局地化英雄名或英文内部名直接归一化;数值 hero id 按表映射
      if (HERO_ID_TO_NAME[String(text).trim()]) return HERO_ID_TO_NAME[String(text).trim()];
      const mapped = normalizeHeroName(normName(text));
      if (mapped) return mapped;
    }
    const raw = profileString(panel, ["hero_id", "heroid", "heroId", "heroID", "HeroID", "m_nHeroID", "hero", "hero_name", "heroName", "HeroName"]);
    if (raw) {
      if (HERO_ID_TO_NAME[String(raw).trim()]) return HERO_ID_TO_NAME[String(raw).trim()];
      const mapped = normalizeHeroName(normName(raw));
      if (mapped) return mapped;
    }
    return "";
  }


  function readProfileName(panel) {
    if (!isValid(panel)) return "";
    // CitadelUserName 是特殊面板,文本在内部子 Label:先找 SelfName(资料页),再 UserName(资料卡)
    const selfNode = findChild(panel, "SelfName") || findChild(panel, "UserName") || findChild(panel, "UserNickname");
    const name = safeText(selfNode) || collectText(selfNode);
    if (name) return name;
    // 类别扫描兜底:部分版本用户名 Label 用 class 而非 id(原版 profile_card 结构差异)
    const byClass = safeText(findClass(panel, "UserName")) || safeText(findClass(panel, "UserNickname")) || safeText(findClass(panel, "SelfName")) ||
      safeText(findClass(panel, "PlayerName")) || safeText(findClass(panel, "playerName")) || safeText(findClass(panel, "NameLabel"));
    if (byClass) return byClass;
    const raw = profileString(panel, ["player_name", "playerName", "PlayerName", "name", "user_name", "username", "nickname", "display_name", "sender_name", "account_name"]);
    return raw || "";
  }

  function rememberProfileIdentity(profile) {
    if (!isValid(profile)) return;
    const account = readProfileAccount(profile);
    const hero = readProfileHero(profile);
    const name = readProfileName(profile);
    if (!account) {
      if (!State.profileEmptyLogged || nowMs() - State.profileEmptyLogged > 10000) {
        State.profileEmptyLogged = nowMs();
        diagLog("profile_empty", "profile card visible but account empty (type=" + String(profile.paneltype || "") + " class=" + panelClass(profile) + " id=" + panelId(profile) + ")");
      }
      return;
    }
    // 悬停配对:资料卡由用户悬停/点击玩家行触发时,把账号配到最近悬停的玩家行
    // (参考 showrank_barebones:账号来自资料卡;配对源是行上的英雄/昵称)
    let paired = false;
    const hr = State.hoverRow;
    if (hr && hr.t && nowMs() - hr.t <= STEAMID_HOVER_PAIR_MS) {
      const hh = hr.hero || "";
      const hn = hr.name ? normName(hr.name) : "";
      if (hh || hn) {
        State.accountByHero = State.accountByHero || {};
        State.accountByName = State.accountByName || {};
        if (hh) State.accountByHero[hh] = account;
        if (hn) {
          State.accountByName[hn] = account;
          if (hh) {
            State.heroByName = State.heroByName || {};
            State.heroByName[hn] = hh;
          }
        }
        paired = true;
        diagOnce("steamid_paired", "steamid paired via hover: hero=" + (hh || "") + " name=" + String(hr.name || "") + " steamid=" + account);
      }
    }
    if (name) {
      const key = normName(name);
      State.accountByName = State.accountByName || {};
      State.accountByName[key] = account;
      // 昵称配对:资料页/卡没有英雄时,用顶栏昵称->英雄映射补全,再挂到 accountByHero
      if (!hero) {
        const h = State.topbarHeroByName && State.topbarHeroByName[key];
        if (h) hero = h;
      }
    }
    if (hero) {
      State.accountByHero = State.accountByHero || {};
      State.accountByHero[hero] = account;
    }
    if (name && hero) {
      State.heroByName = State.heroByName || {};
      State.heroByName[normName(name)] = hero;
    }
    syncSharedIdentity();
    const seenKey = account + "|" + hero + "|" + name;
    State.profileAccountSeen = State.profileAccountSeen || {};
    if (!State.profileAccountSeen[seenKey]) {
      State.profileAccountSeen[seenKey] = true;
      diagLog("profile card identity: type=" + String(profile.paneltype || "") + " hero=" + (hero || "") + " name=" + (name || "") + " steamid=" + account + (paired ? " (paired)" : ""));
    }
  }

  function scanProfileCardsOnce() {
    try {
      const root = getRoot();
      if (!isValid(root)) return;
      const profiles = [];
      const seen = new Set();
      const add = function (p) {
        if (isValid(p) && !seen.has(p)) { seen.add(p); profiles.push(p); }
      };
      const clsPanels = [];
      collectPanelsByClasses(root, [LCT_PROFILE_CARD_CLASS], 40, clsPanels);
      for (let i = 0; i < clsPanels.length; i += 1) add(clsPanels[i]);
      const byId = findChild(root, "ProfileCard");
      if (isValid(byId) && PROFILE_CARD_TYPE_ALTS.indexOf(byId.paneltype) >= 0) add(byId);
      if (profiles.length === 0) {
        const page = findChild(root, "ProfilePage");
        if (isValid(page) && (PROFILE_PAGE_TYPE_ALTS.indexOf(page.paneltype) >= 0 || page.paneltype === "CitadelProfileCard")) add(page);
      }
      for (let i = 0; i < profiles.length; i += 1) rememberProfileIdentity(profiles[i]);
    } catch (e) {}
  }

  function scanProfileCardsLoop() {
    scanProfileCardsOnce();
    captureVisibleProfileAccounts(getRoot());
    $.Schedule(PROFILE_LOOP_SECONDS, scanProfileCardsLoop);
  }

  // ================= 赛后记分板(比赛摘要:KDA/灵魂/伤害/胜负) =================

  function parseScoreboardNum(text) {
    const t = String(text || "").replace(/,/g, "").trim();
    if (!t) return "";
    const km = /^([0-9.]+)\s*k$/i.exec(t);
    const mm = /^([0-9.]+)\s*m$/i.exec(t);
    if (km) return String(Math.round(parseFloat(km[1]) * 1000));
    if (mm) return String(Math.round(parseFloat(mm[1]) * 1000000));
    const digits = t.replace(/[^0-9]/g, "");
    return digits || "";
  }

  // 判断 Team 容器是否属于赛后记分板(沿父链找 CitadelPostGameScoreboardNew 类型,
  // 找不到则要求树里有 MatchID 标签——局内 Tab 计分板没有这两个特征,避免误发摘要)
  function isPostGameScoreboardRoot(root, team) {
    if (!isValid(root) || !isValid(team)) return false;
    try {
      for (let p = team, d = 0; isValid(p) && d < 12; p = (p.GetParent ? p.GetParent() : null), d += 1) {
        if (String(p.paneltype || "") === SCOREBOARD_TYPE) return true;
      }
    } catch (e) {}
    // MatchID 是赛后记分板独有(局内 Tab 计分板没有);TimeLabel 太通用,不作判据
    return isValid(findChild(root, SCOREBOARD_MATCH_ID));
  }

  function findScoreboardRoot() {
    try {
      const root = getRoot();
      if (!isValid(root)) return null;
      for (let i = 0; i < SCOREBOARD_TEAM_IDS.length; i += 1) {
        const team = findChild(root, SCOREBOARD_TEAM_IDS[i]);
        if (!isValid(team)) continue;
        // 只认赛后记分板:Team 容器里有 Player 行,且根/祖先类型或 MatchID 匹配
        const hasPlayers = team.FindChildrenWithClassTraverse
          ? (function () { try { return (team.FindChildrenWithClassTraverse(SCOREBOARD_PLAYER_CLASS) || []).length > 0; } catch (e) { return false; } })()
          : false;
        if (hasPlayers && isPostGameScoreboardRoot(root, team)) return root;
      }
    } catch (e) {}
    return null;
  }

  function readScoreboardPlayer(row) {
    if (!isValid(row)) return null;
    const p = { name: "", hero: "", kills: "", deaths: "", assists: "", souls: "", playerDmg: "", objDmg: "", healing: "", local: false };
    for (let i = 0; i < SCOREBOARD_NAME_IDS.length; i += 1) {
      const nameText = safeText(findChild(row, SCOREBOARD_NAME_IDS[i]));
      if (nameText) { p.name = nameText; break; }
    }
    p.hero = readHeroFromRow(row) || readHeroFromHeroImage(findChild(row, "HeroBadge")) || readHeroFromHeroImage(findChild(row, "HeroImage"));
    for (const key of Object.keys(SCOREBOARD_STAT_IDS)) {
      for (let i = 0; i < SCOREBOARD_STAT_IDS[key].length; i += 1) {
        const v = parseScoreboardNum(safeText(findChild(row, SCOREBOARD_STAT_IDS[key][i])));
        if (v) { p[key] = v; break; }
      }
    }
    try {
      p.local = hasClass(row, SCOREBOARD_LOCAL_CLASS) || (typeof row.BAscendantHasClass === "function" && row.BAscendantHasClass(SCOREBOARD_LOCAL_CLASS));
    } catch (e) {}
    // passive steamid: post-game scoreboard rows may carry account data
    p.steamid = readProfileAccount(row);
    if (!State.scoreboardProbeLogged && p.steamid) {
      State.scoreboardProbeLogged = true;
      diagLog("scoreboard account probe: name=" + p.name + " steamid=" + p.steamid + " hero=" + p.hero);
    }
    return p;
  }

  function scanPostGameScoreboard() {
    try {
      if (State.scoreboardNextScan && nowMs() < State.scoreboardNextScan) return;
      State.scoreboardNextScan = nowMs() + SCOREBOARD_SCAN_MS;
      const root = findScoreboardRoot();
      if (!isValid(root)) return;
      const matchId = safeText(findChild(root, SCOREBOARD_MATCH_ID)) || getMatchId();
      if (State.summarySent && State.summaryMatchId === matchId) return;
      const teams = [];
      let localTeam = "";
      let localWon = false;
      for (let t = 0; t < SCOREBOARD_TEAM_IDS.length; t += 1) {
        const teamPanel = findChild(root, SCOREBOARD_TEAM_IDS[t]);
        if (!isValid(teamPanel)) continue;
        const teamNo = t + 1;
        const won = hasClass(teamPanel, SCOREBOARD_WIN_CLASS) || (typeof teamPanel.BAscendantHasClass === "function" && teamPanel.BAscendantHasClass(SCOREBOARD_WIN_CLASS));
        const players = [];
        const rows = [];
        collectPanelsByClasses(teamPanel, [SCOREBOARD_PLAYER_CLASS], 20, rows);
        for (let i = 0; i < rows.length; i += 1) {
          const p = readScoreboardPlayer(rows[i]);
          if (!p || !p.name) continue;
          if (p.local) { localTeam = "team" + teamNo; localWon = won; }
          players.push(p);
        }
        if (players.length) teams.push({ team: "team" + teamNo, won: won, players: players });
      }
      if (!teams.length) return;
      const duration = safeText(findClass(root, SCOREBOARD_TIME_CLASS)) || "";
      const summary = {
        type: "summary",
        t: new Date().toISOString(),
        matchId: String(matchId || ""),
        duration: duration,
        localTeam: localTeam,
        localWon: localWon,
        teams: teams,
      };
      State.summarySent = true;
      State.summaryMatchId = matchId;
      diagLog("post-game scoreboard summary captured teams=" + teams.length + " localWon=" + localWon);
      // passive identity: scoreboard rows with steamid become player records,
      // bridge persists them in identity_cache for later matches
      const idLines = [];
      const idSeen = {};
      for (let ti = 0; ti < teams.length; ti += 1) {
        for (let pi = 0; pi < teams[ti].players.length; pi += 1) {
          const pp = teams[ti].players[pi];
          if (!pp.name || !pp.steamid) continue;
          const pkey = normName(pp.name);
          if (idSeen[pkey]) continue;
          idSeen[pkey] = true;
          idLines.push({ type: "player", name: pp.name, hero: String(pp.hero || ""), heroId: String(pp.heroId || ""), steamid: pp.steamid });
        }
      }
      flushChatLog(); // 比赛结束:立即冲刷未落盘的消息行,避免末尾日志丢失
      bridgePost("log", { matchId: matchId, lines: [summary] }, function () {});
      if (idLines.length) {
        diagLog("post-game scoreboard identities captured=" + idLines.length);
        bridgePost("log", { matchId: matchId, lines: idLines }, function () {});
      }
    } catch (e) {}
  }

  // 收集面板下所有 Label 文本(处理 Text/Ping 等不同 contents 结构)
  function collectTextInto(panel, out) {
    if (!isValid(panel)) return;
    const text = safeText(panel);
    if (text) out.push(text);
    const count = childCount(panel);
    for (let i = 0; i < count; i += 1) {
      collectTextInto(childAt(panel, i), out);
    }
  }

  function collectText(panel) {
    const out = [];
    collectTextInto(panel, out);
    return out.join(" ").replace(/\s+/g, " ").trim();
  }

  // Collect row + likely child panels that carry sender/hero/identity attributes.
  // Panorama rows nest HeroImage under SenderImage, so direct-child traversal is
  // insufficient; FindChildTraverse / FindChildrenWithClassTraverse are required.
  function identityPanelCandidates(row) {
    const out = [];
    const add = function (p) { if (isValid(p)) out.push(p); };
    add(row);
    for (const id of ["HeroImage", "HeroBadge", "SenderImage", "AvatarImage", "MessageSource", "MessageContents"]) {
      add(findChild(row, id));
    }
    for (const cls of ["SenderHeroImage", "HeroImage", "HeroBadge", "SenderAvatarImage", "AvatarImage", "SenderName", "MessageBody"]) {
      add(findClass(row, cls));
    }
    const count = childCount(row);
    for (let i = 0; i < count && i < 12; i += 1) add(childAt(row, i));
    return out;
  }

  function panelAttrString(panel, attrs) {
    if (!isValid(panel)) return "";
    for (const attr of attrs) {
      try {
        const v = panel.GetAttributeString ? panel.GetAttributeString(attr, "") : "";
        if (v) return String(v);
      } catch (e) {}
    }
    return "";
  }

  function panelAttrIntString(panel, attrs) {
    if (!isValid(panel)) return "";
    for (const attr of attrs) {
      try {
        if (panel.GetAttributeInt) {
          const v = panel.GetAttributeInt(attr, -1);
          if (v > 0) return String(v);
        }
      } catch (e) {}
      try {
        const v = panel.GetAttributeString ? panel.GetAttributeString(attr, "") : "";
        if (v && v !== "0") return String(v);
      } catch (e) {}
    }
    return "";
  }

  // 尽力从聊天行读取英雄名(行内 SenderHeroImage/HeroImage 面板;大厅行用 HeroIcon,失败返回空串)
  // 比旧版多扫一层子面板与常见属性名(游戏行内数据可能挂在任意子节点)
  function panelPropString(panel, attrs) {
    if (!isValid(panel)) return "";
    for (let i = 0; i < attrs.length; i += 1) {
      try {
        const v = panel[attrs[i]];
        if (v !== undefined && v !== null && v !== "") return String(v);
      } catch (e) {}
    }
    return "";
  }

  function panelPropIntString(panel, attrs) {
    if (!isValid(panel)) return "";
    for (let i = 0; i < attrs.length; i += 1) {
      try {
        const v = panel[attrs[i]];
        if (v !== undefined && v !== null && v !== "" && Number(v) > 0) return String(v);
      } catch (e) {}
    }
    return "";
  }

  // Dialog variables: the engine renders chat rows from {s:sender_name}/{s:channel_name}
  // style variables, and may also set hero/steam ones. Read them directly off panels.
  function panelDialogString(panel, keys) {
    if (!isValid(panel)) return "";
    for (let i = 0; i < keys.length; i += 1) {
      try {
        if (panel.GetDialogVariableString) {
          const v = panel.GetDialogVariableString(keys[i], "");
          if (v) return String(v);
        }
      } catch (e) {}
      try {
        if (panel.GetDialogVariable) {
          const v = panel.GetDialogVariable(keys[i]);
          if (v !== undefined && v !== null && v !== "") return String(v);
        }
      } catch (e) {}
      try {
        if (panel.GetDialogVariableInt) {
          const v = panel.GetDialogVariableInt(keys[i], -1);
          if (v > 0) return String(v);
        }
      } catch (e) {}
    }
    return "";
  }

  function panelDialogIntString(panel, keys) {
    if (!isValid(panel)) return "";
    for (let i = 0; i < keys.length; i += 1) {
      try {
        if (panel.GetDialogVariableInt) {
          const v = panel.GetDialogVariableInt(keys[i], -1);
          if (v > 0) return String(v);
        }
      } catch (e) {}
    }
    return "";
  }


  function panelId(panel) {
    try {
      return String((panel.GetAttributeString ? panel.GetAttributeString("id", "") : "") || "");
    } catch (e) { return ""; }
  }

  function panelClass(panel) {
    try {
      return String((panel.GetAttributeString ? panel.GetAttributeString("class", "") : "") || "");
    } catch (e) { return ""; }
  }

  function panelPropSummary(panel) {
    const keys = [];
    try {
      const own = Object.keys(panel) || [];
      for (let i = 0; i < own.length && i < 40; i += 1) keys.push(own[i]);
    } catch (e) {}
    const out = [];
    for (let i = 0; i < keys.length; i += 1) {
      const k = keys[i];
      let v = "";
      try { v = String(panel[k]); } catch (e) {}
      if (v && v.length <= 80) out.push(k + "=" + v);
    }
    return out.join(",");
  }

  function panelDialogSummary(panel) {
    const keys = ["hero_id", "heroid", "heroId", "heroID", "HeroID", "m_nHeroID", "hero_name", "heroName", "hero", "sender_name", "senderName", "channel_name", "channelName", "player_id", "playerid", "steam_id", "steamid", "account_id", "accountid", "xuid", "team_id", "team", "name", "message_text"];
    const out = [];
    for (let i = 0; i < keys.length; i += 1) {
      try {
        const v = panelDialogString(panel, [keys[i]]);
        if (v) out.push(keys[i] + "=" + v);
      } catch (e) {}
    }
    return out.join(",");
  }

  function panelAttrSummary(panel) {
    const attrs = ["hero", "hero_name", "heroName", "heroname", "character", "character_name", "selected_hero", "hero_image", "heroid", "hero_id", "heroId", "selectedHeroId", "selected_hero_id", "m_HeroID", "steamid", "steam_id", "steamId", "m_iSteamID", "xuid", "playerid", "player_id", "data-player-id", "accountid", "account_id", "owner", "playerId"];
    const out = [];
    for (let i = 0; i < attrs.length; i += 1) {
      try {
        const v = panel.GetAttributeString ? panel.GetAttributeString(attrs[i], "") : "";
        if (v) out.push(attrs[i] + "=" + v);
      } catch (e) {}
    }
    return out.join(",");
  }

  function dumpIdentityPanel(panel, label, depth, maxDepth, lightweight) {
    if (!isValid(panel) || depth > maxDepth) return;
    const id = panelId(panel);
    const cls = panelClass(panel);
    const dlg = panelDialogSummary(panel);
    if (lightweight) {
      // 轻量诊断:只输出 id/type/class/文本/对话框变量,避免大段属性序列化卡主线程
      const text = safeText(panel).slice(0, 40);
      if (id || cls || dlg || text) {
        diagLog("rowdiag [" + label + "] d=" + depth + " id=" + id + " type=" + String(panel.paneltype || "") + " class=" + cls + " text=" + text + " dlg={" + dlg + "}");
      }
    } else {
      const attrs = panelAttrSummary(panel);
      const props = panelPropSummary(panel);
      if (id || cls || attrs || props || dlg) {
        diagLog("rowdiag [" + label + "] d=" + depth + " id=" + id + " class=" + cls + " attrs={" + attrs + "} props={" + props + "} dlg={" + dlg + "}");
      }
    }
    const count = childCount(panel);
    const childLimit = lightweight ? 4 : 8;
    for (let i = 0; i < count && i < childLimit; i += 1) {
      dumpIdentityPanel(childAt(panel, i), label + "." + i, depth + 1, maxDepth, lightweight);
    }
  }

  function probeHeroImage(img) {
    if (!isValid(img)) return;
    try {
      const own = Object.keys(img) || [];
      diagLog("heroimg probe ownKeys=" + own.slice(0, 60).join(","));
    } catch (e) {}
    try {
      const protoNames = [];
      let proto = Object.getPrototypeOf(img);
      for (let d = 0; d < 3 && proto; d += 1) {
        const names = Object.getOwnPropertyNames(proto) || [];
        for (let i = 0; i < names.length && protoNames.length < 90; i += 1) protoNames.push(names[i]);
        proto = Object.getPrototypeOf(proto);
      }
      diagLog("heroimg probe proto=" + protoNames.join(","));
    } catch (e) {}
    const tryGet = function (label, fn) {
      try {
        const v = fn();
        if (v !== undefined && v !== null && v !== "") diagLog("heroimg probe " + label + "=" + String(v));
      } catch (e) {}
    };
    tryGet("src", function () { return img.src; });
    tryGet("GetSource", function () { return img.GetSource ? img.GetSource() : ""; });
    tryGet("GetHeroName", function () { return img.GetHeroName ? img.GetHeroName() : ""; });
    tryGet("GetHeroID", function () { return img.GetHeroID ? img.GetHeroID() : ""; });
    tryGet("GetHeroId", function () { return img.GetHeroId ? img.GetHeroId() : ""; });
    tryGet("GetHero", function () { return img.GetHero ? img.GetHero() : ""; });
    tryGet("GetHeroIDName", function () { return img.GetHeroIDName ? img.GetHeroIDName() : ""; });
    tryGet("hero", function () { return img.hero; });
    tryGet("heroid", function () { return img.heroid; });
    tryGet("hero_id", function () { return img.hero_id; });
    tryGet("m_nHeroID", function () { return img.m_nHeroID; });
    tryGet("attr hero", function () { return img.GetAttributeString ? img.GetAttributeString("hero", "") : ""; });
    tryGet("attr hero_id", function () { return img.GetAttributeString ? img.GetAttributeString("hero_id", "") : ""; });
    tryGet("attrU hero_id", function () { return img.GetAttributeUInt32 ? img.GetAttributeUInt32("hero_id", 0) : 0; });
    tryGet("attrI hero_id", function () { return img.GetAttributeInt ? img.GetAttributeInt("hero_id", -1) : -1; });
    tryGet("dv hero_id", function () { return img.GetDialogVariableInt ? img.GetDialogVariableInt("hero_id", -1) : -1; });
    tryGet("dv hero_name", function () { return img.GetDialogVariableString ? img.GetDialogVariableString("hero_name", "") : ""; });
    tryGet("dv all", function () {
      if (!img.GetDialogVariables) return "";
      let s = "";
      try { s = JSON.stringify(img.GetDialogVariables()); } catch (e) { s = String(img.GetDialogVariables()); }
      return s.slice(0, 300);
    });
    tryGet("data", function () { return img.data ? JSON.stringify(img.data).slice(0, 300) : ""; });
    tryGet("layoutfile", function () { return img.layoutfile; });
    tryGet("paneltype", function () { return img.paneltype; });
    tryGet("id", function () { return img.id; });
  }

  function logRowIdentityDiagnostic(row, record) {
    // 每局最多 2 次、只 dump 1 层轻量信息:完整 3 层 dump 曾导致单帧 JS 95ms(掉帧)
    if (row.__lctIdentityDiag || State.identityDiagCount >= 2) return;
    row.__lctIdentityDiag = true;
    State.identityDiagCount += 1;
    diagLog("rowdiag sender=" + String(record.sender || "") + " channel=" + String(record.channel || "") + " text=" + String(record.text || "").slice(0, 60) + " hero=" + String(record.hero || "") + " steamid=" + String(record.steamid || ""));
    dumpIdentityPanel(row, "row", 0, 1, true);
    if (!State.heroImgProbed) {
      State.heroImgProbed = true;
      const heroImg = findChild(row, "HeroImage");
      if (isValid(heroImg)) probeHeroImage(heroImg);
    }
  }


  function readImageSource(img) {
    if (!isValid(img)) return "";
    try { if (img.src) return String(img.src); } catch (e) {}
    try { if (typeof img.GetSource === "function") { const v = img.GetSource(); if (v) return String(v); } } catch (e) {}
    try { if (img.style && img.style.backgroundImage) return String(img.style.backgroundImage); } catch (e) {}
    return "";
  }

  function readHeroFromHeroImage(img) {
    if (!isValid(img)) return "";
    const dv = panelDialogString(img, ["hero_name", "heroName", "heroname", "hero", "selected_hero"]);
    if (dv) return normalizeHeroName(normName(dv));
    const hid = panelDialogString(img, ["hero_id", "heroid", "heroId", "heroID", "HeroID", "m_nHeroID"]);
    if (hid && HERO_ID_TO_NAME[String(hid)]) return HERO_ID_TO_NAME[String(hid)];
    const av = panelAttrString(img, ["hero", "hero_name", "heroName", "heroname", "heroNameStr", "hero_id", "heroid", "heroId", "HeroID", "heroimage", "character", "character_name"]);
    if (av) return normalizeHeroName(normName(av));
    const avi = panelAttrIntString(img, ["hero_id", "heroid", "heroId", "HeroID", "m_nHeroID", "m_iHeroID"]);
    if (avi && HERO_ID_TO_NAME[avi]) return HERO_ID_TO_NAME[avi];
    const pv = panelPropString(img, ["hero", "hero_id", "heroid", "heroId", "HeroID", "m_nHeroID", "m_iHeroID", "m_HeroID", "heroName"]);
    if (pv && HERO_ID_TO_NAME[pv]) return HERO_ID_TO_NAME[pv];
    if (pv && HERO_IMAGE_TO_NAME[String(pv).toLowerCase().replace(/-/g, "_")]) return HERO_IMAGE_TO_NAME[String(pv).toLowerCase().replace(/-/g, "_")];
    const dvi = panelDialogIntString(img, ["hero_id", "heroid", "heroId", "HeroID", "m_nHeroID"]);
    if (dvi && HERO_ID_TO_NAME[dvi]) return HERO_ID_TO_NAME[dvi];
    for (let i = 0; i < HERO_NAMES.length; i += 1) {
      const h = HERO_NAMES[i];
      if (hasClass(img, h) || hasClass(img, "hero_" + h)) return h;
    }
    const src = readImageSource(img);
    if (src) {
      const m = /([a-z0-9_]+?)_sm_psd/i.exec(src) || /heroes\/([a-z0-9_]+?)(?:\.|_)/i.exec(src);
      if (m) {
        const stem = m[1].toLowerCase().replace(/-/g, "_");
        if (HERO_IMAGE_TO_NAME[stem]) return HERO_IMAGE_TO_NAME[stem];
        if (HERO_IMAGE_TO_NAME[stem.replace(/_/g, "")]) return HERO_IMAGE_TO_NAME[stem.replace(/_/g, "")];
        if (HERO_NAMES.indexOf(stem) >= 0) return stem;
      }
    }
    // C++ 面板方法探测(不同版本暴露方式不同)
    const nameFns = ["GetHeroName", "GetHeroNameString", "GetHero", "GetHeroIDName", "GetHeroImageName"];
    for (let i = 0; i < nameFns.length; i += 1) {
      try {
        if (typeof img[nameFns[i]] === "function") {
          const v = img[nameFns[i]]();
          if (v) return normalizeHeroName(normName(String(v)));
        }
      } catch (e) {}
    }
    const idFns = ["GetHeroID", "GetHeroId", "GetHeroIndex", "GetHeroIDValue"];
    for (let i = 0; i < idFns.length; i += 1) {
      try {
        if (typeof img[idFns[i]] === "function") {
          const v = img[idFns[i]]();
          if (v !== undefined && v !== null && Number(v) > 0 && HERO_ID_TO_NAME[String(v)]) return HERO_ID_TO_NAME[String(v)];
        }
      } catch (e) {}
    }
    return "";
  }


  function readHeroFromRow(row) {
    try {
      const hidden = findChild(row, LCT_ROW_HERO_ID);
      const hiddenText = safeText(hidden);
      if (hiddenText) return normalizeHeroName(normName(hiddenText));
      // 顶栏玩家行 HeroName 标签({s:hero_name}):文本直接可读
      const heroLabel = findClass(row, TOPBAR_PLAYER_HERO_CLASS) || findChild(row, "HeroName");
      if (isValid(heroLabel)) {
        const heroText = safeText(heroLabel);
        if (heroText) {
          const mappedHero = normalizeHeroName(normName(heroText));
          if (mappedHero) return mappedHero;
        }
      }
      const candidates = identityPanelCandidates(row);
      const attrs = ["hero", "hero_name", "heroName", "heroname", "heroNameStr", "selected_hero", "selectedHero", "character", "character_name", "hero_image", "heroid", "hero_id", "heroId", "heroID", "HeroID", "m_nHeroID", "m_iHeroID", "m_HeroID", "selected_hero_id", "selectedHeroId"];
      for (const p of candidates) {
        if (!isValid(p)) continue;
        const v = panelAttrString(p, attrs);
        if (v) return normalizeHeroName(String(v));
        const pv = panelPropString(p, attrs);
        if (pv) return normalizeHeroName(String(pv));
        const dv = panelDialogString(p, ["hero_name", "heroName", "heroname", "hero", "character_name", "selected_hero", "hero_id", "heroid", "heroId", "heroID", "HeroID", "m_nHeroID", "selected_hero_id", "selectedHeroId"]);
        if (dv) return normalizeHeroName(String(dv));
        try { if (p.hero) return normalizeHeroName(String(p.hero)); } catch (e) {}
        const img = findChild(p, "HeroImage");
        if (isValid(img)) {
          const iv = panelAttrString(img, attrs);
          if (iv) return normalizeHeroName(String(iv));
          const ipv = panelPropString(img, attrs);
          if (ipv) return normalizeHeroName(String(ipv));
          try { if (img.hero) return normalizeHeroName(String(img.hero)); } catch (e) {}
        }
      }
      const heroImg = findChild(row, "HeroImage");
      if (isValid(heroImg)) {
        const imgHero = readHeroFromHeroImage(heroImg);
        if (imgHero) return imgHero;
      }
      for (let i = 0; i < candidates.length; i += 1) {
        if (isValid(candidates[i]) && String(candidates[i].paneltype || "") === "CitadelHeroImage") {
          const imgHero2 = readHeroFromHeroImage(candidates[i]);
          if (imgHero2) return imgHero2;
        }
      }
    } catch (e) {}
    return "";
  }


  function readHeroIdFromRow(row) {
    try {
      const candidates = identityPanelCandidates(row);
      const attrs = ["heroid", "hero_id", "heroId", "heroID", "HeroID", "selectedHeroId", "selected_hero_id", "m_HeroID", "m_nHeroID", "m_iHeroID", "m_nSelectedHeroID", "nHeroID", "nHero"];
      for (const p of candidates) {
        if (!isValid(p)) continue;
        const v = panelAttrIntString(p, attrs);
        if (v) return String(v);
        const pv = panelPropIntString(p, attrs);
        if (pv) return String(pv);
        const dv = panelDialogString(p, ["hero_id", "heroid", "heroId", "heroID", "HeroID", "m_nHeroID", "selected_hero_id", "selectedHeroId"]);
        if (dv) return String(dv);
        const img = findChild(p, "HeroImage");
        if (isValid(img)) {
          const iv = panelAttrIntString(img, attrs);
          if (iv) return String(iv);
          const ipv = panelPropIntString(img, attrs);
          if (ipv) return String(ipv);
        }
      }
      const hero = readHeroFromRow(row);
      if (hero && HERO_NAME_TO_ID[hero]) return HERO_NAME_TO_ID[hero];
    } catch (e) {}
    return "";
  }

  function readSteamIdFromRow(row) {
    try {
      // 1) showrank_barebones 同款:直接读引擎属性(最可靠,不依赖对话框变量或隐藏 Label 渲染)
      const rowAttr = panelAttrString(row, ["accountid", "steamid", "steam_id", "steamId"]);
      if (rowAttr && looksLikeSteamAccount(rowAttr)) return normalizeSteamValue(rowAttr);
      const rowAttrInt = panelAttrIntString(row, ["accountid", "account_id", "account", "steamid"]);
      if (rowAttrInt && looksLikeSteamAccount(rowAttrInt)) return normalizeSteamValue(rowAttrInt);
      // 2) 隐藏 Label {i:r:account_id}(32 位账号 ID,换算 64 位)
      const accLabel = findChild(row, LCT_ROW_ACCOUNT_ID);
      const accText = safeText(accLabel);
      if (accText && looksLikeSteamAccount(accText)) return normalizeSteamValue(accText);
      // 3) 差异发现出的账号标签 id/class 优先读(玩家列表行/资料卡同款)
      const fromDiscovered = readDiscoveredProfileAccount(row);
      if (fromDiscovered) return fromDiscovered;
      const fromAccountLabel = readAccountFromLabelIds(row, PROFILE_ACCOUNT_LABEL_IDS);
      if (fromAccountLabel) return fromAccountLabel;
      const attrs = ["steamid", "steam_id", "steamId", "m_iSteamID", "m_steamID", "steamID", "xuid", "playerid", "player_id", "data-player-id", "accountid", "account_id", "accountID", "m_accountID", "account", "owner", "playerId"];
      const candidates = identityPanelCandidates(row);
      for (const p of candidates) {
        if (!isValid(p)) continue;
        const v = panelAttrString(p, attrs);
        if (v) return String(v);
        const pv = panelPropString(p, attrs);
        if (pv) return String(pv);
        const dv = panelDialogString(p, ["steam_id", "steamid", "steamId", "m_iSteamID", "account_id", "accountid", "player_id", "playerid", "xuid", "owner", "playerId"]);
        if (dv) return String(dv);
        const img = findChild(p, "HeroImage");
        if (isValid(img)) {
          const iv = panelAttrString(img, attrs);
          if (iv) return String(iv);
          const ipv = panelPropString(img, attrs);
          if (ipv) return String(ipv);
        }
      }
    } catch (e) {}
    return "";
  }

  function padZeros(s, len) {
    let out = String(s || "");
    while (out.length < len) out = "0" + out;
    return out;
  }

  function addDecimalStrings(a, b) {
    const maxLen = Math.max(String(a).length, String(b).length);
    const ra = padZeros(a, maxLen);
    const rb = padZeros(b, maxLen);
    let carry = 0;
    let out = "";
    for (let i = maxLen - 1; i >= 0; i -= 1) {
      const d = ra.charCodeAt(i) - 48 + rb.charCodeAt(i) - 48 + carry;
      out = String(d % 10) + out;
      carry = d >= 10 ? 1 : 0;
    }
    if (carry) out = "1" + out;
    return out;
  }

  // 32 位 Steam 账号 ID -> 64 位 SteamID(常见账号:universe=1,type=1,instance=1)
  function accountIdToSteamId(accountId) {
    const digits = String(accountId || "").replace(/\D/g, "");
    if (!digits) return "";
    return addDecimalStrings("76561197960265728", digits);
  }

  // 规范化昵称(用于与 Players API 对比)
  function normName(name) {
    return String(name || "").replace(/^\[[^\]]+\]\s*/, "").trim().toLowerCase();
  }

  // 把 Players.GetPlayerInfo 单条结果并入 info({ hero, heroId, steamid };多字段兼容)
  // 游戏内渲染的英雄名是本地化文案(如中文),统一转英文键,保证日志一致。
  function normalizeHeroName(hero) {
    const s = String(hero || "").trim();
    if (!s) return "";
    if (ZH_HERO_TO_EN[s]) return ZH_HERO_TO_EN[s];
    return s;
  }


  function isCallable(value) {
    return typeof value === "function";
  }

  function firstStringValue(obj, keys) {
    if (!obj) return "";
    for (let i = 0; i < keys.length; i += 1) {
      try {
        const v = obj[keys[i]];
        if (v !== undefined && v !== null && v !== "" && typeof v !== "object") return String(v);
      } catch (e) {}
    }
    return "";
  }

  function firstPositiveValue(obj, keys) {
    if (!obj) return -1;
    for (let i = 0; i < keys.length; i += 1) {
      try {
        const v = obj[keys[i]];
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) return n;
      } catch (e) {}
    }
    return -1;
  }

  // 只接受像真实 Steam 账号的值:17 位 SteamID64 / 32 位账号ID / U:1: 格式;
  // 排除 0-11 这种玩家槽位号,避免把 player_id 误当 steamid。
  function looksLikeSteamAccount(raw) {
    const v = String(raw || "").trim();
    if (/^\[?U:1:(\d+)\]?$/.test(v)) return true;
    if (/^[0-9]{17}$/.test(v) && v >= "76561197960265728") return true;
    if (/^[0-9]{6,10}$/.test(v)) {
      const n = Number(v);
      return n >= 100000 && n <= 4294967295;
    }
    return false;
  }

  function normalizeSteamValue(raw) {
    const value = String(raw || "").replace(/^\s+|\s+$/g, "");
    if (!value || !/^[0-9]+$/.test(value)) {
      const steam3 = /^\[?U:1:([0-9]+)\]?$/.exec(value);
      if (steam3) return accountIdToSteamId(steam3[1]);
      return value;
    }
    if (value.length === 17 && value >= "76561197960265728") return value;
    if (value.length <= 10 && value <= "4294967295") return accountIdToSteamId(value);
    return value;
  }

  function gameLocalPlayerId() {
    try {
      if (typeof Game !== "undefined" && isCallable(Game.GetLocalPlayerID)) {
        const id = Number(Game.GetLocalPlayerID());
        if (Number.isFinite(id) && id >= 0) return id;
      }
    } catch (e) {}
    try {
      if (typeof Players !== "undefined" && isCallable(Players.GetLocalPlayer)) {
        const id = Number(Players.GetLocalPlayer());
        if (Number.isFinite(id) && id >= 0) return id;
      }
    } catch (e) {}
    return -1;
  }

  function gameLocalPlayerInfo() {
    try {
      if (typeof Game !== "undefined" && isCallable(Game.GetLocalPlayerInfo)) return Game.GetLocalPlayerInfo();
    } catch (e) {}
    return null;
  }

  function getPlayerInfoById(id) {
    let pi = null;
    try {
      if (typeof Game !== "undefined" && isCallable(Game.GetPlayerInfo)) pi = Game.GetPlayerInfo(id);
    } catch (e) {}
    if (!pi) {
      try {
        if (typeof Players !== "undefined" && isCallable(Players.GetPlayerInfo)) pi = Players.GetPlayerInfo(id);
      } catch (e) {}
    }
    return pi;
  }

  function gameAllPlayerIds() {
    const ids = [];
    try {
      if (typeof Game !== "undefined" && isCallable(Game.GetAllPlayerIDs)) {
        const raw = Game.GetAllPlayerIDs();
        if (Array.isArray(raw)) return raw.slice();
        if (raw && typeof raw === "object") {
          if (typeof raw.length === "number") {
            for (let i = 0; i < raw.length; i += 1) ids.push(raw[i]);
            return ids;
          }
          const values = Object.keys(raw);
          for (let i = 0; i < values.length; i += 1) ids.push(raw[values[i]]);
          return ids;
        }
      }
    } catch (e) {}
    for (let i = 0; i < PLAYER_INFO_SCAN_LIMIT; i += 1) ids.push(i);
    return ids;
  }

  function applyPlayerInfo(info, pi) {
    try {
      if (!info.hero) {
        const h = firstStringValue(pi, ["hero", "hero_name", "heroName", "hero_name_str", "selected_hero", "character", "character_name", "heroNameStr", "m_nHeroName", "player_hero", "hero_english"]);
        if (h) info.hero = h;
      }
      if (!info.heroId) {
        const hid = firstPositiveValue(pi, ["hero_id", "heroid", "heroId", "heroID", "HeroID", "selectedHeroId", "selected_hero_id", "m_nHeroID", "m_nSelectedHeroID", "player_hero_id"]);
        if (hid > 0) info.heroId = String(hid);
      }
      if (!info.steamid) {
        const st = firstStringValue(pi, ["steam_id", "steamid", "steamId", "m_iSteamID", "m_steamID", "steamID", "xuid", "playerId", "player_id", "steamid64", "steam_id64"]);
        if (st) {
          info.steamid = normalizeSteamValue(st);
        } else {
          const acc = firstStringValue(pi, ["account_id", "accountid", "accountID", "m_accountID", "account"]);
          if (acc) info.steamid = normalizeSteamValue(acc);
        }
      }
    } catch (e) {}
  }

  function playerInfoName(pi) {
    if (!pi) return "";
    if (typeof pi === "string") return pi;
    return firstStringValue(pi, ["name", "m_name", "player_name", "playerName", "persona_name", "m_personaName", "personaName", "name_str", "player_name_steam", "nickname", "display_name", "account_name"]);
  }

  // Match a sender nickname to identity. Deadlock currently exposes Players only
  // on older/custom layouts, so prefer Game.* (the API docs list Game.GetPlayerInfo).
  function playerInfoForNick(nick) {
    const key = normName(nick);
    if (!key || key === UNKNOWN_NAME) return null;
    State.nickInfoCache = State.nickInfoCache || {};
    if (State.nickInfoCache[key]) return State.nickInfoCache[key];
    try {
      if (typeof Game === "undefined" && typeof Players === "undefined") return null;
      const info = { hero: "", heroId: "", steamid: "" };
      const localId = gameLocalPlayerId();
      if (localId >= 0) {
        const lp = getPlayerInfoById(localId) || gameLocalPlayerInfo();
        if (lp && normName(playerInfoName(lp)) === key) applyPlayerInfo(info, lp);
      }
      const ids = gameAllPlayerIds();
      const seen = new Set();
      if (localId >= 0) seen.add(localId);
      for (let i = 0; i < ids.length && !(info.hero && info.steamid); i += 1) {
        const id = Number(ids[i]);
        if (!Number.isFinite(id) || id < 0 || seen.has(id)) continue;
        seen.add(id);
        const pi = getPlayerInfoById(id);
        if (pi && normName(playerInfoName(pi)) === key) applyPlayerInfo(info, pi);
      }
      // Fallback for layouts that expose names and steam ids through Players only.
      if (!info.steamid) {
        try {
          if (typeof Players !== "undefined" && isCallable(Players.GetPlayerSteamID)) {
            for (let i = 0; i < PLAYER_INFO_SCAN_LIMIT; i += 1) {
              let pn = "";
              try { pn = Players.GetPlayerName ? Players.GetPlayerName(i) : ""; } catch (e) {}
              if (normName(pn) === key) {
                info.steamid = String(Players.GetPlayerSteamID(i) || "");
                break;
              }
            }
          }
        } catch (e) {}
      }
      if (info.hero || info.heroId || info.steamid) {
        State.nickInfoCache[key] = info;
        return info;
      }
    } catch (e) {}
    return null;
  }

  function localPlayerName() {
    if (State.selfName) return State.selfName;
    try {
      const localId = gameLocalPlayerId();
      if (localId >= 0) {
        const lp = getPlayerInfoById(localId) || gameLocalPlayerInfo();
        const name = playerInfoName(lp);
        if (name) return name;
        try {
          if (typeof Players !== "undefined" && isCallable(Players.GetPlayerName)) {
            const n = Players.GetPlayerName(localId);
            if (n) return String(n);
          }
        } catch (e) {}
      }
    } catch (e) {}
    return "";
  }

function resolveSteamId(record) {
    syncSharedIdentity();
    if (record.steamid) return String(record.steamid);
    const nick = String(record.sender || "").trim();
    const key = normName(nick);
    if (key && key !== UNKNOWN_NAME) {
      const info = playerInfoForNick(nick);
      if (info && info.steamid) return info.steamid;
      if (State.accountByName && State.accountByName[key]) return State.accountByName[key];
    }
    const hero = normName(resolveHero(record));
    if (hero && State.accountByHero && State.accountByHero[hero]) return State.accountByHero[hero];
    return "";
  }

  // 用昵称匹配 Players API / TopBar 映射补英雄名(行内读不到时兜底;失败返回空串)
  function resolveHero(record) {
    syncSharedIdentity();
    const hero = normName(record.hero);
    if (hero) return normalizeHeroName(hero);
    const hid = String(record.heroId || "").trim();
    if (hid && HERO_ID_TO_NAME[hid]) return HERO_ID_TO_NAME[hid];
    const nick = String(record.sender || "").trim();
    const key = normName(nick);
    if (!key || key === UNKNOWN_NAME) return "";
    const info = playerInfoForNick(nick);
    if (info && info.hero) return info.hero;
    if (State.topbarHeroByName && State.topbarHeroByName[key]) return State.topbarHeroByName[key];
    if (State.heroByName && State.heroByName[key]) return State.heroByName[key];
    return "";
  }


  // 根据昵称补显示昵称:HUD 行先按英雄反查 TopBar,自己的消息用本地昵称。
  function resolveSender(record) {
    syncSharedIdentity();
    const sender = String(record.sender || "").trim();
    if (sender && sender !== UNKNOWN_NAME) return sender;
    const hero = normName(resolveHero(record));
    if (hero && State.topbarNameByHero && State.topbarNameByHero[hero]) return State.topbarNameByHero[hero];
    if (hero && State.nameByHero && State.nameByHero[hero]) return State.nameByHero[hero];
    if (record.isOwn) return localPlayerName() || UNKNOWN_NAME;
    return UNKNOWN_NAME;
  }

  // 用昵称匹配 Players API 补英雄数字 ID(失败返回空串)
  function resolveHeroId(record) {
    const hid = String(record.heroId || "").trim();
    if (hid) return hid;
    const hero = normName(resolveHero(record));
    if (hero && HERO_NAME_TO_ID[hero]) return HERO_NAME_TO_ID[hero];
    const nick = String(record.sender || "").trim();
    if (!nick || nick === UNKNOWN_NAME) return "";
    const info = playerInfoForNick(nick);
    return (info && info.heroId) ? info.heroId : "";
  }

  // 尽力获取当前比赛 ID(Deadlock Panorama 无统一文档,多候选探测;失败用时间戳)
  // 多候选探测当前比赛 ID(每次调用都执行;Deadlock Panorama API 版本差异大,
  // 常见命名/返回格式都试一遍。拿不到返回空串,由 getMatchId 兜底 session_)
  function readConvarString(name) {
    try {
      if (typeof Convars !== "undefined" && Convars.GetStr) {
        const v = Convars.GetStr(name, "");
        if (v) return String(v).trim();
      }
    } catch (e) {}
    return "";
  }

  function probeMatchId() {
    let id = "";
    const clean = function (v) {
      const s = String(v || "").trim();
      return (s && !/^0+$/.test(s)) ? s : "";
    };
    // Convars 优先:Deadlock 连接日志会输出 match_id=99385833,引擎通常同时
    // 暴露同名 convar;Panorama 全局对象在当前版本会抛 Code generation 错误。
    try {
      const convars = [
        "match_id", "matchid", "MatchID", "matchId",
        "citadel_match_id", "host_matchid", "server_matchid", "sv_matchid",
        "lobby_id", "citadel_lobby_id",
      ];
      for (const key of convars) {
        const v = readConvarString(key);
        id = clean(v);
        if (id) return id;
      }
    } catch (e) {}
    try {
      if (typeof GameStateAPI !== "undefined") {
        // 常见无参 API 名(大小写变体;返回 string 或 { match_id|matchId|id })
        const fns = ["GetMatchID", "GetMatchId", "GetLiveMatchID", "GetLiveMatchId", "GetMatchInfo"];
        for (const fn of fns) {
          try {
            if (typeof GameStateAPI[fn] === "function") {
              const v = GameStateAPI[fn]();
              if (v && typeof v === "object") id = clean(v.match_id || v.matchId || v.matchid || v.id);
              else id = clean(v);
              if (id) return id;
            }
          } catch (e) {}
        }
        // GetGameInfo / GetServerInfo:遍历键,取含 match/game_id/server 的字符串字段
        for (const fn of ["GetGameInfo", "GetServerInfo"]) {
          try {
            if (typeof GameStateAPI[fn] === "function") {
              const info = GameStateAPI[fn]();
              if (info && typeof info === "object") {
                id = clean(info.match_id || info.matchId || info.matchid);
                if (id) return id;
                try {
                  for (const k of Object.keys(info)) {
                    const v = info[k];
                    if (v && typeof v !== "object" && /match|game_id|server/i.test(k)) {
                      id = clean(v);
                      if (id) return id;
                    }
                  }
                } catch (e) {}
              }
            }
          } catch (e) {}
        }
      }
    } catch (e) {}
    // Game / GameUI 命名空间(Deadlock 特有;与 Dota 的 GameStateAPI 并存)
    for (const ns of [typeof Game !== "undefined" ? Game : null, typeof GameUI !== "undefined" ? GameUI : null]) {
      if (!ns) continue;
      for (const fn of ["GetMatchID", "GetMatchId"]) {
        try {
          if (typeof ns[fn] === "function") {
            const v = ns[fn]();
            if (v && typeof v === "object") id = clean(v.match_id || v.matchId || v.matchid || v.id);
            else id = clean(v);
            if (id) return id;
          }
        } catch (e) {}
      }
    }
    // GameInterfaceAPI 设置键(多候选)
    try {
      if (typeof GameInterfaceAPI !== "undefined" && GameInterfaceAPI.GetSettingString) {
        const keys = ["matchid", "match_id", "MatchID", "matchId", "citadel_match_id", "CitadelMatchID", "live_match_id"];
        for (const key of keys) {
          try {
            const v = GameInterfaceAPI.GetSettingString(key, "");
            if (v) {
              id = clean(v);
              if (id) return id;
            }
          } catch (e) {}
        }
      }
    } catch (e) {}
    return "";
  }

  // 一次性诊断:探测失败时把可用 API 方法名列到控制台,便于在未知游戏版本上定位正确的比赛 ID API
  let matchIdDiagLogged = false;
  function logMatchIdDiagnostics() {
    if (matchIdDiagLogged) return;
    matchIdDiagLogged = true;
    try {
      const names = [];
      const scan = function (ns, prefix) {
        if (!ns) return;
        try {
          for (const k of Object.keys(ns)) {
            if (typeof ns[k] === "function" && /match|game|server|map/i.test(k)) names.push(prefix + k);
          }
        } catch (e) {}
      };
      scan(typeof GameStateAPI !== "undefined" ? GameStateAPI : null, "GameStateAPI.");
      scan(typeof GameInterfaceAPI !== "undefined" ? GameInterfaceAPI : null, "GameInterfaceAPI.");
      scan(typeof Game !== "undefined" ? Game : null, "Game.");
      scan(typeof GameUI !== "undefined" ? GameUI : null, "GameUI.");
      diagLog("matchId diagnostic: " + (names.length ? names.join(" | ") : "(no match-related API found)"));
    } catch (e) {}
  }

  function getMatchId() {
    // 已缓存真实比赛 ID:直接返回(不进比赛时一直是 session_ 兜底)
    if (State.matchId && State.matchId.indexOf("session_") !== 0) return State.matchId;
    // 每次重新探测:大厅/组队阶段通常拿不到,进入比赛后一旦拿到真实 ID 就切换文件名
    const id = probeMatchId();
    if (id) {
      State.matchId = id;
      return id;
    }
    if (!State.matchId) {
      State.matchId = "session_" + String(Math.floor(nowMs() / 1000));
      logMatchIdDiagnostics();
    }
    return State.matchId;
  }

  function log(msg) {
    try {
      $.Msg(LOG_PREFIX + " " + msg);
    } catch (e) {}
  }

  // 诊断日志:带 key 去重,同 key 5s 内只打一次(防 hot-path 刷屏)
  const _diagKeys = new Map(); // key -> lastMs
  const DIAG_THROTTLE_MS = 5000;
  function diagLog(key, msg) {
    // 兼容旧单参调用(key 为空则不节流):新提交只改写了部分调用点,单参漏改会输出 undefined
    if (msg === undefined) { msg = key; key = ""; }
    const now = nowMs();
    const prev = _diagKeys.get(key);
    if (key && prev && now - prev < DIAG_THROTTLE_MS) return;
    _diagKeys.set(key, now);
    try { $.Msg(LOG_PREFIX + " [diag] " + msg); } catch (e) {}
    try { bridgePost("diag", { msg: String(msg || "").slice(0, 600) }, function () {}); } catch (e) {}
  }
  // 仅执行一次的诊断日志(无节流)
  const _diagOnceKeys = new Set();
  function diagOnce(key, msg) {
    if (_diagOnceKeys.has(key)) return;
    _diagOnceKeys.add(key);
    try { $.Msg(LOG_PREFIX + " [diag] " + msg); } catch (e) {}
    try { bridgePost("diag", { msg: String(msg || "").slice(0, 600) }, function () {}); } catch (e) {}
  }

  // djb2 哈希:用于生成稳定的译文 Label id(滚动回收后重建用)
  function hashString(str) {
    let h = 5381;
    const s = String(str || "");
    for (let i = 0; i < s.length; i += 1) {
      h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    }
    return h.toString(36);
  }

  // ================= 配置(游戏侧 UI 偏好) =================

  const UI_DEFAULTS = {
    enabled: true,
    provider: "bing", // 默认公共免费服务商;microsoft 需填 Azure Key
    displayMode: "bilingual", // bilingual | translation_only
    outgoing: "off", // off | translation | bilingual
    outgoingTarget: "en",
    targetLanguage: "zh-Hans",
    force: false,
    timeoutMs: 15000,
    chatLog: true, // 聊天日志开关(按比赛 ID 存本地)
    translateOwn: true, // 自己的发言也翻译(默认开)
  };

  // 选项表(驱动选择控件)
  const PROVIDER_OPTIONS = [
    { value: "bing", label: "bing(免 Key)" },
    { value: "microsoft", label: "microsoft(Azure Key)" },
    { value: "openai", label: "OpenAI 兼容(自定义)" },
    { value: "deepl", label: "DeepL(需 Key)" },
    { value: "google", label: "Google Cloud(需 Key)" },
  ];
  const LANGUAGE_OPTIONS = [
    { value: "zh-Hans", label: "简体中文 (zh-Hans)" },
    { value: "zh-Hant", label: "繁體中文 (zh-Hant)" },
    { value: "en", label: "English 英语 (en)" },
    { value: "ja", label: "日本語 日语 (ja)" },
    { value: "ko", label: "한국어 韩语 (ko)" },
    { value: "fr", label: "Français 法语 (fr)" },
    { value: "de", label: "Deutsch 德语 (de)" },
    { value: "es", label: "Español 西语 (es)" },
    { value: "custom", label: "自定义(手输语言代码)" },
  ];
  const DISPLAY_MODES = [
    { value: "bilingual", label: "双语(原文+译文)" },
    { value: "translation_only", label: "仅译文" },
  ];
  const OUTGOING_MODES = [
    { value: "off", label: "关(发原文)" },
    { value: "translation", label: "仅译文" },
    { value: "bilingual", label: "双语(原文 | 译文)" },
  ];

  const UI_CONVAR = "lct_ui";

  function loadUiConfig() {
    const cfg = Object.assign({}, UI_DEFAULTS);
    let raw = "";
    try {
      if (typeof Convars !== "undefined" && Convars.GetStr) raw = Convars.GetStr(UI_CONVAR, "");
    } catch (e) {}
    if (!raw) {
      try {
        raw = $.GetContextPanel().GetAttributeString(UI_CONVAR, "");
      } catch (e) {}
    }
    if (raw) {
      try {
        Object.assign(cfg, JSON.parse(raw));
      } catch (e) {}
    }
    return cfg;
  }

  function saveUiConfig() {
    try {
      const json = JSON.stringify(State.cfg);
      $.GetContextPanel().SetAttributeString(UI_CONVAR, json);
    } catch (e) {}
    try {
      if (typeof Convars !== "undefined") {
        if (Convars.RegisterConVar) Convars.RegisterConVar(UI_CONVAR, "{}", 0, "LinguaChat UI settings");
        if (Convars.SetValue) Convars.SetValue(UI_CONVAR, json);
      }
    } catch (e) {}
  }

  // 消息行 steamid 兜底:行面板读不到时用资料卡采集的昵称 -> steamid 映射
  function steamIdByName(sender) {
    if (!sender || sender === UNKNOWN_NAME) return "";
    const key = normName(sender);
    if (key && State.accountByName && State.accountByName[key]) return State.accountByName[key];
    return "";
  }

  // 聊天行 hero 兜底:行面板读不到时用顶栏/资料卡映射(昵称 -> 英雄)
  function fallbackHeroForSender(sender) {
    if (!sender || sender === UNKNOWN_NAME) return "";
    const key = normName(sender);
    if (key) {
      if (State.topbarHeroByName && State.topbarHeroByName[key]) return State.topbarHeroByName[key];
      if (State.heroByName && State.heroByName[key]) return State.heroByName[key];
    }
    return "";
  }

  // ================= 消息读取与过滤 =================

  function readMessageRow(row) {
    // 大厅聊天行(hudchat:ChatLineContainer 直挂 ChatLinesPanel,无 MessageSource/MessageContents)
    if (hasClass(row, LOBBY_ROW_CLASS)) {
      const lineLabel = findClass(row, LOBBY_LINE_CLASS);
      const text = safeText(lineLabel) || collectText(row);
      if (!text) return null;
      const sender = safeText(findClass(row, LOBBY_PERSONA_CLASS)) || UNKNOWN_NAME;
      const prefix = safeText(findClass(row, LOBBY_PREFIX_CLASS));
      const isOwn = hasClass(row, "IsSelf") || !!findChild(row, LOCAL_CLIENT_ID);
      return {
        sender: sender,
        channel: prefix || "lobby",
        text: text,
        isOwn: isOwn,
        hero: readHeroFromRow(row) || fallbackHeroForSender(sender),
        heroId: readHeroIdFromRow(row),
        steamid: readSteamIdFromRow(row) || steamIdByName(sender),
        lobby: true,
        quick: false,
      };
    }
    // HUD 顶栏行:无 MessageSource,文本在 MessageText(气泡内),sender 未知
    const isHudRow = hasClass(row, "ChatMessage") && !!findClass(row, HUD_BUBBLE_CLASS);
    if (isHudRow) {
      const textLabel = findChild(row, HUD_TEXT_ID);
      const text = safeText(textLabel) || collectText(row);
      if (!text) return null;
      const isOwn = hasClass(row, "IsSelf") || !!findChild(row, LOCAL_CLIENT_ID);
      if (!State.hudRowDiagLogged) {
        State.hudRowDiagLogged = true;
        try {
          let rowClasses = "";
          try { if (typeof row.GetPanelClassList === "function") rowClasses = String(row.GetPanelClassList().join(",")); } catch (e) {}
          diagLog("hud row diag: senderName=" + safeText(findClass(row, SENDER_NAME_CLASS)) + " bubble=" + (!!findClass(row, HUD_BUBBLE_CLASS)) + " heroBadge=" + (!!findChild(row, "HeroBadge")) + " heroImage=" + (!!findChild(row, "HeroImage")) + " classes=" + rowClasses);
        } catch (e) {}
      }
      // 新版气泡行若带 SenderName 直接读;否则保持 <unknown> 走 recentRows 回填
      const inlineSender = safeText(findClass(row, SENDER_NAME_CLASS)) || "";
      const sender = inlineSender || UNKNOWN_NAME;
      return { sender: sender, channel: "hud", text: text, isOwn: isOwn, hero: readHeroFromRow(row) || fallbackHeroForSender(sender), heroId: readHeroIdFromRow(row), steamid: readSteamIdFromRow(row) || steamIdByName(sender), hud: true, quick: true };
    }
    const source = findChild(row, MESSAGE_SOURCE_ID);
    const contents = findChild(row, MESSAGE_CONTENTS_ID);
    const sender =
      safeText(findClass(source, SENDER_NAME_CLASS)) ||
      safeText(findClass(row, SENDER_NAME_CLASS)) ||
      UNKNOWN_NAME;
    const channel =
      safeText(findClass(source, CHANNEL_NAME_CLASS)) ||
      safeText(findClass(row, CHANNEL_NAME_CLASS));
    const text = collectText(contents);
    if (!text) return null;
    const isOwn = hasClass(row, "IsSelf") || !!findChild(row, LOCAL_CLIENT_ID);
    return {
      sender: sender,
      channel: channel,
      text: text,
      isOwn: isOwn,
      hero: readHeroFromRow(row) || fallbackHeroForSender(sender),
      heroId: readHeroIdFromRow(row),
      steamid: readSteamIdFromRow(row) || steamIdByName(sender),
        quick: !!findChild(row, "PingLabel"),
    };
  }

  function makeSignature(record) {
    return [record.channel || "", record.sender || "", record.text || ""].join("\x00");
  }

  function isTargetLanguageText(text) {
    const t = String(State.cfg.targetLanguage || "zh-Hans").toLowerCase();
    if (t.indexOf("zh") === 0) return CJK_RE.test(text);
    return false;
  }

  // 主语言子标签是否相同(如 zh-Hans 与 zh-CN 视为同语言)
  function sameLanguage(a, b) {
    const pa = String(a || "").toLowerCase().split("-")[0];
    const pb = String(b || "").toLowerCase().split("-")[0];
    return !!pa && pa === pb;
  }

  function shouldSkip(record) {
    const text = record.text;
    if (!text || text.length < 2) return true;
    if (text.charAt(0) === "/") return true; // 指令消息
    if (/^[\d\s\W_]+$/.test(text)) return true; // 纯数字/符号
    if (record.isOwn && State.cfg.translateOwn === false) return true; // 可配置:默认翻译自己的消息
    if (!State.cfg.force && isTargetLanguageText(text)) return true; // 已为目标语言
    return false;
  }

  // ================= 译文注入 =================

  function isHudRow(row) {
    return hasClass(row, "ChatMessage") && !!findClass(row, HUD_BUBBLE_CLASS);
  }

  function isLobbyRow(row) {
    return hasClass(row, LOBBY_ROW_CLASS);
  }

  // 大厅行(flow-children:right 气泡)无法直接追加"下方"译文:
  // 首次遇到时把行内容包进 LCTLobbyWrap(横向),行自身改纵向流,译文挂在 wrap 下方。
  // 若运行时无 SetParent(极少见),放弃重构,译文内联显示(仍可见)。
  function ensureLobbyLayout(row) {
    if (row.__lctLobbyWrapped) {
      // 行可能被游戏回收复用:wrap 若已被清掉,需要重建
      if (findClass(row, "LCTLobbyWrap")) return true;
      row.__lctLobbyWrapped = false;
    }
    if (findClass(row, "LCTLobbyWrap")) {
      row.__lctLobbyWrapped = true;
      return true;
    }
    try {
      const wrap = $.CreatePanel("Panel", row, "LCTLobbyWrap" + nowMs());
      wrap.AddClass("LCTLobbyWrap");
      let guard = 0;
      while (childCount(row) > 1 && guard < 24) {
        const child = childAt(row, 0);
        if (!isValid(child) || child === wrap) break;
        if (typeof child.SetParent !== "function") break;
        try {
          child.SetParent(wrap);
        } catch (e) {
          break;
        }
        guard += 1;
      }
      if (childCount(row) > 1) {
        // 移动失败:回滚,保持原行布局
        try { wrap.DeleteAsync(0); } catch (e) {}
        return false;
      }
      try {
        row.style.flowChildren = "down";
      } catch (e) {}
      row.__lctLobbyWrapped = true;
      return true;
    } catch (e) {
      return false;
    }
  }

  // 大厅行译文挂载点:行本身(wrap 之后作为第二个子面板,纵向显示)
  function lobbyLabelHost(row) {
    ensureLobbyLayout(row);
    return row;
  }

  function transLabelId(sig) {
    return "LCTTrans" + hashString(sig);
  }

  function getTransLabel(row, sig) {
    // 深遍历找译文标签(HUD 行挂在 MessageContents 下,普通行挂在 MessageBody 下,统一从行根找)
    return findChild(row, transLabelId(sig));
  }

  // HUD 行译文挂载点:MessageContents(ChatBubble 正下方)。
  // 理由:游戏 CSS 确认 MessageContents 是 flow-children:down,译文位置确定在气泡下方;
  // 直接挂 ChatBubble 会进横向流(气泡+头像+译文并排),译文被挤到气泡右侧外部看不清。
  function hudLabelHost(row) {
    const contents = findChild(row, MESSAGE_CONTENTS_ID);
    if (contents) return contents;
    return findClass(row, HUD_BUBBLE_CLASS) || row;
  }

  function applyTransLabelStyle(label, isError) {
    try {
      const st = label.style || {};
      if (isError) {
        st.color = "#ff9b94";
        st.backgroundColor = "rgba(40, 10, 12, 0.85)";
        st.border = "1px solid rgba(255, 120, 110, 0.4)";
      } else {
        st.color = "#8fd8ff";
        st.backgroundColor = "rgba(8, 12, 20, 0.85)";
        st.border = "1px solid rgba(143, 216, 255, 0.35)";
      }
      st.borderRadius = "4px";
      st.padding = "2px 7px";
      st.fontSize = "13px";
      st.marginTop = "3px";
      st.marginLeft = "58px";
      st.maxWidth = "290px";
      st.fontStyle = "italic";
      st.textShadow = "0px 1px 2px rgba(0, 0, 0, 0.9)";
      st.whiteSpace = "normal";
    } catch (e) {}
  }

function injectTranslation(row, sig, text) {
    if (!isValid(row)) return;
    const hud = isHudRow(row);
    const lobby = isLobbyRow(row);
    // HUD 行:译文 label 挂到 MessageContents(ChatBubble 正下方);大厅行:行内容下方;普通行:MessageBody 下
    const body = hud ? hudLabelHost(row) : (lobby ? lobbyLabelHost(row) : (findClass(row, MESSAGE_BODY_CLASS) || row));
    let label = getTransLabel(row, sig);
    if (!isValid(label)) {
      try {
        label = $.CreatePanel("Label", body, transLabelId(sig));
        label.AddClass(hud ? TRANS_LABEL_HUD_CLASS : (lobby ? TRANS_LABEL_LOBBY_CLASS : TRANS_LABEL_CLASS));
      } catch (e) {
        return;
      }
    } else {
      try {
        label.RemoveClass(TRANS_ERROR_CLASS);
      } catch (e) {}
    }
    try {
      label.text = String(text);
    } catch (e) {}
    applyTransLabelStyle(label, false);
    // 只显示译文模式:隐藏原文(快捷对话/Ping 行保留气泡,避免消息"消失")
    // HUD 顶栏行/大厅行不折叠:气泡本身短暂显示,折叠会连译文一起隐藏
    if (!hud && !lobby && State.cfg.displayMode === "translation_only") {
      const contents = findChild(row, MESSAGE_CONTENTS_ID);
      if (contents) {
        let isPing = false;
        try {
          isPing = hasClass(contents, "Ping") || !!findChild(contents, "PingLabel");
        } catch (e) {}
        if (!isPing) {
          try {
            contents.style.visibility = "collapse";
          } catch (e) {}
        }
      }
    }
  }

  function injectError(row, sig, message) {
    if (!isValid(row)) return;
    const hud = isHudRow(row);
    const lobby = isLobbyRow(row);
    const body = hud ? hudLabelHost(row) : (lobby ? lobbyLabelHost(row) : (findClass(row, MESSAGE_BODY_CLASS) || row));
    let label = getTransLabel(row, sig);
    if (!isValid(label)) {
      try {
        label = $.CreatePanel("Label", body, transLabelId(sig));
        label.AddClass(hud ? TRANS_LABEL_HUD_CLASS : (lobby ? TRANS_LABEL_LOBBY_CLASS : TRANS_LABEL_CLASS));
      } catch (e) {
        return;
      }
    }
    try {
      label.AddClass(TRANS_ERROR_CLASS);
      label.text = "翻译失败: " + String(message || "未知错误").slice(0, 120);
      applyTransLabelStyle(label, true);
    } catch (e) {}
  }

  // 滚动回收重建:已翻译过的行重新出现时,从缓存恢复译文
  function restoreFromCache(row, sig) {
    const cached = State.cache.get(sig);
    if (!cached) return false;
    if (getTransLabel(row, sig)) return true;
    injectTranslation(row, sig, cached.translation);
    return true;
  }

  // ================= 翻译队列与桥接 =================

  function targetLanguage() {
    // 面板里选的目标语言优先;选了自定义则用自定义输入框的值
    let lang = State.cfg.targetLanguage || "zh-Hans";
    if (lang === "custom") {
      lang = fieldValue("LCTTargetLangCustom") || "zh-Hans";
    }
    return lang;
  }

  // 发送目标语言(处理自定义)
  function resolveOutgoingTarget() {
    let lang = State.cfg.outgoingTarget || "en";
    if (lang === "custom") {
      lang = fieldValue("LCTOutgoingTargetCustom") || "en";
    }
    return lang;
  }

  function enqueue(row, sig, record) {
    State.queue.push({ kind: "chat", row: row, sig: sig, record: record, attempts: 0 });
    pumpQueue();
  }

  function enqueueOutgoing(text, done) {
    // 超时兜底:翻译超过 OUTGOING_TIMEOUT_MS 未返回,按原文发送,避免用户等待/重复按键。
    // 计时放在 dispatchJob(任务真正开始处理时),排队等待不计入——
    // 否则连续快速发 3 条时,第 3 条还在排队就已超时,直接发原文。
    // (done 只允许触发一次:正常返回或超时,谁先到谁生效)
    let settled = false;
    const once = function (translated, detected) {
      if (settled) return;
      settled = true;
      done(translated, detected);
    };
    // 出站优先:插队到前面,不让用户的发送等在大量入站翻译后面
    State.queue.unshift({ kind: "outgoing", row: null, sig: null, record: { text: text }, attempts: 0, done: once, enqueuedAt: nowMs() });
    pumpQueue();
  }

  function enqueueBridge(op, data, done) {
    State.queue.push({ kind: "bridge", op: op, data: data, row: null, sig: null, attempts: 0, done: done });
    pumpQueue();
  }

  function pumpQueue() {
    while (State.queue.length > 0 && State.activeRequests < MAX_ACTIVE_REQUESTS) {
      let readyIndex = -1;
      for (let i = 0; i < State.queue.length; i += 1) {
        const job = State.queue[i];
        if (!job.retryAt || nowMs() >= job.retryAt) {
          readyIndex = i;
          break;
        }
      }
      if (readyIndex === -1) break;
      const job = State.queue.splice(readyIndex, 1)[0];
      State.activeRequests += 1;
      dispatchJob(job);
    }
  }

  function buildBridgeUrl(job) {
    const id = "r" + (++State.requestSeq).toString(36);
    job.id = id;
    if (job.kind === "bridge") {
      return (
        "http://" + BRIDGE_HOST + ":" + BRIDGE_PORT +
        "/bridge?id=" + id +
        "&op=" + job.op +
        "&d=" + job.data
      );
    }
    const text = encodeURIComponent(job.record.text);
    const source = encodeURIComponent("auto");
    const target = encodeURIComponent(job.kind === "outgoing" ? resolveOutgoingTarget() : targetLanguage());
    const tm = job.kind === "outgoing" ? OUTGOING_TIMEOUT_MS : (State.cfg.timeoutMs || 15000);
    return (
      "http://" + BRIDGE_HOST + ":" + BRIDGE_PORT +
      "/bridge?id=" + id +
      "&op=translate&text=" + text +
      "&source=" + source +
      "&target=" + target +
      "&timeoutMs=" + tm
    );
  }

  // HTML 桥面板:必须在 chat.xml 里用 <HTML id="LCTBridgePanel"> 声明,
  // 这里只做查找;运行时 $.CreatePanel("HTML",...) 不会得到可用的 HTML 面板。
  function ensurePanel() {
    if (isValid(State.panel) && typeof State.panel.SetURL === "function") return State.panel;
    const root = getRoot();
    if (!root) return null;
    State.panel = findChild(root, BRIDGE_PANEL_ID);
    if (isValid(State.panel)) {
      if (!State.panelLogged) {
        State.panelLogged = true;
        log("bridge panel found; SetURL=" + (typeof State.panel.SetURL === "function" ? "yes" : "NO") + ", title=" + typeof State.panel.title);
      }
      if (typeof State.panel.SetURL !== "function") return null;
      return State.panel;
    }
    if (!State.panelLogged) {
      State.panelLogged = true;
      log("bridge panel NOT found (id=" + BRIDGE_PANEL_ID + "); check chat.xml");
    }
    return null;
  }

  // 直连桥(GET /api/v1/*,经 $.AsyncWebRequest)。
  // 背景:HTML 面板方案在连续导航时会失效(第一条成功,后续 SetURL 导航可能不触发
  // title 更新,导致"几条消息后翻译失效/测试卡住/发送前翻译不可用")。
  // $.AsyncWebRequest 是引擎级 HTTP API(chat_translator 版本验证可用),每条请求独立,无导航竞争。
  function buildApiUrl(job) {
    const base = "http://" + BRIDGE_HOST + ":" + BRIDGE_PORT + "/api/v1/";
    if (job.kind === "bridge") {
      // data 已由 bridgePost 做过 encodeURIComponent,这里不能再次编码,
      // 否则服务端 URLSearchParams 只解码一次,JSON.parse 会失败(日志/配置保存丢失)
      return base + job.op + "?d=" + (job.data || "{}");
    }
    const text = encodeURIComponent(job.record.text);
    const target = encodeURIComponent(job.kind === "outgoing" ? resolveOutgoingTarget() : targetLanguage());
    // provider 不传:由桥按 config.json 的 provider 执行(设置面板保存或手改 config.json 均生效,
    // 避免游戏侧 State.cfg.provider 与桥不同步导致 OpenAI/DeepSeek 配置不生效)
    // 显式传 timeoutMs:出站翻译用 OUTGOING_TIMEOUT_MS(长文本/DeepSeek 需要更久),
    // 普通翻译用用户配置,避免桥端先于游戏侧放弃(否则首次长文本会"发原文,二次才发译文")
    const tm = job.kind === "outgoing" ? OUTGOING_TIMEOUT_MS : (State.cfg.timeoutMs || 12000);
    return base + "translate?text=" + text + "&source=auto&target=" + target + "&timeoutMs=" + tm;
  }

  // 引擎级 HTTP GET 封装(超时兜底,settled 防双触发)
  function httpGetJson(url, cb, timeoutMs) {
    let settled = false;
    const done = function (payload) {
      if (settled) return;
      settled = true;
      try { cb(payload || { ok: false, error: "bad_response" }); } catch (e) {}
    };
    try {
      if (typeof $.AsyncWebRequest !== "function") {
        done({ ok: false, error: "no_asyncwebrequest" });
        return;
      }
    } catch (e) {
      done({ ok: false, error: "no_asyncwebrequest" });
      return;
    }
    let timer = null;
    try {
      timer = setTimeout(function () {
        done({ ok: false, error: "http_timeout" });
      }, timeoutMs || 10000);
    } catch (e) {
      timer = null;
    }
    if (!timer) {
      // Panorama 无 setTimeout 时用 $.Schedule 兜底(秒级;settled 保证单次)
      try {
        $.Schedule(Math.max(1, Math.round((timeoutMs || 10000) / 1000)), function () {
          done({ ok: false, error: "http_timeout" });
        });
      } catch (e) {}
    }
    const parseBody = function (body) {
      if (timer) { try { clearTimeout(timer); } catch (e) {} }
      try {
        if (typeof body === "string" && body) { done(JSON.parse(body)); return; }
      } catch (e) {}
      done({ ok: false, error: "bad_response" });
    };
    // 真实引擎 API(chat_translator 同款):$.AsyncWebRequest(url, {type:"GET", timeout}) 返回 Promise<string>
    try {
      const promise = $.AsyncWebRequest(url, { type: "GET", timeout: timeoutMs || 10000 });
      if (promise && typeof promise.then === "function") {
        promise.then(
          function (body) { parseBody(body); },
          function (err) {
            if (timer) { try { clearTimeout(timer); } catch (e) {} }
            done({ ok: false, error: (err && err.message) ? String(err.message) : "request_failed" });
          }
        );
        return;
      }
    } catch (e) {}
    // 兜底:SendRequest 回调风格(仅模拟测试/旧引擎)
    try {
      let req = null;
      try { req = $.AsyncWebRequest(url); } catch (e) {}
      if (req && typeof req.SendRequest === "function") {
        req.SendRequest(function (status, body) {
          if (timer) { try { clearTimeout(timer); } catch (e) {} }
          try {
            if (typeof body === "string" && body) { done(JSON.parse(body)); return; }
          } catch (e) {}
          done({ ok: false, error: "bad_response_" + String(status) });
        });
        return;
      }
    } catch (e) {}
    if (timer) { try { clearTimeout(timer); } catch (e) {} }
    done({ ok: false, error: "http_exception" });
  }

  // 统一桥响应处理(直连通道与 HTML 面板 fallback 共用)
  function handleBridgePayload(job, payload) {
    if (job.kind === "outgoing") {
      // 已超时:done+finishJob 已由超时回调完成,这里直接退出
      if (job._timedOut) return;
      if (job._timeout) { try { clearTimeout(job._timeout); } catch (e) {} job._timeout = null; }
      if (payload && payload.ok && payload.translation) {
        job.done(payload.translation, payload.detectedLanguage || null);
        finishJob();
      } else {
        job.attempts += 1;
        if (job.attempts < 2) {
          job.retryAt = nowMs() + 600;
          State.queue.unshift(job);
          $.Schedule(0.6, pumpQueue);
          finishJob();
          log("outgoing retry (1): " + String(job.record.text || "").slice(0, 40));
        } else {
          job.done(null, null);
          finishJob();
        }
      }
    } else if (job.kind === "bridge") {
      job.done(payload || { ok: false, error: "bad_bridge_payload" });
      finishJob();
    } else if (payload.ok) {
      handleResult(job, payload);
    } else {
      failJob(job, payload.error || "unknown_error");
    }
  }

  // ---- 传输通道探测 ----
  // 当前 Deadlock 版本已移除 $.AsyncWebRequest(函数仍存在,但调用即同步抛
  // "AsyncWebRequest has been removed"),只用 typeof 检查会误判可用,导致每次
  // 请求都失败、桥永远显示离线。启动后实际调用一次探测:
  //   - 同步抛异常   -> 不可用,回退 HTML 面板通道(SetURL + document.title 轮询)
  //   - 返回 Promise -> 可用,走直连 GET(引擎内置翻译器同款用法)
  function detectAsyncWebRequest() {
    if (State.canHttp !== null) return State.canHttp;
    let ok = false;
    try {
      if (typeof $.AsyncWebRequest === "function") {
        const probe = $.AsyncWebRequest(
          "http://" + BRIDGE_HOST + ":" + BRIDGE_PORT + "/api/v1/health",
          { type: "GET", timeout: 3000 }
        );
        ok = !!(probe && typeof probe.then === "function");
        if (ok) {
          // 吞掉探测结果(桥未启动时 Promise 会 reject,避免未处理 rejection)
          try { probe.then(function () {}, function () {}); } catch (e) {}
        }
      }
    } catch (e) {
      ok = false;
    }
    State.canHttp = ok;
    log("bridge transport: AsyncWebRequest " + (ok ? "available (direct)" : "removed/unavailable, using HTML panel channel"));
    return ok;
  }

  // 直连通道的传输层错误(引擎移除 API / 同步异常):换成 HTML 面板通道重试才有意义;
  // 桥未启动/超时等业务性失败不算,继续走直连即可。
  function isTransportError(err) {
    const s = String(err || "");
    return s === "http_exception" || s === "no_asyncwebrequest" || s.indexOf("removed") !== -1;
  }

  // HTML 面板通道:SetURL 导航 /bridge 页面,轮询 document.title 读回
  // (AsyncWebRequest 被移除的游戏版本唯一可用通道;DLCT 同款机制)
  function dispatchViaPanel(job) {
    const panel = ensurePanel();
    if (!isValid(panel) || typeof panel.SetURL !== "function") {
      if (job.kind === "outgoing") {
        job.done(null, null);
        finishJob();
      } else if (job.kind === "bridge") {
        job.done({ ok: false, error: "bridge_panel_unavailable" });
        finishJob();
      } else {
        failJob(job, "bridge_panel_unavailable");
      }
      return;
    }
    const url = buildBridgeUrl(job);
    setPending(job.id, function (payload) {
      handleBridgePayload(job, payload);
    }, job.kind === "outgoing" ? OUTGOING_TIMEOUT_MS : (State.cfg.timeoutMs || 15000));
    try {
      panel.SetURL(url);
    } catch (e) {
      State.pending = null;
      log("SetURL failed: " + (e && e.message ? e.message : String(e)));
      if (job.kind === "outgoing") {
        job.done(null, null);
        finishJob();
      } else if (job.kind === "bridge") {
        job.done({ ok: false, error: "bridge_load_failed" });
        finishJob();
      } else {
        failJob(job, "bridge_load_failed");
      }
    }
  }

  function dispatchJob(job) {
    const panel = ensurePanel();
    const canHttp = detectAsyncWebRequest();
    if (!panel && !canHttp) {
      // 出站/桥任务不重试:通道不可用立即回传失败(出站则发原文),避免拖延用户发消息
      if (job.kind === "outgoing") {
        job.done(null, null);
        finishJob();
      } else if (job.kind === "bridge") {
        job.done({ ok: false, error: "bridge_panel_unavailable" });
        finishJob();
      } else {
        failJob(job, "bridge_panel_unavailable");
      }
      return;
    }
    ensureBridgeEvents();
    // 出站翻译排队超过 15s 未轮到(队列被其他请求占满)直接发原文,避免输入卡死
    if (job.kind === "outgoing" && job.enqueuedAt && nowMs() - job.enqueuedAt > 25000) {
      job.done(null, null);
      finishJob();
      log("outgoing dropped: queued too long, sending original");
      return;
    }
    // 出站翻译超时计时从此刻(开始处理)算起;排队等待不计入
    if (job.kind === "outgoing") {
      let scheduled = false;
      try {
        job._timeout = setTimeout(function () {
          if (!job._timedOut) {
            job._timedOut = true;
            job.done(null, null);
            finishJob();
          }
        }, OUTGOING_TIMEOUT_MS);
        scheduled = true;
      } catch (e) {}
      if (!scheduled) {
        // Panorama 无 setTimeout 时用 $.Schedule 兑底(秒级;_timedOut 保证单次)
        try {
          $.Schedule(Math.max(1, Math.round(OUTGOING_TIMEOUT_MS / 1000)), function () {
            if (!job._timedOut) {
              job._timedOut = true;
              job.done(null, null);
              finishJob();
            }
          });
        } catch (e) {}
      }
    }
    // 优先:AsyncWebRequest 直连本地桥(可用时最快;每条请求独立,无导航竞争)
    if (canHttp) {
      const apiUrl = buildApiUrl(job);
      const panelForFallback = panel;
      httpGetJson(apiUrl, function (payload) {
        if (job.kind === "outgoing" && job._timedOut) return;
        // 直连传输失败(引擎移除 AsyncWebRequest 等):切换到 HTML 面板通道重试
        if (payload && !payload.ok && isTransportError(payload.error) && State.canHttp) {
          State.canHttp = false;
          log("direct transport failed (" + payload.error + "); switching to HTML panel channel");
          if (isValid(panelForFallback)) {
            dispatchViaPanel(job);
            return;
          }
        }
        handleBridgePayload(job, payload);
      }, job.kind === "outgoing" ? OUTGOING_TIMEOUT_MS : (State.cfg.timeoutMs || 12000));
      return;
    }
    // fallback:HTML 面板导航(AsyncWebRequest 被移除的版本走这里)
    dispatchViaPanel(job);
  }

  // ================= 统一桥请求状态机 =================
  // 同一时刻只有一个在途请求(聊天翻译串行 + 面板操作互斥)。
  // 读回双通道:
  //   1. HTML 面板事件(HTMLChangedTitle 等,主通道,DLCT 同款机制)
  //   2. panel.title 轮询(兜底)

  const BRIDGE_EVENT_CANDIDATES = [
    "HTMLContentLoaded", "HTMLLoadPage", "HTMLStartRequest", "HTMLFinishRequest",
    "HTMLURLChanged", "HTMLChangedTitle", "HTMLTitle",
  ];

  function setPending(id, onResult, timeoutMs) {
    if (State.pending) {
      const old = State.pending;
      State.pending = null;
      try {
        old.onResult({ ok: false, error: "superseded" });
      } catch (e) {}
    }
    State.pending = {
      id: id,
      onResult: onResult,
      deadline: nowMs() + (timeoutMs || 15000),
      sawAlive: false,
    };
    startTitlePolling();
  }

  function extractEventText(arg) {
    if (arg == null) return "";
    try {
      if (typeof arg === "string") return arg;
    } catch (e) {}
    try {
      if (typeof arg.title === "string") return arg.title;
    } catch (e) {}
    try {
      if (typeof arg.url === "string") return arg.url;
    } catch (e) {}
    try {
      if (typeof arg.src === "string") return arg.src;
    } catch (e) {}
    try {
      if (typeof arg.text === "string") return arg.text;
    } catch (e) {}
    try {
      if (typeof arg.GetAttributeString === "function") {
        return String(
          arg.GetAttributeString("title", "") ||
          arg.GetAttributeString("url", "") ||
          arg.GetAttributeString("src", "") ||
          ""
        );
      }
    } catch (e) {}
    return "";
  }

  function tryResolveFromText(text) {
    const pending = State.pending;
    if (!pending) return false;
    const marker = TITLE_PREFIX + pending.id;
    const hay = String(text || "");
    const idx = hay.indexOf(marker);
    if (idx === -1) return false;
    let payload = null;
    try {
      payload = JSON.parse(hay.slice(idx + marker.length));
    } catch (e) {}
    if (!payload) return false;
    State.pending = null;
    pending.onResult(payload);
    return true;
  }

  function onBridgeEvent(a, b, c, d) {
    if (tryResolveFromText(extractEventText(a))) return;
    if (tryResolveFromText(extractEventText(b))) return;
    if (tryResolveFromText(extractEventText(c))) return;
    if (tryResolveFromText(extractEventText(d))) return;
    // 页面加载完成标记
    const t = String(extractEventText(a) || extractEventText(b) || "");
    if (t === TITLE_ALIVE) {
      markBridgeUp();
      if (State.pending) State.pending.sawAlive = true;
    }
  }

  function ensureBridgeEvents() {
    if (State.eventsRegistered) return;
    State.eventsRegistered = true;
    for (let i = 0; i < BRIDGE_EVENT_CANDIDATES.length; i += 1) {
      try {
        $.RegisterForUnhandledEvent(BRIDGE_EVENT_CANDIDATES[i], onBridgeEvent);
      } catch (e) {}
    }
    log("bridge events registered");
  }

  function markBridgeUp() {
    if (!State.bridgeUp) {
      State.bridgeUp = true;
      log("bridge online");
    }
  }

  function startTitlePolling() {
    if (State.polling) return;
    State.polling = true;
    $.Schedule(TITLE_POLL_SECONDS, pollTitle);
  }

  function readBridgeTitle() {
    const panel = State.panel;
    if (!isValid(panel)) return null;
    // 主通道:页面 document.title;备选:属性 / GetTitle()
    try {
      if (typeof panel.title === "string" && panel.title) return panel.title;
    } catch (e) {}
    try {
      const attr = panel.GetAttributeString ? panel.GetAttributeString("title", "") : "";
      if (attr) return attr;
    } catch (e) {}
    try {
      if (typeof panel.GetTitle === "function") {
        const t = panel.GetTitle();
        if (t) return String(t);
      }
    } catch (e) {}
    return null;
  }

  function pollTitle() {
    State.polling = false;
    const pending = State.pending;
    if (!pending) return;
    const title = readBridgeTitle();
    if (title === TITLE_ALIVE) {
      markBridgeUp();
      pending.sawAlive = true;
    } else if (title && title.indexOf(TITLE_PREFIX + pending.id) === 0) {
      // 轮询通道命中:标题 = 前缀 + id + JSON
      let payload = null;
      try {
        payload = JSON.parse(title.slice((TITLE_PREFIX + pending.id).length));
      } catch (e) {}
      State.pending = null;
      pending.onResult(payload || { ok: false, error: "bad_bridge_payload" });
      return;
    }
    // 超时处理
    if (nowMs() >= pending.deadline) {
      State.pending = null;
      if (!State.bridgeUp && !pending.sawAlive) {
        warnBridgeOffline();
        pending.onResult({ ok: false, error: "bridge_offline" });
      } else {
        pending.onResult({ ok: false, error: "timeout" });
      }
      return;
    }
    $.Schedule(TITLE_POLL_SECONDS, pollTitle);
  }

  function warnBridgeOffline() {
    if (State.panelWarned) return;
    State.panelWarned = true;
    log("bridge offline: 请先启动 core/bridge_server.js(或 StartDeadlock.bat)");
    setStatus("本地桥未运行:请先运行 StartDeadlock.bat");
  }

  function handleResult(job, payload) {
    if (payload.ok && payload.translation) {
      State.cache.set(job.sig, { translation: payload.translation });
      trimCache();
      // 行可能已被回收复用:只有行仍持有同一条消息时才注入,避免旧译文贴到新消息
      if (isValid(job.row) && job.row.__lctSig === job.sig) {
        injectTranslation(job.row, job.sig, payload.translation);
        log("translated [" + (job.record.channel || "chat") + "] " + job.record.sender + ": " + payload.translation.slice(0, 60));
      } else {
        // 诊断:翻译成功但行已失效(游戏可能在 2 秒内清理了顶栏消息行)
        log("translated skipped: row=" + (isValid(job.row) ? "valid" : "GONE") + " sig=" + ((job.row && job.row.__lctSig === job.sig) ? "match" : "MISMATCH") + " text=" + String(job.record.text || "").slice(0, 30));
        // HUD 测试行被游戏清理后,重建一条译文显示行(验证通路;真实消息行生命周期更长不受影响)
        tryRecreateHudTranslation(job, payload.translation);
      }
      finishJob();
    } else {
      failJob(job, payload.error || "unknown_error");
    }
  }

  // HUD 顶栏行被游戏快速清理(外来构造行无内部状态)时,在顶栏 chat 根面板下挂独立译文浮层
  // (不挂在 #Messages 下、不带 ChatMessage 类,避开游戏消息清理器),显示 5 秒后自删。
  function tryRecreateHudTranslation(job, translation) {
    try {
      if (job.record.channel !== "hud") return;
      resolveHudMessages();
      if (State.hudMessages.length === 0) return;
      const container = State.hudMessages[0]; // #Messages
      if (!isValid(container)) return;
      // 浮层挂在 Messages 的父级(CitadelHudTopBarChat 根)下,而非 Messages 内
      const parent = container.GetParent ? container.GetParent() : null;
      if (!isValid(parent)) return;
      const overlay = $.CreatePanel("Panel", parent, "LCTOverlay" + nowMs());
      overlay.AddClass("LCTTransOverlay");
      const label = $.CreatePanel("Label", overlay, "");
      label.AddClass("LCTTransOverlayText");
      label.text = String(translation || "");
      log("HUD test: recreated translation overlay (original row was cleaned up)");
      // 5 秒后自删(译文浮层仅用于测试验证通路,不长期占用)
      $.Schedule(5.0, function () {
        try {
          if (isValid(overlay)) overlay.DeleteAsync(0);
        } catch (e) {}
      });
    } catch (e) {
      log("HUD test: recreate failed: " + (e && e.message ? e.message : String(e)));
    }
  }

  // 失败/重试:统一由 failJob 释放活动槽(finishJob),避免队列卡死
  function failJob(job, error) {
    job.attempts += 1;
    if (job.attempts < RETRY_LIMIT) {
      job.retryAt = nowMs() + RETRY_DELAY_SECONDS * 1000;
      State.queue.unshift(job);
      $.Schedule(RETRY_DELAY_SECONDS, pumpQueue);
      log("retry (" + job.attempts + "): " + String(error).slice(0, 80));
    } else {
      // 失败后允许同一文本在新行上重试(旧行已注入错误;seen 去重不应永久吞掉重试)
      if (job.kind === "chat" && job.sig) {
        try { State.seen.delete(job.sig); } catch (e) {}
      }
      if (isValid(job.row) && job.row.__lctSig === job.sig) {
        injectError(job.row, job.sig, String(error || "unknown_error").slice(0, 120));
      }
      log("failed: " + String(error).slice(0, 80));
    }
    finishJob();
  }

  function finishJob() {
    State.activeRequests = Math.max(0, State.activeRequests - 1);
    pumpQueue();
  }

  function trimCache() {
    while (State.cache.size > CACHE_LIMIT) {
      const firstKey = State.cache.keys().next().value;
      if (firstKey === undefined) break;
      State.cache.delete(firstKey);
    }
  }

  // ---- 聊天日志(按比赛 ID 划分,经桥写入本地 logs/chat/) ----

  // 最近完整日志去重缓存:文本 -> { t, isOwn }(剔除 HUD 重复行与挂起条目的重复记录)
  function pruneRecentLogs() {
    if (!State.recentLogs || State.recentLogs.size === 0) return;
    const cutoff = nowMs() - LOG_DEDUP_WINDOW_MS;
    const keys = [];
    const it = State.recentLogs.keys();
    let k = it.next();
    while (!k.done) {
      keys.push(k.value);
      k = it.next();
    }
    for (let i = 0; i < keys.length; i += 1) {
      const rec = State.recentLogs.get(keys[i]);
      if (!rec || rec.t < cutoff) State.recentLogs.delete(keys[i]);
    }
  }

  function recentLogHit(text, isOwn, sender) {
    pruneRecentLogs();
    const t = String(text || "").trim();
    if (!t) return false;
    const rec = State.recentLogs.get(t);
    if (!rec) return false;
    if (rec.isOwn !== !!isOwn) return false;
    // 已落盘的是 <unknown> 兜底条目:不算完整行,不能拦住晚到的带 sender 完整行
    if (sender && sender !== UNKNOWN_NAME && !rec.sender) return false;
    if (sender && sender !== UNKNOWN_NAME && rec.sender && rec.sender !== sender) return false;
    return nowMs() - rec.t <= LOG_DEDUP_WINDOW_MS;
  }

  function rememberRecentLog(text, isOwn, sender) {
    pruneRecentLogs();
    const t = String(text || "").trim();
    if (!t) return;
    State.recentLogs.set(t, { t: nowMs(), isOwn: !!isOwn, sender: String(sender || "") });
    if (State.recentLogs.size > LOG_DEDUP_LIMIT) {
      const firstKey = State.recentLogs.keys().next().value;
      if (firstKey !== undefined) State.recentLogs.delete(firstKey);
    }
  }

  // 快速发言文本归一化:去多余空白 + 去尾部感叹号/问号等标点。
  // 气泡与左下聊天行对同一消息的文本略有差异(如 "撤退" vs "撤退!"),归一化后按同一条处理。
  function normalizeQuickText(text) {
    return String(text || "").replace(/\s+/g, " ").replace(/[！!？?。，,．.、]+$/g, "").trim().toLowerCase();
  }

  // 记录一条已知 sender 的完整行(供后续 HUD 气泡/未知行回填 sender)
  function rememberRecentRow(entry) {
    const sender = String(entry.sender || "").trim();
    if (!sender || sender === UNKNOWN_NAME) return;
    const norm = normalizeQuickText(entry.text);
    if (!norm) return;
    const cutoff = nowMs() - HUD_SENDER_MATCH_MS;
    while (State.recentRows.length && State.recentRows[0].t < cutoff) State.recentRows.shift();
    State.recentRows.push({
      norm: norm,
      sender: sender,
      hero: String(entry.hero || ""),
      heroId: String(entry.heroId || ""),
      steamid: String(entry.steamid || ""),
      isOwn: !!entry.isOwn,
      channel: String(entry.channel || ""),
      t: nowMs(),
    });
    if (State.recentRows.length > RECENT_ROWS_LIMIT) {
      State.recentRows.splice(0, State.recentRows.length - RECENT_ROWS_LIMIT);
    }
  }

  // 在最近完整行中找同文本(归一化)的已知 sender;isOwn 一致者优先
  function matchKnownSender(record) {
    const norm = normalizeQuickText(record.text);
    if (!norm) return null;
    const cutoff = nowMs() - HUD_SENDER_MATCH_MS;
    let best = null;
    for (let i = State.recentRows.length - 1; i >= 0; i -= 1) {
      const r = State.recentRows[i];
      if (r.t < cutoff) continue;
      if (r.norm !== norm) continue;
      if (!best) best = r;
      else if (best.isOwn !== !!record.isOwn && r.isOwn === !!record.isOwn) best = r;
    }
    return best;
  }

  // 最近完整行中是否已存在同文本(归一化)同 sender 的行(用于跳过重复落盘)
  function recentRowHit(record) {
    const norm = normalizeQuickText(record.text);
    if (!norm) return false;
    const cutoff = nowMs() - HUD_SENDER_MATCH_MS;
    const sender = String(record.sender || "");
    // <unknown> 按通配处理:占位条目兜底落盘前检查时不要求 sender 一致
    const senderKey = (sender && sender !== UNKNOWN_NAME) ? sender : "";
    for (let i = State.recentRows.length - 1; i >= 0; i -= 1) {
      const r = State.recentRows[i];
      if (r.t < cutoff) continue;
      if (r.norm !== norm) continue;
      if (r.isOwn !== !!record.isOwn) continue;
      if (senderKey && r.sender && senderKey !== r.sender) continue;
      return true;
    }
    return false;
  }

  // HUD 占位被完整行顶掉后的长窗口去重:同一文本的 HUD 副本行在窗口内不再挂起,
  // 避免 15s 去重窗口过期后 HUD 行仍留在 DOM 被重扫,又生成 <unknown> 重复条目
  function pruneHudSatisfied() {
    if (!State.hudSatisfied || State.hudSatisfied.size === 0) return;
    const cutoff = nowMs() - HUD_SATISFIED_WINDOW_MS;
    const keys = [];
    const it = State.hudSatisfied.keys();
    let k = it.next();
    while (!k.done) { keys.push(k.value); k = it.next(); }
    for (let i = 0; i < keys.length; i += 1) {
      if (State.hudSatisfied.get(keys[i]) < cutoff) State.hudSatisfied.delete(keys[i]);
    }
  }

  function hudSatisfiedHit(text, isOwn) {
    pruneHudSatisfied();
    const key = normalizeQuickText(text) + "\x00" + (isOwn ? "1" : "0");
    const t = State.hudSatisfied && State.hudSatisfied.get(key);
    if (!t) return false;
    return nowMs() - t <= HUD_SATISFIED_WINDOW_MS;
  }

  function hudSatisfiedRemember(text, isOwn) {
    pruneHudSatisfied();
    const key = normalizeQuickText(text) + "\x00" + (isOwn ? "1" : "0");
    if (!key || key.charAt(0) === "\x00") return;
    State.hudSatisfied.set(key, nowMs());
    if (State.hudSatisfied.size > LOG_DEDUP_LIMIT) {
      const firstKey = State.hudSatisfied.keys().next().value;
      if (firstKey !== undefined) State.hudSatisfied.delete(firstKey);
    }
  }

  // 挂起条目键:文本+是否自己+发送者
  // 发送者参与键:不同人说的同一句话各自留档,不会被合并漏记;
  // HUD 顶栏行无发送者,统一按空串,便于左下聊天完整行到达时顶掉同文本的 HUD 占位。
  function pendingKey(text, isOwn, sender) {
    const s = String(sender || "");
    return String(text || "").trim() + "\x00" + (isOwn ? "1" : "0") + "\x00" + (s === UNKNOWN_NAME ? "" : s);
  }

  // 是否存在同文本同归属的挂起条目(不看发送者:HUD 顶栏行是左下行的重复展示,
  // 任意发送者的同文本挂起都视为同一消息的副本)
  function pendingExists(text, isOwn) {
    const wantText = String(text || "").trim();
    const wantOwn = isOwn ? "1" : "0";
    for (const k of Object.keys(State.pendingLogs)) {
      const parts = k.split("\x00");
      if ((parts[0] || "") === wantText && (parts[1] || "0") === wantOwn) return true;
    }
    return false;
  }

  function buildLogEntry(record) {
    const kind = record.quick ? "quick" : (record.hud ? "hud" : (record.lobby ? "lobby" : "chat"));
    return {
      t: new Date().toISOString(),
      kind: kind,
      sender: resolveSender(record),
      hero: resolveHero(record),
      heroId: resolveHeroId(record),
      steamid: resolveSteamId(record),
      channel: String(record.channel || ""),
      isOwn: !!record.isOwn,
      text: String(record.text || "").slice(0, 2000),
    };
  }


  // 挂起一条字段未填充完整的记录:等完整版到达后丢弃,或超时后兜底落盘(不丢消息)
  // 重复扫描同一行时不刷新首次挂起时间,避免持续重扫导致永不落盘。
  // 键含发送者:不同发送者的同文本互不覆盖,各自留档;
  // 同发送者合并,空占位(HUD 副本/未补全行)被带名字的完整行顶掉时继承挂起时间。
  function deferLog(record) {
    const entry = buildLogEntry(record);
    const key = pendingKey(entry.text, entry.isOwn, entry.sender);
    const senderPart = key.slice(key.lastIndexOf("\x00") + 1);
    let t = nowMs();
    for (const k of Object.keys(State.pendingLogs)) {
      const existing = State.pendingLogs[k];
      if (!existing) continue;
      const parts = k.split("\x00");
      if ((parts[0] || "") !== entry.text) continue;
      if ((parts[1] || "0") !== (entry.isOwn ? "1" : "0")) continue;
      const otherPart = parts[2] || "";
      if (otherPart === senderPart || !otherPart) {
        t = existing.t || t;
        delete State.pendingLogs[k];
      }
      // 两个都有名字且不同:不同玩家的同文本,各自留档,不合并。
    }
    State.pendingLogs[key] = { entry: entry, t: t };
  }

  // 清掉挂起条目:精确键(文本+是否自己+发送者),外加同文本的空发送者占位键
  // (HUD 副本/未补全行),避免完整行落盘后 HUD 占位超时又补一条重复。
  function dropPending(text, isOwn, sender) {
    const keys = [pendingKey(text, isOwn, sender)];
    const placeholder = pendingKey(text, isOwn, "");
    if (keys[0] !== placeholder) keys.push(placeholder);
    let removed = false;
    for (let i = 0; i < keys.length; i += 1) {
      if (State.pendingLogs[keys[i]]) {
        delete State.pendingLogs[keys[i]];
        removed = true;
      }
    }
    // 占位被完整行顶掉:登记长窗口去重,防止同一 HUD/未补全行超时后重扫再次挂起
    if (removed) hudSatisfiedRemember(text, isOwn);
  }

  // 挂起超过等待窗口的记录兜底落盘(此时通常已无完整版,宁留 <unknown> 不漏消息)
  // 兜底条目不写入 recentLogs:HUD 去重只针对"已有完整普通记录"的重复行,
  // 避免把 HUD-only 快速指令的不同次触发误去重
  function flushPendingLogs() {
    const cutoff = nowMs() - PENDING_LOG_TIMEOUT_MS;
    for (const key of Object.keys(State.pendingLogs)) {
      const item = State.pendingLogs[key];
      if (item && item.t <= cutoff) {
        // 兜底落盘前再查一次:完整行已到(同文本,占位 sender 未知按通配)
        // -> 丢弃占位,避免 <unknown> 与完整行重复
        if (recentRowHit(item.entry) || recentLogHit(item.entry.text, item.entry.isOwn, item.entry.sender)) {
          delete State.pendingLogs[key];
          continue;
        }
        State.logBuffer.push(item.entry);
        delete State.pendingLogs[key];
      }
    }
  }

  function pushEntry(entry) {
    State.logBuffer.push(entry);
    rememberRecentLog(entry.text, entry.isOwn, entry.sender);
    rememberRecentRow(entry);
    if (State.logBuffer.length >= 30) flushChatLog();
    else if (!State.logFlushing) {
      State.logFlushing = true;
      $.Schedule(3.0, flushChatLog);
    }
  }

  function pushChatLog(record) {
    if (State.cfg && State.cfg.chatLog === false) return;
    const text = String(record.text || "").slice(0, 2000);
    if (!text) return;
    let sender = String(record.sender || "").trim();
    const channel = String(record.channel || "");

    // HUD 顶栏行是左下聊天行的重复展示:
    // - 同文本最近已有完整记录 -> 跳过,避免 <unknown>/hud 重复条目
    // - 气泡行无 sender:先用最近完整行(归一化文本)回填 sender/hero/steamid,
    //   回填后若同文本已记录则不再重复落盘
    // - 已挂起同文本 -> 跳过(等完整版或超时兜底)
    // - 否则挂起等待补全,避免与晚到的完整普通行重复
    if (record.hud) {
      if (recentLogHit(text, record.isOwn)) return;
      if (hudSatisfiedHit(text, record.isOwn)) return;
      if (!sender || sender === UNKNOWN_NAME) {
        const known = matchKnownSender(record);
        if (known) {
          record = Object.assign({}, record, {
            sender: known.sender,
            isOwn: record.isOwn || known.isOwn,
            channel: (known.channel && record.channel === "hud") ? known.channel : record.channel,
            hero: record.hero || known.hero,
            heroId: record.heroId || known.heroId,
            steamid: record.steamid || known.steamid,
          });
          sender = String(record.sender || "");
        }
      }
      // 自己的 HUD 消息:补本地玩家昵称,让英雄/SteamID 能按昵称解析
      // (仅 isOwn 时补;他人消息补本地昵称会造成错误归属)
      if (record.isOwn && (!sender || sender === UNKNOWN_NAME)) {
        const ownName = localPlayerName();
        if (ownName) record = Object.assign({}, record, { sender: ownName });
      }
      // 已由完整行记录过(同一消息) -> 跳过气泡副本
      if (recentRowHit(record)) return;
      if (pendingExists(text, record.isOwn)) return;
      deferLog(record);
      return;
    }

    // 普通行尚未填充完整(sender 为空):先按文本回填已知 sender,再挂起等字段就绪,
    // 避免先落 <unknown> 再补完整行的重复。后续扫描同一行会继续更新挂起条目;
    // 超时由 flushPendingLogs 兜底落盘。
    // (英雄/SteamID 当前版本无法解析,身份字段就绪后由完整记录路径落盘)
    if (!sender || sender === UNKNOWN_NAME) {
      const known = matchKnownSender(record);
      if (known) {
        record = Object.assign({}, record, {
          sender: known.sender,
          isOwn: record.isOwn || known.isOwn,
          channel: record.channel || known.channel,
          hero: record.hero || known.hero,
          heroId: record.heroId || known.heroId,
          steamid: record.steamid || known.steamid,
        });
        sender = String(record.sender || "");
      }
    }
    // 自己的普通行消息也补本地昵称(HUD 分支之外;他人消息补本地昵称会造成错误归属)
    if (record.isOwn && (!sender || sender === UNKNOWN_NAME)) {
      const ownName = localPlayerName();
      if (ownName) record = Object.assign({}, record, { sender: ownName });
    }

    if (!sender || sender === UNKNOWN_NAME) {
      deferLog(record);
      return;
    }
    // 同一消息在多个容器各有一条行(左下/顶栏/气泡):同文本同 sender 最近已落盘则跳过
    if (recentLogHit(text, record.isOwn, sender)) return;
    dropPending(text, record.isOwn, sender);
    pushEntry(buildLogEntry(record));
  }

  function flushChatLog() {
    State.logFlushing = false;
    flushPendingLogs(); // 超时的挂起条目先兜底进缓冲,一并发送
    // 按时间排序:挂起条目超时兜底会打乱顺序(先记录的占位可能晚于后记录的完整行落盘)
    State.logBuffer.sort(function (a, b) {
      const ta = String(a.t || "");
      const tb = String(b.t || "");
      return ta < tb ? -1 : ta > tb ? 1 : 0;
    });
    const lines = State.logBuffer.splice(0, 50);
    if (!lines.length) return;
    bridgePost("log", { matchId: getMatchId(), lines: lines }, function (res) {
      if (res && !res.ok) {
        // 失败重放一次,避免丢日志;仍失败则丢弃(不阻塞翻译)
        if (lines.length && !State.logBuffer.__retried) {
          State.logBuffer.__retried = true;
          State.logBuffer.unshift.apply(State.logBuffer, lines.slice(0, 20));
          $.Schedule(5.0, flushChatLog);
        }
      }
    });
  }

  // ---- 桥健康探测(定时 ping,断线后状态栏提示 + 恢复后自动清错) ----
  // 注意:health 与翻译共用串行队列;队列忙时跳过本次 ping,避免 health 阻塞发消息/测试
  function healthCheck() {
    if (State.queue.length > 0 || State.pending) return;
    bridgePost("health", {}, function (res) {
      if (res && res.ok) {
        if (!State.bridgeUp) log("bridge online (health)");
        State.bridgeUp = true;
        State.bridgeOfflineSince = 0;
        setBridgeStatus("桥在线 · 服务商 " + (res.provider || State.cfg.provider || "bing"));
      } else {
        State.bridgeUp = false;
        if (!State.bridgeOfflineSince) {
          State.bridgeOfflineSince = nowMs();
          log("bridge offline (health)");
          setStatus("本地桥未连接,翻译不可用");
        }
        setBridgeStatus("桥离线,翻译不可用");
      }
    });
  }

  function setBridgeStatus(text) {
    const label = findChild(getRoot(), "LCTBridgeStatus");
    if (label) {
      try {
        label.text = "桥状态: " + String(text || "");
      } catch (e) {}
    }
  }

  // ================= 聊天扫描 =================

  function resolveChatMessages() {
    const root = getRoot();
    if (!root) return null;
    if (!isValid(State.chat)) State.chat = findChild(root, CHAT_ROOT_ID);
    const chat = State.chat;
    const messages = findChild(chat, CHAT_MESSAGES_ID) || findChild(root, CHAT_MESSAGES_ID);
    if (isValid(messages) && messages !== State.messages) {
      State.messages = messages;
      State.scannedCount = 0;
    }
    if (isValid(State.messages) && !State.bootLogged) {
      State.bootLogged = true;
      log("loaded v" + VERSION + "; watching ChatMessages");
    }
    return isValid(State.messages) ? State.messages : null;
  }

  // 回收复用清理:聊天行被游戏复用时,清除本 mod 残留(旧译文标签 + 原文折叠样式)
  function resetRowModState(row) {
    try {
      const contents = findChild(row, MESSAGE_CONTENTS_ID);
      if (contents && contents.style) {
        contents.style.visibility = "visible";
      }
    } catch (e) {}
    // 收集译文标签所在容器(普通行:MessageBody;HUD 行:MessageContents)
    const containers = [];
    const body = findClass(row, MESSAGE_BODY_CLASS);
    if (isValid(body)) containers.push(body);
    const contents = findChild(row, MESSAGE_CONTENTS_ID);
    if (isValid(contents)) containers.push(contents);
    const bubble = findClass(row, HUD_BUBBLE_CLASS);
    if (isValid(bubble)) containers.push(bubble);
    containers.push(row);
    for (const container of containers) {
      if (!isValid(container)) continue;
      const count = childCount(container);
      for (let i = count - 1; i >= 0; i -= 1) {
        const child = childAt(container, i);
        if (!isValid(child)) continue;
        if (!hasClass(child, TRANS_LABEL_CLASS) && !hasClass(child, TRANS_LABEL_HUD_CLASS) && !hasClass(child, TRANS_LABEL_LOBBY_CLASS)) continue;
        try {
          child.DeleteAsync(0);
        } catch (e) {
          try {
            child.RemoveAndDeleteChildren();
          } catch (e2) {}
        }
      }
    }
  }

  function processRow(row) {
    if (!isValid(row)) return false;
    const record = readMessageRow(row);
    if (!record) return false;
    if (record.isOwn && record.sender && record.sender !== UNKNOWN_NAME) State.selfName = String(record.sender).trim();
    if (!record.hud) logRowIdentityDiagnostic(row, record);
    const sig = makeSignature(record);

    // 已处理过的行:若签名变化说明被回收复用,重置处理状态
    const prevSig = row.__lctSig;
    if (row.__lctProcessed && prevSig === sig) {
      // 已处理过的行如果还有挂起日志(等字段补全),继续尝试补齐。
      if (State.pendingLogs && State.pendingLogs[pendingKey(record.text, record.isOwn, record.sender)]) {
        pushChatLog(record);
      }
      // 尝试从缓存恢复译文(聊天滚动回收场景)
      if (State.cache.has(sig)) restoreFromCache(row, sig);
      return false;
    }
    if (prevSig !== sig) {
      row.__lctProcessed = false;
      resetRowModState(row);
    }
    row.__lctSig = sig;
    row.__lctProcessed = true;

    if (State.seen.has(sig)) {
      if (State.cache.has(sig)) restoreFromCache(row, sig);
      // 测试行:相同文本也强制重新翻译(seen 去重会吞掉重复测试)
      if (row.__lctTestForce) {
        State.seen.delete(sig);
        row.__lctTestForce = false;
      } else {
        return false;
      }
    }
    State.seen.add(sig);
    while (State.seen.size > SEEN_LIMIT) {
      const first = State.seen.values().next().value;
      if (first === undefined) break;
      State.seen.delete(first);
    }

    // 聊天日志采集(所有新消息都记,不随 shouldSkip 过滤——指令/自己的消息也要留档)
    pushChatLog(record);

    if (shouldSkip(record)) return false;
    if (State.cache.has(sig)) {
      injectTranslation(row, sig, State.cache.get(sig).translation);
      return false;
    }
    enqueue(row, sig, record);
    return true;
  }

  function processRange(messages, start, end) {
    let touched = false;
    for (let i = Math.max(0, start); i < end; i += 1) {
      if (processRow(childAt(messages, i))) touched = true;
    }
    return touched;
  }

  function scanChatMessagesOnce() {
    const messages = resolveChatMessages();
    if (!messages) {
      State.messages = null;
      State.scannedCount = 0;
      return false;
    }
    const count = childCount(messages);
    if (count < State.scannedCount) State.scannedCount = 0; // 聊天清空/重建
    let touched = false;
    if (State.scannedCount === 0 && count > BOOTSTRAP_TAIL_SCAN_LIMIT) {
      touched = processRange(messages, count - BOOTSTRAP_TAIL_SCAN_LIMIT, count) || touched;
    } else {
      touched = processRange(messages, State.scannedCount, count) || touched;
    }
    State.scannedCount = count;
    // 低延迟:每次额外扫末尾几条(发送者名/内容可能延迟填充)
    touched = processRange(messages, Math.max(0, count - LOW_LATENCY_TAIL_SCAN_LIMIT), count) || touched;
    return touched;
  }

  // ================= 大厅聊天扫描(hudchat.vxml) =================
  // 大厅/组队聊天容器:ChatLinesPanel(旧版 hudchat 结构;当前版本若无此面板则静默跳过)
  function resolveLobbyMessages() {
    const root = getRoot();
    if (!root) return null;
    if (!isValid(State.lobbyMessages)) {
      State.lobbyMessages = findChild(root, CHAT_LINES_PANEL_ID);
      if (isValid(State.lobbyMessages)) {
        State.lobbyScanned = 0;
        log("watching lobby chat (ChatLinesPanel)");
      }
    }
    return isValid(State.lobbyMessages) ? State.lobbyMessages : null;
  }

  function scanLobbyOnce() {
    const messages = resolveLobbyMessages();
    if (!messages) return false;
    const count = childCount(messages);
    if (count < State.lobbyScanned) State.lobbyScanned = 0; // 清空/重建
    let touched = false;
    if (State.lobbyScanned === 0 && count > BOOTSTRAP_TAIL_SCAN_LIMIT) {
      touched = processRange(messages, count - BOOTSTRAP_TAIL_SCAN_LIMIT, count) || touched;
    } else {
      touched = processRange(messages, State.lobbyScanned, count) || touched;
    }
    State.lobbyScanned = count;
    touched = processRange(messages, Math.max(0, count - LOW_LATENCY_TAIL_SCAN_LIMIT), count) || touched;
    return touched;
  }

  // ================= HUD 顶栏聊天扫描(citadel_hud_top_bar_chat) =================

  // 解析 HUD 顶栏聊天的 Messages 容器(Team1Chat/Team2Chat 两个实例)
  // 注意:CitadelHudTopBarChat 是面板 type 不是 class,FindChildrenWithClassTraverse 找不到,
  // 必须用布局里写死的 id(Team1Chat/Team2Chat)查找,class 遍历仅作兜底。
  function resolveHudMessages() {
    const root = getRoot();
    if (!root) return;
    const found = [];
    const seen = new Set(); // 用 Set 去重(对象 key 会转 [object Object] 导致误判)
    const tryAdd = (chat) => {
      if (!isValid(chat) || seen.has(chat)) return;
      const messages = findChild(chat, HUD_MESSAGES_ID);
      if (isValid(messages)) { seen.add(chat); found.push(messages); }
    };
    // 主路径:固定 id(游戏布局写死)
    for (const id of HUD_CHAT_IDS) {
      tryAdd(findChild(root, id));
    }
    // 兜底:class 遍历(万一游戏改了 id)
    const chats = root.FindChildrenWithClassTraverse
      ? (() => { try { return root.FindChildrenWithClassTraverse(HUD_CHAT_CLASS) || []; } catch (e) { return []; } })()
      : [];
    for (const chat of chats) tryAdd(chat);
    // 面板树变化时重建列表(游戏可能动态增删顶栏聊天实例)
    let changed = found.length !== State.hudMessages.length;
    if (!changed) {
      for (let i = 0; i < found.length; i += 1) {
        if (found[i] !== State.hudMessages[i]) { changed = true; break; }
      }
    }
    if (changed) {
      State.hudMessages = found;
      State.hudScanned = found.map(() => 0);
      State.hudRowsLogged = false;
      // 每次面板树变化都打印(菜单 0 个 -> 进局 2 个,日志能明确看到发现时机)
      log("watching HUD top bar chat (" + found.length + ")");
    }
    // 首轮 resolve 若 0 个:打印诊断(根面板 id/class),仅一次避免刷屏
    if (found.length === 0 && !State.hudLogged) {
      State.hudLogged = true;
      let cls = "?";
      try { if (root.GetPanelClassList) cls = root.GetPanelClassList().join(","); } catch (e) {}
      log("HUD chat not found yet: root=" + (root.id || "?") + " classes=[" + cls + "] (retrying each poll)");
    }
  }

  function scanHudTopBarOnce() {
    resolveHudMessages();
    let touched = false;
    let hudRowsSeen = false;
    for (let i = 0; i < State.hudMessages.length; i += 1) {
      const messages = State.hudMessages[i];
      if (!isValid(messages)) continue;
      const count = childCount(messages);
      if (count > 0) hudRowsSeen = true;
      if (count < State.hudScanned[i]) State.hudScanned[i] = 0;
      const start = State.hudScanned[i];
      touched = processRange(messages, start, count) || touched;
      // 低延迟:每次额外扫末尾几条
      touched = processRange(messages, Math.max(0, count - LOW_LATENCY_TAIL_SCAN_LIMIT), count) || touched;
      State.hudScanned[i] = count;
    }
    // 每代容器首次见行打印一次,确认扫描循环存活且能看到 HUD 行
    if (hudRowsSeen && !State.hudRowsLogged) {
      State.hudRowsLogged = true;
      diagLog("hud scan: rows present (" + State.hudMessages.length + " containers)");
    }
    return touched;
  }

  function scanChatMessages() {
    try {
      refreshTopbarIdentity();
      pollSteamIdRoster();
      scanPostGameScoreboard();
      // 注意:两个扫描都必须执行,不能用 || 短路——
      // 左下角聊天有活动时 scanChatMessagesOnce() 返回 true 会跳过 HUD 扫描
      // 每个扫描独立 try/catch:单次异常不中断循环,并记录错误归属便于定位
      let pollHadError = false;
      let touchedChat = false;
      let touchedHud = false;
      let touchedLobby = false;
      try { touchedChat = scanChatMessagesOnce(); } catch (e) { pollHadError = true; pollScanError("scanChatMessagesOnce", e); }
      try { touchedHud = scanHudTopBarOnce(); } catch (e) { pollHadError = true; pollScanError("scanHudTopBarOnce", e); }
      try { touchedLobby = scanLobbyOnce(); } catch (e) { pollHadError = true; pollScanError("scanLobbyOnce", e); }
      const touched = touchedChat || touchedHud || touchedLobby;
      const hasWork = touched || State.queue.length > 0 || State.pending;
      if (!pollHadError && State.pollErrMsg) { // 本轮无错误才清除标记(否则节流被同轮清空抵消,每轮刷屏)
        State.pollErrMsg = "";
        State.pollErrCount = 0;
      }
      $.Schedule(hasWork ? FAST_POLL_SECONDS : SLOW_POLL_SECONDS, scanChatMessages);
    } catch (e) {
      pollScanError("scanChatMessages", e);
      $.Schedule(SLOW_POLL_SECONDS, scanChatMessages); // 兑底:循环永不因异常中断
    }
  }

  function pollScanError(where, e) {
    const msg = String((e && e.message) || e);
    State.pollErrCount = (State.pollErrCount || 0) + 1;
    if (State.pollErrMsg !== msg) {
      State.pollErrMsg = msg;
      diagLog("poll error in " + where + ": " + msg);
      log("poll error in " + where + ": " + msg + " (loop kept alive)");
    } else if (State.pollErrCount % 20 === 1) {
      diagLog("poll error (x" + State.pollErrCount + ") in " + where + ": " + msg);
    }
  }


  // !lcttest 测试命令:向 HUD 顶栏聊天注入一条构造消息(与真实行同构),
  // 走正常扫描+翻译流程。无队友/无 bot 时验证 HUD 通路的唯一手段。
  function injectHudTestMessage(text) {
    try {
      resolveHudMessages();
      if (State.hudMessages.length === 0) {
        log("HUD test: no HUD chat container found yet (in-match?)");
        return;
      }
      const container = State.hudMessages[0]; // Team1Chat 的 Messages
      const row = $.CreatePanel("Panel", container, "LCTTestRow" + nowMs());
      row.AddClass("ChatMessage");
      const contents = $.CreatePanel("Panel", row, "MessageContents");
      const bubble = $.CreatePanel("Panel", contents, "");
      bubble.AddClass("ChatBubble");
      const tc = $.CreatePanel("Panel", bubble, "");
      tc.AddClass("TextContainer");
      const textPanel = $.CreatePanel("Label", tc, "MessageText");
      textPanel.text = String(text);
      row.__lctTestForce = true; // 每次测试都强制重新翻译(不被 seen 去重吞掉)
      log("HUD test: injected '" + String(text).slice(0, 40) + "' into HUD chat (" + State.hudMessages.length + " containers)");
      // 关键:行可能被游戏 1 秒内清理,立即同步扫描一次抢在清理前发出翻译请求
      try { scanHudTopBarOnce(); } catch (e) { log("HUD test: immediate scan failed: " + (e && e.message ? e.message : String(e))); }
      // 诊断:1s/3s 后检查行是否存活、可见性、是否已注入译文(定位行被删/隐藏/翻译时序问题)
      const checkRow = row;
      $.Schedule(1.0, function () {
        if (!isValid(checkRow)) { log("HUD test: row GONE at 1s"); return; }
        let vis = "?";
        try { vis = String(checkRow.style.visibility); } catch (e) {}
        let expired = false;
        try { expired = checkRow.BHasClass("Expired"); } catch (e) {}
        const hasLabel = findClass(checkRow, TRANS_LABEL_HUD_CLASS);
        log("HUD test: row alive@1s vis=" + vis + " expired=" + expired + " label=" + (hasLabel ? "yes" : "no"));
      });
      $.Schedule(3.0, function () {
        if (!isValid(checkRow)) { log("HUD test: row GONE at 3s"); return; }
        let vis = "?";
        try { vis = String(checkRow.style.visibility); } catch (e) {}
        const hasLabel = findClass(checkRow, TRANS_LABEL_HUD_CLASS);
        log("HUD test: row alive@3s vis=" + vis + " label=" + (hasLabel ? "yes" : "no"));
      });
    } catch (e) {
      log("HUD test failed: " + (e && e.message ? e.message : String(e)));
    }
  }

  // ================= 发送接管(命令 / 发送前翻译) =================

  // 触发原版发送:派发 CitadelChatInputSubmitted 事件,必须传入输入面板参数
  // (DLCT/poker 同款机制;传 null 原版处理器不会发送)
  function submitEventName() {
    try {
      if (findChild(getRoot(), CHAT_LINES_PANEL_ID)) return "CitadelChatTextSubmitted";
    } catch (e) {}
    return "CitadelChatInputSubmitted";
  }

  function triggerStockSubmit(input) {
    try {
      if (!input || !input.text) input = State.input || findChild(getRoot(), CHAT_INPUT_ID);
      if (!input) return;
      $.DispatchEvent(submitEventName(), input);
    } catch (e) {
      log("submit dispatch failed: " + (e && e.message ? e.message : String(e)));
    }
  }

  function clearInput() {
    try {
      const input = State.input || findChild(getRoot(), CHAT_INPUT_ID);
      if (input) input.text = "";
    } catch (e) {}
  }

  // 统一提交处理;带防重(函数调用 + 事件监听双通道可能同时触发)
  function handleChatSubmit(input) {
    const now = nowMs();
    if (State.lastSubmitAt && now - State.lastSubmitAt < 150) return;
    State.lastSubmitAt = now;

    if (!input || typeof input.text !== "string") {
      input = State.input || findChild(getRoot(), CHAT_INPUT_ID);
    }
    if (!input) return;
    State.input = input;

    const raw = safeText(input);
    const trimmed = String(raw).trim();
    if (!trimmed) return;

    // /tr 命令:打开设置面板,不发送
    if (trimmed === "/tr" || trimmed.indexOf("/tr ") === 0) {
      clearInput();
      openSettingsPanel();
      return;
    }

    // !lcttest 测试命令:向 HUD 顶栏聊天注入一条英文消息(不真实发送)
    // 用途:无队友/无 bot 时验证 HUD 扫描+翻译通路;进训练场即可测
    if (trimmed === "!lcttest" || trimmed.indexOf("!lcttest ") === 0) {
      const testText = trimmed.length > 9 ? trimmed.slice(9).trim() : "hello can you push mid";
      injectHudTestMessage(testText);
      clearInput();
      return;
    }

    // 发送前翻译(off=发原文 / translation=仅译文 / bilingual=原文|译文)
    // 若检测到消息已是目标语言(sameLanguage),则按原文发送,不做无用翻译
    const outgoingMode = State.cfg.outgoing || "off";
    if (State.cfg.enabled && outgoingMode !== "off" && trimmed.charAt(0) !== "/") {
      const outTarget = resolveOutgoingTarget();
      // 防重复发送:同一文本翻译中,重复按 Enter 直接忽略(避免队列积压发多条)
      // 不同文本则排队(前一文本的翻译结果已提交,不冲突)
      if (State.outgoingPending === trimmed) {
        log("outgoing dedupe: same text pending, ignored: " + trimmed.slice(0, 40));
        return;
      }
      State.outgoingPending = trimmed;
      // 立即清空输入框:视觉反馈"已发送",不再误以为没发出去而重复按键
      clearInput();
      translateOutgoing(trimmed, function (translated, detected) {
        State.outgoingPending = null;
        let send = trimmed;
        if (translated && translated !== trimmed && !sameLanguage(detected, outTarget)) {
          const trText = String(translated).trim();
          if (outgoingMode === "translation") send = trText;
          else if (outgoingMode === "bilingual") send = trimmed + " | " + trText;
          // 超长消息保护:游戏聊天发送有长度上限,拼接过长会被截断/失败;
          // 优先保留原文,译文超限部分截断加省略号
          const MAX_SEND_CHARS = 400;
          if (send.length > MAX_SEND_CHARS) {
            if (outgoingMode === "bilingual") {
              const budget = Math.max(0, MAX_SEND_CHARS - trimmed.length - 3);
              send = trimmed + " | " + (trText.length > budget ? trText.slice(0, budget) + "…" : trText);
            } else {
              send = send.slice(0, MAX_SEND_CHARS) + "…";
            }
          }
          setStatus("已发送译文: " + String(send).slice(0, 40));
        } else if (!translated) {
          // 翻译不可用/超时:按原文发送,但必须留日志,否则用户看到原文会以为服务商坏了
          log("outgoing: translation unavailable (timeout/error), sending original");
          setStatus("翻译不可用,已按原文发送");
        } else if (translated === trimmed || sameLanguage(detected, outTarget)) {
          // 目标语言与原文相同(en->en 等):不发无用译文
          log("outgoing: no-op (detected=" + (detected || "unknown") + " == target), sending original");
          setStatus("原文已是目标语言,按原文发送");
        }
        log("outgoing mode=" + outgoingMode + " detected=" + (detected || "-") + " -> " + send.slice(0, 80));
        // 覆盖前先捕获当前输入框内容:若用户已输入新消息,不能丢失
        const cur = safeText(input);
        try {
          input.text = send;
        } catch (e) {}
        triggerStockSubmit(input);
        if (cur !== "" && cur !== trimmed) {
          // 用户已输入新内容:恢复它,让用户自行提交
          try {
            input.text = cur;
          } catch (e) {}
        } else {
          clearInput();
        }
      });
      return;
    }

    // 常规发送:确保文本就位后触发原版发送(与 DLCT commitChatText 行为一致)
    try {
      input.text = trimmed;
    } catch (e) {}
    triggerStockSubmit(input);
    clearInput();
  }

  function translateOutgoing(text, done) {
    const panel = ensurePanel();
    if (!panel) {
      setStatus("桥未连接,已按原文发送");
      done(null, null);
      return;
    }
    ensureBridgeEvents();
    enqueueOutgoing(text, done);
  }

  // ================= 设置面板 =================

  function setStatus(text) {
    const label = findChild(getRoot(), STATUS_LABEL_ID);
    if (label) {
      try {
        label.text = text || "";
      } catch (e) {}
    }
  }

  // 把桥返回的配置应用到游戏侧 UI 状态(出站翻译/开关/服务商等;顺带记录各服务商 Key 状态)。
  // 供设置面板打开与游戏启动同步共用,保证 config.json 的手改配置能生效。
  // 用户显式设置过的字段(持久化在 lct_ui):桥 config.json 同步时不再覆盖这些字段,
  // 避免用户在 /tr 面板里的选择被 config.json 默认值(如 displayMode=bilingual)覆盖。
  function uiTouched(field) {
    const arr = State.cfg && State.cfg._userTouched;
    return Array.isArray(arr) && arr.indexOf(field) >= 0;
  }
  function markUiTouched(field) {
    if (!State.cfg) return;
    if (!Array.isArray(State.cfg._userTouched)) State.cfg._userTouched = [];
    if (State.cfg._userTouched.indexOf(field) < 0) State.cfg._userTouched.push(field);
  }

  function applyBridgeUiConfig(c) {
    if (!c) return false;
    let changed = false;
    if (c.ui) {
      if (!uiTouched("displayMode") && typeof c.ui.displayMode === "string") { State.cfg.displayMode = c.ui.displayMode; changed = true; }
      if (!uiTouched("outgoing") && typeof c.ui.outgoing === "string") { State.cfg.outgoing = c.ui.outgoing; changed = true; }
      if (!uiTouched("outgoingTarget") && typeof c.ui.outgoingTarget === "string") { State.cfg.outgoingTarget = c.ui.outgoingTarget; changed = true; }
      if (!uiTouched("targetLanguage") && typeof c.ui.targetLanguage === "string") { State.cfg.targetLanguage = c.ui.targetLanguage; changed = true; }
      if (!uiTouched("enabled") && typeof c.ui.enabled === "boolean") { State.cfg.enabled = c.ui.enabled; changed = true; }
      if (!uiTouched("force") && typeof c.ui.force === "boolean") { State.cfg.force = c.ui.force; changed = true; }
      if (!uiTouched("provider") && typeof c.ui.provider === "string") { State.cfg.provider = c.ui.provider; changed = true; }
      if (!uiTouched("timeoutMs") && typeof c.ui.timeoutMs === "number") { State.cfg.timeoutMs = c.ui.timeoutMs; changed = true; }
    }
    State.cfg._providerKeys = {
      microsoft: !!(c.microsoft && c.microsoft.hasApiKey),
      openai: !!(c.openai && c.openai.hasApiKey),
      deepl: !!(c.deepl && c.deepl.hasApiKey),
      google: !!(c.google && c.google.hasApiKey),
    };
    return changed;
  }

  // API Key 行状态提示:已配置 / 未配置(仅提示,不回显明文 Key)
  function updateKeyStateLabel() {
    const label = findChild(getRoot(), "LCTKeyState");
    if (!label) return;
    const prov = State.cfg.provider || "bing";
    let text = "未配置";
    if (prov === "bing") text = "免 Key";
    else if ((State.cfg._providerKeys || {})[prov]) text = "已配置";
    try { label.text = text; } catch (e) {}
  }

  // 启动时从桥同步 config.json 的 UI 设置(失败重试,避免桥尚未就绪时丢同步)
  function syncUiFromBridge(attempt) {
    bridgePost("config", {}, function (res) {
      if (res && res.ok && res.config) {
        const changed = applyBridgeUiConfig(res.config);
        if (changed) saveUiConfig();
      } else if (attempt < 3) {
        $.Schedule(5.0, function () { syncUiFromBridge(attempt + 1); });
      }
    });
  }
  function openSettingsPanel() {
    const panel = findChild(getRoot(), SETTINGS_PANEL_ID);
    if (!panel) return;
    try {
      panel.AddClass(SETTINGS_VISIBLE_CLASS);
    } catch (e) {}
    try {
      if (typeof panel.SetHasClass === "function") panel.SetHasClass(SETTINGS_VISIBLE_CLASS, true);
    } catch (e) {}
    syncPanelFromConfig();
    // 立即用上次已知的 Key 状态回填占位符(避免每次打开先闪空;异步拉取后会再确认)
    if ((State.cfg._providerKeys || {})[State.cfg.provider || "bing"]) setFieldText("LCTApiKey", "********");
    // 从桥拉取已保存配置:回填 UI 偏好(游戏重启后恢复) + apiKey 占位符
    bridgePost("config", {}, function (res) {
      if (res && res.ok && res.config) {
        const c = res.config;
        const changed = applyBridgeUiConfig(c);
        if (changed) {
          syncPanelFromConfig();
          saveUiConfig();
        }
        // apiKey 占位符必须在 syncPanelFromConfig 之后设置(否则会被其清空)
        if (c.microsoft && c.microsoft.hasApiKey) setFieldText("LCTApiKey", "********");
        if (c.openai && c.openai.hasApiKey) setFieldText("LCTApiKey", "********");
        if (c.deepl && c.deepl.hasApiKey) setFieldText("LCTApiKey", "********");
        if (c.google && c.google.hasApiKey) setFieldText("LCTApiKey", "********");
        if (c.openai && c.openai.baseUrl) setFieldText("LCTOpenaiBaseUrl", c.openai.baseUrl);
        if (c.openai && c.openai.model) setFieldText("LCTOpenaiModel", c.openai.model);
        if (c.deepl && c.deepl.endpoint) setFieldText("LCTDeeplEndpoint", c.deepl.endpoint);
        if (Array.isArray(c.fallbackProviders)) {
          setFieldText("LCTFallback", c.fallbackProviders.join(","));
        }
        if (c.chatLog && typeof c.chatLog.enabled === "boolean") {
          State.cfg.chatLog = c.chatLog.enabled;
          setToggleText("LCTChatLog", State.cfg.chatLog);
        }

        updateKeyStateLabel();
      }
    });
    // 聚焦面板本身(与 DLCT 一致:优先控件,失败则面板;面板持焦后 Tab/Enter 可用)
    try {
      const first = findChild(panel, "LCTEnabled");
      if (first && first.SetFocus) first.SetFocus();
      else if (panel.SetFocus) panel.SetFocus();
    } catch (e) {}
  }

  function closeSettingsPanel() {
    const panel = findChild(getRoot(), SETTINGS_PANEL_ID);
    if (panel) {
      try {
        panel.RemoveClass(SETTINGS_VISIBLE_CLASS);
      } catch (e) {}
    }
  }

  function LCTToggleSettings() {
    const panel = findChild(getRoot(), SETTINGS_PANEL_ID);
    if (panel && hasClass(panel, SETTINGS_VISIBLE_CLASS)) closeSettingsPanel();
    else openSettingsPanel();
  }

  function LCTCloseSettings() {
    log("close clicked");
    closeSettingsPanel();
  }

  function fieldValue(id) {
    const panel = findChild(getRoot(), SETTINGS_PANEL_ID);
    const field = panel ? findChild(panel, id) : null;
    return field ? safeText(field) : "";
  }

  function setFieldText(id, text) {
    const panel = findChild(getRoot(), SETTINGS_PANEL_ID);
    const field = panel ? findChild(panel, id) : null;
    if (field) {
      try {
        field.text = text;
      } catch (e) {}
    }
  }

  function syncPanelFromConfig() {
    setFieldText("LCTApiKey", "");
    setFieldText("LCTRegion", "");
    setFieldText("LCTOpenaiBaseUrl", "");
    setFieldText("LCTOpenaiModel", "");
    setFieldText("LCTDeeplEndpoint", "");
    setFieldText("LCTFallback", "");
    setFieldText("LCTTargetLangCustom", "");
    setFieldText("LCTOutgoingTargetCustom", "");
    setFieldText("LCTTimeout", String(State.cfg.timeoutMs || 15000));
    setSelectText("LCTProviderSelect", labelFor(PROVIDER_OPTIONS, State.cfg.provider || "bing"));
    syncProviderRows();
    setSelectText("LCTTargetLangSelect", labelFor(LANGUAGE_OPTIONS, State.cfg.targetLanguage || "zh-Hans"));
    setSelectText("LCTDisplayModeSelect", labelFor(DISPLAY_MODES, State.cfg.displayMode || "bilingual"));
    setSelectText("LCTOutgoingSelect", labelFor(OUTGOING_MODES, State.cfg.outgoing || "off"));
    setSelectText("LCTOutgoingTargetSelect", labelFor(LANGUAGE_OPTIONS, State.cfg.outgoingTarget || "en"));
    setToggleText("LCTEnabled", !!State.cfg.enabled);
    setToggleText("LCTForce", !!State.cfg.force);
    setToggleText("LCTTranslateOwn", State.cfg.translateOwn !== false);
    setToggleText("LCTChatLog", State.cfg.chatLog !== false);
    syncCustomInputs();
    closeSelectMenus();
    setStatus("");
  }

  function setSelectText(buttonId, text) {
    const panel = findChild(getRoot(), SETTINGS_PANEL_ID);
    const btn = panel ? findChild(panel, buttonId) : null;
    const label = btn ? findChild(btn, buttonId + "Label") : null;
    if (label) {
      try {
        label.text = text;
      } catch (e) {}
    }
  }

  function labelFor(options, value) {
    for (let i = 0; i < options.length; i += 1) {
      if (options[i].value === value) return options[i].label;
    }
    return String(value || "");
  }

  function cycleValue(options, current) {
    for (let i = 0; i < options.length; i += 1) {
      if (options[i].value === current) return options[(i + 1) % options.length].value;
    }
    return options[0].value;
  }

  const SELECT_MENU_IDS = [
    "LCTProviderMenu",
    "LCTTargetLangMenu",
    "LCTDisplayModeMenu",
    "LCTOutgoingMenu",
    "LCTOutgoingTargetMenu",
  ];

  function closeSelectMenus() {
    const root = getRoot();
    for (let i = 0; i < SELECT_MENU_IDS.length; i += 1) {
      const m = findChild(root, SELECT_MENU_IDS[i]);
      if (m) {
        try {
          m.RemoveClass(SETTINGS_VISIBLE_CLASS);
        } catch (e) {}
      }
    }
  }

  // 自定义语言输入框显隐
  function syncCustomInputs() {
    const root = getRoot();
    const t = findChild(root, "LCTTargetLangCustom");
    const o = findChild(root, "LCTOutgoingTargetCustom");
    if (t) {
      try {
        if (State.cfg.targetLanguage === "custom") t.AddClass(SETTINGS_VISIBLE_CLASS);
        else t.RemoveClass(SETTINGS_VISIBLE_CLASS);
      } catch (e) {}
    }
    if (o) {
      try {
        if (State.cfg.outgoingTarget === "custom") o.AddClass(SETTINGS_VISIBLE_CLASS);
        else o.RemoveClass(SETTINGS_VISIBLE_CLASS);
      } catch (e) {}
    }
  }

  // API Key / 区域行显隐已按用户意见移除(行显隐机制不稳定,且非必需)

  function setToggleText(id, on) {
    const panel = findChild(getRoot(), SETTINGS_PANEL_ID);
    const toggle = panel ? findChild(panel, id) : null;
    if (!toggle) return;
    // Button 自身不渲染 text,必须更新内嵌 Label(命名约定:<按钮id>Label)
    const label = findChild(toggle, id + "Label") || toggle;
    try {
      label.text = on ? "是" : "否";
    } catch (e) {}
  }

  function LCTOnToggle(which) {
    markUiTouched(which);
    if (which === "enabled") {
      State.cfg.enabled = !State.cfg.enabled;
      setToggleText("LCTEnabled", State.cfg.enabled);
    } else if (which === "force") {
      State.cfg.force = !State.cfg.force;
      setToggleText("LCTForce", State.cfg.force);
    } else if (which === "chatLog") {
      State.cfg.chatLog = State.cfg.chatLog === false;
      setToggleText("LCTChatLog", State.cfg.chatLog);
      setStatus("聊天日志" + (State.cfg.chatLog ? "已开启(按比赛 ID 存 logs/chat)" : "已关闭"));
    } else if (which === "translateOwn") {
      State.cfg.translateOwn = State.cfg.translateOwn === false;
      setToggleText("LCTTranslateOwn", State.cfg.translateOwn);
      setStatus("翻译自己的消息" + (State.cfg.translateOwn ? "已开启" : "已关闭"));
    }
    saveUiConfig();
    log("toggle: " + which);
  }

  // 循环切换(服务商/显示模式/发送模式)
  // 根据当前服务商显示/隐藏对应的配置行与标签提示
  function syncProviderRows() {
    const p = State.cfg.provider || "bing";
    const setRow = function (id, show) {
      const row = findChild(getRoot(), id);
      if (!row) return;
      try {
        row.style.visibility = show ? "visible" : "collapse";
      } catch (e) {}
    };
    setRow("LCTRowApiKey", p === "microsoft" || p === "openai" || p === "deepl" || p === "google");
    setRow("LCTRowRegion", p === "microsoft");
    setRow("LCTRowOpenaiBase", p === "openai");
    setRow("LCTRowOpenaiModel", p === "openai");
    setRow("LCTRowDeeplEndpoint", p === "deepl");
    let hint = "";
    if (p === "bing") hint = "免 Key 公共接口,可能有隐形限流;失败可配置自动回退";
    else if (p === "microsoft") hint = "Azure Translator Key(可留空则跳过该服务商)";
    else if (p === "openai") hint = "OpenAI 兼容端点:DeepSeek 填 https://api.deepseek.com + deepseek-chat/deepseek-reasoner;OpenAI/Ollama/LM Studio/OneAPI 亦可";
    else if (p === "deepl") hint = "DeepL API Key(free/pro 端点可选)";
    else if (p === "google") hint = "Google Cloud Translation API Key";
    setStatus(hint);
  }

  function LCTPickProvider(value) {
    markUiTouched("provider");
    State.cfg.provider = value;
    syncPanelFromConfig();
    // 该服务商已配置 Key:回填占位符,避免面板显示空白
    if ((State.cfg._providerKeys || {})[value]) setFieldText("LCTApiKey", "********");
    updateKeyStateLabel();
    saveUiConfig();
    closeSelectMenus();
    log("pickProvider: " + value);
  }

  function LCTCycle(which) {
    closeSelectMenus();
    markUiTouched(which);
    if (which === "provider") {
      State.cfg.provider = cycleValue(PROVIDER_OPTIONS, State.cfg.provider || "bing");
      setSelectText("LCTProviderSelect", labelFor(PROVIDER_OPTIONS, State.cfg.provider));
    } else if (which === "displayMode") {
      State.cfg.displayMode = cycleValue(DISPLAY_MODES, State.cfg.displayMode || "bilingual");
      setSelectText("LCTDisplayModeSelect", labelFor(DISPLAY_MODES, State.cfg.displayMode));
    } else if (which === "outgoing") {
      State.cfg.outgoing = cycleValue(OUTGOING_MODES, State.cfg.outgoing || "off");
      setSelectText("LCTOutgoingSelect", labelFor(OUTGOING_MODES, State.cfg.outgoing));
    }
    saveUiConfig();
    log("cycle: " + which + " -> " + State.cfg[which]);
  }

  // 下拉菜单开关(目标语言/发送目标语言)
  function LCTToggleMenu(field) {
    const menuId =
      field === "targetLanguage" ? "LCTTargetLangMenu" :
      field === "outgoingTarget" ? "LCTOutgoingTargetMenu" :
      field === "provider" ? "LCTProviderMenu" :
      field === "displayMode" ? "LCTDisplayModeMenu" :
      field === "outgoing" ? "LCTOutgoingMenu" : "";
    if (!menuId) return;
    const menu = findChild(getRoot(), menuId);
    if (!menu) return;
    const isOpen = hasClass(menu, SETTINGS_VISIBLE_CLASS);
    closeSelectMenus();
    if (!isOpen) {
      try {
        menu.AddClass(SETTINGS_VISIBLE_CLASS);
      } catch (e) {}
    }
    log("menu: " + field + (isOpen ? " close" : " open"));
  }

  // 菜单选项选择
  function LCTPickLang(field, value) {
    closeSelectMenus();
    markUiTouched(field);
    if (field === "targetLanguage") {
      State.cfg.targetLanguage = value;
      setSelectText("LCTTargetLangSelect", labelFor(LANGUAGE_OPTIONS, value));
    } else {
      State.cfg.outgoingTarget = value;
      setSelectText("LCTOutgoingTargetSelect", labelFor(LANGUAGE_OPTIONS, value));
    }
    syncCustomInputs();
    saveUiConfig();
    closeSelectMenus();
    log("pickLang: " + field + " -> " + value);
    if (value === "custom") {
      const customId = field === "targetLanguage" ? "LCTTargetLangCustom" : "LCTOutgoingTargetCustom";
      const custom = findChild(getRoot(), customId);
      if (custom && custom.SetFocus) {
        try {
          custom.SetFocus();
        } catch (e) {}
      }
    }
  }

  function LCTPickOption(field, value) {
    markUiTouched(field);
    if (field === "displayMode") State.cfg.displayMode = value;
    else if (field === "outgoing") State.cfg.outgoing = value;
    else return;
    syncPanelFromConfig();
    saveUiConfig();
    closeSelectMenus();
    log("pickOption: " + field + " -> " + value);
  }

  function collectPanelConfig() {
    const customTarget = fieldValue("LCTTargetLangCustom");
    const targetLang = State.cfg.targetLanguage === "custom"
      ? (customTarget || "zh-Hans")
      : (State.cfg.targetLanguage || "zh-Hans");
    const customOut = fieldValue("LCTOutgoingTargetCustom");
    const outgoingTarget = State.cfg.outgoingTarget === "custom"
      ? (customOut || "en")
      : (State.cfg.outgoingTarget || "en");
    const prov = State.cfg.provider || "bing";
    const apiKeyField = fieldValue("LCTApiKey");
    // 面板字段为空但该服务商已有 Key:发保留标记,避免误清空(修复 /tr 重复打开后 Key 丢失)
    const apiKeyValue = (!apiKeyField && (State.cfg._providerKeys || {})[prov]) ? "********" : apiKeyField;
    return {
      provider: prov,
      apiKey: apiKeyValue,
      region: fieldValue("LCTRegion"),
      openaiBaseUrl: fieldValue("LCTOpenaiBaseUrl"),
      openaiModel: fieldValue("LCTOpenaiModel"),
      deeplEndpoint: fieldValue("LCTDeeplEndpoint"),
      targetLanguage: targetLang,
      sourceLanguage: "auto",
      displayMode: State.cfg.displayMode || "bilingual",
      outgoing: State.cfg.outgoing || "off",
      outgoingTarget: outgoingTarget,
      enabled: !!State.cfg.enabled,
      force: !!State.cfg.force,
      timeoutMs: Number(fieldValue("LCTTimeout")) || 15000,
      fallbackProviders: String(fieldValue("LCTFallback") || "")
        .split(",").map(function (x) { return x.trim(); }).filter(Boolean),
      chatLog: State.cfg.chatLog !== false,
      translateOwn: State.cfg.translateOwn !== false,
      ui: {
        enabled: !!State.cfg.enabled,
        provider: State.cfg.provider || "bing",
        displayMode: State.cfg.displayMode || "bilingual",
        outgoing: State.cfg.outgoing || "off",
        outgoingTarget: outgoingTarget,
        targetLanguage: targetLang,
        force: !!State.cfg.force,
        timeoutMs: Number(fieldValue("LCTTimeout")) || 15000,
      },
    };
  }

  function bridgePost(op, payload, done) {
    const data = encodeURIComponent(JSON.stringify(payload || {}));
    // 直连通道可用时不要求 HTML 面板存在(hudchat 未加载时测试/保存也能用)
    const canHttp = detectAsyncWebRequest();
    const panel = canHttp ? null : ensurePanel();
    if (!canHttp && !panel) {
      done({ ok: false, error: "bridge_panel_unavailable" });
      return;
    }
    ensureBridgeEvents();
    enqueueBridge(op, data, done);
  }

  function LCTSave() {
    log("save clicked");
    closeSelectMenus();
    const p = collectPanelConfig();
    for (const f of ["provider", "targetLanguage", "displayMode", "outgoing", "outgoingTarget", "enabled", "force", "timeoutMs", "chatLog", "translateOwn"]) markUiTouched(f);
    bridgePost("config", { config: p }, function (res) {
      if (res && res.ok) {
        State.cfg.provider = p.provider || State.cfg.provider;
        State.cfg.targetLanguage = p.targetLanguage;
        State.cfg.displayMode = p.displayMode;
        State.cfg.outgoing = p.outgoing;
        State.cfg.outgoingTarget = p.outgoingTarget;
        State.cfg.enabled = p.enabled;
        State.cfg.force = p.force;
        State.cfg.timeoutMs = p.timeoutMs;
        State.cfg.chatLog = p.chatLog !== false;
        State.cfg.translateOwn = p.translateOwn !== false;
        // 保存成功:同步 Key 状态(新填 Key / 保留占位符都视为已有 Key)
        if (State.cfg._providerKeys) {
          State.cfg._providerKeys[p.provider || "bing"] = !!(p.apiKey && p.apiKey !== "");
        }
        syncProviderRows();
        saveUiConfig();
        setStatus("已保存(服务商 " + (p.provider || "bing") + ")");
        log("settings saved");
      } else {
        setStatus("保存失败: " + ((res && res.error) || "unknown"));
      }
    });
  }

  function LCTTest() {
    log("test clicked");
    setStatus("测试中...最长约 " + Math.round((State.cfg.timeoutMs || 15000) / 1000) + " 秒,请稍候");
    bridgePost("test", {}, function (res) {
      if (res && res.ok) setStatus("测试成功: " + (res.translation || ""));
      else setStatus("测试失败: " + ((res && res.error) || "unknown") + " (检查桥/Key/网络,或配置回退)");
    });
  }

  // ================= 启动 =================

  // 一次性玩家 API 诊断:把 Players 命名空间方法与 GetPlayerInfo 字段送到 bridge.log,
  // 用于定位英雄名/SteamID 解析失败的根因(每次进游戏只 dump 一次,避免刷屏)
  function summarizeIdentityValue(value) {
    if (value === undefined || value === null) return "";
    if (typeof value === "object") {
      try { return JSON.stringify(value).slice(0, 400); } catch (e) {}
      return Object.prototype.toString.call(value);
    }
    return String(value).slice(0, 400);
  }

  function probePlayerApiDiagnostics() {
    try {
      let globalKeys = [];
      try { globalKeys = Object.keys(globalThis); } catch (e) {}
      diagLog("player global keys(" + globalKeys.length + ")=" + globalKeys.slice(0, 250).join(","));
      const relevant = [];
      for (let i = 0; i < globalKeys.length; i += 1) {
        if (/player|hero|steam|account|match|lobby|game|citadel|deadlock|net|convar|entity|team|score|ui|conv/i.test(globalKeys[i])) relevant.push(globalKeys[i]);
      }
      diagLog("player global relevant=" + (relevant.length ? relevant.join(",") : "(none)"));

      let ownNames = [];
      try { ownNames = Object.getOwnPropertyNames(globalThis); } catch (e) {}
      const ownRelevant = [];
      for (let i = 0; i < ownNames.length; i += 1) {
        if (/player|hero|steam|account|match|lobby|game|citadel|deadlock|net|convar|entity|team|score|ui|conv/i.test(ownNames[i])) ownRelevant.push(ownNames[i]);
      }
      diagLog("player global own relevant=" + (ownRelevant.length ? ownRelevant.join(",") : "(none)"));

      const ctx = $.GetContextPanel();
      try { diagLog("player ctx keys=" + Object.keys(ctx).slice(0, 200).join(",")); } catch (e) {}
      try { diagLog("player $ keys=" + Object.keys($).slice(0, 200).join(",")); } catch (e) {}

      const root = getRoot();
      let chain = [];
      let cur = root;
      for (let depth = 0; isValid(cur) && depth < 10; depth += 1) {
        let id = "";
        try { id = String(cur.id || ""); } catch (e) {}
        let type = "";
        try { type = String(cur.paneltype || ""); } catch (e) {}
        let layout = "";
        try { layout = String(cur.layoutfile || ""); } catch (e) {}
        chain.push(type + "#" + id + "(" + layout + ")");
        try { cur = cur.GetParent && cur.GetParent(); } catch (e) { cur = null; }
      }
      diagLog("player root chain=" + chain.join(" > "));

      const present = [];
      const cands = ["Game", "Players", "GameStateAPI", "GameInterfaceAPI", "GameUI", "Citadel", "CitadelAPI", "DeadlockAPI", "Heroes", "Steam", "LobbyAPI", "PartyAPI", "MatchAPI", "ScoreboardAPI", "Convars"];
      for (let c = 0; c < cands.length; c += 1) {
        const name = cands[c];
        try {
          if (globalThis[name] !== undefined && globalThis[name] !== null) present.push(name);
        } catch (e) {}
      }
      diagLog("player ns present=" + (present.length ? present.join(",") : "(none)"));
      for (let c = 0; c < cands.length; c += 1) {
        const name = cands[c];
        let ns = null;
        try { ns = globalThis[name]; } catch (e) {}
        if (ns === undefined || ns === null) continue;
        let keys = [];
        try { keys = Object.keys(ns); } catch (e) {}
        const rel = [];
        for (let k = 0; k < keys.length; k += 1) {
          if (/player|hero|team|steam|account|local|name|id|match|game/i.test(keys[k])) rel.push(keys[k]);
        }
        diagLog(name + " keys(" + keys.length + ") rel=" + (rel.length ? rel.join(",") : "(none)"));
      }
      const localId = gameLocalPlayerId();
      diagLog("player localId=" + localId);
      if (typeof Game === "undefined") {
        diagLog("player Game namespace missing");
      } else {
        const ids = gameAllPlayerIds();
        diagLog("player Game.GetAllPlayerIDs=" + ids.slice(0, 24).join(","));
        diagLog("player Game.GetLocalPlayerInfo=" + summarizeIdentityValue(gameLocalPlayerInfo()));
        if (localId >= 0) diagLog("player Game.GetPlayerInfo(local)=" + summarizeIdentityValue(getPlayerInfoById(localId)));
        for (let i = 0; i < Math.min(ids.length, 12); i += 1) {
          const id = Number(ids[i]);
          if (!Number.isFinite(id) || id < 0) continue;
          const pi = getPlayerInfoById(id);
          if (pi) diagLog("player Game.GetPlayerInfo(" + id + ")=" + summarizeIdentityValue(pi));
        }
      }
      if (typeof Players !== "undefined") {
        if (localId >= 0 && isCallable(Players.GetPlayerName)) {
          try { diagLog("player Players.GetPlayerName(local)=" + String(Players.GetPlayerName(localId) || "")); } catch (e) {}
        }
      }
    } catch (e) {
      diagLog("player diag failed: " + (e && e.message ? e.message : String(e)));
    }
  }

  function boot() {
    State.cfg = loadUiConfig();
    ensureBridgeEvents(); // 尽早注册 HTML 面板事件(读回主通道)
    // 玩家 API 诊断:主页/大厅/比赛三个阶段各跑一次(命名空间可能随场景出现)
    let playerDiagTries = 0;
    $.Schedule(3.0, function playerDiagLoop() {
      probePlayerApiDiagnostics();
      playerDiagTries += 1;
      if (playerDiagTries < 3) $.Schedule(60.0, playerDiagLoop);
    });
    // 启动后从桥同步 config.json 的 UI 设置(出站翻译/开关/服务商等),避免手改文件不生效
    $.Schedule(1.0, function () { syncUiFromBridge(0); });
    $.Schedule(SLOW_POLL_SECONDS, scanChatMessages);
    $.Schedule(PROFILE_LOOP_SECONDS, scanProfileCardsLoop);
    // 场景侦察:启动后一次性 dump 顶栏/HUD/ESC 关键子树(定位玩家条目创建位置)
    $.Schedule(6.0, reconScene);
    // 桥健康探测(每 5 秒;与翻译请求共用串行队列,量极小不影响翻译)
    $.Schedule(2.0, function healthLoop() {
      healthCheck();
      $.Schedule(5.0, healthLoop);
    });
    // 日志缓冲兜底冲刷(每 8 秒;确保不丢最后一小批)
    $.Schedule(8.0, function logLoop() {
      flushChatLog();
      $.Schedule(8.0, logLoop);
    });
  }

  // 导出给 XML 布局调用的全局函数
  // 教训:每个导出必须独立 try/catch——曾有虚构事件注册抛异常被吞,
  // 导致后续导出全部跳过(按钮点击报 is not defined)。
  function exportGlobal(name, fn) {
    try {
      globalThis[name] = fn;
    } catch (e) {
      log("export failed: " + name + " - " + (e && e.message ? e.message : String(e)));
    }
  }
  exportGlobal("LCTOnChatSubmit", function () {
    handleChatSubmit(findChild(getRoot(), CHAT_INPUT_ID));
  });
  exportGlobal("LCTToggleSettings", LCTToggleSettings);
  exportGlobal("LCTCloseSettings", LCTCloseSettings);
  exportGlobal("LCTOnToggle", LCTOnToggle);
  exportGlobal("LCTCycle", LCTCycle);
  exportGlobal("LCTToggleMenu", LCTToggleMenu);
  exportGlobal("LCTPickLang", LCTPickLang);
  exportGlobal("LCTPickProvider", LCTPickProvider);
  exportGlobal("LCTPickOption", LCTPickOption);
  exportGlobal("LCTSave", LCTSave);
  exportGlobal("LCTTest", LCTTest);
  exportGlobal("LCTRowHovered", function (panel) {
    try {
      if (!isValid(panel)) return;
      let name = safeText(findClass(panel, TOPBAR_PLAYER_NAME_CLASS));
      if (!name) name = safeText(findChild(panel, "PlayerName")) || safeText(findChild(panel, "UserName"));
      let hero = readPlayerRowHero(panel) || readHeroFromRow(panel);
      if (!hero) hero = readHeroFromHeroImage(findChild(panel, "HeroBadge")) || readHeroFromHeroImage(findChild(panel, "HeroImage"));
      if (!hero) hero = fallbackHeroForSender(name);
      State.hoverRow = { panel: panel, hero: hero, name: name, t: nowMs() };
    } catch (e) {}
  });
  exportGlobal("LCTRowUnhovered", function (panel) {
    try {
      if (State.hoverRow && (!panel || State.hoverRow.panel === panel)) State.hoverRow = null;
    } catch (e) {}
  });

  boot();
})();




