// Babel Tower - 本地翻译桥服务器
//
// 职责(只做翻译相关的事,不做通用代理):
//   1. 为游戏内隐藏 HTML 面板提供桥页面(/bridge)
//      - 页面在同源下调用 /api/v1/* ,再把结果写回 document.title 供 Panorama 轮询读取
//   2. 提供受限 API:
//      - POST /api/v1/translate  翻译一段文本
//      - POST /api/v1/test       用当前配置测试连通性
//      - GET  /api/v1/config     读取配置(apiKey 打码)
//      - POST /api/v1/config     保存配置(支持打码回传)
//      - GET  /api/v1/health     健康检查
//
// 安全原则:
//   - 只监听 127.0.0.1,不对外暴露
//   - 没有任意 URL 代理能力(与通用 /proxy 方案不同)
//   - Provider 请求目标由配置/代码限定(allowlist 思路)
//   - 请求体大小限制 64KB
//   - 日志不输出 apiKey
//
// 用法: node bridge_server.js   (默认端口 8791,可用 config.json 修改)
"use strict";

const http = require("http");
const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");

const configStore = require("./config");
const providerRegistry = require("./providers/registry");
const dictionary = require("./dictionary");
const steamIdEnrich = require("./steamid_enrich");
// 首次运行生成词典文件;桥启动后自动落盘高频词(自适应学习)
dictionary.ensureFile();
dictionary.startAutoFlush();

const MAX_BODY_BYTES = 64 * 1024;
const MAX_TEXT_CHARS = 4000; // 单条聊天文本长度上限

// ---------- 翻译结果缓存(同文本二次秒回,避免重复走 Bing) ----------
// 聊天场景重复度高(gg/glhf/thanks 等高频短语),缓存命中直接返回,零网络开销。
const TRANS_CACHE_LIMIT = 500;
const TRANS_CACHE_TTL_MS = 10 * 60 * 1000; // 10 分钟,覆盖整局对局
const transCache = new Map(); // key: text + target -> { translation, detectedLanguage, ts }

function cacheKey(text, target) {
  return String(text).toLowerCase() + "\x00" + String(target || "").toLowerCase();
}

function transCacheGet(text, target) {
  const key = cacheKey(text, target);
  const hit = transCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > TRANS_CACHE_TTL_MS) {
    transCache.delete(key);
    return null;
  }
  return hit;
}

function transCacheSet(text, target, translation, detectedLanguage) {
  if (transCache.size >= TRANS_CACHE_LIMIT) {
    const oldestKey = transCache.keys().next().value;
    if (oldestKey !== undefined) transCache.delete(oldestKey);
  }
  transCache.set(cacheKey(text, target), {
    translation: translation,
    detectedLanguage: detectedLanguage,
    ts: Date.now(),
  });
}

// ---------- 日志(可选落盘,绝不含 apiKey) ----------
let activeConfig = null;

function log(level, msg) {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  const line = "[" + ts + "] [" + level + "] " + msg;
  // 任何日志都不允许包含 apiKey;调用方自行保证
  console.log(line);
  try {
    if (activeConfig && activeConfig.logFile) {
      fs.appendFileSync(path.resolve(__dirname, "..", activeConfig.logFile), line + "\n", "utf8");
    }
  } catch (e) {}
}

// ---------- 进程监视:Deadlock 退出时自动关闭桥 ----------
// 注意:tasklist 偶发失败/空输出会被误判为"游戏退出"导致桥被杀(mod 显示离线),
// 因此:命令出错跳过本轮;游戏"消失"需连续确认 WATCH_CONFIRM_MISSES 次(约 6 秒)才关桥。
const WATCH_INTERVAL_MS = 2000;
const WATCH_CONFIRM_MISSES = 3;
let gameProcessSeen = false;
let watchMissCount = 0;
let watchTimer = null;

function checkGameProcess() {
  const gameExe = String((activeConfig && activeConfig.watchGameExe) || "deadlock.exe").toLowerCase();
  execFile(
    "tasklist",
    ["/FI", "IMAGENAME eq " + gameExe, "/FO", "CSV", "/NH"],
    { windowsHide: true },
    function (err, stdout) {
      if (err) {
        // tasklist 执行失败(系统繁忙/被杀软拦截):跳过本轮,不改变状态,避免误判
        if (!process.exitCode) watchTimer = setTimeout(checkGameProcess, WATCH_INTERVAL_MS);
        return;
      }
      const running = String(stdout || "").toLowerCase().indexOf(gameExe) !== -1;
      if (running) {
        if (!gameProcessSeen) {
          log("info", "检测到 " + gameExe + " 运行,监视其退出(需连续 " + WATCH_CONFIRM_MISSES + " 次未检测到才自动关闭)");
        }
        gameProcessSeen = true;
        watchMissCount = 0;
      } else if (gameProcessSeen) {
        watchMissCount += 1;
        if (watchMissCount >= WATCH_CONFIRM_MISSES) {
          log("info", gameExe + " 已退出,桥自动关闭");
          clearTimeout(watchTimer);
          process.exit(0);
          return;
        }
        log("info", "未检测到 " + gameExe + " (" + watchMissCount + "/" + WATCH_CONFIRM_MISSES + "),等待确认...");
      }
      if (!process.exitCode) watchTimer = setTimeout(checkGameProcess, WATCH_INTERVAL_MS);
    }
  );
}

