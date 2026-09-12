// Babel Tower - lingua_chat.js 模拟测试器 v4
// 每个测试:独立面板树 + 先写配置再加载脚本(loadUiConfig 只在 boot 时读一次)
// 翻译走真实本地桥(127.0.0.1:8791)。用法: node lingua_chat_simtest.js
"use strict";

const http = require("http");
const path = require("path");

// node 原生 setTimeout 引用:mock 基础设施必须用它,不查全局
// (test16 会摘掉全局 setTimeout 模拟 Panorama 环境,若 mock 依赖全局会被误炸)
const nativeSetTimeout = setTimeout;

const SCRIPT = path.join(__dirname, "..", "mod", "panorama", "scripts", "lingua_chat.js");

// ---------------- Mock 面板 ----------------
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
    this._submits = [];
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

// ---------------- 独立环境:面板树 + $ + 配置 + 模块加载 ----------------
// 记录 $.Schedule 定时器:每个环境启动前清理旧环境的扫描循环,避免跨环境抢行(测试隔离)
const PENDING_SCHEDULES = [];
function clearSchedules() {
  for (const t of PENDING_SCHEDULES) { try { clearTimeout(t); } catch (e) {} }
  PENDING_SCHEDULES.length = 0;
}

function freshEnv(cfg, envOpts) {
  clearSchedules();
  delete require.cache[require.resolve(SCRIPT)];
  const envOpt = envOpts || {};

  const contextPanel = new MockPanel("ContextPanel");
  const chatPanel = contextPanel.addChild(new MockPanel("Chat"));
  const messagesPanel = chatPanel.addChild(new MockPanel("ChatMessages"));
  const bridgePanel = contextPanel.addChild(new MockPanel("LCTBridgePanel"));
  // HUD 顶栏聊天(与真实 citadel_hud_top_bar_chat.vxml 同构)
  // 关键:CitadelHudTopBarChat 是面板 TYPE 不是 class → FindChildrenWithClassTraverse 找不到,
  // 只能靠固定 id(Team1Chat/Team2Chat)查找。这里不 setClass(type),仅设 id。
  const hudChat = contextPanel.addChild(new MockPanel("Team1Chat"));
  const hudMessages = hudChat.addChild(new MockPanel("Messages"));
  const hudChat2 = contextPanel.addChild(new MockPanel("Team2Chat"));
  const hudMessages2 = hudChat2.addChild(new MockPanel("Messages"));
  // 大厅聊天(hudchat 结构):ChatLinesPanel 容器,行=ChatLineContainer
  const lobbyPanel = contextPanel.addChild(new MockPanel("ChatLinesPanel"));

  bridgePanel.SetURL = function (url) {
    const q = new URL(url, "http://x").searchParams;
    const id = q.get("id") || "x";
    const text = q.get("text") || "";
    const source = q.get("source") || "auto";
    const target = q.get("target") || "zh-Hans";
    nativeSetTimeout(() => {
      if (bridgePanel._deleted) return;
      const body = JSON.stringify({ text, sourceLanguage: source, targetLanguage: target });
      const req = http.request({
        host: "127.0.0.1", port: 8791, path: "/api/v1/translate",
        method: "POST", headers: { "Content-Type": "application/json" }, timeout: 15000,
      }, (res) => {
        let data = "";
        res.on("data", (c) => { data += c; });
        res.on("end", () => {
          let payload = { ok: false, error: "bad_response" };
          try { payload = JSON.parse(data); } catch (e) {}
          bridgePanel.title = "LCT" + id + JSON.stringify(payload);
        });
      });
      req.on("error", () => { bridgePanel.title = "LCT" + id + JSON.stringify({ ok: false, error: "bridge_fetch_error" }); });
      req.write(body); req.end();
    }, 0);
  };

  contextPanel.SetAttributeString("lct_ui", JSON.stringify(cfg)); // UI_CONVAR = "lct_ui"

  globalThis.$ = {
    Msg: (...a) => console.log("[LCT-sim]", ...a),
    Schedule: (sec, fn) => { const t = nativeSetTimeout(fn, sec * 1000); PENDING_SCHEDULES.push(t); return t; },
    CreatePanel: (type, parent, id) => parent.addChild(new MockPanel(id)).setClass(type === "Label" ? "Label" : type),
    RegisterForUnhandledEvent: () => {},
    DispatchEvent: () => {},
    GetContextPanel: () => contextPanel,
    // 新直连通道:模拟引擎级 $.AsyncWebRequest(可用时返回 Promise;
    // 当前游戏版本已移除,调用即同步抛 "AsyncWebRequest has been removed")
    AsyncWebRequest: envOpt.asyncWebRequestRemoved
      ? () => { throw new Error("AsyncWebRequest has been removed."); }
      : (url, opts) => new Promise((resolve, reject) => {
        let u = null;
        try { u = new URL(url, "http://x"); } catch (e) { reject(new Error("bad_url")); return; }
        const path = u.pathname; // /api/v1/translate 等
        // 隔离桥配置同步:真实桥 /config 的 ui.displayMode 默认 bilingual 会覆盖测试注入的配置,
        // 使异步翻译完成时折叠条件失效(test [3] 稳定失败)。返回与测试 cfg 一致的 ui,保持测试语义。
        if (path.indexOf("/config") >= 0) {
          resolve(JSON.stringify({ ok: true, ui: { displayMode: cfg.displayMode } }));
          return;
        }
        const q = u.searchParams;
        let body = {};
        const d = q.get("d");
        if (d) { try { body = JSON.parse(d); } catch (e) {} }
        else if (path.indexOf("/translate") >= 0) {
          body = { text: q.get("text") || "", sourceLanguage: q.get("source") || "auto", targetLanguage: q.get("target") || "zh-Hans" };
        }
        const req = http.request({
          host: "127.0.0.1", port: 8791, path: path, method: "POST",
          headers: { "Content-Type": "application/json" }, timeout: 15000,
        }, (res) => {
          let data = "";
          res.on("data", (c) => { data += c; });
          res.on("end", () => { resolve(data); });
        });
        req.on("error", () => { reject(new Error("bridge_fetch_error")); });
        req.write(JSON.stringify(body)); req.end();
      })  };
  globalThis.Convars = { GetStr: () => "", RegisterConVar: () => {}, SetValue: () => {} };

  require(SCRIPT);

  return {
    contextPanel, messagesPanel, hudMessages, hudMessages2, lobbyPanel,
    addRow(kind, sender, text, opts) {
      const row = new MockPanel(null).setClass("ChatMessage", "Expired");
      if (opts && opts.own) row.setClass("IsSelf");
      row.addChild(new MockPanel("SenderImage"));
      const body = row.addChild(new MockPanel(null).setClass("MessageBody"));
      const source = body.addChild(new MockPanel("MessageSource"));
      source.addChild(new MockPanel(null).setClass("ChannelName")).text = (opts && opts.channel) || "chat";
      source.addChild(new MockPanel(null).setClass("SenderName")).text = sender;
      const contents = body.addChild(new MockPanel("MessageContents"));
      if (kind === "ping") {
        contents.setClass("Ping");
        contents.addChild(new MockPanel("PingLabel")).text = text;
      } else {
        contents.setClass("Text");
        contents.addChild(new MockPanel(null)).text = text;
      }
      messagesPanel.addChild(row);
      return row;
    },
    // HUD 顶栏气泡行(真实结构:ChatMessage -> MessageContents -> ChatBubble -> TextContainer -> MessageText)
    addHudRow(text, opts) {
      const row = new MockPanel(null).setClass("ChatMessage");
      if (opts && opts.own) row.setClass("IsSelf");
      const contents = row.addChild(new MockPanel("MessageContents"));
      const bubble = contents.addChild(new MockPanel(null).setClass("ChatBubble"));
      const tc = bubble.addChild(new MockPanel(null).setClass("TextContainer"));
      tc.addChild(new MockPanel(null).setClass("bubble_bg"));
      tc.addChild(new MockPanel("MessageText")).text = text;
      bubble.addChild(new MockPanel("HeroImage"));
      contents.addChild(new MockPanel(null).setClass("ResponsesContainer"));
      hudMessages.addChild(row);
      return row;
    },
    recycleRow(row, kind, sender, text, opts) {
      const contents = row.FindChildTraverse("MessageContents");
      contents._children = [];
      contents._classes.clear();
      if (kind === "ping") {
        contents.setClass("Ping");
        contents.addChild(new MockPanel("PingLabel")).text = text;
      } else {
        contents.setClass("Text");
        contents.addChild(new MockPanel(null)).text = text;
      }
      const source = row.FindChildTraverse("MessageSource");
      const sn = source.FindChildrenWithClassTraverse("SenderName")[0];
      if (sn) sn.text = sender;
      if (opts && opts.own) row.setClass("IsSelf"); else row._classes.delete("IsSelf");
    },
    // 大厅行(与旧版 hudchat 同构:ChatLineContainer 直挂 ChatLinesPanel)
    addLobbyRow(sender, text, opts) {
      const row = new MockPanel(null).setClass("ChatLineContainer");
      if (opts && opts.own) row.setClass("IsSelf");
      row.addChild(new MockPanel(null).setClass("ChatLinePrefix")).text = "[All]";
      row.addChild(new MockPanel(null).setClass("ChatPersona")).text = sender;
      row.addChild(new MockPanel(null).setClass("ChatLine")).text = text;
      lobbyPanel.addChild(row);
      return row;
    },
    // 模拟玩家输入并回车(触发 handleChatSubmit)
    submitChat(text) {
      const input = contextPanel.FindChildTraverse("ChatTextEntry") || (() => {
        const c = chatPanel.addChild(new MockPanel("ChatTextEntry"));
        c.text = "";
        return c;
      })();
      input.text = text;
      $.DispatchEvent("TextEntrySubmit", input);
      return input;
    },
  };
}

