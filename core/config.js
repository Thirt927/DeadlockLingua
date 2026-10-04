// Babel Tower - 本地配置管理
// 配置只存放在本地磁盘 config/config.json(绝不进入 VPK / Git / 日志)。
// 首次运行会自动从 config.example.json 生成。
"use strict";

const fs = require("fs");
const path = require("path");

const DEFAULTS = {
  port: 8791,
  provider: "bing",
  bing: {},
  microsoft: {
    apiKey: "",
    region: "",
    endpoint: "https://api.cognitive.microsofttranslator.com",
  },
  openai: {
    apiKey: "",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
  },
  deepl: {
    apiKey: "",
    endpoint: "https://api-free.deepl.com/v2/translate",
  },
  google: {
    apiKey: "",
  },
  // 主服务商失败时的自动回退顺序(可空数组表示不回退)
  // 例:["bing"] 表示 bing 失败后依次尝试 bing(仅当它是备用时才有意义)
  // 建议:["microsoft","openai","deepl","google"] (仅尝试已配置 Key 的服务商)
  fallbackProviders: [],
  // 聊天日志(按比赛 ID 划分文件)
  chatLog: {
    enabled: true,
    dir: "logs/chat",
  },
  // 使用 Deadlock 公开数据 API 回填聊天日志里缺失的 SteamID。
  // 说明: 当前游戏版本 Panorama 不再暴露 Game/Players API, 其他玩家的 SteamID
  // 无法从聊天行/顶栏稳定采集; 此功能按“昵称 -> Steam 搜索 -> 精确匹配”补全。
  steamIdEnrichment: {
    enabled: false,
    baseUrl: "https://api.deadlock-api.com",
    searchLimit: 20,
    minMatchesPlayedLast30d: 0,
    exactNameOnly: true,
    ambiguousMatchCheck: true,
    maxAmbiguousChecks: 3,
    maxPlayersPerFile: 12,
    maxFilesPerRun: 10,
    minFileAgeMs: 180000,
    rosterMinFileAgeMs: 21600000,
    intervalMs: 3600000,
    requestTimeoutMs: 15000,
    rosterEnabled: true,
    rosterRequestTimeoutMs: 30000,
    steamProfileRequestTimeoutMs: 30000,
    lookbackHours: 72,
  },
  defaults: {
    sourceLanguage: "auto",
    targetLanguage: "zh-Hans",
  },
  // 游戏外翻译悬浮窗:本版游戏移除了 Panorama 的 HTTP 能力,游戏内不再可能显示译文,
  // 改为「游戏 -> console.log -> 桥 -> 游戏外悬浮窗」。enabled=false 关闭整套功能,
  // autoOpen=false 只关闭"检测到游戏启动自动开窗"(可手动打开 http://127.0.0.1:<port>/overlay)。
  // mode: native = 原生 WPF 窗口(真透明 + 贴边收起,默认);web = Edge/Chrome 小窗(不透明,仅回退)。
  overlay: {
    enabled: true,
    autoOpen: true,
    mode: "native",
    // view: panel = 常规面板窗;subtitle = 字幕浮层(角落堆叠的聊天胶囊,鼠标穿透)
    view: "panel",
    opacity: 0.85,
    // 与 overlay_window.ps1 的 $T.Surface / $T.Brass 保持一致:Apply-Config 会用
    // 这两项覆写 XAML 里写好的令牌值, 不一致的话新配色会被旧色盖掉
    background: "#131920",
    // 预留:自定义背景图(本地绝对路径);留空则用 background 纯色
    backgroundImage: "",
    cornerRadius: 10,
    accent: "#C9A44E",
    fontSize: 12,
    // 收起时贴哪条屏边(拖动松手后, 离最近边小于阈值才吸附);
    // "float" = 自由悬浮(拖到屏幕中间停住, 不贴边也不自动收起)
    edge: "right",
    // edge=float 时记住的窗口左上角屏幕绝对坐标(松手时写入)
    floatX: null,
    floatY: null,
    autoHide: true,
    awakeMs: 6000,
    // 字幕浮层:角落堆叠的聊天胶囊(昵称 + 原文 + 译文)。
    // 位置存成相对工作区的比例(0..1),换分辨率/换屏不会跑偏;实际摆放由窗口拖动写入。
    subtitle: {
      xRatio: 0.02,
      yRatio: 0.30,
      width: 380,
      fontSize: 15,
      nameSize: 11,
      origSize: 11,
      bgColor: "#0A0C11",
      bgOpacity: 0.55,
      radius: 8,
      gap: 6,
      lifeMs: 9000,
      fadeMs: 260,
      maxVisible: 6,
      // persist=true: 不按时间过期, 只保留最近 maxVisible 条, 超出才挤掉最旧的
      persist: false,
      textColor: "#F2F4F8",
      nameColor: "#A8B0BE",
      origColor: "#8A93A3",
      showSender: true,
      showOriginal: true,
    },
  },
  timeoutMs: 15000,
  maxQueue: 200,
  // 游戏面板 UI 偏好(经桥持久化,避免游戏重启丢失)
  ui: {
    enabled: true,
    provider: "bing",
    displayMode: "bilingual",
    outgoing: "off",
    outgoingTarget: "en",
    targetLanguage: "zh-Hans",
    force: false,
    timeoutMs: 15000,
  },
  // 进程监视:Deadlock 退出时是否连桥一起关闭。
  // 默认 false = 桥常驻:桥只在开机自启时拉起一次,游戏关闭时仅关闭悬浮窗。
  // (若设为 true,游戏一关桥就退出,而自启只在登录时执行一次——之后重开游戏桥不会
  //  自动回来,这正是"关闭游戏后桥也关了、再开游戏有时不自动启动"的原因。)
  // 悬浮窗的自动开关不受此项影响,由 overlay.autoOpen 控制。
  watchGame: false,
  watchGameExe: "deadlock.exe",
  // 可选文件日志(相对项目根目录;留空则不落盘)
  logFile: "logs/bridge.log",
};

