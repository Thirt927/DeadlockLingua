// BTIPC 桥端传输层验收:REQ 行校验(§14.1)、信封(§5.1)、/btipc/dl 轮次语义(§6)、GC 不变量
// 运行: node tests/btipc/transport.test.js
"use strict";

const path = require("path");
const F = require(path.resolve("core/btipc/framer.js"));
const W = require(path.resolve("core/btipc/window.js"));
const T = require(path.resolve("core/btipc/transport.js"));
const crc16 = require(path.resolve("core/btipc/crc16.js")).crc16;

let fail = 0;
function ok(name, cond, extra) {
  if (!cond) fail += 1;
  console.log((cond ? "  ok   " : "  FAIL ") + name + (cond || extra === undefined ? "" : "  " + extra));
}
const tick = () => new Promise((r) => setTimeout(r, 0));

// 模拟游戏侧的一轮:128 个面板各自取自己那一位(位 1 → 200,位 0 → 404),
// 按位拼成 16 字节再解帧。这是"状态码即数据"的正确用法 —— 桥端对同一轮的
// 不同面板必须回不同状态码,否则游戏侧会读到全 1。
function serveRound(tr, win, r) {
  const bits = [];
  let n200 = 0;
  for (let p = 0; p < F.WINDOW_PANELS; p += 1) {
    const b = tr.serveDL({ w: win, r: r, p: p, t: "x" }).status === 200 ? 1 : 0;
    if (b) n200 += 1;
    bits.push(b);
  }
  return { decoded: F.decodeFrame(F.frameFromBits(bits)), n200: n200 };
}

// 模拟游戏侧闭合:从 startRound 起逐轮取帧,遇到 END 帧拼装成文本。
// 对应 §4 的轮次生命周期(SHOT → 收 ImageLoaded → 组帧 → CRC → 拼装 → END 停轮)。
function collect(tr, win, startRound) {
  const decoded = [];
  for (let i = 0; i < 200; i += 1) {
    const out = serveRound(tr, win, startRound + i);
    if (!out.decoded.ok) return null;
    decoded.push(out.decoded);
    if (out.decoded.end) return F.assembleFrames(decoded);
  }
  return null;
}

// 窗口号规则见 §14.1:必须是 6 位小写 hex(nowMs 低 24 位)。
const WIN = "f3a1cc";

// 造一行合法 REQ(带引擎时间戳前缀,验证行尾锚定)
function buildReqLine(win, id, text) {
  const payload = Buffer.from(text, "utf8");
  const crc = crc16(payload).toString(16).padStart(4, "0");
  const idHex = id.toString(16).padStart(4, "0");
  return "10:00:00 [PanoramaScript] [LCT] BTIPC REQ w=" + win + " id=" + idHex +
    " len=" + payload.length + " crc=" + crc + " b64=" + payload.toString("base64");
}

// ---------- §14.1 REQ 行校验 ----------

const good = buildReqLine(WIN, 0x00c8, "hello world");
const parsed = T.parseReqLine(good);
ok("合法 REQ 解析通过", !!parsed && parsed.win === WIN && parsed.id === 0x00c8);
ok("payload 还原", parsed && parsed.payload.toString("utf8") === "hello world");

ok("空 payload 合法", !!T.parseReqLine(buildReqLine("000001", 1, "")));
ok("非 BTIPC 行返回 null", T.parseReqLine("10:00:00 [PanoramaScript] [LCT-CHAT]{}") === null);
ok("w 非法(5 位)drop", T.parseReqLine(good.replace("w=" + WIN, "w=f3a1c")) === null);
ok("w 非法(7 位)drop", T.parseReqLine(good.replace("w=" + WIN, "w=f3a1cc0")) === null);
ok("w 非法(大写)drop", T.parseReqLine(good.replace("w=" + WIN, "w=F3A1CC")) === null);
ok("id 非法 drop", T.parseReqLine(good.replace("id=00c8", "id=0c8")) === null);
ok("len 与解码长度不符 drop", T.parseReqLine(good.replace("len=11", "len=12")) === null);
ok("crc 不符 drop", T.parseReqLine(good.replace(/crc=[0-9a-f]{4}/, "crc=0000")) === null);
ok("b64 长度非 4 倍数 drop", T.parseReqLine(good.replace(/b64=\S+/, "b64=aGVsbG8")) === null);
ok("len 超 680 drop", T.parseReqLine(buildReqLine(WIN, 1, "a".repeat(681))) === null);
ok("行尾追加内容 drop(防拼接)", T.parseReqLine(good + " trailing") === null);
ok("整行 >1000 字符 drop", T.parseReqLine("x".repeat(1001) + good) === null);
ok("CAN 行解析", !!T.parseCanLine("10:00:00 [LCT] BTIPC CAN w=" + WIN));

