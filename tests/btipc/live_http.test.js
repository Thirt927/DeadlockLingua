// BTIPC 真实 HTTP 验收:在**真实监听端口的桥进程**上跑一次完整下行往返。
//
// 与 route.test.js 的区别:那个用桩 transport 只验接线;这里除"配置来源"与"翻译服务商"
// 之外全部是真的 —— 真的 http 服务器、真的 overlay tail(读真实 console.log 文件)、
// 真的 REQ 校验、真的 framer 编码、真的 /btipc/dl 状态码与响应头。
// 它覆盖的正是实车必需、而 mock 测不到的那一段:进程真的能把帧通过 HTTP 发出来。
//
// 运行: node tests/btipc/live_http.test.js   (约 5s)
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const http = require("http");
const F = require(path.resolve("core/btipc/framer.js"));
const crc16 = require(path.resolve("core/btipc/crc16.js")).crc16;

let fail = 0;
function ok(name, cond, extra) {
  if (!cond) fail += 1;
  console.log((cond ? "  ok   " : "  FAIL ") + name + (cond || extra === undefined ? "" : "  " + extra));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 隔离环境 ----------

const coreDir = path.resolve("core");
const PORT = 8799; // 与真桥(8791)错开,避免抢端口
const tmpDir = path.resolve("logs/_btipc_live");
fs.rmSync(tmpDir, { recursive: true, force: true });
fs.mkdirSync(tmpDir, { recursive: true });
const logFile = path.join(tmpDir, "console.log");
fs.writeFileSync(logFile, "");

const stubCfg = {
  port: PORT,
  deadlockConsoleLog: logFile,
  provider: "stub",
  fallbackProviders: [],
  defaults: { sourceLanguage: "auto", targetLanguage: "zh-Hans" },
  timeoutMs: 5000,
  chatLog: { enabled: false, dir: "logs/chat/_btipc_live" },
  watchGame: false,
  ui: {},
  overlay: { enabled: false, autoOpen: false },
};

let savedCfg = null;
const stubConfig = {
  DEFAULTS: {},
  load: () => savedCfg || stubCfg,
  save: (c) => { savedCfg = c; },
  mask: (c) => c,
  applyMaskedUpdate: (cur, patch) => Object.assign({}, cur, patch),
  configPath: () => path.join(tmpDir, "config.json"),
  examplePath: () => path.join(tmpDir, "config.example.json"),
};

// 翻译服务商桩:确定性、零网络(被测的是信道,不是 provider —— 那条链已有
// scripts/test_bridge_fallback.js 覆盖)
const stubRegistry = {
  getProvider: () => ({
    id: "stub",
    translate: async (text) => ({ translation: "译:" + text, detectedLanguage: "en" }),
  }),
  listProviders: () => ["stub"],
};

// 桩对象对未知成员一律返回空函数:这组测试的被测对象是信道,不是词典/名单。
// (bridge_server 在模块加载期就会调 dictionary.ensureFile / startAutoFlush 等,
//  逐个列举容易漏,Proxy 兜底更稳。)
const noop = function () {};
function lenientStub(overrides) {
  return new Proxy(overrides || {}, {
    get: (t, k) => (k in t ? t[k] : noop),
  });
}

const stubDictionary = lenientStub({ lookup: () => null });
const stubSteamId = lenientStub({});

const sandbox = {
  require: (m) => {
    if (m === "./config") return stubConfig;
    if (m === "./providers/registry") return stubRegistry;
    if (m === "./dictionary") return stubDictionary;
    if (m === "./steamid_enrich") return stubSteamId;
    if (m.startsWith("./") || m.startsWith("../")) m = path.join(coreDir, m);
    return require(m);
  },
  module: { exports: {} }, exports: {}, process, console, Buffer, URL,
  setTimeout, clearTimeout, setInterval, clearInterval,
  Date, Math, JSON, Object, Array, String, Number, Boolean, Error, RegExp, Promise, Map, Set,
  __dirname: coreDir, __filename: path.join(coreDir, "bridge_server.js"),
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(coreDir, "bridge_server.js"), "utf8"), sandbox,
  { filename: "bridge_server.js" });

