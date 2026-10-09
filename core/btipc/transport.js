// Babel Tower - BTIPC 桥端传输层
//
// 协议依据: docs/btipc-v1.md §5(出站行格式)、§5.1(上层信封)、§13.2(职责)、§14(校验)。
//
// 两条独立的线,共用同一套帧/窗口核心:
//   上行 游戏 → 桥: console.log 里的 `[LCT] BTIPC REQ ...` 结构化单行(本模块解析)
//   下行 桥 → 游戏: GET /btipc/dl?w&r&p&t(本模块应答)
//
// 位编码(§3.1):位=1 → HTTP 200 + PNG;位=0 → HTTP 404(空体)。
// 游戏侧只认这两个符号,所以这里的 body 内容本身不重要 —— 重要的是状态码。
"use strict";

const crc16 = require("./crc16").crc16;
const framer = require("./framer");
const windowsMod = require("./window");

// §14.1:整行 ≤1000 字符(J1 实测上限)
const MAX_LINE = 1000;

// 1x1 透明 PNG:位=1 时回它(引擎只要能成功解码出图片就会 fire ImageLoaded)
const BIT1_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64"
);

// 行尾锚定:从 `[LCT] BTIPC` 起整体匹配到行尾(允许尾随 \r),防拼接注入
const REQ_RE = /^\[LCT\] BTIPC REQ w=([0-9a-f]{6}) id=([0-9a-f]{4}) len=(\d{1,4}) crc=([0-9a-f]{4}) b64=([A-Za-z0-9+/=]*)$/;
const CAN_RE = /^\[LCT\] BTIPC CAN w=([0-9a-f]{6})$/;

// §5.1 上层信封白名单
const ENV_OP_RE = /^op=(config|test)(;tm=\d{1,7})?$/;
const ENV_T_RE = /^t=([A-Za-z0-9-]{1,16})(;tm=\d{1,7})?$/;

// 解析一行日志里的 REQ。返回 null 表示不是(或不是合法的)REQ 行。
// 校验全部通过才受理,任一不过静默 drop(只记 WARN,不回显到任何游戏可见通道)。
function parseReqLine(line) {
  if (line === null || line === undefined) return null;
  const s = String(line);
  if (s.length > MAX_LINE) return null;
  const at = s.indexOf("[LCT] BTIPC");
  if (at < 0) return null;
  const m = REQ_RE.exec(s.slice(at).replace(/\r+$/, ""));
  if (!m) return null;

  const win = m[1];
  const idHex = m[2];
  const len = Number(m[3]);
  const crcHex = m[4];
  const b64 = m[5];

  if (!Number.isFinite(len) || len < 0 || len > framer.MAX_PAYLOAD_BYTES) return null;
  // 严格 base64:字符集 + 长度 mod 4 + 解码不抛
  if (b64.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) return null;
  let payload;
  try {
    payload = Buffer.from(b64, "base64");
  } catch (e) {
    return null;
  }
  if (payload.length !== len) return null;
  const crc = crc16(payload).toString(16).padStart(4, "0");
  if (crc !== crcHex) return null;

  return { win: win, id: parseInt(idHex, 16), len: len, payload: payload };
}

function parseCanLine(line) {
  if (line === null || line === undefined) return null;
  const s = String(line);
  if (s.length > MAX_LINE) return null;
  const at = s.indexOf("[LCT] BTIPC");
  if (at < 0) return null;
  const m = CAN_RE.exec(s.slice(at).replace(/\r+$/, ""));
  return m ? { win: m[1] } : null;
}

// §5.1 信封:payload 首行是信封头 + \n,其余按裸文本透传。
function splitEnvelope(text) {
  const s = String(text === null || text === undefined ? "" : text);
  const nl = s.indexOf("\n");
  if (nl < 0) return { kind: "bare", body: s };
  const head = s.slice(0, nl);
  const body = s.slice(nl + 1);
  const op = ENV_OP_RE.exec(head);
  if (op) return { kind: op[1] === "config" ? "config" : "test", body: body, head: head };
  const t = ENV_T_RE.exec(head);
  if (t) return { kind: "translate", target: t[1], body: body, head: head };
  // 未知 op / 未知键 / 不安全字符集 → 整条按裸文本(向后兼容老客户端与冒烟命令)
  return { kind: "bare", body: s };
}