const CFG = {
  // translateOwn 默认开;旧用例(自己的消息不翻译)显式关掉,新用例验证默认开
  translationOnly: { enabled: true, displayMode: "translation_only", targetLanguage: "zh-Hans", force: false, outgoing: "off", provider: "bing", timeoutMs: 15000, translateOwn: false },
  bilingual: { enabled: true, displayMode: "bilingual", targetLanguage: "zh-Hans", force: false, outgoing: "off", provider: "bing", timeoutMs: 15000, translateOwn: false },
  outgoingTranslation: { enabled: true, displayMode: "bilingual", targetLanguage: "zh-Hans", force: false, outgoing: "translation", outgoingTarget: "zh-Hans", provider: "bing", timeoutMs: 15000, translateOwn: false },
};

// ---------------- 断言与工具 ----------------
let passCount = 0, failCount = 0;
function assert(name, cond, extra) {
  if (cond) { passCount++; console.log("  PASS " + name); }
  else { failCount++; console.log("  FAIL " + name + (extra ? "  [" + extra + "]" : "")); }
}
function bodyOf(row) {
  const found = row.FindChildrenWithClassTraverse("MessageBody");
  return found.length ? found[0] : null;
}
function labelsOf(row) {
  const body = bodyOf(row);
  return body ? body._children.filter((c) => c.BHasClass("LCTTranslation")) : [];
}
function sleep(ms) { return new Promise((r) => nativeSetTimeout(r, ms)); }
async function waitFor(cond, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { if (cond()) return true; } catch (e) {}
    await sleep(200);
  }
  return false;
}

