// Babel Tower - sender backfill regression test for pushChatLog / flushPendingLogs.
// Verifies: HUD bubble rows without a sender get the sender from the matching full row
// (normalized text), duplicates are dropped, and bubble-only rows still fall back to <unknown>.
// Usage: node test_sender_backfill.js  (no bridge required)
"use strict";
const path = require("path");
const nativeSetTimeout = setTimeout;

const SCRIPT = path.join(__dirname, "..", "mod", "panorama", "scripts", "lingua_chat.js");

// ---------------- Mock panels ----------------
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
    this.__lctSig = undefined;
    this.__lctProcessed = false;
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
  DeleteAsync() {
    if (this._parent) {
      const i = this._parent._children.indexOf(this);
      if (i >= 0) this._parent._children.splice(i, 1);
    }
    this._deleted = true;
    this._parent = null;
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

// ---------------- Environment ----------------
const PENDING_SCHEDULES = [];
function clearSchedules() {
  for (const t of PENDING_SCHEDULES) { try { clearTimeout(t); } catch (e) {} }
  PENDING_SCHEDULES.length = 0;
}

function freshEnv(cfg) {
  clearSchedules();
  delete require.cache[require.resolve(SCRIPT)];
  const logPosts = [];
  const contextPanel = new MockPanel("ContextPanel");
  const chatPanel = contextPanel.addChild(new MockPanel("Chat"));
  const messagesPanel = chatPanel.addChild(new MockPanel("ChatMessages"));
  const hudChat = contextPanel.addChild(new MockPanel("Team1Chat"));
  const hudMessages = hudChat.addChild(new MockPanel("Messages"));
  contextPanel.addChild(new MockPanel("Team2Chat")).addChild(new MockPanel("Messages"));
  contextPanel.addChild(new MockPanel("LCTBridgePanel"));
  contextPanel.addChild(new MockPanel("ChatLinesPanel"));
  contextPanel.SetAttributeString("lct_ui", JSON.stringify(cfg));

  globalThis.$ = {
    Msg: (...a) => console.log("[LCT-bf]", ...a),
    Schedule: (sec, fn) => { const t = nativeSetTimeout(fn, sec * 1000); PENDING_SCHEDULES.push(t); return t; },
    CreatePanel: (type, parent, id) => parent.addChild(new MockPanel(id)).setClass(type === "Label" ? "Label" : type),
    RegisterForUnhandledEvent: () => {},
    DispatchEvent: () => {},
    GetContextPanel: () => contextPanel,
    AsyncWebRequest: (url) => new Promise((resolve) => {
      let u = null;
      try { u = new URL(url, "http://x"); } catch (e) { resolve(JSON.stringify({ ok: false, error: "bad_url" })); return; }
      const q = u.searchParams;
      const op = q.get("op") || "";
      if (op === "log" || u.pathname.indexOf("/log") >= 0) {
        let payload = { lines: [] };
        try { payload = JSON.parse(q.get("d") || "{}"); } catch (e) {}
        logPosts.push(payload);
        resolve(JSON.stringify({ ok: true }));
        return;
      }
      if (op === "health") { resolve(JSON.stringify({ ok: true, provider: "bing" })); return; }
      if (op === "config") { resolve(JSON.stringify({ ok: true, ui: cfg })); return; }
      if (u.pathname.indexOf("/api/v1/translate") >= 0) {
        const text = q.get("text") || "";
        resolve(JSON.stringify({ ok: true, translation: "译:" + text, sourceLanguage: "en", targetLanguage: "zh-Hans" }));
        return;
      }
      resolve(JSON.stringify({ ok: true }));
    }),
  };
  globalThis.Convars = { GetStr: () => "", RegisterConVar: () => {}, SetValue: () => {} };

  require(SCRIPT);

  return {
    logPosts,
    addRow(sender, text, opts) {
      const row = new MockPanel(null).setClass("ChatMessage", "Expired");
      if (opts && opts.own) row.setClass("IsSelf");
      row.addChild(new MockPanel("SenderImage"));
      const body = row.addChild(new MockPanel(null).setClass("MessageBody"));
      const source = body.addChild(new MockPanel("MessageSource"));
      source.addChild(new MockPanel(null).setClass("ChannelName")).text = (opts && opts.channel) || "chat";
      source.addChild(new MockPanel(null).setClass("SenderName")).text = sender;
      const contents = body.addChild(new MockPanel("MessageContents"));
      contents.setClass("Text");
      contents.addChild(new MockPanel(null)).text = text;
      messagesPanel.addChild(row);
      return row;
    },
    addHudRow(text, opts) {
      const row = new MockPanel(null).setClass("ChatMessage");
      if (opts && opts.own) row.setClass("IsSelf");
      const contents = row.addChild(new MockPanel("MessageContents"));
      const bubble = contents.addChild(new MockPanel(null).setClass("ChatBubble"));
      const tc = bubble.addChild(new MockPanel(null).setClass("TextContainer"));
      tc.addChild(new MockPanel("MessageText")).text = text;
      hudMessages.addChild(row);
      return row;
    },
    // Row WITHOUT MessageSource (different DOM structure): sender unknown, text readable
    addSourceLessRow(text) {
      const row = new MockPanel(null).setClass("ChatMessage", "Expired");
      const contents = row.addChild(new MockPanel("MessageContents"));
      contents.setClass("Text");
      contents.addChild(new MockPanel(null)).text = text;
      messagesPanel.addChild(row);
      return row;
    },
  };
}

const CFG = { enabled: true, displayMode: "bilingual", targetLanguage: "zh-Hans", force: false, outgoing: "off", provider: "bing", timeoutMs: 15000, translateOwn: true, chatLog: true };

let passCount = 0, failCount = 0;
function assert(name, cond, extra) {
  if (cond) { passCount++; console.log("  PASS " + name); }
  else { failCount++; console.log("  FAIL " + name + (extra ? "  [" + extra + "]" : "")); }
}
function sleep(ms) { return new Promise((r) => nativeSetTimeout(r, ms)); }
async function waitFor(cond, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { if (cond()) return true; } catch (e) {}
    await sleep(150);
  }
  return false;
}
function allMsgEntries(env) {
  // Client payload lines carry no type field (bridge adds type:"msg" on disk write);
  // every line in a /log post is a chat-log entry.
  const out = [];
  for (const p of env.logPosts) {
    for (const l of (p.lines || [])) {
      if (l && typeof l === "object" && "text" in l) out.push(l);
    }
  }
  return out;
}
function waitForMsgs(env, count, timeoutMs) {
  return waitFor(() => allMsgEntries(env).length >= count, timeoutMs);
}
// ---------------- Tests ----------------
async function test1_fullRowThenBubbleWithPunct() {
  console.log("\n[1] full row first, bubble with extra '!' later -> 1 entry, sender resolved");
  const env = freshEnv(CFG);
  env.addRow("Wrapp_09", "撤退", { channel: "[队友]" });
  await sleep(1200);
  env.addHudRow("撤退！");
  const ok = await waitForMsgs(env, 1, 6000);
  await sleep(1500);
  const entries = allMsgEntries(env);
  assert("exactly 1 msg entry", ok && entries.length === 1, JSON.stringify(entries.map((e) => e.sender + "|" + e.text)));
  assert("sender resolved to Wrapp_09", entries.length === 1 && entries[0].sender === "Wrapp_09", JSON.stringify(entries[0]));
  assert("full-row text kept (not bubble ! variant)", entries.length === 1 && entries[0].text === "撤退", JSON.stringify(entries[0]));
  clearSchedules();
}