// deps:
//   log(line)                       日志
//   translate(text, target)         → Promise<string>  target=null 表示用配置默认目标语言
//   test(body)                      → Promise<string>(JSON 文本)
//   config(body)                    → Promise<string>(JSON 文本)
//   tablesOpts                      → 透传给窗口表(测试用)
function createTransport(deps) {
  const d = deps || {};
  const log = typeof d.log === "function" ? d.log : function () {};
  const tables = windowsMod.createWindowTable({ log: log, ttlMs: d.ttlMs, endGcMs: d.endGcMs });

  function resolvePayload(text) {
    const env = splitEnvelope(text);
    if (env.kind === "config") {
      if (typeof d.config !== "function") return Promise.resolve("{\"ok\":false,\"error\":\"config_unsupported\"}");
      return Promise.resolve(d.config(env.body));
    }
    if (env.kind === "test") {
      if (typeof d.test !== "function") return Promise.resolve("{\"ok\":false,\"error\":\"test_unsupported\"}");
      return Promise.resolve(d.test(env.body));
    }
    if (env.kind === "translate") {
      if (typeof d.translate !== "function") return Promise.resolve(env.body);
      return Promise.resolve(d.translate(env.body, env.target));
    }
    // 裸文本:整条按原文翻译(目标语言交给桥的默认配置)
    if (typeof d.translate !== "function") return Promise.resolve(text);
    return Promise.resolve(d.translate(text, null));
  }

  function accept(req) {
    tables.put(req.win, req.id, req.payload);
    const text = req.payload.toString("utf8");
    const op = splitEnvelope(text).kind;
    log("info", "BTIPC TRQ w=" + req.win + " id=" + req.id + " len=" + req.len + " op=" + op);
    resolvePayload(text)
      .then(function (out) {
        const s = out === null || out === undefined ? "" : String(out);
        tables.setText(req.win, s);
        log("info", "BTIPC RSP w=" + req.win + " frames=" + framer.encode(req.id, s).length +
          " bytes=" + Buffer.byteLength(s, "utf8"));
      })
      .catch(function (e) {
        const msg = (e && e.message) || String(e);
        log("warn", "BTIPC resolve failed w=" + req.win + ": " + msg);
        // 降级:回原文(游戏侧表现为"未翻译",不会卡死)
        try {
          tables.setText(req.win, text);
        } catch (e2) {
          log("warn", "BTIPC degrade failed w=" + req.win + ": " + ((e2 && e2.message) || String(e2)));
        }
      });
    return true;
  }

  // 喂一行 console.log。返回 true = 本行被 BTIPC 消费。
  function handleLogLine(line) {
    const req = parseReqLine(line);
    if (req) return accept(req);
    const can = parseCanLine(line);
    if (can) {
      tables.cancel(can.win);
      log("info", "BTIPC CAN w=" + can.win);
      return true;
    }
    return false;
  }

  // GET /btipc/dl?w&r&p&t。p 只用于 URL 唯一性(防引擎缓存串窗),桥端不需要它 ——
  // 帧里已经含全部 128 位,每个面板各自读自己那一位。
  function serveDL(query) {
    const q = query || {};
    const win = String(q.w === undefined || q.w === null ? "" : q.w);
    if (!/^[0-9a-f]{6}$/.test(win)) return { status: 404, body: null };
    const r = Number(q.r);
    const res = tables.serve(win, Number.isFinite(r) ? r : 0);
    if (res.status !== 200) return { status: 404, body: null };
    return {
      status: 200,
      body: BIT1_PNG,
      busy: !!res.busy,
      frameIndex: res.frameIndex,
      end: !!res.end,
      repeat: !!res.repeat,
      frame: res.frame,
    };
  }

  return {
    handleLogLine: handleLogLine,
    serveDL: serveDL,
    gc: tables.gc,
    size: tables.size,
    reset: tables.reset,
    windows: tables,
  };
}

module.exports = {
  MAX_LINE: MAX_LINE,
  BIT1_PNG: BIT1_PNG,
  parseReqLine: parseReqLine,
  parseCanLine: parseCanLine,
  splitEnvelope: splitEnvelope,
  createTransport: createTransport,
};