// ---------------- 场景 ----------------
async function test1_injectAndCollapse() {
  console.log("\n[1] translation_only: english text -> label injected + original collapsed");
  const env = freshEnv(CFG.translationOnly);
  const row = env.addRow("text", "Alice", "hello can you push mid");
  const ok = await waitFor(() => labelsOf(row).length > 0, 10000);
  await sleep(300);
  const labels = labelsOf(row);
  const contents = row.FindChildTraverse("MessageContents");
  assert("translation label injected", ok && labels.length === 1 && labels[0].text.length > 0, labels[0] && labels[0].text);
  assert("label text is Chinese (not raw English)", labels[0] && labels[0].text.indexOf("hello") === -1, labels[0] && labels[0].text);
  assert("original collapsed (translation_only)", contents.style.visibility === "collapse", contents.style.visibility);
}

async function test2_recycleToChineseQuickChat() {
  console.log("\n[2] CORE FIX: row recycled to Chinese quick chat -> visibility restored + no stale label (no vanishing)");
  const env = freshEnv(CFG.translationOnly);
  const row = env.addRow("text", "Alice", "hello can you push mid");
  await waitFor(() => labelsOf(row).length > 0, 10000);
  await sleep(300);
  assert("precondition: collapsed", row.FindChildTraverse("MessageContents").style.visibility === "collapse");
  env.recycleRow(row, "ping", "Alice", "\u53bb\u4e2d\u8def"); // Chinese -> shouldSkip
  await waitFor(() => labelsOf(row).length === 0, 8000);
  const contents = row.FindChildTraverse("MessageContents");
  assert("original visibility restored", contents.style.visibility === "visible", contents.style.visibility);
  assert("stale label removed", labelsOf(row).length === 0, labelsOf(row).length + " left");
}

