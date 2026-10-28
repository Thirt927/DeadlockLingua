// Babel Tower - hero data sync (game localization + deadlock-api)
// ---------------------------------------------------------------------------
// 用途:游戏更新后(新英雄上线 / 译名调整),一键刷新三处英雄数据:
//   1. core/glossary.js        -> heroNames(仅玩家可选英雄) / heroCnToEn(官方中文名+社区昵称)
//   2. core/hero_names.js      -> HERO_ZH(英文名 -> 官方中文名,供缩写词典)
//   3. mod/panorama/scripts/lingua_chat.js -> ZH_HERO_TO_EN / HERO_ID_TO_NAME(游戏内日志用)
//
// 数据源(AGENTS.md §4.5):
//   - 本地:Deadlock 安装目录 resource/localization/citadel_gc_hero_names/*.txt(官方译名+官方搜索别名)
//   - 在线:https://api.deadlock-api.com/v1/assets/heroes?language=english(player_selectable 列表)
//
// 用法:
//   node scripts/sync_heroes.js                      # 只打印将发生的变化(不写盘)
//   node scripts/sync_heroes.js --write              # 写盘
//   node scripts/sync_heroes.js --game-root "E:\Steam\steamapps\common\Deadlock" --write
//   node scripts/sync_heroes.js --selectable-json <file>   # 离线:用缓存的 API 响应
// ---------------------------------------------------------------------------
"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");

const ROOT = path.resolve(__dirname, "..");
const WRITE = process.argv.includes("--write");

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : "";
}

// 社区昵称白名单:只收「指向明确、几乎不会当普通词用」的别名;
// 官方 _search 列表里还有 球/奶奶/猪/钩子 这类泛词,收进来会让模型把普通词翻成英雄名。
const EXTRA_CN_ALIASES = {
  "老七": "Seven",
  "女巫": "Vindicta",
  "女鬼": "Vindicta",
  "刀姐": "Yamato",
  "火男": "Infernus",
  "电男": "Seven",
  "滚滚": "Viscous",
  "史莱姆": "Viscous",
  "绿泡泡": "Viscous",
  "猫女": "Calico",
  "帕吉": "Bebop",
  "斧王": "Shiv",
  "蛇女": "Vyper",
  "骷髅王": "Victor",
  "哈基米": "Mina",
  "书虫": "Paige",
  "门童": "The Doorman",
  "悠米": "Rem",
  "独角兽": "Celeste",
  "剑客": "Apollo",
  "鼠鼠": "Rat King",
  "老鼠": "Rat King",
  "象棋": "Solomon",
  "神父": "Venator",
  "冰男": "Kelvin",
  "牌女": "Wraith",
  "提箱客": "Pocket",
  "灯神": "Mirage",
  "石像鬼": "Ivy",
  "血妈": "Lady Geist",
  "盖斯特": "Lady Geist",
  "一枪超人": "Paradox",
  "牛仔": "Holliday",
  "辛克莱": "Sinclair",
  "格瑞姆": "Graves",
  "牛": "Abrams"
};

function findGameRoot() {
  const explicit = argValue("--game-root");
  const candidates = [
    explicit,
    "E:/Steam/steamapps/common/Deadlock",
    "F:/Steam/steamapps/common/Deadlock",
    "C:/Program Files (x86)/Steam/steamapps/common/Deadlock",
    "D:/Steam/steamapps/common/Deadlock"
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "game", "citadel", "resource", "localization"))) return c;
  }
  return "";
}

function parseHeroNames(file) {
  const txt = fs.readFileSync(file, "utf8");
  const map = new Map(); // hero_viscous -> value
  const re = /"hero_([a-z0-9_]+):n"\s+"([^"]+)"/gi;
  let m;
  while ((m = re.exec(txt)) !== null) map.set(m[1].toLowerCase(), m[2]);
  return map;
}

function fetchJson(url) {
  return new Promise(function (resolve, reject) {
    https
      .get(url, { headers: { "User-Agent": "BabelTower-sync/1.0" } }, function (res) {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error("HTTP " + res.statusCode + " for " + url));
        }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", function (chunk) { body += chunk; });
        res.on("end", function () {
          try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
        });
      })
      .on("error", reject);
  });
}

async function loadSelectable() {
  const cached = argValue("--selectable-json");
  if (cached) {
    const j = JSON.parse(fs.readFileSync(cached, "utf8"));
    return Array.isArray(j) ? j : (j.heroes || j.data || []);
  }
  const url = "https://api.deadlock-api.com/v1/assets/heroes?language=english";
  const j = await fetchJson(url);
  return Array.isArray(j) ? j : (j.heroes || j.data || []);
}

