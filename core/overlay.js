// Babel Tower - 游戏外翻译悬浮窗(overlay)
//
// 背景:2026/10/01 的 Deadlock 更新移除了 Panorama 的全部 HTTP 能力
// ($.AsyncWebRequest 调用即抛 "AsyncWebRequest has been removed",隐藏 HTML 面板
// 不再创建浏览器实例),游戏内既发不出请求也读不回响应。
// 唯一活着的通道是单向的「游戏 -> console.log」:mod 每落档一条聊天就打一行
//   <时间戳> [PanoramaScript] [LCT-CHAT]{"o":0,"n":"Alice","c":"chat","h":"","t":"hello"}
// 本模块增量 tail 该文件,把新聊天翻译成中文后存进环形缓冲,由浏览器里的悬浮窗
// 页面轮询展示;发消息则走「悬浮窗输入中文 -> 翻译成英文 -> 写入剪贴板 -> 游戏内 Ctrl+V」。
//
// 只监听 127.0.0.1,不代理任意 URL;不落盘聊天内容(除已有的聊天日志功能)。
"use strict";

const fs = require("fs");
const path = require("path");

const CHAT_MARKER = "[LCT-CHAT]";
const DEFAULT_CONSOLE_LOG = "E:/Steam/steamapps/common/Deadlock/game/citadel/console.log";

// 增量读取:与 bridge_server.js 的 matchId 扫描同思路 —— 边界指纹检测日志重写,
// 因为每次启动游戏 console.log 会被清空重写,只靠 size 变化判断增量会从错位字节开始读。
const FINGERPRINT_LEN = 256;
const MAX_CHUNK = 4 * 1024 * 1024;
const POLL_MS = 800;

// 环形缓冲:悬浮窗只需要最近的消息;上限防止长时间运行内存膨胀
const RING_LIMIT = 300;
// 同一条消息可能同时来自左下聊天行与顶栏气泡副本(文本相同):去重窗口。
// 两个副本几乎同时出现,窗口取 2 分钟足够覆盖;原来的 10 分钟太长,会把同一人
// 重复说的同一句话(如两次 "gg" / "push" / "1")当成副本吞掉,第二条根本不显示。
const DEDUP_WINDOW_MS = 2 * 60 * 1000;
const DEDUP_LIMIT = 600;
// 同时进行的翻译请求数上限(桥端服务商多为单账号限流,串行会太慢,并发太高会触发 429)
const MAX_TRANSLATING = 4;
const QUEUE_LIMIT = 80;
// 桥中途重启时的历史回填:游戏还在运行时,回填本局最近这么多条聊天行,让"桥开启前的
// 聊天"也能出现在悬浮窗;限定条数避免一次性把整局历史丢进翻译队列(API 洪峰)。
const PRIME_BACKFILL_MAX = 60;
const PRIME_BACKFILL_BYTES = 4 * 1024 * 1024;

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff]/;

let ring = [];
let seq = 0;
// 会话标识:桥进程启动、日志被游戏重写(新一局)、游戏退出清空时都会换一个新值。
// 悬浮窗据此判断"桥换过一次 / 进了新一局",把本地已渲染的旧聊天清掉,避免残留。
let session = 0;
let fileState = { path: "", offset: 0, tail: "", fingerprint: null, primed: false };
let dedup = new Map();
let queue = [];
let translating = 0;
let timer = null;
let deps = { log: function () {}, getConfig: function () { return null; }, translate: null, isGameRunning: null };
let pageCache = "";
let started = false;

function setDeps(d) {
  if (!d) return;
  if (typeof d.log === "function") deps.log = d.log;
  if (typeof d.getConfig === "function") deps.getConfig = d.getConfig;
  if (typeof d.translate === "function") deps.translate = d.translate;
  if (typeof d.writeChatLog === "function") deps.writeChatLog = d.writeChatLog;
  if (typeof d.isGameRunning === "function") deps.isGameRunning = d.isGameRunning;
}

// ---------- 日志行解析 ----------