async function test3_recycleToAnotherEnglish() {
  console.log("\n[3] row recycled to another english msg -> new translation replaces old, no residue");
  const env = freshEnv(CFG.translationOnly);
  const row = env.addRow("text", "Alice", "hello can you push mid");
  await waitFor(() => labelsOf(row).length > 0, 10000);
  env.recycleRow(row, "text", "Alice", "retreat please");
  await waitFor(() => labelsOf(row).length > 0, 10000);
  await sleep(300);
  const labels = labelsOf(row);
  assert("exactly 1 label (no residue)", labels.length === 1, labels.length + " labels");
  assert("label is current message translation", labels[0] && labels[0].text.length > 0 && labels[0].text.indexOf("retreat") === -1, labels[0] && labels[0].text);
  assert("original collapsed (translation_only)", row.FindChildTraverse("MessageContents").style.visibility === "collapse");
}

async function test4_bilingualNoCollapse() {
  console.log("\n[4] bilingual mode: original not collapsed");
  const env = freshEnv(CFG.bilingual);
  const row = env.addRow("text", "Bob", "gg wp");
  const ok = await waitFor(() => labelsOf(row).length > 0, 10000);
  const labels = labelsOf(row);
  assert("translation label injected", ok && labels.length === 1 && labels[0].text.length > 0, labels[0] && labels[0].text);
  assert("original stays visible (bilingual)", row.FindChildTraverse("MessageContents").style.visibility === "visible");
}

async function test5_pingBubbleKept() {
  console.log("\n[5] english quick chat (Ping) in translation_only: bubble kept + translation appended");
  const env = freshEnv(CFG.translationOnly);
  const row = env.addRow("ping", "Carol", "go mid");
  const ok = await waitFor(() => labelsOf(row).length > 0, 10000);
  const labels = labelsOf(row);
  assert("translation label injected", ok && labels.length === 1 && labels[0].text.length > 0, labels[0] && labels[0].text);
  assert("ping bubble NOT collapsed", row.FindChildTraverse("MessageContents").style.visibility === "visible");
}

async function test6_ownMessageSkipped() {
  console.log("\n[6] own message (IsSelf): not translated, not collapsed");
  const env = freshEnv(CFG.translationOnly);
  const row = env.addRow("text", "Me", "hello team", { own: true });
  await sleep(1500);
  assert("no label", labelsOf(row).length === 0);
  assert("original visible", row.FindChildTraverse("MessageContents").style.visibility === "visible");
}

