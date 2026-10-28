// Babel Tower - BTIPC 桥端帧编解码
//
// 协议依据: docs/btipc-v1.md §3(帧格式)、§4(轮次生命周期)、§9(参数表)。
//
// 一帧 = 16 字节 = 128 bit,恰好对应游戏侧 128 个隐藏 Image 面板:
//   面板 p 携带全局第 p 位,LSB 在前 —— 即 byte k 的 bit b → 面板 k*8+b。
//
// 帧布局(冻结):
//   +----+----+----+----+----+----+------------+
//   | B0 | B1 | B2 | B3 |CRCH|CRCL|  Payload   |
//   +----+----+----+----+----+----+------------+
//   B0      : bit7 = END,      bit0..6 = seq(0..127)
//   B1..B2  : request_id(16 bit,大端)
//   B3      : bit7 = VALID,    bit0..6 = LEN(0..10)
//   B4..B5  : CRC-16/CCITT-FALSE(大端)
//   B6..B15 : payload(10 字节,LEN 不足处补 0x00)
//
// CRC 覆盖 B0..B3 + B6..B15 = 固定 14 字节(含 LEN 之后的 0x00 填充),
// 不含 CRC 自身。seq / id / VALID / LEN 全属协议控制信息,所以 round 错位或
// LEN 被篡改都会被 CRC 揪出。
"use strict";

const crc16 = require("./crc16").crc16;

const FRAME_BYTES = 16;
const WINDOW_PANELS = FRAME_BYTES * 8; // 128
const PAYLOAD_PER_FRAME = FRAME_BYTES - 6; // 10
const MAX_SEQ = 127;
// §9 REQ_MAX_PAYLOAD:受 console.log 整行 ≤1000 字符约束(680B → 68 帧 ≤ seq7 上限)
const MAX_PAYLOAD_BYTES = 680;

// CRC 输入 = B0..B3 + payload(B6..B15),固定 14 字节
function crcInput(b0, b1, b2, b3, payload) {
  const buf = Buffer.alloc(14);
  buf[0] = b0 & 0xff;
  buf[1] = b1 & 0xff;
  buf[2] = b2 & 0xff;
  buf[3] = b3 & 0xff;
  payload.copy(buf, 4, 0, 10);
  return buf;
}

// 组装一个数据帧。payload 长度不足 10 时右侧补 0x00。
function buildFrame(id, seq, end, valid, len, payload) {
  const buf = Buffer.alloc(FRAME_BYTES);
  const b0 = (end ? 0x80 : 0) | (seq & 0x7f);
  const b3 = (valid ? 0x80 : 0) | (len & 0x7f);
  const b1 = (id >> 8) & 0xff;
  const b2 = id & 0xff;
  const body = Buffer.alloc(PAYLOAD_PER_FRAME);
  if (payload && payload.length) payload.copy(body, 0, 0, Math.min(payload.length, PAYLOAD_PER_FRAME));
  const crc = crc16(crcInput(b0, b1, b2, b3, body));
  buf[0] = b0;
  buf[1] = b1;
  buf[2] = b2;
  buf[3] = b3;
  buf[4] = (crc >> 8) & 0xff;
  buf[5] = crc & 0xff;
  body.copy(buf, 6);
  return buf;
}

// BUSY 固定帧(§3.2 冻结,不随机):VALID=0 → 游戏侧只判 BUSY,不跑重组逻辑。
// B0 = 0x00(seq=0, END=0) / B3 = 0x00(VALID=0, LEN=0) / payload 全 0。
function buildBusyFrame(id) {
  return buildFrame(id || 0, 0, false, false, 0, null);
}

