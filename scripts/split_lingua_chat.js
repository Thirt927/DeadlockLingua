// 巨石拆分:把 mod/panorama/scripts/lingua_chat.js 切成 5 个**同作用域**片段(顶层非 IIFE),
// build.ps1 的 Concat-LinguaChat 按 identity→logs→channels→settings→diag 顺序拼回单文件再编译。
// 切分原则:片段是原 IIFE 体内的**连续行块**(纯机械搬移,不改任何代码字符),拼接结果与拆前逐字等价
// (空行归一除外)。行号锚点按"段首行精确匹配"定位,防手改后行号漂移。
"use strict";

const fs = require("fs");
const path = require("path");
const SRC = path.join(__dirname, "..", "mod", "panorama", "scripts", "lingua_chat.js");

// 段锚点(段首行;结束于下一段首前一行)。顺序即拼接顺序。
// 注:channels 含 BTIPC/分发/桥状态/扫描/出站;settings 含 配置/UI 偏好/LCT* 面板回调;logs 含 healthCheck/桥状态文本/日志落盘。
const SEGMENTS = [
  { file: "lct_identity.js", anchor: '  const LOG_PREFIX = "[LCT]";', endAnchor: "  // ================= 配置(游戏侧 UI 偏好) =================" },
  { file: "lct_settings.js", anchor: "  // ================= 配置(游戏侧 UI 偏好) =================", endAnchor: "  // ================= BTIPC:唯一的双向通道 =================" },
  { file: "lct_channels.js", anchor: "  // ================= BTIPC:唯一的双向通道 =================", endAnchor: "  function healthCheck() {" },
  { file: "lct_logs.js", anchor: "  function healthCheck() {", endAnchor: "  function injectHudTestMessage(text) {" },
  { file: "lct_diag.js", anchor: "  function injectHudTestMessage(text) {", endAnchor: null },
];

function main() {
  const raw = fs.readFileSync(SRC, "utf8");
  const lines = raw.split(/\r?\n/);
  const N = lines.length;

  const findAnchor = (a, from) => {
    for (let i = from; i < N; i += 1) if (lines[i] === a) return i;
    return -1;
  };
  const findStart = (a) => findAnchor(a, 0);

  const segs = [];
  let cur = 0;
  for (const s of SEGMENTS) {
    const start = findStart(s.anchor);
    if (start < 0) throw new Error("找不到段首锚点 " + s.file + ": " + JSON.stringify(s.anchor));
    let end; // inclusive
    if (s.endAnchor) {
      const e = findAnchor(s.endAnchor, start);
      if (e < 0) throw new Error("找不到段尾锚点 " + s.file + ": " + JSON.stringify(s.endAnchor));
      end = e - 1;
    } else {
      // 末段:到 "  boot();" 调用前一行(boot() 由 build.ps1 注入)
      let boot = -1;
      for (let i = N - 1; i >= 0; i -= 1) { if (lines[i].trim() === "boot();") { boot = i; break; } }
      if (boot < 0) throw new Error("找不到 boot(); 调用行");
      end = boot - 1;
    }
    if (start < cur) throw new Error("段乱序: " + s.file + " start=" + start + " < 上段 end=" + (cur - 1));
    segs.push({ file: s.file, start: start, end: end });
    cur = end + 1;
  }
  // 连续性校验:上段 end+1 == 下段 start
  for (let i = 1; i < segs.length; i += 1) {
    if (segs[i].start !== segs[i - 1].end + 1) throw new Error("段不连续: " + segs[i - 1].file + " end=" + segs[i - 1].end + " next=" + segs[i].file + " start=" + segs[i].start);
  }

  const DIR = path.dirname(SRC);
  for (const s of segs) {
    const chunk = lines.slice(s.start, s.end + 1).join("\r\n") + "\r\n";
    fs.writeFileSync(path.join(DIR, s.file), chunk, "utf8");
    console.log("  wrote " + s.file + "  (L" + (s.start + 1) + "-" + (s.end + 1) + ", " + (s.end - s.start + 1) + " 行)");
  }
  console.log("5 片段已写出(连续切分 L" + (segs[0].start + 1) + "-" + (segs[segs.length - 1].end + 1) + ")。");
}

main();
