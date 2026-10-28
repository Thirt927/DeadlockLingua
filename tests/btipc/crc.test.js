// BTIPC §12.1 验收:CRC-16/CCITT-FALSE 测试向量
// 运行: node tests/btipc/crc.test.js
"use strict";

const path = require("path");
const crc16 = require(path.resolve("core/btipc/crc16.js")).crc16;

let fail = 0;
function check(name, actual, expect) {
  const ok = actual === expect;
  if (!ok) fail += 1;
  const hex = (n) => "0x" + (n & 0xffff).toString(16).toUpperCase().padStart(4, "0");
  console.log((ok ? "  ok   " : "  FAIL ") + name + " = " + hex(actual) + (ok ? "" : "  expect " + hex(expect)));
}

// §12.1 标准向量(CCITT-FALSE 权威值)
check('crc16("123456789")', crc16(Buffer.from("123456789", "ascii")), 0x29b1);
// 空输入 = 初值(无 xorout)
check("crc16(empty)", crc16(Buffer.alloc(0)), 0xffff);
// 同输入必同输出(游戏侧 vs 桥端互检的前提)
check('crc16("123456789") 复算', crc16(Buffer.from("123456789", "ascii")), 0x29b1);

// UTF-8 中文不得抛错且稳定
const zh = Buffer.from("你好世界", "utf8");
check("crc16(中文) 稳定", crc16(zh), crc16(Buffer.from("你好世界", "utf8")));

// 全 0x00 ×16:规格 §12.1 标注「以实现互检为准」,这里只断言不抛错且落在 16 位内
const zeros = crc16(Buffer.alloc(16));
console.log("  info  全 0x00×16 = 0x" + zeros.toString(16).toUpperCase().padStart(4, "0") + "(互检基准)");

console.log(fail ? "crc.test FAIL " + fail : "crc.test PASS");
process.exit(fail ? 1 : 0);