function parseLine(line) {
  const i = line.indexOf(CHAT_MARKER);
  if (i < 0) return null;
  const json = line.slice(i + CHAT_MARKER.length).trim();
  let obj;
  try {
    obj = JSON.parse(json);
  } catch (e) {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const text = String(obj.t || "").trim();
  if (!text) return null;
  return {
    own: obj.o === 1 || obj.o === true,
    sender: String(obj.n || "").trim(),
    channel: String(obj.c || "").trim(),
    hero: String(obj.h || "").trim(),
    text: text.slice(0, 400),
  };
}

function needsTranslation(text, cfg) {
  const target = String((cfg && cfg.defaults && cfg.defaults.targetLanguage) || "zh-Hans").toLowerCase();
  if (target.indexOf("zh") === 0) return !CJK_RE.test(text);
  return true;
}

function ingest(line, opts) {
  const rec = parseLine(line);
  if (!rec) return;
  const sig = (rec.own ? "1" : "0") + "\x00" + rec.sender + "\x00" + rec.text;
  const now = Date.now();
  const prev = dedup.get(sig);
  if (prev && now - prev < DEDUP_WINDOW_MS) return;
  dedup.set(sig, now);
  // 落盘聊天日志。游戏更新后 mod 已经无法把日志 POST 给桥(HTTP 通道被移除),
  // 这里是唯一还活着的通道, 用它把 logs/chat 的写入补回来。
  // 只在新条目(已过去重)时写, 避免日志被重写后重复落盘。
  // noLog: 桥中途重启的回填 —— 这些行上一条桥实例多半已经落过盘, 不再重复写。
  if (typeof deps.writeChatLog === "function" && !(opts && opts.noLog)) {
    try {
      deps.writeChatLog({
        t: now,
        kind: "chat",
        isOwn: !!rec.own,
        sender: rec.sender,
        channel: rec.channel,
        hero: rec.hero,
        text: rec.text,
      });
    } catch (e) {}
  }
  if (dedup.size > DEDUP_LIMIT) {
    const first = dedup.keys().next().value;
    if (first !== undefined) dedup.delete(first);
  }

  const msg = {
    seq: ++seq,
    own: rec.own,
    sender: rec.sender,
    channel: rec.channel,
    hero: rec.hero,
    text: rec.text,
    translation: "",
    error: "",
    pending: false,
    ts: now,
  };
  ring.push(msg);
  while (ring.length > RING_LIMIT) ring.shift();

  if (!needsTranslation(msg.text, deps.getConfig())) return;
  if (!deps.translate) return;
  if (queue.length >= QUEUE_LIMIT) {
    msg.error = "queue_full";
    return;
  }
  msg.pending = true;
  queue.push(msg);
  pump();
}

// ---------- 翻译队列(限并发) ----------

function pump() {
  while (translating < MAX_TRANSLATING && queue.length) {
    const msg = queue.shift();
    translating += 1;
    Promise.resolve()
      .then(function () { return deps.translate(msg.text); })
      .then(function (tr) {
        const out = String(tr || "").trim();
        if (out) msg.translation = out;
        else msg.error = "empty_translation";
        msg.pending = false;
      })
      .catch(function (e) {
        msg.error = String((e && e.message) || e || "translate_failed").slice(0, 120);
        msg.pending = false;
      })
      .then(function () {
        translating -= 1;
        pump();
      });
  }
}

// ---------- console.log 增量 tail ----------

function resetFileState() {
  fileState = { path: "", offset: 0, tail: "", fingerprint: null, primed: false };
}

function clearDedup() {
  dedup = new Map();
}

// 进入新一局(或游戏退出)时调用:清空聊天缓冲与去重表,并换一个会话标识。
// 悬浮窗轮询到会话标识变了就会把本地渲染的旧聊天清掉,避免上一局残留。
function beginNewSession() {
  ring = [];
  queue = [];
  dedup = new Map();
  session += 1;
}

// 桥中途启动、且游戏仍在运行时,回填本局最近若干条聊天。
// 这样"桥开启前"的聊天也能被翻译(用户反馈:重启桥后先前的聊天不翻译)。
// 只回填最近 PRIME_BACKFILL_MAX 条,且不重复落盘(上一条桥实例多半已写过)。
function primeBackfill(file, size) {
  const cap = Math.min(size, PRIME_BACKFILL_BYTES);
  const buf = Buffer.alloc(cap);
  const fd = fs.openSync(file, "r");
  try {
    fs.readSync(fd, buf, 0, cap, size - cap);
  } finally {
    fs.closeSync(fd);
  }
  const lines = buf.toString("utf8").split("\n");
  if (size > cap) lines.shift(); // 从字节中间开始,首行是半截,丢掉
  const chatLines = lines
    .filter(function (l) { return l.indexOf(CHAT_MARKER) !== -1; })
    .slice(-PRIME_BACKFILL_MAX);
  for (const l of chatLines) ingest(l.replace(/\r$/, ""), { noLog: true });
  fileState.offset = size;
  // 末尾可能是半截行,留作 tail,等续写补全后再解析
  fileState.tail = lines.length ? lines[lines.length - 1] : "";
  const fpLen = Math.min(FINGERPRINT_LEN, size);
  if (fpLen > 0) {
    const fp = Buffer.alloc(fpLen);
    const fd2 = fs.openSync(file, "r");
    try {
      fs.readSync(fd2, fp, 0, fpLen, size - fpLen);
    } finally {
      fs.closeSync(fd2);
    }
    fileState.fingerprint = fp;
  } else {
    fileState.fingerprint = null;
  }
}

function tailOnce() {
  const cfg = deps.getConfig();
  const file = String((cfg && cfg.deadlockConsoleLog) || DEFAULT_CONSOLE_LOG || "");
  if (!file) return;
  if (fileState.path !== file) {
    resetFileState();
    fileState.path = file;
  }

  let stat;
  try {
    stat = fs.statSync(file);
  } catch (e) {
    return; // 游戏尚未启动/日志不存在
  }
  if (!fileState.primed) {
    fileState.primed = true;
    // 首次接触:
    //  - 游戏正在运行 => 桥是中途(重)启的,回填本局最近聊天,让"桥开启前的聊天"也能翻译;
    //  - 游戏不在运行 => 这份日志是上一局留下的,seek 到末尾,不回放(否则登录自启时会翻译整局旧历史)。
    fileState.offset = stat.size;
    fileState.tail = "";
    fileState.fingerprint = null;
    if (stat.size > 0 && typeof deps.isGameRunning === "function" && deps.isGameRunning()) {
      try {
        primeBackfill(file, stat.size);
      } catch (e) {
        deps.log("warn", "overlay prime backfill failed: " + ((e && e.message) || String(e)));
      }
    }
    return;
  }

  let reset = false;
  if (stat.size < fileState.offset) {
    reset = true;
  } else if (fileState.fingerprint && fileState.offset > 0) {
    const probeStart = Math.max(0, fileState.offset - fileState.fingerprint.length);
    const probeLen = fileState.offset - probeStart;
    const probe = Buffer.alloc(probeLen);
    const fd = fs.openSync(file, "r");
    try {
      fs.readSync(fd, probe, 0, probeLen, probeStart);
    } finally {
      fs.closeSync(fd);
    }
    if (!probe.equals(fileState.fingerprint)) reset = true;
  }
  if (reset) {
    // 游戏重启会清空重写 console.log:从头读这一轮新日志,并作废上一局的去重记录。
    // 同时清空聊天缓冲/换会话标识,避免上一局的聊天残留在悬浮窗里。
    fileState.offset = 0;
    fileState.tail = "";
    fileState.fingerprint = null;
    beginNewSession();
    deps.log("info", "overlay: game console.log rewritten, new session, re-tailing from start");
  }

  const fd = fs.openSync(file, "r");
  try {
    let readFrom = fileState.offset;
    let tail = fileState.tail;
    let advanced = 0;
    while (readFrom < stat.size) {
      const len = Math.min(stat.size - readFrom, MAX_CHUNK);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, readFrom);
      const lines = buf.toString("utf8").split("\n");
      lines[0] = tail + lines[0];
      tail = lines.pop();
      for (const raw of lines) ingest(raw.replace(/\r$/, ""));
      readFrom += len;
      advanced += len;
      if (len < MAX_CHUNK) break;
    }
    fileState.tail = tail;
    fileState.offset = stat.size;
    if (advanced > 0) {
      const fpLen = Math.min(FINGERPRINT_LEN, advanced);
      const fp = Buffer.alloc(fpLen);
      fs.readSync(fd, fp, 0, fpLen, stat.size - fpLen);
      fileState.fingerprint = fp;
    }
  } finally {
    fs.closeSync(fd);
  }
}