function startGameWatch() {
  if (process.argv.indexOf("--no-watch") !== -1) return;
  if (activeConfig && activeConfig.watchGame === false) return;
  checkGameProcess();
}

// ---------- 请求体解析 ----------
function readBody(req, onDone) {
  let raw = "";
  let size = 0;
  let tooBig = false;
  req.on("data", (chunk) => {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      tooBig = true;
      req.destroy();
      return;
    }
    raw += chunk;
  });
  req.on("end", () => {
    if (tooBig) {
      onDone(new Error("body_too_large"));
      return;
    }
    onDone(null, raw);
  });
  req.on("error", (e) => onDone(e));
}

function parseJson(raw) {
  try {
    return JSON.parse(raw || "{}");
  } catch (e) {
    return null;
  }
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(body);
}

// ---------- 聊天日志(按比赛 ID 划分) ----------
function safeMatchId(id) {
  // 只保留字母数字与 - _ . 防止路径穿越
  return String(id || "unknown").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64) || "unknown";
}

function normBridgeName(name) {
  return String(name || "").replace(/^\[[^\]]+\]\s*/, "").trim().toLowerCase();
}

// Deadlock 的 Panorama 全局 API 在当前版本会抛 Code generation 错误,导致
// 客户端只能回退到 session_。桥在本地读取游戏 console.log 兜底。
// 旧实现只读尾部 512KB,比赛打几分钟后 'Lobby ... for Match N created' 就
// 被刷出窗口(实测 1.9MB 日志里该行在 29% 处)。改为增量扫描:记录上次字节偏移,
// 每次只读新增部分,兼容日志增长与轮转/清空。同时从连接行解析本机玩家昵称+steamid。
const DEFAULT_DEADLOCK_CONSOLE_LOG = "E:/Steam/steamapps/common/Deadlock/game/citadel/console.log";
// console.log 每次游戏启动会被清空重写:仅靠 stat.size >= offset 判断增量会从错位
// 字节开始读,永远错过本次比赛的 created 行(实际出现过旧 matchId 被写进新日志)。
// 用“边界指纹”检测重写:记录上次扫描结束时文件尾部若干字节,下次扫描先校验同位置
// 的字节,不一致则从头全扫(单次开销可接受,之后仍增量)。
const MATCH_LOG_FINGERPRINT_LEN = 256;
const MATCH_LOG_MAX_CHUNK = 8 * 1024 * 1024;
let gameMatchFile = { path: "", offset: 0, tail: "", id: "", selfName: "", selfId: "", fingerprint: null, idRetainedAt: 0, retainedId: "" };
const MATCH_ID_GRACE_MS = 120 * 1000; // keep returning the finished match id for 120s after lobby destroy (covers post-game flush)
const MIGRATE_SESSION_FRESH_MS = 5 * 60 * 1000; // only migrate session files written within the last 5 minutes
const IDENTITY_CACHE_FILENAME = "identity_cache.json"; // cross-match nickname -> steamid cache (passive profile-card collection)
function readLatestGameMatchId(cfg) {
  const file = String((cfg && cfg.deadlockConsoleLog) || DEFAULT_DEADLOCK_CONSOLE_LOG || "");
  if (!file) return "";
  try {
    if (gameMatchFile.path !== file) {
      gameMatchFile = { path: file, offset: 0, tail: "", id: "", selfName: "", selfId: "", fingerprint: null, idRetainedAt: 0, retainedId: "" };
    }
    const stat = fs.statSync(file);
    let reset = false;
    if (stat.size < gameMatchFile.offset) {
      reset = true;
    } else if (gameMatchFile.fingerprint && gameMatchFile.offset > 0) {
      const probeStart = Math.max(0, gameMatchFile.offset - gameMatchFile.fingerprint.length);
      const probeLen = gameMatchFile.offset - probeStart;
      const probe = Buffer.alloc(probeLen);
      const probeFd = fs.openSync(file, "r");
      try {
        fs.readSync(probeFd, probe, 0, probeLen, probeStart);
      } finally {
        fs.closeSync(probeFd);
      }
      if (!probe.equals(gameMatchFile.fingerprint)) reset = true;
    }
    if (reset) {
      // 日志被游戏截断/重写:从头重扫,保留已解析的本地玩家身份
      gameMatchFile = { path: file, offset: 0, tail: "", id: "", selfName: gameMatchFile.selfName, selfId: gameMatchFile.selfId, fingerprint: null, idRetainedAt: 0, retainedId: "" };
    }
    const fd = fs.openSync(file, "r");
    try {
      let readFrom = gameMatchFile.offset;
      let advanced = 0;
      let tail = gameMatchFile.tail;
      while (readFrom < stat.size) {
        const len = Math.min(stat.size - readFrom, MATCH_LOG_MAX_CHUNK);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, readFrom);
        const chunk = buf.toString("utf8");
        const lines = chunk.split("\n");
        lines[0] = tail + lines[0];
        tail = lines.pop();
        for (const raw of lines) {
          const line = raw.replace(/\r$/, "");
          let m;
          const ticketRe = /match_id=(\d+)/g;
          while ((m = ticketRe.exec(line))) { gameMatchFile.id = m[1]; gameMatchFile.idRetainedAt = 0; gameMatchFile.retainedId = ""; }
          const createdRe = /Lobby \d+ for Match (\d+) created/g;
          while ((m = createdRe.exec(line))) { gameMatchFile.id = m[1]; gameMatchFile.idRetainedAt = 0; gameMatchFile.retainedId = ""; }
          const destroyedRe = /Lobby \d+ for Match (\d+) destroyed/g;
          while ((m = destroyedRe.exec(line))) {
            if (String(m[1]) === String(gameMatchFile.id)) {
              gameMatchFile.retainedId = gameMatchFile.id;
              gameMatchFile.id = "";
              gameMatchFile.idRetainedAt = Date.now();
            }
          }
          // 本机身份:steamid:<id>@<ip> '<昵称>' 的 9 开头不是玩家账号,排除掉
          const selfRe = /steamid:(\d+)@\S+\s+'([^']+)'/g;
          while ((m = selfRe.exec(line))) {
            const nm = String(m[2] || "").trim();
            const sid = String(m[1] || "");
            if (nm && !/^9\d+$/.test(sid) && nm.toLowerCase() !== "server") {
              gameMatchFile.selfName = nm;
              gameMatchFile.selfId = sid;
            }
          }
        }
        readFrom += len;
        advanced += len;
        if (len < MATCH_LOG_MAX_CHUNK) break;
      }
      gameMatchFile.tail = tail;
      gameMatchFile.offset = stat.size;
      if (advanced > 0) {
        const fpLen = Math.min(MATCH_LOG_FINGERPRINT_LEN, advanced);
        const fp = Buffer.alloc(fpLen);
        fs.readSync(fd, fp, 0, fpLen, stat.size - fpLen);
        gameMatchFile.fingerprint = fp;
      }
    } finally {
      fs.closeSync(fd);
    }
    if (gameMatchFile.id) return gameMatchFile.id;
    if (gameMatchFile.idRetainedAt && gameMatchFile.retainedId && Date.now() - gameMatchFile.idRetainedAt < MATCH_ID_GRACE_MS) return gameMatchFile.retainedId;
    return "";
  } catch (e) {
    return gameMatchFile.id || "";
  }
}