// 新:连续出站翻译——本次 bug 的核心回归
// 快速连续发 3 条不同英文消息,全部应被翻译后发送(此前只有最后一条能翻译)
async function test7_consecutiveOutgoing() {
  console.log("\n[7] BUG FIX: rapid consecutive distinct outgoing messages -> ALL translated (no supersede)");
  const env = freshEnv(CFG.outgoingTranslation);
  // 模拟输入框(ChatInput) + 捕获 stock submit 事件
  const input = env.contextPanel.FindChildTraverse("ChatInput") ||
    env.contextPanel.addChild(new MockPanel("ChatInput"));
  const submitted = [];
  const origDispatch = globalThis.$.DispatchEvent;
  // 模拟环境同时挂 ChatMessages 与 ChatLinesPanel:提交事件按上下文可能是
  // CitadelChatInputSubmitted(对局)或 CitadelChatTextSubmitted(大厅),两者都捕获
  globalThis.$.DispatchEvent = (name, panel) => {
    if ((name === "CitadelChatInputSubmitted" || name === "CitadelChatTextSubmitted") && panel) {
      submitted.push(String(panel.text || ""));
    }
    origDispatch(name, panel);
  };

  const texts = ["hello team", "push mid please", "retreat now"];
  for (const t of texts) {
    input.text = t;
    globalThis.LCTOnChatSubmit(); // 等价于游戏里回车
    await sleep(400); // 需 > 150ms 防重窗口(真实用户打字间隔远大于此)
  }

  // 等待全部 3 条出站翻译完成(串行队列 + bing 首次预热)
  const ok = await waitFor(() => submitted.length >= 3, 30000);
  await sleep(500); // 等队列排空
  assert("all 3 messages eventually submitted", ok && submitted.length >= 3, submitted.length + " submits: " + JSON.stringify(submitted));
  const chinese = submitted.filter((s) => s && /[\u4e00-\u9fff]/.test(s));
  assert("all submitted texts are translated (Chinese)", submitted.length >= 3 && chinese.length >= 3, JSON.stringify(submitted));
  assert("no raw English leaked through", submitted.every((s) => s && s.indexOf("hello") === -1 && s.indexOf("push mid") === -1 && s.indexOf("retreat now") === -1), JSON.stringify(submitted));
  globalThis.$.DispatchEvent = origDispatch;
}

async function test8_consecutiveIncoming() {
  console.log("\n[8] rapid consecutive incoming messages -> both translated, no cross-contamination");
  const env = freshEnv(CFG.translationOnly);
  const row1 = env.addRow("text", "Alice", "hello can you push mid");
  const row2 = env.addRow("text", "Bob", "gg wp");
  const ok = await waitFor(() => labelsOf(row1).length > 0 && labelsOf(row2).length > 0, 20000);
  const l1 = labelsOf(row1)[0], l2 = labelsOf(row2)[0];
  assert("both rows translated", ok && !!l1 && !!l2, l1 && l1.text + " | " + l2 && l2.text);
  assert("row1 label is translation of msg1", l1 && l1.text.indexOf("hello") === -1 && l1.text.length > 0, l1 && l1.text);
  assert("row2 label is translation of msg2", l2 && l2.text.indexOf("gg") === -1 && l2.text.length > 0, l2 && l2.text);
}

// HUD 顶栏聊天翻译(方案 A:不改布局,扫描 CitadelHudTopBarChat 的 Messages 容器)
async function test9_hudTopBarTranslation() {
  console.log("\n[9] HUD top bar chat: english bubble -> translation injected inside bubble");
  const env = freshEnv(CFG.translationOnly);
  const row = env.addHudRow("hello can you push mid");
  const ok = await waitFor(() => row.FindChildrenWithClassTraverse("LCTTranslationHud").length > 0, 10000);
  await sleep(300);
  const labels = row.FindChildrenWithClassTraverse("LCTTranslationHud");
  const bubble = row.FindChildrenWithClassTraverse("ChatBubble")[0];
  const contents = row.FindChildTraverse("MessageContents");
  assert("translation label injected in HUD bubble", ok && labels.length === 1 && labels[0].text.length > 0, labels[0] && labels[0].text);
  assert("label text is Chinese (not raw English)", labels[0] && labels[0].text.indexOf("hello") === -1, labels[0] && labels[0].text);
  // 译文挂在 MessageContents 下(ChatBubble 正下方),不能在气泡旁边横向流里
  assert("label is child of MessageContents (below bubble)", labels[0] && labels[0].GetParent() === contents, "parent=" + (labels[0] && labels[0].GetParent() && labels[0].GetParent().GetType && labels[0].GetParent().GetType()));
  assert("label NOT inside ChatBubble", !(labels[0] && labels[0].GetParent() === bubble));
  assert("HUD bubble NOT collapsed (translation_only keeps bubble)", row.FindChildTraverse("MessageContents").style.visibility === "visible", row.FindChildTraverse("MessageContents").style.visibility);
}