// 文本 → 帧数组。空文本 = 单帧 len=0 + END。
function encode(id, text) {
  const bytes = Buffer.from(text === null || text === undefined ? "" : String(text), "utf8");
  if (bytes.length > MAX_PAYLOAD_BYTES) {
    const err = new Error("btipc_payload_too_long");
    err.kind = "too_long";
    err.bytes = bytes.length;
    err.limit = MAX_PAYLOAD_BYTES;
    throw err;
  }
  const count = Math.max(1, Math.ceil(bytes.length / PAYLOAD_PER_FRAME));
  if (count > MAX_SEQ + 1) {
    const err = new Error("btipc_too_many_frames");
    err.kind = "too_long";
    err.frames = count;
    throw err;
  }
  const frames = [];
  for (let i = 0; i < count; i += 1) {
    const start = i * PAYLOAD_PER_FRAME;
    const chunk = bytes.slice(start, Math.min(start + PAYLOAD_PER_FRAME, bytes.length));
    frames.push(buildFrame(id, i, i === count - 1, true, chunk.length, chunk));
  }
  return frames;
}

// 单帧解码(含 CRC 校验)。ok=false 时其余字段仅供排查,不应采信。
function decodeFrame(buf) {
  if (!buf || buf.length !== FRAME_BYTES) {
    return { ok: false, error: "bad_frame_size", size: buf ? buf.length : -1 };
  }
  const payload = Buffer.from(buf.slice(6, 16));
  const b0 = buf[0];
  const b1 = buf[1];
  const b2 = buf[2];
  const b3 = buf[3];
  const crcExpect = (buf[4] << 8) | buf[5];
  const crcActual = crc16(crcInput(b0, b1, b2, b3, payload));
  const len = b3 & 0x7f;
  const seq = b0 & 0x7f;
  const crcOk = crcExpect === crcActual;
  const lenOk = len <= PAYLOAD_PER_FRAME;
  const seqOk = seq <= MAX_SEQ;
  return {
    ok: crcOk && lenOk && seqOk,
    crcOk: crcOk,
    crcExpect: crcExpect,
    crcActual: crcActual,
    lenOk: lenOk,
    seqOk: seqOk,
    error: crcOk ? (lenOk ? (seqOk ? "" : "bad_seq") : "bad_len") : "crc_mismatch",
    end: (b0 & 0x80) !== 0,
    seq: seq,
    id: (b1 << 8) | b2,
    valid: (b3 & 0x80) !== 0,
    len: len,
    payload: payload,
  };
}

// 16 字节 → 128 位(面板 p ← byte[p>>3] 的 bit(p&7),LSB 在前)
function bitsOfFrame(buf) {
  const bits = new Uint8Array(WINDOW_PANELS);
  for (let p = 0; p < WINDOW_PANELS; p += 1) {
    bits[p] = (buf[p >> 3] >> (p & 7)) & 1;
  }
  return bits;
}

// 128 位 → 16 字节(游戏侧闭合后组帧走这里;测试与仿真器用)
function frameFromBits(bits) {
  const buf = Buffer.alloc(FRAME_BYTES);
  for (let p = 0; p < WINDOW_PANELS; p += 1) {
    if (bits[p]) buf[p >> 3] |= 1 << (p & 7);
  }
  return buf;
}

// 按 seq 顺序把若干已解码帧的 payload 拼回文本。
// 每个数据帧贡献 payload 的前 len 字节;END 帧的 len 给出有效尾长。
function assembleFrames(decoded) {
  const list = decoded.slice().sort(function (a, b) { return a.seq - b.seq; });
  const parts = [];
  for (const f of list) {
    if (!f.valid) continue;
    const take = Math.max(0, Math.min(f.len, PAYLOAD_PER_FRAME));
    if (take > 0) parts.push(f.payload.slice(0, take));
  }
  return Buffer.concat(parts).toString("utf8");
}

module.exports = {
  FRAME_BYTES: FRAME_BYTES,
  WINDOW_PANELS: WINDOW_PANELS,
  PAYLOAD_PER_FRAME: PAYLOAD_PER_FRAME,
  MAX_SEQ: MAX_SEQ,
  MAX_PAYLOAD_BYTES: MAX_PAYLOAD_BYTES,
  buildFrame: buildFrame,
  buildBusyFrame: buildBusyFrame,
  encode: encode,
  decodeFrame: decodeFrame,
  bitsOfFrame: bitsOfFrame,
  frameFromBits: frameFromBits,
  assembleFrames: assembleFrames,
};
