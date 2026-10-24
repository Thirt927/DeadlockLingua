// BTIPC 接线验收:bridge_server 的 /btipc/dl 路由 + overlay onLine 转发 + GC 定时器
//
// 用 VM 沙箱 + 桩模块把 bridge_server 单独加载起来(沿用 scripts/test_bridge_dedup.js 的手法):
// 只验**接线**,不验协议 —— 协议语义由 crc / frame / transport 三个套件覆盖。
//
// 运行: node tests/btipc/route.test.js
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

let fail = 0;
function ok(name, cond, extra) {
  if (!cond) fail += 1;
  console.log((cond ? "  ok   " : "  FAIL ") + name + (cond || extra === undefined ? "" : "  " + extra));
}

// ---------- 桩 ----------

let capturedHandler = null;
const serveCalls = [];
const lineCalls = [];
const BIT1 = Buffer.from("PNGSTUB");

const fakeHttp = {
  createServer: (handler) => {
    capturedHandler = handler;
    return { on: () => {}, listen: () => {}, setTimeout: () => {} };
  },
};

const stubTransport = {
  MAX_LINE: 1000,
  BIT1_PNG: BIT1,
  parseReqLine: () => null,
  parseCanLine: () => null,
  splitEnvelope: () => ({ kind: "bare", body: "" }),
  createTransport: () => ({
    serveDL: (q) => {
      serveCalls.push(q);
      // 用一个魔法窗口号让桩返回 200,其余一律 404
      if (q && q.w === "200ok0") return { status: 200, body: BIT1, busy: false, frameIndex: 0 };
      return { status: 404, body: null };
    },
    handleLogLine: (l) => { lineCalls.push(l); return true; },
    gc: () => 3,
    size: () => 0,
    reset: () => {},
  }),
};

let overlayDeps = null;
const stubOverlay = {
  CHAT_MARKER: "[LCT-CHAT]",
  start: (d) => { overlayDeps = d; },
  stop: () => {}, reset: () => {},
  list: () => [], latestSeq: () => 0, sessionId: () => 0,
  clearMessages: () => {}, pageHtml: () => "", ingestLine: () => {},
};

const intervals = [];
const coreDir = path.resolve("core");
const sandbox = {
  require: (m) => {
    if (m === "http") return fakeHttp;
    // 本套只验路由接线;bridge_server 加载时 startGameWatch() 会 execFile("tasklist"),
    // 在受限沙箱/无桌面环境里 spawn 会被拒(EPERM)并把测试卡死。这里桩掉子进程即可,
    // 与 /btipc/dl 路由本身无关。
    if (m === "child_process") {
      return {
        execFile: (f, a, cb) => { if (typeof cb === "function") cb(new Error("stub"), "", ""); },
        exec: () => {},
        spawn: () => ({ on: () => {}, unref: () => {} }),
      };
    }
    if (m === "./btipc/transport") return stubTransport;
    if (m === "./overlay") return stubOverlay;
    if (m.startsWith("./") || m.startsWith("../")) m = path.join(coreDir, m);
    return require(m);
  },
  module: { exports: {} }, exports: {}, process, console, Buffer, URL,
  setTimeout: (fn, ms) => { intervals.push(["timeout", ms]); return { unref: () => {} }; },
  clearTimeout: () => {},
  setInterval: (fn, ms) => { intervals.push(["interval", ms]); return { unref: () => {} }; },
  clearInterval: () => {},
  __dirname: coreDir, __filename: path.join(coreDir, "bridge_server.js"),
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(coreDir, "bridge_server.js"), "utf8"), sandbox,
  { filename: "bridge_server.js" });

ok("bridge_server 在沙箱内加载成功(含新 require)", typeof capturedHandler === "function");

// ---------- 假 req / res ----------

function mockRes() {
  return {
    statusCode: 0,
    headers: {},
    body: null,
    setHeader: function (k, v) { this.headers[k.toLowerCase()] = v; },
    end: function (b) { this.body = b === undefined || b === null ? "" : b; },
  };
}
function get(p) {
  const res = mockRes();
  capturedHandler({ url: p, method: "GET", headers: {}, on: () => {} }, res);
  return res;
}

// 位 1:200 + PNG + 不可缓存
const hit = get("/btipc/dl?w=200ok0&r=7&p=3&t=nonce123");
ok("桩返回 200 时 → 200", hit.statusCode === 200, "status=" + hit.statusCode);
ok("位1 → Content-Type image/png", hit.headers["content-type"] === "image/png");
ok("位1 → 带 PNG 体", Buffer.isBuffer(hit.body) && hit.body.equals(BIT1));
ok("响应不可缓存", hit.headers["cache-control"] === "no-store");
ok("查询参数原样透传给 serveDL(含 p)",
  (function () {
    const c = serveCalls[serveCalls.length - 1];
    return c.w === "200ok0" && c.r === "7" && c.p === "3" && c.t === "nonce123";
  })(), JSON.stringify(serveCalls[serveCalls.length - 1]));

// 位 0:必须真 404 且空体(引擎对非 200 不触发 ImageLoaded)
const miss = get("/btipc/dl?w=abcdef&r=1&p=0&t=x");
ok("位0 → 404", miss.statusCode === 404, "status=" + miss.statusCode);
ok("位0 → 空体", miss.body === "" || (Buffer.isBuffer(miss.body) && miss.body.length === 0));
ok("位0 → 也带 no-store(证明走的是 BTIPC 分支)", miss.headers["cache-control"] === "no-store");

// 未注册路径仍走通用 404(证明路由没把别的请求吞掉)
const other = get("/not-a-route");
ok("未知路径 → 通用 404", other.statusCode === 404 && String(other.body) === "not found",
  "status=" + other.statusCode + " body=" + String(other.body));

// ---------- overlay onLine 转发 ----------

ok("overlay.start 收到 onLine 回调", overlayDeps && typeof overlayDeps.onLine === "function");
if (overlayDeps && typeof overlayDeps.onLine === "function") {
  overlayDeps.onLine("20:00:00 [PanoramaScript] [LCT] BTIPC REQ w=abcdef id=0001 len=0 crc=ffff b64=");
  ok("onLine 把日志行转给 BTIPC 传输层",
    lineCalls.length === 1 && lineCalls[0].indexOf("BTIPC REQ") > 0);
  overlayDeps.onLine("20:00:01 [PanoramaScript] [LCT-CHAT]{\"t\":\"hi\"}");
  ok("普通聊天行也转发(由 BTIPC 自行过滤)", lineCalls.length === 2);
}

// ---------- GC 定时器 ----------

ok("注册了 5000ms 的 BTIPC GC 定时器",
  intervals.some((i) => i[0] === "interval" && i[1] === 5000),
  JSON.stringify(intervals));

console.log(fail ? "route.test FAIL " + fail : "route.test PASS");
process.exit(fail ? 1 : 0);