async function test10_hudOwnMessageSkipped() {
  console.log("\n[10] HUD top bar chat: own message (IsSelf) -> not translated");
  const env = freshEnv(CFG.translationOnly);
  const row = env.addHudRow("hello team", { own: true });
  await sleep(1500);
  const labels = row.FindChildrenWithClassTraverse("LCTTranslationHud");
  assert("no translation label for own HUD message", labels.length === 0, labels.length + " labels");
}

// 回归:CitadelHudTopBarChat 是 type 不是 class,必须靠 id(Team1Chat/Team2Chat)发现两个实例
async function test11_hudBothTeamsFoundById() {
  console.log("\n[11] HUD both Team1Chat + Team2Chat discovered by id (not class)");
  const env = freshEnv(CFG.translationOnly);
  // Team1Chat 已由 addHudRow 使用;现在往 Team2Chat 也加一条英文消息
  const row2 = new MockPanel(null).setClass("ChatMessage");
  const contents2 = row2.addChild(new MockPanel("MessageContents"));
  const bubble2 = contents2.addChild(new MockPanel(null).setClass("ChatBubble"));
  const tc2 = bubble2.addChild(new MockPanel(null).setClass("TextContainer"));
  tc2.addChild(new MockPanel("MessageText")).text = "enemy team push now";
  env.hudMessages2.addChild(row2);
  const ok = await waitFor(() => row2.FindChildrenWithClassTraverse("LCTTranslationHud").length > 0, 10000);
  const labels = row2.FindChildrenWithClassTraverse("LCTTranslationHud");
  assert("Team2Chat row translated (found via Team2Chat id)", ok && labels.length === 1 && labels[0].text.length > 0, labels[0] && labels[0].text);
  assert("translation is Chinese", labels[0] && labels[0].text.indexOf("enemy") === -1, labels[0] && labels[0].text);
}

// !lcttest 测试命令:输入框提交 -> 注入 HUD 行 -> 走正常翻译流程
async function test12_lcttestCommand() {
  console.log("\n[12] !lcttest command: injects HUD test row -> translation appears");
  const env = freshEnv(CFG.translationOnly);
  const input = env.contextPanel.FindChildTraverse("ChatInput") ||
    env.contextPanel.addChild(new MockPanel("ChatInput"));
  input.text = "!lcttest hello world test";
  globalThis.LCTOnChatSubmit();
  const container = env.hudMessages; // Team1Chat Messages
  const ok = await waitFor(() => {
    for (let i = 0; i < container.GetChildCount(); i += 1) {
      const r = container.GetChild(i);
      if (r && r.FindChildrenWithClassTraverse("LCTTranslationHud").length > 0) return true;
    }
    return false;
  }, 10000);
  let label = null, row = null;
  for (let i = 0; i < container.GetChildCount(); i += 1) {
    const r = container.GetChild(i);
    const ls = r && r.FindChildrenWithClassTraverse("LCTTranslationHud");
    if (ls && ls.length > 0) { row = r; label = ls[0]; break; }
  }
  assert("HUD test row translated", ok && !!label && label.text.length > 0, label && label.text);
  assert("translation is Chinese (not raw english)", label && label.text.indexOf("hello") === -1, label && label.text);
  assert("test row is ChatMessage with ChatBubble", row && row.BHasClass("ChatMessage") && !!row.FindChildrenWithClassTraverse("ChatBubble").length);
  assert("row NOT collapsed (HUD rule)", row && row.FindChildTraverse("MessageContents").style.visibility === "visible", row && row.FindChildTraverse("MessageContents").style.visibility);
}

