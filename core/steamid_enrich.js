// Babel Tower - SteamID 回填模块
//
// 当前 Deadlock 版本的 Panorama 不再暴露 Game/Players 命名空间,
// 其他玩家的 SteamID 无法从聊天行/顶栏/ESC 玩家列表稳定采集。
// 本模块利用公开 Deadlock 数据 API:
//   /v1/players/steam-search  按昵称搜索 Steam 档案
//   /v1/players/{account_id}/match-history  用本局 matchId + heroId 验证歧义候选
//   /v1/matches/metadata?match_ids=...&include_player_info=true  拉取整局玩家 roster
//   /v1/players/steam?account_ids=...  批量获取玩家昵称
// 把昵称解析成 SteamID64, 并原子回写 logs/chat/<matchId>.jsonl。
//
// 安全原则:
//   - 只请求公开接口, 不上传 apiKey / 聊天内容
//   - 只在启用 steamIdEnrichment.enabled 时运行
//   - 不修改 active match 文件 (避免与 appendChatLog 并发写)
"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");

const STEAMID64_BASE = BigInt("76561197960265728");
const IDENTITY_CACHE_FILENAME = "identity_cache.json";

function normName(name) {
  return String(name || "").replace(/^\[[^\]]+\]\s*/, "").trim().toLowerCase();
}

function accountIdToSteamId64(accountId) {
  try {
    const n = BigInt(String(accountId || "").replace(/\D/g, ""));
    if (n <= 0n) return "";
    return (STEAMID64_BASE + n).toString();
  } catch (e) {
    return "";
  }
}

function requestJson(url, timeoutMs, redirects) {
  return new Promise((resolve, reject) => {
    let target;
    try { target = new URL(url); } catch (e) { reject(e); return; }
    const lib = target.protocol === "http:" ? http : https;
    const req = lib.get(target, { headers: { "User-Agent": "BabelTowerBridge/0.2", "Accept": "application/json" } }, (res) => {
      const status = res.statusCode || 0;
      const location = res.headers.location;
      if ((status === 301 || status === 302 || status === 307 || status === 308) && location) {
        res.resume();
        if ((redirects || 0) >= 3) { reject(new Error("too_many_redirects")); return; }
        requestJson(new URL(location, target).toString(), timeoutMs, (redirects || 0) + 1).then(resolve, reject);
        return;
      }
      const chunks = [];
      let size = 0;
      res.on("data", (chunk) => {
        size += chunk.length;
        if (size > 5 * 1024 * 1024) { req.destroy(new Error("response_too_large")); return; }
        chunks.push(chunk);
      });
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (status < 200 || status >= 300) { reject(new Error("HTTP " + status)); return; }
        try { resolve(JSON.parse(text)); } catch (e) { reject(new Error("bad_json")); }
      });
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs || 15000, () => req.destroy(new Error("request_timeout")));
  });
}

function loadIdentityCache(dir) {
  const p = path.join(dir, IDENTITY_CACHE_FILENAME);
  try { return JSON.parse(fs.readFileSync(p, "utf8")) || {}; } catch (e) { return {}; }
}

function saveIdentityCache(dir, cache) {
  try {
    fs.writeFileSync(path.join(dir, IDENTITY_CACHE_FILENAME), JSON.stringify(cache, null, 2), "utf8");
  } catch (e) {}
}

async function searchSteamProfiles(opts, name) {
  const base = String(opts.baseUrl || "https://api.deadlock-api.com").replace(/\/+$/, "");
  const limit = Math.max(1, Math.min(100, Number(opts.searchLimit) || 20));
  const minMatches = Math.max(0, Number(opts.minMatchesPlayedLast30d) || 0);
  const url = base + "/v1/players/steam-search?search_query=" + encodeURIComponent(name) +
    "&limit=" + limit + "&min_matches_played_last_30d=" + minMatches;
  return requestJson(url, opts.requestTimeoutMs, 0);
}

async function fetchMatchHistory(opts, accountId) {
  const base = String(opts.baseUrl || "https://api.deadlock-api.com").replace(/\/+$/, "");
  const url = base + "/v1/players/" + encodeURIComponent(String(accountId)) + "/match-history";
  return requestJson(url, opts.requestTimeoutMs, 0);
}

function accountCacheKey(accountId) {
  const id = String(accountId || "").replace(/\D/g, "");
  return id ? "account:" + id : "";
}