async function test2_ownBubbleDeduped() {
  console.log("\n[2] own full row + own bubble -> 1 entry with own name");
  const env = freshEnv(CFG);
  env.addRow("得歌", "开尔文不见了", { own: true, channel: "[队友]" });
  await sleep(1200);
  env.addHudRow("开尔文不见了", { own: true });
  const ok = await waitForMsgs(env, 1, 6000);
  await sleep(1500);
  const entries = allMsgEntries(env);
  assert("exactly 1 msg entry", ok && entries.length === 1, JSON.stringify(entries.map((e) => e.sender + "|" + e.text)));
  assert("sender is own name", entries.length === 1 && entries[0].sender === "得歌", JSON.stringify(entries[0]));
  clearSchedules();
}

async function test3_sourceLessRowBackfilled() {
  console.log("\n[3] source-less row after full row -> 1 entry, sender resolved");
  const env = freshEnv(CFG);
  env.addRow("Wrapp_09", "be careful", { channel: "[队友]" });
  await sleep(1200);
  env.addSourceLessRow("be careful");
  const ok = await waitForMsgs(env, 1, 6000);
  await sleep(1500);
  const entries = allMsgEntries(env);
  assert("exactly 1 msg entry", ok && entries.length === 1, JSON.stringify(entries.map((e) => e.sender + "|" + e.text)));
  assert("sender resolved", entries.length === 1 && entries[0].sender === "Wrapp_09", JSON.stringify(entries[0]));
  clearSchedules();
}

async function test4_bubbleFirstFullRowLater() {
  console.log("\n[4] bubble first, full row later (pending flush must not add <unknown>) -> 1 entry");
  const env = freshEnv(CFG);
  env.addHudRow("撤退！");
  await sleep(1200);
  env.addRow("Wrapp_09", "撤退", { channel: "[队友]" });
  const ok = await waitForMsgs(env, 1, 8000);
  await sleep(3000);
  const entries = allMsgEntries(env);
  assert("exactly 1 msg entry", ok && entries.length === 1, JSON.stringify(entries.map((e) => e.sender + "|" + e.text)));
  assert("sender resolved, no <unknown>", entries.length === 1 && entries[0].sender === "Wrapp_09", JSON.stringify(entries));
  clearSchedules();
}

async function test5_bubbleOnlyFallsBackToUnknown() {
  console.log("\n[5] bubble-only message (no counterpart) -> logged once as <unknown> fallback");
  const env = freshEnv(CFG);
  env.addHudRow("我看到 劳什");
  const ok = await waitForMsgs(env, 1, 14000);
  await sleep(1200);
  const entries = allMsgEntries(env);
  assert("entry eventually logged", ok && entries.length === 1, JSON.stringify(entries.map((e) => e.sender + "|" + e.text)));
  assert("sender stays <unknown> (unresolvable)", entries.length === 1 && entries[0].sender === "<unknown>", JSON.stringify(entries[0]));
  clearSchedules();
}

async function main() {
  console.log("=== Babel Tower sender-backfill regression tests ===");
  await test1_fullRowThenBubbleWithPunct();
  await test2_ownBubbleDeduped();
  await test3_sourceLessRowBackfilled();
  await test4_bubbleFirstFullRowLater();
  await test5_bubbleOnlyFallsBackToUnknown();
  console.log("\n=== RESULT: PASS " + passCount + " / FAIL " + failCount + " ===");
  process.exit(failCount === 0 ? 0 : 1);
}
main();