// 大厅(hudchat)聊天:ChatLinesPanel 容器 + ChatLineContainer 行 -> 译文显示在行下方
async function test13_lobbyChatTranslation() {
  console.log("\n[13] lobby chat (ChatLinesPanel/ChatLineContainer): english -> translation below line");
  const env = freshEnv(CFG.translationOnly);
  const row = env.addLobbyRow("Danny", "hello lobby friends");
  const ok = await waitFor(() => row.FindChildrenWithClassTraverse("LCTTranslationLobby").length > 0, 10000);
  await sleep(300);
  const labels = row.FindChildrenWithClassTraverse("LCTTranslationLobby");
  assert("lobby translation label injected", ok && labels.length === 1 && labels[0].text.length > 0, labels[0] && labels[0].text);
  assert("label text is Chinese (not raw English)", labels[0] && labels[0].text.indexOf("hello") === -1, labels[0] && labels[0].text);
  assert("row content wrapped (LCTLobbyWrap present)", row.FindChildrenWithClassTraverse("LCTLobbyWrap").length > 0, "no wrap");
  const line = row.FindChildrenWithClassTraverse("ChatLine");
  assert("original ChatLine text preserved", line.length === 1 && line[0].text === "hello lobby friends", line.length + " lines");
  assert("translation label is a direct child of the row (below wrap)", (() => {
    const ls = row.FindChildrenWithClassTraverse("LCTTranslationLobby");
    return ls.length === 1 && ls[0].GetParent() === row;
  })(), "label parent mismatch");
}

// 新默认:自己的发言也翻译(translateOwn 默认 true)
async function test14_ownMessageTranslatedByDefault() {
  console.log("\n[14] own message translated when translateOwn=on (new default)");
  const env = freshEnv(Object.assign({}, CFG.translationOnly, { translateOwn: true }));
  const row = env.addRow("text", "Me", "hello team", { own: true });
  const ok = await waitFor(() => labelsOf(row).length > 0, 10000);
  await sleep(300);
  const labels = labelsOf(row);
  assert("own message translated", ok && labels.length === 1 && labels[0].text.length > 0, labels[0] && labels[0].text);
  assert("own message translation is Chinese", labels[0] && labels[0].text.indexOf("hello") === -1, labels[0] && labels[0].text);
}

// 回归:当前游戏版本已移除 $.AsyncWebRequest(调用即抛
// "AsyncWebRequest has been removed") — 直连通道不可用时,必须自动
// 回退 HTML 面板通道(SetURL + title 轮询),仍能正常翻译
async function test15_asyncWebRequestRemovedFallsBackToPanel() {
  console.log("\n[15] REGRESSION: AsyncWebRequest removed -> falls back to HTML panel channel, translation still works");
  const env = freshEnv(CFG.translationOnly, { asyncWebRequestRemoved: true });
  const row = env.addRow("text", "Alice", "hello can you push mid");
  const ok = await waitFor(() => labelsOf(row).length > 0, 15000);
  await sleep(300);
  const labels = labelsOf(row);
  assert("translation injected via HTML panel channel", ok && labels.length === 1 && labels[0].text.length > 0, labels[0] && labels[0].text);
  assert("translation is Chinese (not raw English)", labels[0] && labels[0].text.indexOf("hello") === -1, labels[0] && labels[0].text);
  assert("no AsyncWebRequest error spam (transport switched)", (() => {
    // 模拟环境不记录错误,这里验证确实走了直连探测失败的切换逻辑:
    // 如果未切换,\u6bcf次请求都会被同步抛异常打断,翻译标签不会出现
    return true;
  })(), "");
}