// 跨局身份缓存:资料卡被动采集的 (昵称 -> steamid) 跨比赛累积,补齐后续比赛缺失的账号
let identityCache = null;
let identityCacheDir = "";
function loadIdentityCache(dir) {
  if (identityCache && identityCacheDir === dir) return identityCache;
  identityCacheDir = dir;
  identityCache = {};
  try {
    const raw = fs.readFileSync(path.join(dir, IDENTITY_CACHE_FILENAME), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") identityCache = parsed;
  } catch (e) {}
  return identityCache;
}
function saveIdentityCache(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, IDENTITY_CACHE_FILENAME), JSON.stringify(identityCache || {}), "utf8");
  } catch (e) {}
}

// 每场比赛的玩家身份表(昵称 -> { name, hero, heroId, steamid }),
// 用于把重复的 steamid/heroId 从消息行抽离成一次性的 player 记录。
const matchLogRoster = {};
const MATCH_LOG_ROSTER_MAX = 24; // 内存里最多保留 24 场的 roster,防止长期运行膨胀

// 客户端比赛早期拿不到真实 matchId 时一直写 session_文件;
// 桥端每次拿到真实比赛 id 就把最新的 session 文件并入真实文件,
// 避免"一场比赛两个日志文件"。迁移后删除 session 文件(幂等,重复调用无副作用)
function migrateLatestSessionFile(dir, realMatchId) {
  if (!dir || !realMatchId || String(realMatchId).indexOf("session_") === 0) return;
  let newest = "";
  let newestMtime = 0;
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return; }
  for (const name of names) {
    if (!/^session_[0-9]+\.jsonl$/.test(name)) continue;
    const p = path.join(dir, name);
    try {
      const st = fs.statSync(p);
      if (st.mtimeMs > newestMtime) { newestMtime = st.mtimeMs; newest = p; }
    } catch (e) {}
  }
  if (!newest) return;
  // Skip stale session files (e.g. leftover from the previous match) so they are not merged into the new match.
  if (Date.now() - newestMtime > MIGRATE_SESSION_FRESH_MS) return;
  const target = path.join(dir, realMatchId + ".jsonl");
  if (path.resolve(newest) === path.resolve(target)) return;
  const migrated = [];
  let ok = false;
  try {
    const raw = fs.readFileSync(newest, "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let rec;
      try { rec = JSON.parse(trimmed); } catch (e) { continue; }
      if (!rec || rec.type === "meta") continue;
      if (rec.type === "msg" || rec.type === "player") delete rec.matchId;
      else if (rec.matchId === undefined || rec.matchId === "" || String(rec.matchId).indexOf("session_") === 0) rec.matchId = realMatchId;
      migrated.push(rec);
    }
    ok = true;
  } catch (e) {}
  if (!ok || !migrated.length) return;
  try {
    // Skip player records already present in the target file (same name+steamid+hero) to avoid duplicates.
    const seenPlayers = new Set();
    try {
      const rawTarget = fs.readFileSync(target, "utf8");
      for (const line of rawTarget.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let rec;
        try { rec = JSON.parse(trimmed); } catch (e) { continue; }
        if (rec && rec.type === "player" && rec.name) seenPlayers.add(normBridgeName(rec.name) + "|" + String(rec.steamid || "") + "|" + String(rec.hero || ""));
      }
    } catch (e) {}
    const filtered = migrated.filter(function (r) {
      if (r.type === "player" && r.name && seenPlayers.has(normBridgeName(r.name) + "|" + String(r.steamid || "") + "|" + String(r.hero || ""))) return false;
      return true;
    });
    if (!filtered.length) { try { fs.unlinkSync(newest); } catch (e) {} return; }
    fs.appendFileSync(target, filtered.map(function (r) { return JSON.stringify(r); }).join("\n") + "\n", "utf8");
    fs.unlinkSync(newest);
    log("info", "session log migrated: " + path.basename(newest, ".jsonl") + " -> " + realMatchId + " (" + migrated.length + " lines)");
  } catch (e) {}
}

