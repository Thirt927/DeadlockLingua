// 校验:5 个 lct_*.js 片段按 build.ps1 Concat-LinguaChat 的精确规则
// (head = lingua_chat.js L1-15 原样 + 各片段 ReadAllText 原样直接拼接 + "  boot();\r\n})();\r\n" + 末尾 CRLF 归一)
// 拼回后与现 lingua_chat.js **逐字等价**(拆分为纯机械切分,不改任何代码字符)。
"use strict";
const fs = require("fs");
const path = require("path");
const DIR = path.join(__dirname, "..", "mod", "panorama", "scripts");
// 与 build.ps1 $parts 顺序一致(物理切分顺序:identity → settings → channels → logs → diag)
const parts = ["lct_identity.js", "lct_settings.js", "lct_channels.js", "lct_logs.js", "lct_diag.js"];
const targetRaw = fs.readFileSync(path.join(DIR, "lingua_chat.js"), "utf8");

// 复刻 PowerShell:[IO.File]::ReadLines(out) | Select -First 15,join CRLF
const head = targetRaw.split(/\r\n/).slice(0, 15).join("\r\n");

// 复刻 StringBuilder:head + CRLF + Σ片段(原样) + "  boot();\r\n" + "})();\r\n"
let sb = head + "\r\n";
for (const p of parts) {
  sb += fs.readFileSync(path.join(DIR, p), "utf8");
}
sb += "  boot();\r\n";
sb += "})();\r\n\r\n\r\n\r\n\r\n";
const concatCrlf = sb.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");

const targetLf = targetRaw.replace(/\r\n/g, "\n");
const concatLf = concatCrlf.replace(/\r\n/g, "\n");
const ok = concatLf === targetLf;
console.log("Concat-LinguaChat 复刻 == lingua_chat.js ? " + ok);
if (!ok) {
  const A = concatLf.split("\n"), B = targetLf.split("\n");
  console.log("concat lines=" + A.length + " lingua lines=" + B.length);
  let first = -1;
  for (let i = 0; i < Math.max(A.length, B.length); i += 1) {
    if (A[i] !== B[i]) { first = i; break; }
  }
  console.log("first diff at line " + (first + 1));
  for (let i = Math.max(0, first - 2); i < Math.min(A.length, B.length, first + 5); i += 1) {
    const al = (A[i] === undefined ? "<none>" : A[i]).slice(0, 55);
    const bl = (B[i] === undefined ? "<none>" : B[i]).slice(0, 55);
    console.log(String(i + 1).padEnd(6) + " C:" + al + "   T:" + bl + (al === bl ? "" : "   <-- DIFF"));
  }
}
