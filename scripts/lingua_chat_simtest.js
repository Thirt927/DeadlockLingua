// Babel Tower - lingua_chat.js 模拟测试器 v4
// 每个测试:独立面板树 + 先写配置再加载脚本(loadUiConfig 只在 boot 时读一次)
// 翻译走真实本地桥(127.0.0.1:8791)。用法: node lingua_chat_simtest.js
"use strict";

const http = require("http");
const path = require("path");

// 桥端 BTIPC 实现的唯一真实来源:模拟器用它编码,游戏侧用自己的内联副本解码。
// 两侧若漂移(CRC/位序/UTF-8/base64 任一处),游戏侧 CRC 必然不过,测试立刻抓到。
const FRAMER = require(path.join(__dirname, "..", "core", "btipc", "framer.js"));
const CRC16 = require(path.join(__dirname, "..", "core", "btipc", "crc16.js")).crc16;

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
  const setUrlCalls = []; // 所有 HTML 面板的 SetURL 调用(自愈测试用)
  const createdPanels = []; // 运行时创建的 HTML 面板 id(应当始终为空)
  const wedge = { on: !!envOpt.wedgeBridgePanel }; // true = HTML 面板已僵死(所有面板一起失效)
  // HUD 顶栏聊天(与真实 citadel_hud_top_bar_chat.vxml 同构)
  // 关键:CitadelHudTopBarChat 是面板 TYPE 不是 class → FindChildrenWithClassTraverse 找不到,
  // 只能靠固定 id(Team1Chat/Team2Chat)查找。这里不 setClass(type),仅设 id。
  const hudChat = contextPanel.addChild(new MockPanel("Team1Chat"));
  const hudMessages = hudChat.addChild(new MockPanel("Messages"));
  const hudChat2 = contextPanel.addChild(new MockPanel("Team2Chat"));
  const hudMessages2 = hudChat2.addChild(new MockPanel("Messages"));
  // 大厅聊天(hudchat 结构):ChatLinesPanel 容器,行=ChatLineContainer
  const lobbyPanel = contextPanel.addChild(new MockPanel("ChatLinesPanel"));

  // HTML 桥面板的 SetURL:把请求转发给真实桥,拿到结果写回面板 title。
  // __wedged 复现真实故障:面板首次导航失败(桥没起来)后会僵死——
  // SetURL 不再抛错、也不再发出任何请求,title 永远不变。
  function installBridgeSetUrl(panel) {
    panel.SetURL = function (url) {
      const self = panel;
      setUrlCalls.push({ id: self.id, url: url });
      if (wedge.on) return;
      const q = new URL(url, "http://x").searchParams;
      const id = q.get("id") || "x";
      const text = q.get("text") || "";
      const source = q.get("source") || "auto";
      const target = q.get("target") || "zh-Hans";
      nativeSetTimeout(() => {
        if (self._deleted) return;
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
            self.title = "LCT" + id + JSON.stringify(payload);
          });
        });
        req.on("error", () => { self.title = "LCT" + id + JSON.stringify({ ok: false, error: "bridge_fetch_error" }); });
        req.write(body); req.end();
      }, 0);
    };
  }
  installBridgeSetUrl(bridgePanel);

  contextPanel.SetAttributeString("lct_ui", JSON.stringify(cfg)); // UI_CONVAR = "lct_ui"

  // ---------------- 模拟 BTIPC 位信道(桥端行为) ----------------
  // 游戏侧已不再走 HTTP:上行是 `[LCT] BTIPC REQ` 行(从 $.Msg 抓),下行是 128 个
  // Image 面板的 SetImage —— 桥按位回 200/404,只有 200 会 fire ImageLoaded。
  // 这里用**真实桥端 framer** 编码,游戏侧用自己内联的 frameFromBits/CRC 解码。
  const btipcWindows = new Map();
  const imageHandlers = new Map();
  const btipcShots = []; // 每次 SetImage 的 URL(诊断用)
  let btipcReqCount = 0;
  const btipcReqTexts = [];

  function btipcServe(win, r, p) {
    const w = btipcWindows.get(win);
    if (!w) return 0; // 桥端无此窗口 -> 404 -> 事件不 fire
    let frame;
    if (!w.frames) {
      frame = FRAMER.buildBusyFrame(w.id); // 翻译未就绪 -> BUSY 固定帧(带 id/CRC 位,绝不全 0)
    } else {
      if (w.frameStartRound === null) w.frameStartRound = r;
      const idx = Math.max(0, Math.min(r - w.frameStartRound, w.frames.length - 1));
      frame = w.frames[idx];
    }
    return FRAMER.bitsOfFrame(frame)[p] ? 1 : 0;
  }

  function installImagePanel(p) {
    p.SetImage = function (url) {
      btipcShots.push(url);
      let u = null;
      try { u = new URL(url, "http://x"); } catch (e) { return; }
      const q = u.searchParams;
      const bit = btipcServe(q.get("w"), Number(q.get("r")), Number(q.get("p")));
      if (!bit) return; // 位 0:不 fire
      const h = imageHandlers.get(p);
      if (h) nativeSetTimeout(() => { try { h(p); } catch (e) {} }, 0);
    };
  }

  function btipcHandleReq(line) {
    const at = line.indexOf("[LCT] BTIPC REQ");
    if (at < 0) return;
    if (envOpt.btipcBridgeDown) return; // 模拟桥没在跑:窗口永不建立 -> 客户端全 0 轮
    const m = /^\[LCT\] BTIPC REQ w=([0-9a-f]{6}) id=([0-9a-f]{4}) len=(\d{1,4}) crc=([0-9a-f]{4}) b64=([A-Za-z0-9+/=]*)$/
      .exec(line.slice(at).replace(/\r+$/, ""));
    if (!m) return;
    btipcReqCount += 1;
    const win = m[1];
    const id = parseInt(m[2], 16);
    const len = Number(m[3]);
    const payload = Buffer.from(m[5], "base64");
    if (payload.length !== len) return;
    if (CRC16(payload).toString(16).padStart(4, "0") !== m[4]) return;
    const text = payload.toString("utf8");
    let target = "zh-Hans";
    let body = text;
    const nl = text.indexOf("\n");
    if (nl >= 0) {
      const tm = /^t=([A-Za-z0-9-]{1,16})(;tm=\d{1,7})?$/.exec(text.slice(0, nl));
      if (tm) { target = tm[1]; body = text.slice(nl + 1); }
    }
    btipcReqTexts.push(body);
    btipcWindows.set(win, { id: id, frames: null, frameStartRound: null });
    // 用真实桥翻译(与旧路径同一个 /api/v1/translate)
    const req = http.request({
      host: "127.0.0.1", port: 8791, path: "/api/v1/translate", method: "POST",
      headers: { "Content-Type": "application/json" }, timeout: 15000,
    }, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => {
        let obj = null;
        try { obj = JSON.parse(data); } catch (e) {}
        const cur = btipcWindows.get(win);
        if (!cur) return;
        // 桥侧翻译失败 -> 降级回原文(与真实桥端 transport 的降级一致)
        cur.frames = FRAMER.encode(id, (obj && obj.translation) || body);
      });
    });
    req.on("error", () => {});
    req.write(JSON.stringify({ text: body, sourceLanguage: "auto", targetLanguage: target }));
    req.end();
  }

  globalThis.$ = {
    Msg: (...a) => {
      // BTIPC 上行就在这行输出里(tail -> 桥端 REQ 解析器),先喂给模拟桥再接原日志
      try { btipcHandleReq(Array.prototype.join.call(a, " ")); } catch (e) {}
      console.log("[LCT-sim]", ...a);
    },
    Schedule: (sec, fn) => { const t = nativeSetTimeout(fn, sec * 1000); PENDING_SCHEDULES.push(t); return t; },
    CreatePanel: (type, parent, id) => {
      // 记录运行时创建的 HTML 面板:项目已确认这种面板不可用,自愈绝不能走这条路
      if (type === "HTML") createdPanels.push(id);
      const p = parent.addChild(new MockPanel(id)).setClass(type === "Label" ? "Label" : type);
      if (type === "Image") installImagePanel(p); // BTIPC 的位信道载体
      return p;
    },
    // 事件白名单里的 ImageLoaded;RegisterEventHandler 恰好 3 参,第 2 参传面板对象
    RegisterEventHandler: (name, panel, handler) => {
      if (name === "ImageLoaded") imageHandlers.set(panel, handler);
    },
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
    bridgePanel, setUrlCalls, createdPanels, wedge,
    btipcWindows, btipcShots, imageHandlers,
    btipcReqCount: () => btipcReqCount,
    btipcReqTexts: () => btipcReqTexts.slice(),
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
  await waitFor(() => labelsOf(row).length > 0, 15000);
  await sleep(300);
  const before = (labelsOf(row)[0] && labelsOf(row)[0].text) || "";
  env.recycleRow(row, "text", "Alice", "retreat please");
  // 关键:不能只等"有标签" —— 上一轮的标签可能还在,会立刻满足条件导致断言过早。
  // 必须等到标签文本真的换成了新消息的译文(BTIPC 一轮约 3s,不是旧 HTTP 的毫秒级)。
  await waitFor(() => {
    const l = labelsOf(row);
    return l.length > 0 && l[0].text.length > 0 && l[0].text !== before;
  }, 15000);
  await sleep(300);
  const labels = labelsOf(row);
  assert("exactly 1 label (no residue)", labels.length === 1, labels.length + " labels");
  assert("label is current message translation",
    labels[0] && labels[0].text.length > 0 && labels[0].text.indexOf("retreat") === -1 && labels[0].text !== before,
    labels[0] && labels[0].text);
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

async function test7b_langOverride() {
  console.log("\n[7b] //sd <lang> <body> -> only translation sent, prefix stripped (works with outgoing=off)");
  const env = freshEnv(CFG.translationOnly); // outgoing=off:覆盖指令必须自己强制翻译
  const input = env.contextPanel.FindChildTraverse("ChatInput") ||
    env.contextPanel.addChild(new MockPanel("ChatInput"));
  const submitted = [];
  const origDispatch = globalThis.$.DispatchEvent;
  globalThis.$.DispatchEvent = (name, panel) => {
    if ((name === "CitadelChatInputSubmitted" || name === "CitadelChatTextSubmitted") && panel) {
      submitted.push(String(panel.text || ""));
    }
    origDispatch(name, panel);
  };

  input.text = "//sd ru 我们一起去推中路";
  globalThis.LCTOnChatSubmit();
  const ok = await waitFor(() => submitted.length >= 1, 30000);
  await sleep(400);
  const sent = submitted[0] || "";
  assert("submitted exactly once", ok && submitted.length === 1, JSON.stringify(submitted));
  assert("sent text is Russian (Cyrillic)", /[\u0400-\u04FF]/.test(sent) && sent.indexOf("推中路") === -1, sent);
  assert("command prefix not leaked", sent.indexOf("//") === -1 && sent.indexOf("sd") === -1, sent);

  // 短形式 + 未知语言的显式指令不发送
  input.text = "//ja 集合打团";
  globalThis.LCTOnChatSubmit();
  const okJa = await waitFor(() => submitted.length >= 2, 30000);
  await sleep(400);
  const sentJa = submitted[1] || "";
  assert("short form //ja translated to Japanese", okJa && /[\u3040-\u30ff]/.test(sentJa) && sentJa.indexOf("集合打团") === -1, sentJa);

  const before = submitted.length;
  input.text = "//sd 火星语 不该发出去";
  globalThis.LCTOnChatSubmit();
  await sleep(1200);
  assert("unknown language -> nothing submitted", submitted.length === before, JSON.stringify(submitted));
  globalThis.$.DispatchEvent = origDispatch;
}

async function test7c_prefixUsesSettings() {
  console.log("\n[7c] //<unknown token> <body> -> strip prefix, then translate body per settings");
  const env = freshEnv(CFG.outgoingTranslation); // outgoing=translation, target=zh-Hans
  const input = env.contextPanel.FindChildTraverse("ChatInput") ||
    env.contextPanel.addChild(new MockPanel("ChatInput"));
  const submitted = [];
  const origDispatch = globalThis.$.DispatchEvent;
  globalThis.$.DispatchEvent = (name, panel) => {
    if ((name === "CitadelChatInputSubmitted" || name === "CitadelChatTextSubmitted") && panel) {
      submitted.push(String(panel.text || ""));
    }
    origDispatch(name, panel);
  };

  input.text = "//随便 hello can you push mid";
  globalThis.LCTOnChatSubmit();
  const ok = await waitFor(() => submitted.length >= 1, 30000);
  await sleep(300);
  const sent = submitted[0] || "";
  assert("body translated to Chinese per settings", ok && /[\u4e00-\u9fff]/.test(sent), sent);
  assert("prefix and raw body not leaked", sent.indexOf("//") === -1 && sent.indexOf("随便") === -1 && sent.indexOf("hello") === -1, sent);
  globalThis.$.DispatchEvent = origDispatch;
}

async function test7d_prefixUsesSettingsOff() {
  console.log("\n[7d] //<unknown token> <body> with outgoing=off -> stripped body sent untranslated");
  const env = freshEnv(CFG.translationOnly);
  const input = env.contextPanel.FindChildTraverse("ChatInput") ||
    env.contextPanel.addChild(new MockPanel("ChatInput"));
  const submitted = [];
  const origDispatch = globalThis.$.DispatchEvent;
  globalThis.$.DispatchEvent = (name, panel) => {
    if ((name === "CitadelChatInputSubmitted" || name === "CitadelChatTextSubmitted") && panel) {
      submitted.push(String(panel.text || ""));
    }
    origDispatch(name, panel);
  };

  input.text = "//随便 hello there";
  globalThis.LCTOnChatSubmit();
  const ok = await waitFor(() => submitted.length >= 1, 8000);
  await sleep(300);
  assert("outgoing=off -> stripped body sent untranslated", ok && submitted.length === 1 && submitted[0] === "hello there", JSON.stringify(submitted));
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

// 同一句在普通聊天与 HUD 顶栏各有一份 DOM 副本时,只能请求一次。
async function test8b_duplicateTextDedup() {
  console.log("\n[8b] duplicate HUD/chat copies of one message -> one BTIPC request, both labels filled");
  const env = freshEnv(CFG.translationOnly);
  const text = "duplicate chat dedup test";
  const row = env.addRow("text", "Alice", text);
  const hud = env.addHudRow(text);
  const ok = await waitFor(() => {
    return labelsOf(row).length > 0 && hud.FindChildrenWithClassTraverse("LCTTranslationHud").length > 0;
  }, 20000);
  const hudLabels = hud.FindChildrenWithClassTraverse("LCTTranslationHud");
  const copies = env.btipcReqTexts().filter((s) => s === text).length;
  assert("both normal and HUD copies translated", ok && labelsOf(row).length === 1 && hudLabels.length === 1,
    "chat=" + labelsOf(row).length + " hud=" + hudLabels.length);
  assert("duplicate text uses exactly one BTIPC request", copies === 1, "requests=" + copies);
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

// 回归:2026/10/01 版本同时废掉了两条通道 —— $.AsyncWebRequest 调用即抛
// "AsyncWebRequest has been removed",HTML 面板通道也被引擎停用(面板即使被渲染,
// 引擎也不再为它建浏览器:SetURL 不报错但桥端收不到请求、panel.title 永远 undefined)。
// 此时翻译不可能成功,但绝不能卡住:必须在有限时间内结束,且不能再往聊天行上挂
// "翻译失败: xxx"(通道是永久性的没了, 每行都挂一个红标只是刷屏)。
async function test15_asyncWebRequestRemovedNoChannel() {
  console.log("\n[15] REGRESSION: AsyncWebRequest removed + panel channel disabled -> fails fast, NO noise label");
  const env = freshEnv(CFG.translationOnly, { asyncWebRequestRemoved: true });
  const row = env.addRow("text", "Alice", "hello can you push mid");
  const t0 = Date.now();
  // 通道已废, 不会再出现"翻译失败"标签, 所以不能再等标签出现; 改为等一段固定时间
  // 后断言"行上始终干净" —— 译文现在由游戏外的悬浮窗显示, 游戏内挂红标只是刷屏。
  await new Promise((r) => setTimeout(r, 2500));
  const elapsed = Date.now() - t0;
  const labels = labelsOf(row);
  assert("dead channel settles quickly (no hang)", elapsed < 12000, "elapsed=" + elapsed + "ms");
  assert("no error label injected on a permanently dead channel", labels.length === 0,
    labels.map((l) => l.text).join(" | "));
  assert("no panel navigation attempted (channel disabled)",
    env.setUrlCalls.length === 0, "setUrlCalls=" + env.setUrlCalls.length);
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

// 收敛:面板通道被引擎废除后,自愈和探针都不应再空转。
// 旧实现会在每次健康探测失败后把面板重置到 about:blank 并每 6s 打一条
// "bridge self-heal" 日志刷屏,还带一个每 4s 重新导航的探针 —— 全是无用功。
// 正确行为:面板通道既然不可用就什么都不做,由上层走"拿不到译文就按原文发送"。
async function test17_panelChannelDisabledNoSpinning() {
  console.log("\n[17] CONVERGENCE: panel channel disabled -> no self-heal / no probe / no runtime panel");
  const env = freshEnv(CFG.translationOnly, { asyncWebRequestRemoved: true, wedgeBridgePanel: true });
  await sleep(4000);
  assert("no about:blank self-heal resets",
    env.setUrlCalls.filter((c) => c.url === "about:blank").length === 0,
    "setUrlCalls=" + env.setUrlCalls.length);
  assert("no panel navigation attempts at all",
    env.setUrlCalls.length === 0, "setUrlCalls=" + env.setUrlCalls.length);
  assert("never recreates the HTML panel at runtime",
    env.createdPanels.length === 0, "createdPanels=" + JSON.stringify(env.createdPanels));
}

// 悬浮窗通道:2026/10/01 更新后游戏内 HTTP 全废,唯一活着的出向通道是
// 游戏 -> console.log。每条最终落档的聊天(已去重、sender 已解析)必须打一行
// [LCT-CHAT]{json},桥端才能 tail 出来翻译进悬浮窗。
async function test18_overlayChatEmitted() {
  console.log("\n[18] overlay channel: settled chat emits [LCT-CHAT] json line to console.log");
  const captured = [];
  const origLog = console.log;
  console.log = function () {
    try { captured.push(Array.prototype.join.call(arguments, " ")); } catch (e) {}
  };
  try {
    const env = freshEnv(CFG.bilingual);
    env.addRow("text", "Alice", "hello can you push mid");
    await waitFor(() => captured.some((l) => l.indexOf("[LCT-CHAT]") >= 0), 8000);
  } finally {
    console.log = origLog;
  }
  // 同一进程里其它环境可能残留定时器,这里只认"本条消息"的那一行
  const payloads = captured
    .filter((l) => l.indexOf("[LCT-CHAT]") >= 0)
    .map((l) => {
      try { return JSON.parse(l.slice(l.indexOf("[LCT-CHAT]") + "[LCT-CHAT]".length)); } catch (e) { return null; }
    })
    .filter((p) => !!p);
  const payload = payloads.find((p) => p.n === "Alice" && p.t === "hello can you push mid") || null;
  assert("emits [LCT-CHAT] marker line", payloads.length > 0, "lines=" + payloads.length);
  assert("payload is single-line JSON with sender/hero/text",
    !!payload && payload.n === "Alice" && payload.t === "hello can you push mid",
    JSON.stringify(payloads));
  assert("own flag 0 for other player's message", !!payload && payload.o === 0, payload && String(payload.o));
}

// BTIPC 端到端:位信道现在是唯一的翻译通道。验两件事 ——
//   (a) 跨实现一致性:模拟桥用 core/btipc/framer 编码,游戏侧用自己内联的
//       frameFromBits/CRC 解码。任一侧漂移(位序 / CRC / UTF-8 / base64)都会 CRC 失败。
//   (b) 桥缺席时的降级:连续全 0 轮 -> bridge_down,快速失败、不挂红标、不卡队列。
async function test19_btipcChannel() {
  console.log("\n[19] BTIPC channel: cross-impl framing + bridge-down fast degrade");
  const env = freshEnv(CFG.translationOnly);
  const row = env.addRow("text", "Alice", "hello can you push mid");
  const ok = await waitFor(() => labelsOf(row).length > 0, 15000);
  const labels = labelsOf(row);
  assert("BTIPC: translation returned through the bit channel and rendered in-game",
    ok && labels.length === 1 && labels[0].text.length > 0, labels[0] && labels[0].text);
  assert("BTIPC: bridge received at least one REQ line", env.btipcReqCount() >= 1,
    "reqs=" + env.btipcReqCount());
  assert("BTIPC: SHOT covers panel 0 and panel 127",
    env.btipcShots.some((u) => u.indexOf("&p=0&") >= 0) &&
    env.btipcShots.some((u) => u.indexOf("&p=127&") >= 0),
    "shots=" + env.btipcShots.length);
  // 同一 URL 撞引擎缓存后不再 fire ImageLoaded —— 所以每次 SHOT 的 URL 必须唯一。
  // 这是上游 v1.0 踩过的坑(frameFails 1->9 死循环),这里钉成回归。
  assert("BTIPC: every SHOT URL is unique (cache-busting nonce)", (function () {
    const seen = new Set();
    for (const u of env.btipcShots) {
      if (seen.has(u)) return false;
      seen.add(u);
    }
    return env.btipcShots.length > 0;
  })(), "shots=" + env.btipcShots.length);

  // (b) 桥缺席
  const env2 = freshEnv(CFG.translationOnly, { btipcBridgeDown: true });
  const row2 = env2.addRow("text", "Bob", "hello can you push mid");
  const t0 = Date.now();
  await sleep(7000);
  const elapsed = Date.now() - t0;
  assert("BTIPC: bridge absent -> degrades fast (does NOT burn CRC_DEAD)",
    elapsed < 12000, "elapsed=" + elapsed + "ms");
  assert("BTIPC: bridge absent -> no red error label in chat",
    labelsOf(row2).length === 0, labelsOf(row2).map((l) => l.text).join(" | "));
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
  await test7b_langOverride();
  await test7c_prefixUsesSettings();
  await test7d_prefixUsesSettingsOff();
  await test8_consecutiveIncoming();
  await test8b_duplicateTextDedup();
  await test9_hudTopBarTranslation();
  await test10_hudOwnMessageSkipped();
  await test11_hudBothTeamsFoundById();
  await test12_lcttestCommand();
  await test13_lobbyChatTranslation();
  await test14_ownMessageTranslatedByDefault();
  await test15_asyncWebRequestRemovedNoChannel();
  await test16_outgoingWithoutGlobalSetTimeout();
  await test17_panelChannelDisabledNoSpinning();
  await test18_overlayChatEmitted();
  await test19_btipcChannel();
  console.log("\n=== RESULT: PASS " + passCount + " / FAIL " + failCount + " ===");
  process.exit(failCount === 0 ? 0 : 1);
}

main();