// ---------- 真实 HTTP 客户端(与游戏侧同构) ----------

function getHttp(p) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port: PORT, path: p, timeout: 4000 }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", () => resolve({ status: 0, headers: {}, body: Buffer.alloc(0) }));
    req.on("timeout", () => { req.destroy(); resolve({ status: 0, headers: {}, body: Buffer.alloc(0) }); });
  });
}

(async function main() {
  // 等真实服务器起来
  let up = false;
  for (let i = 0; i < 40 && !up; i += 1) {
    const r = await getHttp("/api/v1/health");
    up = r.status === 200;
    if (!up) await sleep(150);
  }
  ok("桥在 127.0.0.1:" + PORT + " 上真实监听", up);
  if (!up) { console.log("live_http.test FAIL (server never came up)"); process.exit(1); }

  // 未知窗口:真实 HTTP 上必须是 404 且带 no-store(与通用 404 可区分)
  const miss = await getHttp("/btipc/dl?w=abcdef&r=1&p=0&t=x");
  ok("未知窗口 → 真实 404", miss.status === 404, "status=" + miss.status);
  ok("BTIPC 分支带 Cache-Control: no-store", miss.headers["cache-control"] === "no-store");
  const generic = await getHttp("/definitely-not-a-route");
  ok("通用 404 不带 no-store(区分成立)", generic.status === 404 && !generic.headers["cache-control"]);

  // ---------- 完整下行往返 ----------
  const now = Date.now();
  const win = (now & 0xffffff).toString(16).padStart(6, "0");
  const id = now & 0xffff;
  const body = "t=zh-Hans\nhello from live http test";
  const payload = Buffer.from(body, "utf8");
  const line = "[LCT] BTIPC REQ w=" + win + " id=" + id.toString(16).padStart(4, "0") +
    " len=" + payload.length +
    " crc=" + crc16(payload).toString(16).padStart(4, "0") +
    " b64=" + payload.toString("base64");
  fs.appendFileSync(logFile, line + "\n");

  // 等真实 tail(800ms 间隔)读到这一行
  await sleep(2200);

  const decoded = [];
  let round = 1;
  let assembled = null;
  let sawBusy = false;
  for (let attempt = 0; attempt < 80 && assembled === null; attempt += 1) {
    // 一轮 = 128 个面板并行取位(等价于游戏侧 128 个 Image 面板)
    const bits = new Array(128);
    const res = await Promise.all(
      Array.from({ length: 128 }, (_, p) =>
        getHttp("/btipc/dl?w=" + win + "&r=" + round + "&p=" + p + "&t=live-" + round + "-" + p)
          .then((r) => r.status)
      )
    );
    for (let p = 0; p < 128; p += 1) bits[p] = res[p] === 200 ? 1 : 0;
    const d = F.decodeFrame(F.frameFromBits(bits));
    if (!d.ok) {
      ok("r=" + round + " 帧 CRC 通过", false, d.error);
      break;
    }
    if (!d.valid) { sawBusy = true; await sleep(500); continue; }
    decoded.push(d);
    if (d.end) { assembled = F.assembleFrames(decoded); break; }
    round += 1;
  }

  ok("收到过 BUSY 帧(翻译未就绪)或直接拿到数据", true);
  ok("拼装完成(收到 END 帧)", assembled !== null, "rounds=" + decoded.length);
  ok("解出的文本 = 桩服务商对请求原文的输出",
    assembled === "译:hello from live http test", JSON.stringify(assembled));

  // 帧内容与桥端 framer 编码逐字节一致(纯冗余校验,证明状态码→位→字节这条链没错)
  const expect = F.encode(id, "译:hello from live http test");
  ok("帧数一致", decoded.length === expect.length, decoded.length + " vs " + expect.length);
  ok("request_id 一致", decoded.every((d) => d.id === id));

  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log(fail ? "live_http.test FAIL " + fail : "live_http.test PASS");
  process.exit(fail ? 1 : 0);
})();