function configDir() {
  return path.join(__dirname, "..", "config");
}

function configPath() {
  return path.join(configDir(), "config.json");
}

function examplePath() {
  return path.join(configDir(), "config.example.json");
}

function deepMerge(base, extra) {
  const out = Object.assign({}, base);
  for (const key of Object.keys(extra || {})) {
    const v = extra[key];
    if (v && typeof v === "object" && !Array.isArray(v) && base[key] && typeof base[key] === "object") {
      out[key] = deepMerge(base[key], v);
    } else {
      out[key] = v;
    }
  }
  return out;
}

function normalize(raw) {
  const cfg = deepMerge(DEFAULTS, raw || {});
  if (!Number.isFinite(Number(cfg.port))) cfg.port = DEFAULTS.port;
  if (!Number.isFinite(Number(cfg.timeoutMs))) cfg.timeoutMs = DEFAULTS.timeoutMs;
  if (!Number.isFinite(Number(cfg.maxQueue))) cfg.maxQueue = DEFAULTS.maxQueue;
  const enrich = cfg.steamIdEnrichment || {};
  enrich.searchLimit = Number(enrich.searchLimit) || DEFAULTS.steamIdEnrichment.searchLimit;
  enrich.minMatchesPlayedLast30d = Number(enrich.minMatchesPlayedLast30d);
  enrich.maxAmbiguousChecks = Number(enrich.maxAmbiguousChecks) || DEFAULTS.steamIdEnrichment.maxAmbiguousChecks;
  enrich.maxPlayersPerFile = Number(enrich.maxPlayersPerFile) || DEFAULTS.steamIdEnrichment.maxPlayersPerFile;
  enrich.maxFilesPerRun = Number(enrich.maxFilesPerRun) || DEFAULTS.steamIdEnrichment.maxFilesPerRun;
  enrich.minFileAgeMs = Number(enrich.minFileAgeMs) || DEFAULTS.steamIdEnrichment.minFileAgeMs;
  enrich.rosterMinFileAgeMs = Number(enrich.rosterMinFileAgeMs) || DEFAULTS.steamIdEnrichment.rosterMinFileAgeMs;
  enrich.intervalMs = Number(enrich.intervalMs) || DEFAULTS.steamIdEnrichment.intervalMs;
  enrich.requestTimeoutMs = Number(enrich.requestTimeoutMs) || DEFAULTS.steamIdEnrichment.requestTimeoutMs;
  if (typeof enrich.rosterEnabled !== "boolean") enrich.rosterEnabled = DEFAULTS.steamIdEnrichment.rosterEnabled;
  enrich.rosterRequestTimeoutMs = Number(enrich.rosterRequestTimeoutMs) || DEFAULTS.steamIdEnrichment.rosterRequestTimeoutMs;
  enrich.steamProfileRequestTimeoutMs = Number(enrich.steamProfileRequestTimeoutMs) || DEFAULTS.steamIdEnrichment.steamProfileRequestTimeoutMs;
  enrich.lookbackHours = Number(enrich.lookbackHours) || DEFAULTS.steamIdEnrichment.lookbackHours;
  return cfg;
}