function mergeIdentity(cache, key, entry) {
  if (!key) return false;
  const now = Date.now();
  const cur = cache[key];
  if (!cur) {
    const next = Object.assign({}, entry);
    if (next.matchId) {
      next.lastMatchId = String(next.matchId);
      next.matchCount = 1;
      delete next.matchId;
    }
    cache[key] = Object.assign({ t: now }, next);
    return true;
  }
  if (entry.steamid && cur.steamid && cur.steamid !== entry.steamid) return false;
  if (entry.accountId && cur.accountId && String(cur.accountId) !== String(entry.accountId)) return false;
  let changed = false;
  if (entry.accountId && !cur.accountId) { cur.accountId = String(entry.accountId); changed = true; }
  if (entry.steamid && !cur.steamid) { cur.steamid = entry.steamid; changed = true; }
  if (entry.name && (!cur.name || cur.name === key)) { cur.name = entry.name; changed = true; }
  if (entry.heroId && (!cur.heroId || cur.heroId === String(entry.heroId))) { cur.heroId = String(entry.heroId); changed = true; }
  if (entry.hero && (!cur.hero || cur.hero === String(entry.heroId || ""))) { cur.hero = entry.hero; changed = true; }
  if (entry.matchId) {
    if (cur.lastMatchId !== String(entry.matchId)) {
      cur.matchCount = (Number(cur.matchCount) || 0) + 1;
      cur.lastMatchId = String(entry.matchId);
      changed = true;
    }
    delete cur.matchId;
  }
  cur.t = now;
  return changed;
}

function mergeAccountIdentity(cache, accountId, entry) {
  return mergeIdentity(cache, accountCacheKey(accountId), Object.assign({ accountId: String(accountId || "").replace(/\D/g, "") }, entry));
}

function mergeNameIdentity(cache, name, entry) {
  const key = normName(name);
  if (!key || key === "<unknown>") return false;
  const cur = cache[key];
  if (cur && cur.steamid && entry.steamid && cur.steamid !== entry.steamid) return false;
  return mergeIdentity(cache, key, entry);
}

async function fetchMatchRoster(opts, matchId) {
  const base = String(opts.baseUrl || "https://api.deadlock-api.com").replace(/\/+$/, "");
  const url = base + "/v1/matches/metadata?match_ids=" + encodeURIComponent(String(matchId)) + "&include_player_info=true";
  const payload = await requestJson(url, Number(opts.rosterRequestTimeoutMs) || 30000, 0);
  const match = Array.isArray(payload) ? payload[0] : payload;
  const players = match && Array.isArray(match.players) ? match.players : [];
  return players.filter((p) => p && p.account_id);
}

async function fetchSteamProfilesByIds(opts, accountIds) {
  const ids = Array.from(new Set(accountIds.map((id) => String(id || "").replace(/\D/g, "")).filter(Boolean)));
  if (!ids.length) return [];
  const base = String(opts.baseUrl || "https://api.deadlock-api.com").replace(/\/+$/, "");
  const url = base + "/v1/players/steam?account_ids=" + encodeURIComponent(ids.join(","));
  return requestJson(url, Number(opts.steamProfileRequestTimeoutMs) || 30000, 0);
}

async function enrichRoster(opts, cache, matchId, log) {
  if (!opts.rosterEnabled) return { status: "disabled" };
  let players;
  try {
    players = await fetchMatchRoster(opts, matchId);
  } catch (e) {
    return { status: "roster_error", error: e && e.message ? e.message : String(e) };
  }
  if (!players.length) return { status: "roster_unavailable" };

  const profiles = new Map();
  const need = [];
  for (const p of players) {
    const id = String(p.account_id || "").replace(/\D/g, "");
    if (!id) continue;
    const cur = cache[accountCacheKey(id)];
    if (cur && cur.name) {
      profiles.set(id, { personaname: cur.name });
    } else {
      need.push(id);
    }
  }

  if (need.length) {
    try {
      const rows = await fetchSteamProfilesByIds(opts, need);
      for (const row of Array.isArray(rows) ? rows : []) {
        const id = String(row.account_id || "").replace(/\D/g, "");
        if (id) profiles.set(id, row);
      }
    } catch (e) {}
  }

  let added = 0;
  let updated = 0;
  let named = 0;
  for (const p of players) {
    const id = String(p.account_id || "").replace(/\D/g, "");
    const sid = accountIdToSteamId64(id);
    if (!id || !sid) continue;
    const row = profiles.get(id) || {};
    const entry = {
      accountId: id,
      steamid: sid,
      name: row.personaname || "",
      heroId: String(p.hero_id || ""),
      hero: "",
      matchId: String(matchId),
    };
    const nameEntry = entry.name ? cache[normName(entry.name)] : null;
    if (nameEntry && nameEntry.hero) entry.hero = nameEntry.hero;
    const existed = !!cache[accountCacheKey(id)];
    if (mergeAccountIdentity(cache, id, entry)) {
      if (existed) updated += 1;
      else added += 1;
    }
    if (entry.name && mergeNameIdentity(cache, entry.name, entry)) named += 1;
  }
  return { status: "roster_ok", players: players.length, added: added, updated: updated, named: named };
}

