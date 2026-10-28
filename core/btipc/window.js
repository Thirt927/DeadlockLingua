// Babel Tower - BTIPC 桥端窗口表(per window 状态机)
//
// 协议依据: docs/btipc-v1.md §6(桥端状态机)、§14.2(窗口隔离)。
//
// 铁律:
//   - 桥端**不维护** nextFrameIdx 之类的自增计数器(会与游戏脱步)。
//     帧号只由轮号现算: frameIndex = round - frameStartRound
//     → 同一个 round 重投天然幂等得同帧,零额外状态。
//   - 所有传输状态只经 Map<win, Transfer> 读写,窗口之间不得互相覆盖。
//   - frames 未就绪 → 回 BUSY 固定帧(VALID=0),与轮号无关。
"use strict";

const framer = require("./framer");

// 窗口无活动 TTL
const TTL_MS = 60000;
// END 帧被服务后的保留时长。必须 > 客户端最长重试跨度
// (T_HARD 12s + 9×(STORM_TCLOSE 2.5s + 冷却 1s) ≈ 40s),否则窗口会在客户端
// 仍在重试时自删 → 128 面板全 404 → 全零位 → CRC 必败 → 误报 crc_dead。
// 上游实车抓到过该现场(单轮卡 25s),故取 45s。
const END_GC_MS = 45000;

function createWindowTable(opts) {
  const o = opts || {};
  const log = typeof o.log === "function" ? o.log : function () {};
  const ttlMs = Number(o.ttlMs) > 0 ? Number(o.ttlMs) : TTL_MS;
  const endGcMs = Number(o.endGcMs) > 0 ? Number(o.endGcMs) : END_GC_MS;
  const table = new Map();

  // REQ 到达:同 w 幂等覆盖(游戏超时重发是正常路径,不是滥用);新 w 建窗。
  function put(win, id, payload) {
    table.set(win, {
      id: id,
      payload: payload,
      tReq: Date.now(),
      frames: null,
      frameStartRound: null,
      tEndServed: 0,
      tLast: Date.now(),
      served: 0,
    });
  }

  function has(win) {
    return table.has(win);
  }

  function get(win) {
    return table.get(win) || null;
  }

  // 翻译完成 → 填帧队列
  function setFrames(win, frames) {
    const w = table.get(win);
    if (!w) return false;
    w.frames = frames;
    w.tLast = Date.now();
    return true;
  }

  // 便捷:文本 → 帧(内部走 framer.encode,超限会抛 too_long)
  function setText(win, text) {
    const w = table.get(win);
    if (!w) return false;
    w.frames = framer.encode(w.id, text);
    w.tLast = Date.now();
    return true;
  }

  function cancel(win) {
    return table.delete(win);
  }

  // /btipc/dl?w&r 的应答。返回 { status, frame }:
  //   404 → 窗口不存在(游戏侧视为 BUSY 等价,继续轮询)
  //   200 → frame 为 16 字节(可能是 BUSY 固定帧)
  function serve(win, round) {
    const w = table.get(win);
    if (!w) return { status: 404, frame: null };
    const r = Number.isFinite(round) ? Math.floor(round) : 0;
    w.tLast = Date.now();
    w.served += 1;

    if (!w.frames) {
      return { status: 200, frame: framer.buildBusyFrame(w.id), busy: true, frameIndex: -1 };
    }
    if (w.frameStartRound === null) w.frameStartRound = r;
    const last = w.frames.length - 1;
    const raw = r - w.frameStartRound;
    const idx = raw < 0 ? 0 : Math.min(raw, last);
    if (idx === last && !w.tEndServed) w.tEndServed = Date.now();
    return {
      status: 200,
      frame: w.frames[idx],
      busy: false,
      frameIndex: idx,
      end: idx === last,
      repeat: raw > last,
    };
  }

  // 双条件回收:END 帧服务后 endGcMs,或窗口 ttlMs 无活动。
  function gc() {
    const now = Date.now();
    let removed = 0;
    for (const entry of Array.from(table.entries())) {
      const win = entry[0];
      const w = entry[1];
      const idle = now - w.tLast;
      const endAge = w.tEndServed ? now - w.tEndServed : 0;
      if ((w.tEndServed > 0 && endAge > endGcMs) || idle > ttlMs) {
        table.delete(win);
        removed += 1;
      }
    }
    if (removed > 0) log("debug", "BTIPC GC removed=" + removed + " remain=" + table.size);
    return removed;
  }

  function size() {
    return table.size;
  }

  function reset() {
    table.clear();
  }

  return {
    put: put,
    has: has,
    get: get,
    setFrames: setFrames,
    setText: setText,
    cancel: cancel,
    serve: serve,
    gc: gc,
    size: size,
    reset: reset,
    _table: table,
  };
}

module.exports = {
  TTL_MS: TTL_MS,
  END_GC_MS: END_GC_MS,
  createWindowTable: createWindowTable,
};
