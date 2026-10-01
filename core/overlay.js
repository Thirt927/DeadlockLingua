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
// 同一条消息可能同时来自左下聊天行与顶栏气泡副本(文本相同):去重窗口
const DEDUP_WINDOW_MS = 10 * 60 * 1000;
const DEDUP_LIMIT = 600;
// 同时进行的翻译请求数上限(桥端服务商多为单账号限流,串行会太慢,并发太高会触发 429)
const MAX_TRANSLATING = 4;
const QUEUE_LIMIT = 80;

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff]/;

let ring = [];
let seq = 0;
let fileState = { path: "", offset: 0, tail: "", fingerprint: null, primed: false };
let dedup = new Map();
let queue = [];
let translating = 0;
let timer = null;
let deps = { log: function () {}, getConfig: function () { return null; }, translate: null };
let pageCache = "";
let started = false;

function setDeps(d) {
  if (!d) return;
  if (typeof d.log === "function") deps.log = d.log;
  if (typeof d.getConfig === "function") deps.getConfig = d.getConfig;
  if (typeof d.translate === "function") deps.translate = d.translate;
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

function ingest(line) {
  const rec = parseLine(line);
  if (!rec) return;
  const sig = (rec.own ? "1" : "0") + "\x00" + rec.sender + "\x00" + rec.text;
  const now = Date.now();
  const prev = dedup.get(sig);
  if (prev && now - prev < DEDUP_WINDOW_MS) return;
  dedup.set(sig, now);
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
    // 首次接触:从当前末尾开始,不回放历史聊天(桥重启时不把旧消息全刷出来)。
    fileState.offset = stat.size;
    fileState.tail = "";
    fileState.fingerprint = null;
    fileState.primed = true;
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
    // 游戏重启会清空重写 console.log:从头读这一轮新日志,并作废上一局的去重记录
    fileState.offset = 0;
    fileState.tail = "";
    fileState.fingerprint = null;
    clearDedup();
    deps.log("info", "overlay: game console.log rewritten, re-tailing from start");
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

function start(d) {
  setDeps(d);
  if (started) return;
  started = true;
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
  pageHtml: pageHtml,
  // 仅测试使用:把一行模拟日志喂进解析管线
  ingestLine: ingest,
};