function esc(str) {
  return String(str).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// 把 "a": "b" 形式的条目按宽度折行(生成的表可读性优先于紧凑)
function wrapEntries(entries, indent, width) {
  const out = [];
  let line = indent;
  for (let i = 0; i < entries.length; i += 1) {
    const piece = entries[i] + (i === entries.length - 1 ? "" : ",");
    if (line.length > indent.length && line.length + 1 + piece.length > width) {
      out.push(line);
      line = indent + piece;
    } else {
      line += (line.length > indent.length ? " " : "") + piece;
    }
  }
  if (line.length > indent.length) out.push(line);
  return out.join("\n");
}

async function main() {
  const gameRoot = findGameRoot();
  if (!gameRoot) {
    console.error("找不到 Deadlock 安装目录(可用 --game-root 指定)");
    process.exit(1);
  }
  const locDir = path.join(gameRoot, "game", "citadel", "resource", "localization", "citadel_gc_hero_names");
  const enFile = path.join(locDir, "citadel_gc_hero_names_english.txt");
  const zhFile = path.join(locDir, "citadel_gc_hero_names_schinese.txt");
  if (!fs.existsSync(enFile) || !fs.existsSync(zhFile)) {
    console.error("缺少本地化文件: " + locDir);
    process.exit(1);
  }
  const en = parseHeroNames(enFile);
  const zh = parseHeroNames(zhFile);

  const apiHeroes = await loadSelectable();
  const selectable = apiHeroes
    .filter(function (h) { return h && (h.player_selectable === true || h.player_selectable === 1); })
    .map(function (h) { return { id: h.id, name: String(h.name || "").trim() }; })
    .filter(function (h) { return h.name; });

  // API 英文名 -> 本地化 hero id(用英文名匹配本地化文件;麦金妮等大小写差异做归一化)
  const norm = function (s) { return String(s).toLowerCase().replace(/[^a-z0-9]/g, ""); };
  const enToId = new Map();
  for (const [id, name] of en) {
    const key = norm(name);
    if (!enToId.has(key)) enToId.set(key, id);
  }

  const heroNames = [];
  const cnToEn = {};   // 官方中文名 + 白名单昵称 -> 英文名
  const enToCn = {};   // 英文名 -> 官方中文名(hero_names.js / zoo)
  const missing = [];
  for (const h of selectable.slice().sort(function (a, b) { return a.name.localeCompare(b.name); })) {
    const id = enToId.get(norm(h.name));
    if (!id) { missing.push(h.name); continue; }
    const zhName = zh.get(id) || "";
    heroNames.push(h.name);
    if (zhName && /[\u4e00-\u9fff]/.test(zhName)) {
      cnToEn[zhName] = h.name;
      enToCn[h.name] = zhName;
    }
  }
  for (const [alias, target] of Object.entries(EXTRA_CN_ALIASES)) {
    if (!enToCn[target]) continue; // 目标英雄当前不可选则跳过
    if (!cnToEn[alias]) cnToEn[alias] = target;
  }
  if (missing.length) console.warn("警告:本地化文件里找不到这些可选英雄(跳过): " + missing.join(", "));

  // 完整 hero id 表(含未上线,供游戏内日志/缩写词典)
  const idToName = {};
  const allZhRows = [];
  for (const h of apiHeroes) {
    const id = enToId.get(norm(h.name));
    if (!id) continue;
    const zhName = zh.get(id) || "";
    idToName[String(h.id)] = h.name;
    if (zhName && /[\u4e00-\u9fff]/.test(zhName) && !/test|genericperson|targetdummy/i.test(id)) {
      allZhRows.push([zhName, h.name]);
    }
  }

  // ---- HERO_IMAGE_TO_NAME merge(保留已有 legacy 映射,只补缺失的新英雄) ----
  const imgPath = path.join(ROOT, "mod", "panorama", "scripts", "lingua_chat.js");
  const imgSrcRaw = fs.readFileSync(imgPath, "utf8");
  const imgMatch = imgSrcRaw.match(/const HERO_IMAGE_TO_NAME = \{[\s\S]*?\n  \};/);
  if (!imgMatch) { console.error("HERO_IMAGE_TO_NAME block not found"); process.exit(1); }
  const imgPairs = {};
  {
    const re = /"([^"]+)":\s*"([^"]+)"/g;
    let m;
    while ((m = re.exec(imgMatch[0])) !== null) imgPairs[m[1]] = m[2];
  }
  const addedImg = [];
  for (const h of apiHeroes) {
    const id = enToId.get(norm(h.name));
    if (!id) continue;
    if (/^hero_/.test(id) || !/^[a-z0-9_]+$/.test(id)) continue;
    if (imgPairs[id]) continue;
    imgPairs[id] = h.name.toLowerCase();
    addedImg.push(id + " -> " + imgPairs[id]);
  }
  const imgEntries = Object.keys(imgPairs).map(function (k) { return '"' + esc(k) + '": "' + esc(imgPairs[k]) + '"'; });
  const imgMapText = "  const HERO_IMAGE_TO_NAME = {\n" + wrapEntries(imgEntries, "    ", 150) + "\n  };";
  console.log("图片 stem 新增:", addedImg.length ? addedImg.join(", ") : "(无)");

  // ---- render blocks ----
  const hnEntries = heroNames.map(function (nm) { return '"' + esc(nm) + '"'; });
  const glossaryHeroNames = "  heroNames: [\n" + wrapEntries(hnEntries, "    ", 150) + "\n  ],";
  const cnEntries = Object.keys(cnToEn).map(function (cn) { return '"' + esc(cn) + '": "' + esc(cnToEn[cn]) + '"'; });
  const glossaryCnToEn = "  heroCnToEn: {\n" + wrapEntries(cnEntries, "    ", 150) + "\n  },";

  const heroZhEntries = allZhRows
    .sort(function (a, b) { return a[1].localeCompare(b[1]); })
    .map(function (row) { return '"' + esc(row[1]) + '": "' + esc(row[0]) + '"'; });
  const heroNamesJs = "const HERO_ZH = {\n" + wrapEntries(heroZhEntries, "  ", 150) + "\n};";

  const modZhEntries = Object.keys(cnToEn)
    .map(function (cn) { return '"' + esc(cn) + '": "' + esc(cnToEn[cn].toLowerCase()) + '"'; });
  const modZhMap = "  const ZH_HERO_TO_EN = {\n" + wrapEntries(modZhEntries, "    ", 150) + "\n  };";
  const modIdEntries = Object.keys(idToName)
    .sort(function (a, b) { return Number(a) - Number(b); })
    .map(function (k) { return '"' + k + '": "' + esc(idToName[k].toLowerCase()) + '"'; });
  const modIdMap = "  const HERO_ID_TO_NAME = {\n" + wrapEntries(modIdEntries, "    ", 150) + "\n  };";

  console.log("可选英雄:", heroNames.length, "| 中文映射:", cnEntries.length, "| id 表:", modIdEntries.length);

  const files = [
    {
      path: path.join(ROOT, "core", "glossary.js"),
      patches: [
        { re: /^ {2}heroNames: \[[\s\S]*?\n {2}\],$/m, text: glossaryHeroNames },
        { re: /^ {2}heroCnToEn: \{[\s\S]*?\n {2}\},$/m, text: glossaryCnToEn }
      ]
    },
    {
      path: path.join(ROOT, "core", "hero_names.js"),
      patches: [
        { re: /^const HERO_ZH = \{[\s\S]*?\n\};$/m, text: heroNamesJs }
      ]
    },
    {
      path: path.join(ROOT, "mod", "panorama", "scripts", "lingua_chat.js"),
      patches: [
        { re: /^ {2}const HERO_IMAGE_TO_NAME = \{[\s\S]*?\n {2}\};$/m, text: imgMapText },
        { re: /^ {2}const ZH_HERO_TO_EN = \{[\s\S]*?\n {2}\};$/m, text: modZhMap },
        { re: /^ {2}const HERO_ID_TO_NAME = \{[\s\S]*?\n {2}\};$/m, text: modIdMap }
      ]
    }
  ];

  for (const f of files) {
    let src = fs.readFileSync(f.path, "utf8");
    const hadBom = src.charCodeAt(0) === 0xfeff;
    if (hadBom) src = src.slice(1);
    const crlf = src.indexOf("\r\n") !== -1;
    for (const p of f.patches) {
      if (!p.re.test(src)) {
        console.error("锚点未命中: " + f.path + " -> " + p.re);
        process.exit(1);
      }
      src = src.replace(p.re, p.text);
    }
    if (WRITE) {
      // 保持文件原有行尾(三份源文件都是 CRLF,混入 LF 会造成 diff 噪音)
      let out = src.replace(/\r\n/g, "\n");
      if (crlf) out = out.replace(/\n/g, "\r\n");
      fs.writeFileSync(f.path, (hadBom ? "\ufeff" : "") + out, "utf8");
      console.log((hadBom ? "[BOM] " : "      ") + "已写入 " + path.relative(ROOT, f.path));
    } else {
      console.log("(dry-run) 将更新 " + path.relative(ROOT, f.path));
    }
  }
}

main().catch(function (e) {
  console.error("同步失败:", e && e.message ? e.message : e);
  process.exit(1);
});