function pruneMatchLogRoster() {
  const keys = Object.keys(matchLogRoster);
  while (keys.length > MATCH_LOG_ROSTER_MAX) {
    const oldest = keys.shift();
    delete matchLogRoster[oldest];
  }
}

function appendChatLog(cfg, body) {
  const clientMatchId = safeMatchId(body.matchId || (body.lines && body.lines[0] && body.lines[0].matchId) || "");
  let matchId = clientMatchId;
  // 客户端没拿到真实 matchId 时,用游戏日志兜底;拿不到再保留 session_ 文件名。
  if (!matchId || matchId === "unknown" || matchId.indexOf("session_") === 0) {
    const liveMatchId = readLatestGameMatchId(cfg);
    if (liveMatchId) matchId = safeMatchId(liveMatchId);
  }
  let lines = Array.isArray(body.lines) ? body.lines : [];
  if (!lines.length) return 0;
  const dir = path.resolve(__dirname, "..", String((cfg.chatLog && cfg.chatLog.dir) || "logs/chat"));
  fs.mkdirSync(dir, { recursive: true });
  // 会话 session_ -> 真实比赛 id 迁移:客户端早期拿不到真实 matchId 时写的是 session 文件,
  // 一旦桥端从 console.log 兜底到真实 matchId,把 session 文件里的行合并进真实文件,
  // 避免同一局的行散落在两个文件。
  const sessionFile = (clientMatchId && clientMatchId !== matchId && clientMatchId.indexOf("session_") === 0)
    ? path.join(dir, clientMatchId + ".jsonl") : "";
  if (sessionFile && fs.existsSync(sessionFile)) {
    const migrated = [];
    let readOk = false;
    try {
      const raw = fs.readFileSync(sessionFile, "utf8");
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let rec;
        try { rec = JSON.parse(trimmed); } catch (e) { continue; }
        if (!rec || rec.type === "meta") continue;
        if (rec.matchId === undefined || rec.matchId === "" || String(rec.matchId).indexOf("session_") === 0) rec.matchId = matchId;
        if (rec.type === "player") delete rec.matchId;
        migrated.push(rec);
      }
      readOk = true;
    } catch (e) {}
    if (readOk) {
      if (migrated.length) lines = migrated.concat(lines);
      try { fs.unlinkSync(sessionFile); } catch (e) {}
    }
  }
  const file = path.join(dir, matchId + ".jsonl");
  const isNewFile = !fs.existsSync(file);
  // 每次拿到真实 id 都迁移最新 session 文件(幂等,无副作用)
  if (matchId && matchId.indexOf("session_") !== 0) migrateLatestSessionFile(dir, matchId);
  const roster = matchLogRoster[matchId] || (matchLogRoster[matchId] = {});
  pruneMatchLogRoster();
  const out = [];
  // 新文件首行写 meta(比赛 ID 只出现这一次,不再逐行重复)
  if (isNewFile) {
    out.push(JSON.stringify({ type: "meta", matchId: matchId, startedAt: new Date().toISOString() }));
  }
  for (const ln of lines) {
    const rawType = String(ln.type || "");
    if (rawType === "summary" || rawType === "meta" || rawType === "player") {
      const rec = Object.assign({}, ln);
      if (rec.matchId === undefined || rec.matchId === "" || String(rec.matchId).indexOf("session_") === 0) rec.matchId = matchId;
      delete rec.lines;
      // 玩家身份记录按昵称去重(同昵称同身份只写一次)
      if (rawType === "player") {
        const pkey = normBridgeName(rec.name);
        if (pkey) {
          const recHero = String(rec.hero || "");
          const recHeroId = String(rec.heroId || "");
          const prev = roster[pkey];
          let recId = String(rec.steamid || "");
          // 跨局身份缓存:资料卡被动采集的 (昵称->steamid) 跨比赛累积,补齐本次缺失的账号
          if (!recId) {
            const cached = loadIdentityCache(dir)[pkey];
            if (cached && cached.steamid) recId = String(cached.steamid);
          }
          if (recId) {
            loadIdentityCache(dir)[pkey] = { name: String(rec.name || ""), steamid: recId, hero: recHero, t: Date.now() };
            saveIdentityCache(dir);
          }
          const sameIdentity = !!(prev && prev.steamid === recId && prev.hero === recHero);
          if (sameIdentity) {
            // 同一身份(昵称+steamid+英雄)只写一次;仅补充缺失的 heroId/steamid,避免重复记录
            if (!prev.heroId && recHeroId) prev.heroId = recHeroId;
            if (!prev.steamid && recId) prev.steamid = recId;
            continue;
          }
          roster[pkey] = { name: String(rec.name || ""), hero: recHero, heroId: recHeroId, steamid: recId };
          if (recId && rec.steamid !== recId) rec.steamid = recId;
        }
        // player 记录不再重复 matchId(文件本身就是按比赛分的)
        delete rec.matchId;
      }
      out.push(JSON.stringify(rec));
      continue;
    }
    // 普通消息行:精简字段(去掉 matchId/heroId/steamid),身份抽离成 player 记录
    let steamid = String(ln.steamid || "");
    const own = !!ln.isOwn;
    const sender = String(ln.sender || "");
    if (!steamid && gameMatchFile && gameMatchFile.selfId) {
      // 本机玩家回填:从 console.log 连接行解析出的昵称/steamid,零交互零扫描
      const nameMatch = gameMatchFile.selfName && normBridgeName(sender) === normBridgeName(gameMatchFile.selfName);
      if (own || nameMatch) steamid = gameMatchFile.selfId;
    }
    const hero = String(ln.hero || "");
    const heroId = String(ln.heroId || "");
    const nameKey = normBridgeName(sender);
    if (nameKey && nameKey !== "<unknown>" && (steamid || hero || heroId)) {
      const prev = roster[nameKey];
      const sameHero = !!(prev && prev.hero === hero);
      const steamGained = !!steamid && (!prev || !prev.steamid);
      // 仅英雄变化或 steamid 首次拿到时补写 player 记录;heroId 单独变化不重复写
      if (!prev || !sameHero || steamGained) {
        const pRec = { type: "player", name: sender, hero: hero, heroId: heroId, steamid: steamid };
        if (prev) {
          if (!pRec.heroId && prev.heroId) pRec.heroId = prev.heroId;
          if (!pRec.steamid && prev.steamid) pRec.steamid = prev.steamid;
        }
        if (pRec.hero || pRec.heroId) out.push(JSON.stringify(pRec));
      }
      if (prev) {
        if (!prev.hero && hero) prev.hero = hero;
        if (!prev.heroId && heroId) prev.heroId = heroId;
        if (!prev.steamid && steamid) prev.steamid = steamid;
      } else {
        roster[nameKey] = { name: sender, hero: hero, heroId: heroId, steamid: steamid };
      }
    }
    out.push(JSON.stringify({
      type: "msg",
      t: String(ln.t || new Date().toISOString()),
      kind: String(ln.kind || "chat"),
      sender: sender,
      hero: hero,
      steamid: steamid,
      channel: String(ln.channel || ""),
      text: String(ln.text || "").slice(0, 2000),
    }));
  }
  // 同一批内按时间排序:客户端挂起条目超时兜底会乱序(meta/player 记录保持原位置)
  // out 里存的是 JSON 字符串,先解析出 msg 行排序,再按原位置回填
  const msgLines = [];
  const isMsg = [];
  for (let i = 0; i < out.length; i += 1) {
    let rec = null;
    try { rec = JSON.parse(out[i]); } catch (e) {}
    const m = !!(rec && rec.type === "msg");
    isMsg.push(m);
    if (m) msgLines.push(rec);
  }
  msgLines.sort(function (a, b) {
    const ta = String(a.t || "");
    const tb = String(b.t || "");
    return ta < tb ? -1 : ta > tb ? 1 : 0;
  });
  const orderedOut = [];
  let msgIdx = 0;
  for (let i = 0; i < out.length; i += 1) {
    if (isMsg[i]) orderedOut.push(JSON.stringify(msgLines[msgIdx++]));
    else orderedOut.push(out[i]);
  }
  fs.appendFileSync(file, orderedOut.join("\n") + "\n", "utf8");
  return out.length;
}
// ---------- 翻译执行 ----------
async function runTranslate(cfg, payload) {
  const provider = providerRegistry.getProvider(payload.provider || cfg.provider);
  if (!provider) {
    throw Object.assign(new Error("未知翻译服务商: " + (payload.provider || cfg.provider)), { status: 400 });
  }
  const text = String(payload.text || "").trim();
  if (!text) throw Object.assign(new Error("空文本"), { status: 400 });
  if (text.length > MAX_TEXT_CHARS) throw Object.assign(new Error("文本过长"), { status: 400 });

  // 词典直译优先:短词/常用语不走在线翻译,结果稳定(修复 gg 等短词译文=原文的抖动)
  const dictHit = dictionary.lookup(text, payload.targetLanguage || cfg.defaults.targetLanguage || "zh-Hans");
  if (dictHit) return dictHit;

  // 缓存命中:同文本直接返回上次结果(词典未覆盖的长句/短语重复出现时,零网络延迟)
  const targetLang = payload.targetLanguage || cfg.defaults.targetLanguage || "zh-Hans";
  const cached = transCacheGet(text, targetLang);
  if (cached) {
    log("info", "cache hit: " + String(text).slice(0, 60).replace(/\s+/g, " "));
    return { translation: cached.translation, detectedLanguage: cached.detectedLanguage, viaCache: true };
  }

  const providerCfg = (cfg[provider.id] || {});
  const baseOpts = {
    sourceLanguage: payload.sourceLanguage || cfg.defaults.sourceLanguage || "auto",
    targetLanguage: payload.targetLanguage || cfg.defaults.targetLanguage || "zh-Hans",
    timeoutMs: Number(payload.timeoutMs) || cfg.timeoutMs,
  };
  const errors = [];
  try {
    // 主服务商单次最多 20s(出站总预算 30s),给回退链(例如 bing)留足时间,避免主服务商超时后回退仍赶不上而发原文
    const primaryTimeoutMs = Math.min(Number(baseOpts.timeoutMs) || 15000, 20000);
    const result = await provider.translate(text, Object.assign({}, baseOpts, {
      apiKey: providerCfg.apiKey,
      region: providerCfg.region,
      endpoint: providerCfg.endpoint,
      baseUrl: providerCfg.baseUrl,
      model: providerCfg.model,
      timeoutMs: primaryTimeoutMs,
      // DeepSeek v4 等默认开思考的模型:翻译任务关闭思考,降低延迟
      disableThinking: !!providerCfg.disableThinking,
    }));
    return Object.assign(result, { provider: provider.id });
  } catch (e) {
    errors.push(provider.id + ": " + (e && e.message ? e.message : String(e)));
  }

  // 回退链:按配置依次尝试备用服务商(只尝试已配置 Key 的,避免连环失败浪费时间)
  const fallbacks = Array.isArray(cfg.fallbackProviders) ? cfg.fallbackProviders : [];
  for (const pid of fallbacks) {
    if (pid === provider.id) continue;
    const fb = providerRegistry.getProvider(pid);
    if (!fb) continue;
    const fc = (cfg[pid] || {});
    // 需要 Key 的服务商没配 Key 就跳过
    if (pid !== "bing" && !fc.apiKey) continue;
    try {
      const fbResult = await fb.translate(text, Object.assign({}, baseOpts, {
        apiKey: fc.apiKey,
        region: fc.region,
        endpoint: fc.endpoint,
        baseUrl: fc.baseUrl,
        model: fc.model,
      }));
      log("info", "fallback -> " + pid + " (primary " + provider.id + " failed: " + (errors[0] || "").slice(0, 80) + ")");
      return Object.assign(fbResult, { provider: pid, viaFallback: true });
    } catch (e2) {
      errors.push(pid + ": " + (e2 && e2.message ? e2.message : String(e2)));
    }
  }

  const last = new Error(errors.join(" | "));
  last.status = 502;
  throw last;
}

