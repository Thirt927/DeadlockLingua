// BTIPC §12.2 验收:framer 往返 + §3.3 位序例 + §3.2 BUSY 固定帧
// 运行: node tests/btipc/frame.test.js
"use strict";

const path = require("path");
const F = require(path.resolve("core/btipc/framer.js"));

let fail = 0;
function ok(name, cond, extra) {
  if (!cond) fail += 1;
  console.log((cond ? "  ok   " : "  FAIL ") + name + (cond || extra === undefined ? "" : "  " + extra));
}

// ---------- 往返 ----------

function roundTrip(label, text) {
  const id = 0x00c8;
  const frames = F.encode(id, text);
  const decoded = frames.map(F.decodeFrame);
  for (const d of decoded) {
    if (!d.ok) { ok(label + " 每帧 CRC 通过", false, "frame err=" + d.error); return; }
  }
  const back = F.assembleFrames(decoded);
  ok(label + " 往返逐字节相等 (frames=" + frames.length + ")", back === text,
    back === text ? "" : "got=" + JSON.stringify(back.slice(0, 40)));
  ok(label + " 末帧 END=1", decoded[decoded.length - 1].end === true);
  ok(label + " 仅末帧 END=1", decoded.filter((d) => d.end).length === 1);
  ok(label + " 全部 VALID=1", decoded.every((d) => d.valid === true));
  ok(label + " frame id 一致", decoded.every((d) => d.id === id));
  // 位映射往返
  ok(label + " bits↔frame 往返", frames.every((f) => F.frameFromBits(F.bitsOfFrame(f)).equals(f)));
}

roundTrip("空文本", "");
roundTrip("10B 整帧", "abcdefghij");
roundTrip("11B 跨帧", "abcdefghijk");
roundTrip("300B 中文(多帧)", "测".repeat(100));
roundTrip("680B 上限", "a".repeat(F.MAX_PAYLOAD_BYTES));

// 帧数符合 §9:每帧 10B 载荷
ok("11B → 2 帧", F.encode(1, "abcdefghijk").length === 2);
ok("10B → 1 帧", F.encode(1, "abcdefghij").length === 1);
ok("300B → 30 帧", F.encode(1, "测".repeat(100)).length === 30);
ok("680B → 68 帧且 seq ≤ 127", F.encode(1, "a".repeat(680)).length === 68);

// 超限必须立刻拒(§8 too_long)
try {
  F.encode(1, "a".repeat(F.MAX_PAYLOAD_BYTES + 1));
  ok("681B 抛 too_long", false, "未抛错");
} catch (e) {
  ok("681B 抛 too_long", e.kind === "too_long");
}

// ---------- §3.3 位序 worked example ----------

// B0 = 0x01(seq=1,END=0)、B1 = 0xA5 → fires {0,8,10,13,15}
const example = F.buildFrame(0xa500, 1, false, true, 0, null);
ok("位序例 B0=0x01", example[0] === 0x01, "got 0x" + example[0].toString(16));
ok("位序例 B1=0xA5", example[1] === 0xa5, "got 0x" + example[1].toString(16));
const bits = F.bitsOfFrame(example);
// §3.3 只定义前两个字节(B0/B1 → 面板 0..15)的位映射。B3 的 VALID 位与
// B4/B5 的 CRC 字节会落在后面的面板上,不属于该例,故只取前 16 位比对。
const fires = [];
for (let i = 0; i < 16; i += 1) if (bits[i]) fires.push(i);
const expectFires = [0, 8, 10, 13, 15];
ok("位序例 面板0..15 fires = {0,8,10,13,15}",
  fires.length === expectFires.length && fires.every((v, i) => v === expectFires[i]),
  "got {" + fires.join(",") + "}");

// ---------- §3.2 BUSY 固定帧 ----------

const busy = F.buildBusyFrame(0x00c8);
ok("BUSY B0=0x00", busy[0] === 0x00, "got 0x" + busy[0].toString(16));
ok("BUSY B1..B2 = request_id", busy[1] === 0x00 && busy[2] === 0xc8);
ok("BUSY B3=0x00", busy[3] === 0x00, "got 0x" + busy[3].toString(16));
ok("BUSY payload 全 0", busy.slice(6).every((b) => b === 0));
const busyDecoded = F.decodeFrame(busy);
ok("BUSY CRC 通过", busyDecoded.crcOk === true);
ok("BUSY VALID=0", busyDecoded.valid === false);
ok("BUSY LEN=0", busyDecoded.len === 0);
// BUSY 帧固定:同 id 两次构造必须逐字节相同(§3.2「不随机」)
ok("BUSY 帧确定性", F.buildBusyFrame(0x00c8).equals(busy));

// ---------- CRC 覆盖范围:seq / LEN 被改必须被揪出 ----------

const base = F.encode(0x1234, "hello world")[0];
const tamperedSeq = Buffer.from(base);
tamperedSeq[0] = (tamperedSeq[0] & 0x80) | (((tamperedSeq[0] & 0x7f) + 1) & 0x7f);
ok("改 seq → CRC fail", F.decodeFrame(tamperedSeq).ok === false);

const tamperedLen = Buffer.from(base);
tamperedLen[3] = (tamperedLen[3] & 0x80) | 3;
ok("改 LEN → CRC fail", F.decodeFrame(tamperedLen).ok === false);

const tamperedPayload = Buffer.from(base);
tamperedPayload[6] = tamperedPayload[6] ^ 0xff;
ok("改 payload → CRC fail", F.decodeFrame(tamperedPayload).ok === false);

// LEN > 10 即使 CRC 重算通过也必须判非法(§3.1 LEN 0..10)
const bogus = F.buildFrame(1, 0, false, true, 11, null);
ok("LEN=11 判非法", F.decodeFrame(bogus).ok === false && F.decodeFrame(bogus).error === "bad_len");

// 尺寸不对
ok("长度 15 判非法", F.decodeFrame(Buffer.alloc(15)).ok === false);

console.log(fail ? "frame.test FAIL " + fail : "frame.test PASS");
process.exit(fail ? 1 : 0);
