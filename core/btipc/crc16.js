// Babel Tower - BTIPC 桥端 CRC-16/CCITT-FALSE
//
// 协议依据: docs/btipc-v1.md §3.2(CRC 覆盖范围冻结)。
// 参数: poly 0x1021, init 0xFFFF, refin=false, refout=false, xorout=0x0000。
// 标准测试向量: crc16(Buffer.from("123456789")) === 0x29B1。
//
// 游戏侧(mod/panorama/scripts/lingua_chat.js 的 State.btipc)内联了同一算法的副本
// (Panorama 无模块系统)。两侧实现必须逐字节一致,改动此处必须同步改游戏侧,
// 否则帧级 CRC 永远校验失败。
"use strict";

function crc16(bytes) {
  let crc = 0xffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = (crc ^ ((bytes[i] & 0xff) << 8)) & 0xffff;
    for (let b = 0; b < 8; b += 1) {
      if (crc & 0x8000) crc = ((crc << 1) ^ 0x1021) & 0xffff;
      else crc = (crc << 1) & 0xffff;
    }
  }
  return crc & 0xffff;
}

module.exports = { crc16: crc16 };