function load() {
  try {
    if (fs.existsSync(configPath())) {
      return normalize(JSON.parse(fs.readFileSync(configPath(), "utf8")));
    }
  } catch (e) {
    // 配置损坏时回退默认值,不崩溃
  }
  // 首次运行:用默认值自动生成 config.json,方便用户后续查看/调整
  const defaults = normalize({});
  try {
    fs.mkdirSync(configDir(), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(defaults, null, 2), "utf8");
  } catch (e) {}
  return defaults;
}

function save(cfg) {
  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2), "utf8");
}

// 返回给游戏面板的配置(apiKey 打码,绝不回传明文)
function mask(cfg) {
  const key = (cfg.microsoft && cfg.microsoft.apiKey) || "";
  const openaiKey = (cfg.openai && cfg.openai.apiKey) || "";
  const deeplKey = (cfg.deepl && cfg.deepl.apiKey) || "";
  const googleKey = (cfg.google && cfg.google.apiKey) || "";
  return {
    port: cfg.port,
    provider: cfg.provider,
    microsoft: {
      apiKey: key ? "********" : "",
      hasApiKey: !!key,
      region: (cfg.microsoft && cfg.microsoft.region) || "",
      endpoint: (cfg.microsoft && cfg.microsoft.endpoint) || DEFAULTS.microsoft.endpoint,
    },
    openai: {
      apiKey: openaiKey ? "********" : "",
      hasApiKey: !!openaiKey,
      baseUrl: (cfg.openai && cfg.openai.baseUrl) || DEFAULTS.openai.baseUrl,
      model: (cfg.openai && cfg.openai.model) || DEFAULTS.openai.model,
    },
    deepl: {
      apiKey: deeplKey ? "********" : "",
      hasApiKey: !!deeplKey,
      endpoint: (cfg.deepl && cfg.deepl.endpoint) || DEFAULTS.deepl.endpoint,
    },
    google: {
      apiKey: googleKey ? "********" : "",
      hasApiKey: !!googleKey,
    },
    fallbackProviders: Array.isArray(cfg.fallbackProviders) ? cfg.fallbackProviders : [],
    chatLog: Object.assign({ enabled: true, dir: "logs/chat" }, cfg.chatLog || {}),
    defaults: {
      sourceLanguage: (cfg.defaults && cfg.defaults.sourceLanguage) || "auto",
      targetLanguage: (cfg.defaults && cfg.defaults.targetLanguage) || "zh-Hans",
    },
    timeoutMs: cfg.timeoutMs,
    ui: Object.assign({}, DEFAULTS.ui, cfg.ui || {}),
    // 悬浮窗配置(无敏感信息,原样回传给悬浮窗的设置面板)
    overlay: Object.assign({}, DEFAULTS.overlay, cfg.overlay || {}, {
      subtitle: Object.assign({}, DEFAULTS.overlay.subtitle, (cfg.overlay && cfg.overlay.subtitle) || {}),
    }),
  };
}