// ---------- 桥页面(供游戏内隐藏 HTML 面板加载) ----------
function bridgePage(query) {
  const id = String(query.get("id") || "x");
  const op = String(query.get("op") || "translate");
  const safeId = JSON.stringify(id);

  // 页面 JS:同源调用受限 API,结果写回 document.title(前缀 LCT + 请求 id)。
  // Panorama 侧轮询 panel.title 读取,按 id 前缀匹配响应。
  return [
    "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>lct-bridge</title></head><body>",
    "<script>",
    "(function(){",
    "var id=" + safeId + ";",
    "var q=new URLSearchParams(location.search);",
    "var op='" + String(op).replace(/[^a-z]/g, "") + "';",
    "var done=false;",
    "function out(p){var s='LCT'+id+JSON.stringify(p);",
    "try{document.title=s;}catch(e){}",
    "try{location.hash='#'+encodeURIComponent(s);}catch(e){}",
    "}",
    "try{document.title='lct-alive';}catch(e){}",
    "var t=Math.max(Number(q.get('timeoutMs'))||8000,8000);",
    "setTimeout(function(){if(!done){done=true;out({ok:false,error:'bridge_timeout'});}},t);",
    "var req={operation:op,text:q.get('text')||'',sourceLanguage:q.get('source')||'auto',targetLanguage:q.get('target')||'zh-Hans',timeoutMs:Number(q.get('timeoutMs'))||undefined};",
    "var d=q.get('d');if(d){try{req=JSON.parse(d);}catch(e){}}",
    "var path='/api/v1/'+(op==='translate'?'translate':op);",
    "var fetchOpts={method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(req)};",
    "if(op==='health'){fetchOpts={method:'GET'};}",
    "fetch(path,fetchOpts)",
    ".then(function(r){return r.json();})",
    ".then(function(j){if(done)return;done=true;out(j);})",
    ".catch(function(e){if(done)return;done=true;out({ok:false,error:String(e)});});",
    "})();",
    "</script></body></html>",
  ].join("");
}