function tick() {
  try {
    tailOnce();
  } catch (e) {
    deps.log("warn", "overlay tail failed: " + ((e && e.message) || String(e)));
  }
}

// ---------- 对外接口 ----------

function list(after) {
  const a = Number(after) || 0;
  const out = [];
  for (const m of ring) {
    if (m.seq > a) out.push(m);
  }
  return out;
}

function latestSeq() {
  return seq;
}

function sessionId() {
  return session;
}

// 游戏退出时调用:清空缓冲并换会话标识(下次进游戏从干净状态开始)。
function clearMessages() {
  beginNewSession();
}

function start(d) {
  setDeps(d);
  if (started) return;
  started = true;
  // 每次桥进程启动都拿一个不同的会话标识:悬浮窗若在桥重启后仍然活着,
  // 轮询到标识变化就会清屏并重新拉取(否则会因序号错位而卡住不更新)。
  session = Date.now();
  // 先 prime 一次:立刻记下当前文件长度,避免第一轮循环与启动日志交错把历史读进来
  try {
    tailOnce();
  } catch (e) {}
  timer = setInterval(tick, POLL_MS);
  if (timer && typeof timer.unref === "function") timer.unref();
  deps.log("info", "overlay: watching " + String((deps.getConfig() || {}).deadlockConsoleLog || DEFAULT_CONSOLE_LOG) + " for " + CHAT_MARKER);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  started = false;
}

// 测试用:清空全部内存状态(不影响已启动的定时器)
function reset() {
  ring = [];
  seq = 0;
  session = 0;
  queue = [];
  translating = 0;
  clearDedup();
  resetFileState();
}

// 悬浮窗页面:读同目录的 overlay_page.html 并缓存(打包脚本会一并复制该文件)
function pageHtml() {
  if (pageCache) return pageCache;
  try {
    pageCache = fs.readFileSync(path.join(__dirname, "overlay_page.html"), "utf8");
  } catch (e) {
    pageCache = "<!DOCTYPE html><html><body style=\"font:14px sans-serif;padding:16px\">" +
      "缺少 overlay_page.html,请重新解压发布包。</body></html>";
  }
  return pageCache;
}

module.exports = {
  CHAT_MARKER: CHAT_MARKER,
  start: start,
  stop: stop,
  reset: reset,
  list: list,
  latestSeq: latestSeq,
  sessionId: sessionId,
  clearMessages: clearMessages,
  pageHtml: pageHtml,
  // 仅测试使用:把一行模拟日志喂进解析管线
  ingestLine: ingest,
};