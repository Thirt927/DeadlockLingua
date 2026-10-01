// Babel Tower - SteamID 采集定向测试
// 验证修复:
//   1. ESC 玩家列表被动采集(captureEscapeRosterAccounts)在只读(不派发任何事件)前提下,
//      把行内 LCTRowAccount({i:r:account_id}) 映射进 accountByName/accountByHero。
//   2. 槽位号等误绑定值被 looksLikeSteamAccount 拒绝,不伪造 steamid。
//   3. 采集结果能端到端回填聊天日志(rowdiag 里 steamid 有值)。
// 用法: node scripts/test_steamid_roster.js
"use strict";

const path = require("path");
const nativeSetTimeout = setTimeout;
const nativeClearTimeout = clearTimeout;
const SCRIPT = path.join(__dirname, "..", "mod", "panorama", "scripts", "lingua_chat.js");

// ---------------- Mock 面板(与 lingua_chat_simtest.js 同款) ----------------
let uid = 0;
class MockPanel {
  constructor(id, parent) {
    this._id = id || ("p" + (++uid));
    this._parent = parent || null;
    this._children = [];
    this._classes = new Set();
    this._deleted = false;
    this.text = "";
    this.title = "";
    this.style = { visibility: "visible" };
    this._attrs = {};
  }
  IsValid() { return !this._deleted; }
  GetParent() { return this._parent; }
  GetChildCount() { return this._children.length; }
  GetChild(i) { return this._children[i] || null; }
  BHasClass(c) { return this._classes.has(c); }
  AddClass(c) { this._classes.add(c); }
  RemoveClass(c) { this._classes.delete(c); }
  GetAttributeString(k, def) { return this._attrs[k] !== undefined ? this._attrs[k] : def; }
  SetAttributeString(k, v) { this._attrs[k] = v; }
  SetParent(newParent) {
    if (!newParent) return;
    if (this._parent) {
      const i = this._parent._children.indexOf(this);
      if (i >= 0) this._parent._children.splice(i, 1);
    }
    this._parent = newParent;
    newParent._children.push(this);
  }
  FindChildTraverse(id) {
    if (this._id === id) return this;
    for (const c of this._children) {
      const r = c.FindChildTraverse(id);
      if (r) return r;
    }
    return null;
  }
  FindChildrenWithClassTraverse(cls) {
    const out = [];
    if (this._classes.has(cls)) out.push(this);
    for (const c of this._children) out.push(...c.FindChildrenWithClassTraverse(cls));
    return out;
  }
  addChild(panel) { panel._parent = this; this._children.push(panel); return panel; }
  setClass(...cs) { cs.forEach((c) => this._classes.add(c)); return this; }
}

// ---------------- 环境 ----------------
const PENDING_SCHEDULES = [];
function clearSchedules() {
  for (const t of PENDING_SCHEDULES) { try { nativeClearTimeout(t); } catch (e) {} }
  PENDING_SCHEDULES.length = 0;
}

const LOGS = [];
function logsContain(re) {
  return LOGS.some((l) => re.test(l));
}

let passCount = 0;
let failCount = 0;
function assert(name, cond, extra) {
  if (cond) { passCount++; console.log("  PASS " + name); }
  else { failCount++; console.log("  FAIL " + name + (extra ? "  [" + extra + "]" : "")); }
}

function sleep(ms) { return new Promise((r) => nativeSetTimeout(r, ms)); }
async function waitFor(cond, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return true;
    await sleep(100);
  }
  return cond();
}