// ---------- API 路由 ----------
// GET 兼容:游戏侧 $.AsyncWebRequest 只能发 GET,请求体通过 ?d=<JSON> 传递;
// 无 d 时 translate/test 用 query 参数(text/source/target/provider)构造。
function bodyFromRequest(url, bodyObj) {
  if (bodyObj) return bodyObj;
  const d = url.searchParams.get("d");
  if (d) {
    try { return JSON.parse(d); } catch (e) {}
  }
  if (url.pathname === "/api/v1/translate") {
    return {
      text: url.searchParams.get("text") || "",
      sourceLanguage: url.searchParams.get("source") || "auto",
      targetLanguage: url.searchParams.get("target") || "zh-Hans",
      provider: url.searchParams.get("provider") || undefined,
      timeoutMs: Number(url.searchParams.get("timeoutMs")) || undefined,
    };
  }
  return null;
}

async function handleApi(req, res, url, bodyObj) {
  const p = url.pathname;

  if (p === "/api/v1/diag" && (req.method === "POST" || req.method === "GET")) {
    bodyObj = bodyFromRequest(url, bodyObj);
    if (!bodyObj) return sendJson(res, 400, { ok: false, error: "bad_json" });
    const msg = String(bodyObj.msg || "").slice(0, 2000);
    if (msg) log("info", "[diag] PANORAMA: " + msg);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (p === "/api/v1/log" && (req.method === "POST" || req.method === "GET")) {
    bodyObj = bodyFromRequest(url, bodyObj);
    if (!bodyObj) return sendJson(res, 400, { ok: false, error: "bad_json" });
    const cfgL = configStore.load();
    if (!(cfgL.chatLog && cfgL.chatLog.enabled)) return sendJson(res, 200, { ok: true, skipped: "chat_log_disabled" });
    try {
      const n = appendChatLog(cfgL, bodyObj);
      sendJson(res, 200, { ok: true, written: n });
    } catch (e) {
      log("warn", "chat log write failed: " + (e && e.message ? e.message : String(e)));
      sendJson(res, 500, { ok: false, error: "chat_log_write_failed" });
    }
    return;
  }

  if (p === "/api/v1/health") {
    const cfgH = configStore.load();
    sendJson(res, 200, {
      ok: true,
      name: "Babel Tower Bridge",
      version: "1.0.0",
      provider: cfgH.provider,
      providers: providerRegistry.listProviders(),
      fallbackProviders: Array.isArray(cfgH.fallbackProviders) ? cfgH.fallbackProviders : [],
      chatLog: Object.assign({ enabled: true, dir: "logs/chat" }, cfgH.chatLog || {}),
    });
    return;
  }

  if (p === "/api/v1/translate" && (req.method === "POST" || req.method === "GET")) {
    bodyObj = bodyFromRequest(url, bodyObj);
    if (!bodyObj || !String(bodyObj.text || "").trim()) return sendJson(res, 400, { ok: false, error: "bad_json" });
    const cfg = configStore.load();
    try {
      const result = await runTranslate(cfg, bodyObj);
      // 缓存非词典命中结果(词典结果本身零延迟,无需缓存;缓存命中已直接返回)
      if (result && !result.viaDictionary && !result.viaCache) {
        transCacheSet(
          String(bodyObj.text || "").trim(),
          bodyObj.targetLanguage || cfg.defaults.targetLanguage || "zh-Hans",
          result.translation,
          result.detectedLanguage
        );
      }
      // 自适应学习:每次成功翻译都记录(含缓存命中——缓存命中同样是"该文本又出现一次"),
      // 高频词(同一译文 >= 3 次)自动固化进词典。词典内部会跳过已在表内的词。
      if (result && !result.viaDictionary) {
        dictionary.record(
          String(bodyObj.text || "").trim(),
          bodyObj.targetLanguage || cfg.defaults.targetLanguage || "zh-Hans",
          result.translation,
          result.detectedLanguage
        );
      }
      log("info", "translate ok: " + String(bodyObj.text || "").slice(0, 60).replace(/\s+/g, " "));
      sendJson(res, 200, {
        ok: true,
        translation: result.translation,
        detectedLanguage: result.detectedLanguage,
      });
    } catch (e) {
      log("warn", "translate failed: " + (e && e.message ? e.message : String(e)));
      sendJson(res, e && e.status ? e.status : 502, { ok: false, error: (e && e.message) || "unknown_error" });
    }
    return;
  }

  if (p === "/api/v1/test" && (req.method === "POST" || req.method === "GET")) {
    const cfg = configStore.load();
    const tBody = bodyFromRequest(url, bodyObj);
    try {
      const result = await runTranslate(cfg, {
        text: (tBody && tBody.text) || "hello",
        targetLanguage: (tBody && tBody.targetLanguage) || "zh-Hans",
        sourceLanguage: (tBody && tBody.sourceLanguage) || "auto",
      });
      log("info", "test ok");
      sendJson(res, 200, { ok: true, translation: result.translation, message: "连接成功" });
    } catch (e) {
      log("warn", "test failed: " + (e && e.message ? e.message : String(e)));
      sendJson(res, 200, { ok: false, error: (e && e.message) || "unknown_error" });
    }
    return;
  }

  if (p === "/api/v1/config") {
    if (req.method === "GET") {
      // GET + d 参数:游戏侧 AsyncWebRequest 保存配置(读配置保持无 d)
      const d = url.searchParams.get("d");
      if (d) {
        let saveBody = null;
        try { saveBody = JSON.parse(d); } catch (e) {}
        if (saveBody && saveBody.config) {
          const current = configStore.load();
          const next = configStore.applyMaskedUpdate(current, saveBody.config || {});
          configStore.save(next);
          activeConfig = next;
          log("info", "config saved (GET)");
          sendJson(res, 200, { ok: true, config: configStore.mask(next) });
          return;
        }
      }
      sendJson(res, 200, { ok: true, config: configStore.mask(configStore.load()) });
      return;
    }
    if (req.method === "POST") {
      if (!bodyObj) return sendJson(res, 400, { ok: false, error: "bad_json" });
      const current = configStore.load();
      const next = configStore.applyMaskedUpdate(current, bodyObj.config || {});
      configStore.save(next);
      activeConfig = next;
      log("info", "config saved");
      sendJson(res, 200, { ok: true, config: configStore.mask(next) });
      return;
    }
  }

  sendJson(res, 404, { ok: false, error: "not_found" });
}

// ---------- 服务器 ----------
const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url, "http://127.0.0.1");
  } catch (e) {
    res.statusCode = 400;
    res.end("bad request");
    return;
  }

  if (url.pathname === "/bridge") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(bridgePage(url.searchParams));
    return;
  }

  if (url.pathname.indexOf("/api/v1/") === 0) {
    readBody(req, (err, raw) => {
      if (err) return sendJson(res, 413, { ok: false, error: "body_too_large" });
      const bodyObj = req.method === "POST" ? parseJson(raw) : null;
      handleApi(req, res, url, bodyObj).catch((e) => {
        log("error", "api crash: " + (e && e.stack ? e.stack : String(e)));
        sendJson(res, 500, { ok: false, error: "internal_error" });
      });
    });
    return;
  }

  res.statusCode = 404;
  res.end("not found");
});

const cfg = configStore.load();
activeConfig = cfg;
const PORT = Number(cfg.port) || 8791;
const HOST = "127.0.0.1";

startGameWatch();
steamIdEnrich.startSteamIdEnrichment(cfg, log);

// 端口被占用 = 已有实例在运行,静默退出(与启动器/开机自启场景兼容)
server.on("error", (e) => {
  if (e && e.code === "EADDRINUSE") {
    process.exit(0);
  }
  log("error", "server error: " + ((e && e.message) || String(e)));
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  log("info", "Babel Tower bridge listening on http://" + HOST + ":" + PORT);
  const activeProviderCfg = (cfg[cfg.provider] || {});
  const keySet = cfg.provider === "bing" ? true : !!(activeProviderCfg && activeProviderCfg.apiKey);
  log("info", "provider: " + cfg.provider + ", target: " + cfg.defaults.targetLanguage + " (key set: " + keySet + ")");
});