function exactProfileCandidates(profiles, name) {
  const key = normName(name);
  if (!key || key === "<unknown>") return [];
  const out = [];
  for (const p of Array.isArray(profiles) ? profiles : []) {
    if (!p || normName(p.personaname) !== key) continue;
    out.push(p);
  }
  return out;
}

async function resolveAccountId(opts, name, heroId, matchId) {
  let profiles;
  try {
    profiles = await searchSteamProfiles(opts, name);
  } catch (e) {
    return { status: "search_error", error: e && e.message ? e.message : String(e), candidates: [] };
  }
  const exact = exactProfileCandidates(profiles, name);
  if (!exact.length) return { status: "not_found", candidates: [] };
  if (exact.length === 1) return { status: "found", accountId: exact[0].account_id, candidates: exact };
  if (!opts.ambiguousMatchCheck || !heroId || !matchId) {
    return { status: "ambiguous", candidates: exact };
  }
  const checks = exact.slice(0, Math.max(1, Number(opts.maxAmbiguousChecks) || 3));
  for (const p of checks) {
    try {
      const history = await fetchMatchHistory(opts, p.account_id);
      const matchNum = Number(matchId);
      const heroNum = Number(heroId);
      const hit = Array.isArray(history) && history.some((m) => Number(m && m.match_id) === matchNum && Number(m && m.hero_id) === heroNum);
      if (hit) return { status: "found", accountId: p.account_id, candidates: exact, validated: true };
    } catch (e) {}
  }
  return { status: "ambiguous", candidates: exact };
}

function collectUnknowns(records) {
  const map = {};
  const order = [];
  function add(name, hero, heroId) {
    const key = normName(name);
    if (!key || key === "<unknown>") return;
    if (!map[key]) { map[key] = { name: String(name || "").trim(), hero: "", heroId: "" }; order.push(map[key]); }
    if (!map[key].hero && hero) map[key].hero = String(hero);
    if (!map[key].heroId && heroId) map[key].heroId = String(heroId);
  }
  for (const r of records) {
    if (!r) continue;
    if (r.type === "player") {
      add(r.name, r.hero, r.heroId);
    } else if (r.type === "msg" && !r.steamid) {
      add(r.sender, r.hero, r.heroId);
    }
  }
  return order;
}

function writeFileAtomic(file, lines) {
  const tmp = file + ".steamid.tmp";
  fs.writeFileSync(tmp, lines.join("\n") + "\n", "utf8");
  fs.renameSync(tmp, file);
}

async function enrichFile(file, opts, cache, log) {
  const matchId = path.basename(file, ".jsonl");
  if (!/^[0-9]{4,}$/.test(matchId)) return { file: path.basename(file), status: "skipped_match_id" };
  let st;
  try { st = fs.statSync(file); } catch (e) { return { file: path.basename(file), status: "stat_error" }; }
  const ageMs = Date.now() - st.mtimeMs;
  if (ageMs < Number(opts.minFileAgeMs)) return { file: path.basename(file), status: "active" };
  const rosterMinAgeMs = Number(opts.rosterMinFileAgeMs) || Number(opts.minFileAgeMs) || 180000;
  let roster;
  if (ageMs < rosterMinAgeMs) {
    roster = { status: "waiting_roster_delay", delayMs: rosterMinAgeMs - ageMs };
  } else {
    roster = await enrichRoster(opts, cache, matchId, log);
  }
  let records = [];
  try {
    const raw = fs.readFileSync(file, "utf8");
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try { records.push(JSON.parse(t)); } catch (e) {}
    }
  } catch (e) {
    return { file: path.basename(file), status: "read_error", error: e.message };
  }

  const allUnknowns = collectUnknowns(records);
  const cachedResolved = {};
  const toResolve = [];
  for (const u of allUnknowns) {
    const key = normName(u.name);
    const cached = cache[key] && cache[key].steamid;
    if (cached) cachedResolved[key] = cached;
    else toResolve.push(u);
  }
  const wanted = toResolve.slice(0, Math.max(1, Number(opts.maxPlayersPerFile) || 12));
  const resolved = Object.assign({}, cachedResolved);
  let apiCalls = 0;
  for (const u of wanted) {
    const r = await resolveAccountId(opts, u.name, u.heroId, matchId);
    apiCalls += 1;
    if (r.status === "found" && r.accountId) {
      const sid = accountIdToSteamId64(r.accountId);
      if (sid) resolved[normName(u.name)] = sid;
    }
  }
  if (!Object.keys(resolved).length) return { file: path.basename(file), status: "no_results", apiCalls: apiCalls, wanted: wanted.length, roster: roster };

  let changed = false;
  for (const rec of records) {
    if (!rec) continue;
    if (rec.type === "msg") {
      const key = normName(rec.sender);
      if (!rec.steamid && resolved[key]) { rec.steamid = resolved[key]; changed = true; }
    } else if (rec.type === "player") {
      const key = normName(rec.name);
      if (!rec.steamid && resolved[key]) { rec.steamid = resolved[key]; changed = true; }
    }
  }
  if (changed) {
    const lines = records.map((r) => JSON.stringify(r));
    writeFileAtomic(file, lines);
    for (const key of Object.keys(resolved)) {
      const u = allUnknowns.find((x) => normName(x.name) === key);
      cache[key] = { name: (u && u.name) || key, steamid: resolved[key], hero: (u && u.hero) || "", t: Date.now() };
    }
  }
  return { file: path.basename(file), status: changed ? "enriched" : "no_change", enriched: Object.keys(resolved).length, apiCalls: apiCalls, roster: roster };
}