// 构建场景:contextPanel(带 ShowEscapeMenu class) + ESC 菜单(4 个玩家行) + 聊天容器
function freshEnv() {
  clearSchedules();
  delete require.cache[require.resolve(SCRIPT)];

  const contextPanel = new MockPanel("ContextPanel").setClass("ShowEscapeMenu");
  // 标准聊天/桥面板树(模块 boot 需要)
  const chatPanel = contextPanel.addChild(new MockPanel("Chat"));
  const messagesPanel = chatPanel.addChild(new MockPanel("ChatMessages"));
  const bridgePanel = contextPanel.addChild(new MockPanel("LCTBridgePanel"));
  bridgePanel.SetURL = function () { bridgePanel.title = "LCTok"; };

  // ESC 菜单:类型 CitadelHudEscapeMenu(与游戏一致),挂在 contextPanel 下
  const escapeRoot = contextPanel.addChild(new MockPanel("EscapeMenu"));
  escapeRoot.paneltype = "CitadelHudEscapeMenu";

  // 玩家行(模拟 players_list_entry.xml 覆盖版:LCTPlayerRow 根 class +
  // 隐藏 LCTRowAccount/{i:r:account_id} + LCTRowHero/{g:citadel_hero_name:hero_id} + PlayerName)
  function addRosterRow(name, hero, account) {
    const row = new MockPanel(null).setClass("LCTPlayerRow");
    const mc = row.addChild(new MockPanel("MainContents"));
    mc.addChild(new MockPanel(null).setClass("PlayerName")).text = name;
    if (hero) mc.addChild(new MockPanel("LCTRowHero")).text = hero;
    if (account) mc.addChild(new MockPanel("LCTRowAccount")).text = account;
    escapeRoot.addChild(row);
    return row;
  }
  addRosterRow("Alice", "Infernus", "1284923611"); // 10 位账号ID -> steam64
  addRosterRow("Bob", "Seven", "994123456");       // 9 位账号ID
  addRosterRow("Carol", "", "123456789");          // 英雄缺失,应凭昵称采集
  addRosterRow("Dave", "Vindicta", "7");           // 槽位号,必须被拒绝,不伪造

  function addChatRow(sender, text) {
    const row = new MockPanel(null).setClass("ChatMessage");
    const body = row.addChild(new MockPanel(null).setClass("MessageBody"));
    const source = body.addChild(new MockPanel("MessageSource"));
    source.addChild(new MockPanel(null).setClass("ChannelName")).text = "chat";
    source.addChild(new MockPanel(null).setClass("SenderName")).text = sender;
    const contents = body.addChild(new MockPanel("MessageContents"));
    contents.setClass("Text");
    contents.addChild(new MockPanel(null)).text = text;
    messagesPanel.addChild(row);
    return row;
  }

  contextPanel.SetAttributeString("lct_ui", JSON.stringify({
    enabled: true, displayMode: "bilingual", targetLanguage: "zh-Hans",
    force: false, outgoing: "off", provider: "bing", timeoutMs: 5000, translateOwn: false, chatLog: true,
  }));

  globalThis.$ = {
    Msg: (...a) => { LOGS.push(a.join(" ")); console.log("[LCT-roster]", ...a); },
    Schedule: (sec, fn) => { const t = nativeSetTimeout(fn, sec * 1000); PENDING_SCHEDULES.push(t); return t; },
    CreatePanel: (type, parent, id) => parent.addChild(new MockPanel(id)).setClass(type === "Label" ? "Label" : type),
    RegisterForUnhandledEvent: () => {},
    DispatchEvent: () => {},
    GetContextPanel: () => contextPanel,
    AsyncWebRequest: () => { throw new Error("AsyncWebRequest has been removed."); },
  };
  globalThis.Convars = { GetStr: () => "", RegisterConVar: () => {}, SetValue: () => {} };

  require(SCRIPT);

  return { contextPanel, escapeRoot, bridgePanel, messagesPanel, addChatRow };
}

// ---------------- 测试 ----------------
async function run() {
  const env = freshEnv();

  // 1) ESC 打开后,被动采集应映射 3 个玩家(Dave 槽位号被拒)。gainedHero 统计的是
  //    nameByHero/heroByName/accountByHero 三类映射的新增槽位:Alice=3、Bob=3、Dave=2。
  const rosterOk = await waitFor(() => logsContain(/steamid roster rows=\d+ gainedHero=8 gainedName=3/), 15000);
  assert("ESC roster capture maps 3 players (gainedHero=8 gainedName=3)", rosterOk,
    LOGS.filter((l) => l.indexOf("steamid roster rows=") >= 0).join(" || "));

  // 2) 加一条 Alice 的聊天行,rowdiag 里 steamid 应回填为 7656119...(32位换算 64 位)
  env.addChatRow("Alice", "hello from alice");
  const chatOk = await waitFor(() => logsContain(/rowdiag sender=Alice.*steamid=7656119\d{9}/), 15000);
  assert("chat log steamid backfilled via roster capture (Alice -> 7656119...)", chatOk,
    LOGS.filter((l) => l.indexOf("rowdiag sender=Alice") >= 0).join(" || "));

  // 3) 若 Dave 的 "7" 被错误接受,会伪造 steamid;验证没有被伪造(无 dave 映射进日志)
  const daveOk = !LOGS.some((l) => /rowdiag sender=Dave.*steamid=7656119/.test(l));
  assert("slot-like value rejected (Dave steamid=7 not fabricated)", daveOk, "");

  console.log("=== RESULT: PASS " + passCount + " / FAIL " + failCount + " ===");
  return failCount === 0 ? 0 : 1;
}

run().then((code) => process.exit(code)).catch((e) => { console.error(e); process.exit(1); });