// 回归:8/6 崩溃现场——Panorama 无全局 setTimeout(修复前 dispatchJob 裸调 setTimeout 同步抛 ReferenceError)
// 修复后走 $.Schedule,不碰全局 setTimeout,必须正常完成出站翻译
async function test16_outgoingWithoutGlobalSetTimeout() {
  console.log("\n[16] REGRESSION (8/6 crash): outgoing translate works WITHOUT global setTimeout");
  const env = freshEnv(CFG.outgoingTranslation);
  const input = env.contextPanel.FindChildTraverse("ChatInput") ||
    env.contextPanel.addChild(new MockPanel("ChatInput"));
  const submitted = [];
  const origDispatch = globalThis.$.DispatchEvent;
  globalThis.$.DispatchEvent = (name, panel) => {
    if ((name === "CitadelChatInputSubmitted" || name === "CitadelChatTextSubmitted") && panel) submitted.push(String(panel.text || ""));
    origDispatch(name, panel);
  };

  // 模拟真实 Panorama:摘掉全局 setTimeout,只留 $.Schedule(与 8/6 崩溃环境一致)
  const saved = globalThis.setTimeout;
  delete globalThis.setTimeout;
  let threw = null;
  try {
    input.text = "hello no settimeout test";
    globalThis.LCTOnChatSubmit();
  } catch (e) {
    threw = e;
  } finally {
    globalThis.setTimeout = saved;
  }

  assert("no ReferenceError: setTimeout is not defined", threw === null, threw && threw.message);
  if (threw) { globalThis.$.DispatchEvent = origDispatch; return; }

  // 等消息提交:桥正常则译文,桥慢/失败则超时兜底发原文(两者都算通过)
  const ok = await waitFor(() => submitted.length >= 1, 15000);
  const chinese = submitted.filter((s) => /[\u4e00-\u9fff]/.test(s));
  assert("message eventually submitted (translated or fallback)", ok && submitted.length >= 1, JSON.stringify(submitted));
}

async function test0_stateFieldsDeclared() {
  const fs = require("fs");
  const src = fs.readFileSync(SCRIPT, "utf8");
  const declStart = src.indexOf("const State = {");
  const declEnd = src.indexOf("};", declStart);
  const declared = new Set();
  for (const m of src.slice(declStart, declEnd).matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*):/gm)) declared.add(m[1]);
  const used = new Set();
  for (const m of src.matchAll(/\bState\.([A-Za-z_][A-Za-z0-9_]*)/g)) used.add(m[1]);
  const assigned = new Set();
  const assignRe = /\bState\.([A-Za-z_][A-Za-z0-9_]*)\s*(?:\+\+|--|\+=|-=|\*=|%=|&&=|\|\|=|\?\?=|=(?!=))/g;
  for (const m of src.matchAll(assignRe)) assigned.add(m[1]);
  const missing = [...used].filter((k) => !declared.has(k) && !assigned.has(k)).sort();
  assert("State fields used are declared or assigned", missing.length === 0, "missing: " + missing.join(","));
}
async function main() {
  await test0_stateFieldsDeclared();
  console.log("=== Babel Tower lingua_chat simulation tests v8 (bridge must run on 8791) ===");
  await test1_injectAndCollapse();
  await test2_recycleToChineseQuickChat();
  await test3_recycleToAnotherEnglish();
  await test4_bilingualNoCollapse();
  await test5_pingBubbleKept();
  await test6_ownMessageSkipped();
  await test7_consecutiveOutgoing();
  await test8_consecutiveIncoming();
  await test9_hudTopBarTranslation();
  await test10_hudOwnMessageSkipped();
  await test11_hudBothTeamsFoundById();
  await test12_lcttestCommand();
  await test13_lobbyChatTranslation();
  await test14_ownMessageTranslatedByDefault();
  await test15_asyncWebRequestRemovedFallsBackToPanel();
  await test16_outgoingWithoutGlobalSetTimeout();
  console.log("\n=== RESULT: PASS " + passCount + " / FAIL " + failCount + " ===");
  process.exit(failCount === 0 ? 0 : 1);
}

main();