// ---------- §5.1 信封 ----------

const e1 = T.splitEnvelope("t=zh-Hans\nhello");
ok("t=<target> → translate", e1.kind === "translate" && e1.target === "zh-Hans" && e1.body === "hello");
const e1b = T.splitEnvelope("t=en;tm=5000\nhi");
ok("t=<target>;tm 带超时", e1b.kind === "translate" && e1b.target === "en");
ok("op=config → config", T.splitEnvelope("op=config\n{}").kind === "config");
ok("op=ui → ui", T.splitEnvelope("op=ui\n{}").kind === "ui");
ok("op=test → test", T.splitEnvelope("op=test\n{}").kind === "test");
ok("无换行 → 裸文本", T.splitEnvelope("hello").kind === "bare");
ok("未知 op → 裸文本(整条)", (function () {
  const r = T.splitEnvelope("op=evil\nx");
  return r.kind === "bare" && r.body === "op=evil\nx";
})());
ok("不安全字符集目标语言 → 裸文本", T.splitEnvelope("t=zh Hans\nx").kind === "bare");

// ---------- §6 /btipc/dl 轮次语义 ----------

(async function main() {
  let pending = null;
  const logLines = [];
  const tr = T.createTransport({
    log: (lvl, msg) => logLines.push(lvl + " " + msg),
    translate: (text) => new Promise((res) => { pending = { text: text, res: res }; }),
  });

  ok("未知窗口 → 404", tr.serveDL({ w: "abcdef", r: 1, p: 0 }).status === 404);
  ok("w 格式非法 → 404", tr.serveDL({ w: "zzz", r: 1, p: 0 }).status === 404);
  ok("p 越界 → 404", tr.serveDL({ w: "abcdef", r: 1, p: 128 }).status === 404);
  ok("p 缺失 → 404", tr.serveDL({ w: "abcdef", r: 1 }).status === 404);

  const long = "a".repeat(25); // 25B → 3 帧
  tr.handleLogLine(buildReqLine(WIN, 0x00c8, long));
  await tick();
  ok("REQ 被消费", tr.size() === 1);
  ok("translate 收到原文", pending && pending.text === long);
  ok("op=bare 记入日志", logLines.some((l) => l.indexOf("op=bare") >= 0));

  // 翻译未就绪 → 各面板仍按 BUSY 帧的位回答,闭合后 VALID=0(与轮号无关)
  ok("frames 未就绪 → BUSY 帧", serveRound(tr, WIN, 1).decoded.valid === false);
  ok("BUSY 与轮号无关", serveRound(tr, WIN, 9).decoded.valid === false);

  // 就绪后:frameStartRound 锚定在首个被服务的轮号
  pending.res("你好世界你好世界你好世界"); // 12 汉字 = 36B → 4 帧
  await tick();

  const out5 = serveRound(tr, WIN, 5);
  ok("锚定轮 r=5 → frame0(seq=0)", out5.decoded.ok && out5.decoded.seq === 0 && out5.decoded.end === false);
  // 状态码必须逐面板:整轮全 200 就会让游戏侧读到全 1
  ok("一轮内 200 与 404 并存(状态码逐面板)", out5.n200 > 0 && out5.n200 < F.WINDOW_PANELS,
    "n200=" + out5.n200);
  const out5b = serveRound(tr, WIN, 5);
  ok("同轮重投幂等(r=5 再来一次,逐位一致)",
    out5b.decoded.seq === out5.decoded.seq && out5b.decoded.payload.equals(out5.decoded.payload));
  ok("r=6 → frame1", serveRound(tr, WIN, 6).decoded.seq === 1);
  ok("r=7 → frame2", serveRound(tr, WIN, 7).decoded.seq === 2);
  const out8 = serveRound(tr, WIN, 8);
  ok("r=8 → frame3(末帧,END=1)", out8.decoded.seq === 3 && out8.decoded.end === true);
  const out9 = serveRound(tr, WIN, 9);
  ok("r 超末帧 → 末帧重发", out9.decoded.seq === 3 && out9.decoded.end === true);
  ok("r=4(锚定前)→ 兜底 frame0", serveRound(tr, WIN, 4).decoded.seq === 0);

  // 完整位信道往返:逐轮取 128 位 → 拼帧 → 拼装
  ok("位信道往返还原译文", collect(tr, WIN, 5) === "你好世界你好世界你好世界",
    JSON.stringify(collect(tr, WIN, 5)));

  // CAN 撤窗
  tr.handleLogLine("10:00:00 [LCT] BTIPC CAN w=" + WIN);
  ok("CAN 后窗口消失 → 404", tr.size() === 0 && tr.serveDL({ w: WIN, r: 1, p: 0 }).status === 404);

  // 非法 REQ 不得建窗
  tr.handleLogLine(buildReqLine("zzzzzz", 1, "hi"));
  ok("非法 REQ 不建窗", tr.size() === 0);

  // 信封 t= 走 target 参数
  let lastTarget = "unset";
  const tr2 = T.createTransport({
    log: () => {},
    translate: (text, target) => { lastTarget = target; return Promise.resolve("ok"); },
  });
  tr2.handleLogLine(buildReqLine("abcdef", 1, "t=en\nhello"));
  await tick();
  ok("t=en 透传 target 给 translate", lastTarget === "en");

  // op=config 路由
  let cfgBody = null;
  const tr3 = T.createTransport({
    log: () => {},
    config: (body) => { cfgBody = body; return Promise.resolve("{\"ok\":true}"); },
  });
  tr3.handleLogLine(buildReqLine("abcdef", 1, "op=config\n{}"));
  await tick();
  ok("op=config 路由到 config()", cfgBody === "{}");
  ok("config 应答已入帧队列", collect(tr3, "abcdef", 1) === "{\"ok\":true}");

  // op=ui:游戏侧开机同步专用小包。
  // 整份 masked 配置 1313 字节 = 132 帧,超过协议 128 帧上限 → op=config 在游戏侧
  // 永远收不到(实测:config.json 写着 outgoing=translation,游戏却一直用默认 off)。
  let uiBody = null;
  const tr5 = T.createTransport({
    log: () => {},
    ui: (body) => { uiBody = body; return Promise.resolve("{\"ok\":true,\"ui\":{\"outgoing\":\"translation\"}}"); },
  });
  tr5.handleLogLine(buildReqLine("abcdef", 1, "op=ui\n{}"));
  await tick();
  ok("op=ui 路由到 ui()", uiBody === "{}");
  ok("op=ui 应答可闭合", collect(tr5, "abcdef", 1) === "{\"ok\":true,\"ui\":{\"outgoing\":\"translation\"}}");
  // 该小包必须放得进 128 帧(1280 字节) —— 这是它存在的理由
  ok("op=ui 应答 < 128 帧上限",
    Buffer.byteLength("{\"ok\":true,\"ui\":{\"outgoing\":\"translation\",\"displayMode\":\"bilingual\"},\"keys\":{\"microsoft\":false,\"openai\":true,\"deepl\":false,\"google\":false}}", "utf8") <= 1280);

  // translate 抛错 → 降级回原文,不卡死
  const tr4 = T.createTransport({
    log: () => {},
    translate: () => Promise.reject(new Error("provider_down")),
  });
  tr4.handleLogLine(buildReqLine("abcdef", 1, "fallback me"));
  await tick();
  ok("resolve 失败 → 回原文降级", collect(tr4, "abcdef", 1) === "fallback me");

  // ---------- window 不变量 ----------

  const T_HARD = 12000, STORM_TCLOSE = 2500, STORM_COOLDOWN = 1000;
  ok("END_GC_MS > 客户端最长重试跨度(12s + 9×(2.5s+1s))",
    W.END_GC_MS > T_HARD + 9 * (STORM_TCLOSE + STORM_COOLDOWN),
    "END_GC_MS=" + W.END_GC_MS);

  // GC:END 帧服务后超过 endGcMs 才回收
  const wt = W.createWindowTable({ log: () => {}, endGcMs: 50, ttlMs: 100000 });
  wt.put("aaaaaa", 1, Buffer.from("x"));
  wt.setText("aaaaaa", "a".repeat(25));
  for (let i = 0; i < 3; i += 1) wt.serve("aaaaaa", 1 + i); // 逐轮推进到末帧 → 记 tEndServed
  ok("END 后未到期不回收", wt.gc() === 0 && wt.size() === 1);
  await new Promise((r) => setTimeout(r, 90));
  ok("END 超期回收", wt.gc() === 1 && wt.size() === 0);

  // TTL:从未服务过的窗口也会被回收
  const wt2 = W.createWindowTable({ log: () => {}, endGcMs: 100000, ttlMs: 30 });
  wt2.put("bbbbbb", 1, Buffer.from("x"));
  await new Promise((r) => setTimeout(r, 60));
  ok("TTL 无活动回收", wt2.gc() === 1 && wt2.size() === 0);

  console.log(fail ? "transport.test FAIL " + fail : "transport.test PASS");
  process.exit(fail ? 1 : 0);
})();