// 保存配置时处理打码回传:apiKey 为 "********" 表示保留原值;空串表示清除
// 同时兼容两种输入形态:
//   嵌套式(直接调 API):  { microsoft:{apiKey,region,endpoint}, defaults:{...}, provider, timeoutMs }
//   扁平式(游戏面板):    { provider, apiKey, region, targetLanguage, sourceLanguage, timeoutMs }
function applyMaskedUpdate(current, incoming) {
  const cfg = normalize(current);

  // 嵌套式 microsoft 块
  if (incoming.microsoft) {
    const ms = incoming.microsoft;
    if (typeof ms.apiKey === "string") {
      if (ms.apiKey && ms.apiKey !== "********") cfg.microsoft.apiKey = ms.apiKey;
      if (ms.apiKey === "") cfg.microsoft.apiKey = "";
    }
    if (typeof ms.region === "string") cfg.microsoft.region = ms.region;
    if (typeof ms.endpoint === "string" && ms.endpoint) cfg.microsoft.endpoint = ms.endpoint;
  }

  // 扁平式(面板)字段:apiKey 属于“当前选中的服务商”,
  // 必须按 provider 映射到对应段(DeepSeek 经 OpenAI 兼容填 openai.apiKey,不能固定写 microsoft)
  const flatKeyTarget = incoming.provider || cfg.provider;
  if (typeof incoming.apiKey === "string") {
    const key = incoming.apiKey;
    // 清空 Key 必须显式传 clearApiKey:true;空字符串不再清空,
    // 防止面板字段被清空/异步未回填时误删已保存的 Key(见第 16 轮)
    const clearKey = incoming.clearApiKey === true;
    const setKey = function (obj) {
      if (key && key !== "********") obj.apiKey = key;
      if (key === "" && clearKey) obj.apiKey = "";
    };
    if (flatKeyTarget === "openai") setKey(cfg.openai);
    else if (flatKeyTarget === "deepl") setKey(cfg.deepl);
    else if (flatKeyTarget === "google") setKey(cfg.google);
    else setKey(cfg.microsoft);
  }
  if (typeof incoming.region === "string") cfg.microsoft.region = incoming.region;

  if (incoming.openai) {
    const oa = incoming.openai;
    if (typeof oa.apiKey === "string") {
      if (oa.apiKey && oa.apiKey !== "********") cfg.openai.apiKey = oa.apiKey;
      if (oa.apiKey === "") cfg.openai.apiKey = "";
    }
    if (typeof oa.baseUrl === "string" && oa.baseUrl) cfg.openai.baseUrl = oa.baseUrl;
    if (typeof oa.model === "string" && oa.model) cfg.openai.model = oa.model;
  }
  if (incoming.deepl) {
    const dl = incoming.deepl;
    if (typeof dl.apiKey === "string") {
      if (dl.apiKey && dl.apiKey !== "********") cfg.deepl.apiKey = dl.apiKey;
      if (dl.apiKey === "") cfg.deepl.apiKey = "";
    }
    if (typeof dl.endpoint === "string" && dl.endpoint) cfg.deepl.endpoint = dl.endpoint;
  }
  if (incoming.google) {
    const gg = incoming.google;
    if (typeof gg.apiKey === "string") {
      if (gg.apiKey && gg.apiKey !== "********") cfg.google.apiKey = gg.apiKey;
      if (gg.apiKey === "") cfg.google.apiKey = "";
    }
  }
  if (Array.isArray(incoming.fallbackProviders)) {
    cfg.fallbackProviders = incoming.fallbackProviders.filter((x) => typeof x === "string");
  }
  if (incoming.chatLog && typeof incoming.chatLog === "object") {
    if (typeof incoming.chatLog.enabled === "boolean") cfg.chatLog.enabled = incoming.chatLog.enabled;
    if (typeof incoming.chatLog.dir === "string" && incoming.chatLog.dir) cfg.chatLog.dir = incoming.chatLog.dir;
  }

  // 扁平式:面板可能传 openaiBaseUrl/openaiModel/deeplEndpoint 等
  if (typeof incoming.openaiBaseUrl === "string" && incoming.openaiBaseUrl) cfg.openai.baseUrl = incoming.openaiBaseUrl;
  if (typeof incoming.openaiModel === "string" && incoming.openaiModel) cfg.openai.model = incoming.openaiModel;
  if (typeof incoming.deeplEndpoint === "string" && incoming.deeplEndpoint) cfg.deepl.endpoint = incoming.deeplEndpoint;

  if (typeof incoming.provider === "string" && incoming.provider) cfg.provider = incoming.provider;

  if (incoming.defaults) {
    if (typeof incoming.defaults.sourceLanguage === "string") cfg.defaults.sourceLanguage = incoming.defaults.sourceLanguage;
    if (typeof incoming.defaults.targetLanguage === "string") cfg.defaults.targetLanguage = incoming.defaults.targetLanguage;
  }
  if (typeof incoming.targetLanguage === "string" && incoming.targetLanguage) {
    cfg.defaults.targetLanguage = incoming.targetLanguage;
  }
  if (typeof incoming.sourceLanguage === "string" && incoming.sourceLanguage) {
    cfg.defaults.sourceLanguage = incoming.sourceLanguage;
  }

  if (Number.isFinite(Number(incoming.timeoutMs))) cfg.timeoutMs = Number(incoming.timeoutMs);

  // 游戏面板 UI 偏好(扁平字段,与面板 collectPanelConfig 对齐)
  if (incoming.ui && typeof incoming.ui === "object") {
    const u = incoming.ui;
    if (typeof u.enabled === "boolean") cfg.ui.enabled = u.enabled;
    if (typeof u.provider === "string" && u.provider) cfg.ui.provider = u.provider;
    if (typeof u.displayMode === "string" && u.displayMode) cfg.ui.displayMode = u.displayMode;
    if (typeof u.outgoing === "string" && u.outgoing) cfg.ui.outgoing = u.outgoing;
    if (typeof u.outgoingTarget === "string" && u.outgoingTarget) cfg.ui.outgoingTarget = u.outgoingTarget;
    if (typeof u.targetLanguage === "string" && u.targetLanguage) cfg.ui.targetLanguage = u.targetLanguage;
    if (typeof u.force === "boolean") cfg.ui.force = u.force;
    if (Number.isFinite(Number(u.timeoutMs))) cfg.ui.timeoutMs = Number(u.timeoutMs);
  }
  // 悬浮窗配置(由悬浮窗自身的设置面板提交,字段取白名单 + 数值夹紧,避免脏值写坏配置)
  if (incoming.overlay && typeof incoming.overlay === "object") {
    const ov = incoming.overlay;
    const cur = cfg.overlay;
    const clampNum = function (v, min, max, fallback) {
      const n = Number(v);
      if (!Number.isFinite(n)) return fallback;
      return Math.min(max, Math.max(min, n));
    };
    if (typeof ov.view === "string") {
      // "danmaku" 是第四十三轮用过的旧值,统一迁移到 "subtitle"
      if (ov.view === "danmaku") cur.view = "subtitle";
      else if (["panel", "subtitle"].indexOf(ov.view) !== -1) cur.view = ov.view;
    }
    if (typeof ov.edge === "string" && ["left", "right", "top", "bottom", "float"].indexOf(ov.edge) !== -1) cur.edge = ov.edge;
    if (ov.floatX !== undefined && ov.floatX !== null && Number.isFinite(Number(ov.floatX))) cur.floatX = Math.round(Number(ov.floatX));
    if (ov.floatY !== undefined && ov.floatY !== null && Number.isFinite(Number(ov.floatY))) cur.floatY = Math.round(Number(ov.floatY));
    if (typeof ov.background === "string") cur.background = ov.background;
    if (typeof ov.backgroundImage === "string") cur.backgroundImage = ov.backgroundImage;
    if (typeof ov.accent === "string" && ov.accent) cur.accent = ov.accent;
    if (typeof ov.autoHide === "boolean") cur.autoHide = ov.autoHide;
    if (typeof ov.enabled === "boolean") cur.enabled = ov.enabled;
    cur.opacity = clampNum(ov.opacity, 0.2, 1, cur.opacity);
    cur.cornerRadius = clampNum(ov.cornerRadius, 0, 40, cur.cornerRadius);
    cur.fontSize = clampNum(ov.fontSize, 8, 40, cur.fontSize);
    cur.awakeMs = clampNum(ov.awakeMs, 0, 60000, cur.awakeMs);
    if (ov.subtitle && typeof ov.subtitle === "object") {
      const d = ov.subtitle;
      const cs = cur.subtitle;
      if (typeof d.bgColor === "string" && d.bgColor) cs.bgColor = d.bgColor;
      if (typeof d.textColor === "string" && d.textColor) cs.textColor = d.textColor;
      if (typeof d.nameColor === "string" && d.nameColor) cs.nameColor = d.nameColor;
      if (typeof d.origColor === "string" && d.origColor) cs.origColor = d.origColor;
      cs.fadeMs = clampNum(d.fadeMs, 0, 3000, cs.fadeMs);
      if (typeof d.persist === "boolean") cs.persist = d.persist;
      if (typeof d.showSender === "boolean") cs.showSender = d.showSender;
      if (typeof d.showOriginal === "boolean") cs.showOriginal = d.showOriginal;
      cs.xRatio = clampNum(d.xRatio, 0, 1, cs.xRatio);
      cs.yRatio = clampNum(d.yRatio, 0, 1, cs.yRatio);
      cs.width = clampNum(d.width, 200, 1200, cs.width);
      cs.fontSize = clampNum(d.fontSize, 8, 48, cs.fontSize);
      cs.nameSize = clampNum(d.nameSize, 8, 32, cs.nameSize);
      cs.origSize = clampNum(d.origSize, 8, 32, cs.origSize);
      cs.bgOpacity = clampNum(d.bgOpacity, 0, 1, cs.bgOpacity);
      cs.radius = clampNum(d.radius, 0, 30, cs.radius);
      cs.gap = clampNum(d.gap, 0, 40, cs.gap);
      cs.lifeMs = clampNum(d.lifeMs, 1000, 60000, cs.lifeMs);
      cs.maxVisible = clampNum(d.maxVisible, 1, 20, cs.maxVisible);
    }
  }

  // 兼容面板旧扁平形态(直接顶层字段)
  if (typeof incoming.displayMode === "string" && incoming.displayMode) cfg.ui.displayMode = incoming.displayMode;
  if (typeof incoming.outgoing === "string" && incoming.outgoing) cfg.ui.outgoing = incoming.outgoing;
  if (typeof incoming.outgoingTarget === "string" && incoming.outgoingTarget) cfg.ui.outgoingTarget = incoming.outgoingTarget;
  if (typeof incoming.enabled === "boolean") cfg.ui.enabled = incoming.enabled;
  if (typeof incoming.force === "boolean") cfg.ui.force = incoming.force;
  return cfg;
}

module.exports = { load, save, mask, applyMaskedUpdate, configPath, examplePath, DEFAULTS };