async function enrichRecentChatLogs(cfg, log) {
  const opts = (cfg && cfg.steamIdEnrichment) || {};
  if (!opts.enabled) return { status: "disabled" };
  const dir = path.resolve(__dirname, "..", String((cfg.chatLog && cfg.chatLog.dir) || "logs/chat"));
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return { status: "dir_error" }; }
  const lookback = Math.max(1, Number(opts.lookbackHours) || 72) * 3600 * 1000;
  const now = Date.now();
  const candidates = [];
  for (const name of names) {
    if (!/^[0-9]{4,}\.jsonl$/.test(name)) continue;
    const file = path.join(dir, name);
    try {
      const st = fs.statSync(file);
      if (now - st.mtimeMs <= lookback) candidates.push({ file, mtimeMs: st.mtimeMs });
    } catch (e) {}
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const limit = Math.max(1, Number(opts.maxFilesPerRun) || 10);
  const cache = loadIdentityCache(dir);
  let enriched = 0;
  let changed = 0;
  const results = [];
  for (let i = 0; i < candidates.length && i < limit; i += 1) {
    try {
      const r = await enrichFile(candidates[i].file, opts, cache, log);
      results.push(r);
      if (r.status === "enriched") changed += 1;
      if (r.status === "enriched" || r.status === "no_results") enriched += 1;
    } catch (e) {
      results.push({ file: path.basename(candidates[i].file), status: "error", error: e && e.message ? e.message : String(e) });
    }
  }
  saveIdentityCache(dir, cache);
  const rosterAdded = results.reduce((n, r) => n + ((r.roster && Number(r.roster.added)) || 0), 0);
  if (log) log("info", "steamid enrichment run: files=" + results.length + " changed=" + changed + " resolved=" + results.reduce((n, r) => n + (Number(r.enriched) || 0), 0) + " rosterAdded=" + rosterAdded);
  return { status: "ok", changed: changed, rosterAdded: rosterAdded, results: results };
}

function startSteamIdEnrichment(cfg, log) {
  const opts = (cfg && cfg.steamIdEnrichment) || {};
  if (!opts.enabled) return null;
  const delay = Math.max(5000, Number(opts.minFileAgeMs) || 180000) + 2000;
  const interval = Math.max(60000, Number(opts.intervalMs) || 600000);
  let running = false;
  async function run() {
    if (running) return;
    running = true;
    try { await enrichRecentChatLogs(cfg, log); } catch (e) {}
    running = false;
  }
  const first = setTimeout(() => { run().then(() => setInterval(run, interval)); }, delay);
  first.unref();
  return first;
}

module.exports = {
  accountIdToSteamId64: accountIdToSteamId64,
  accountCacheKey: accountCacheKey,
  enrichFile: enrichFile,
  enrichRecentChatLogs: enrichRecentChatLogs,
  enrichRoster: enrichRoster,
  fetchMatchRoster: fetchMatchRoster,
  fetchSteamProfilesByIds: fetchSteamProfilesByIds,
  mergeAccountIdentity: mergeAccountIdentity,
  mergeNameIdentity: mergeNameIdentity,
  startSteamIdEnrichment: startSteamIdEnrichment,
  searchSteamProfiles: searchSteamProfiles,
  resolveAccountId: resolveAccountId,
};
