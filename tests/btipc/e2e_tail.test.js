// BTIPC 端到端(无游戏):模拟 console.log → overlay tail → onLine → transport → /btipc/dl
//
// 验证的是接线,不是协议语义(协议由 crc/frame/transport 三个套件覆盖):
//   1. overlay.js 的 tail 会把**新增行**喂给 onLine(非 [LCT-CHAT] 行同样要喂)
//   2. onLine 里的 REQ 行能建成窗口,并被 serveDL 正常取帧
//   3. 同一份 tail 里的 [LCT-CHAT] 行仍走原悬浮窗管线,互不干扰
//
// 运行: node tests/btipc/e2e_tail.test.js  (约 1.5s)
"use strict";

const fs = require("fs");
const path = require("path");
const F = require(path.resolve("core/btipc/framer.js"));
const T = require(path.resolve("core/btipc/transport.js"));
const crc16 = require(path.resolve("core/btipc/crc16.js")).crc16;
const overlay = require(path.resolve("core/overlay.js"));

let fail = 0;
function ok(name, cond, extra) {
  if (!cond) fail += 1;
  console.log((cond ? "  ok   " : "  FAIL ") + name + (cond || extra === undefined ? "" : "  " + extra));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const WIN = "b1e2f3";
const REPLY = "对面在推上路,回防";

function reqLine(win, id, text) {
  const payload = Buffer.from(text, "utf8");
  return "20:00:00 [PanoramaScript] [LCT] BTIPC REQ w=" + win + " id=" +
    id.toString(16).padStart(4, "0") + " len=" + payload.length +
    " crc=" + crc16(payload).toString(16).padStart(4, "0") +
    " b64=" + payload.toString("base64");
}

(async function main() {
  const dir = path.resolve("logs/_btipc_e2e");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const logFile = path.join(dir, "console.log");
  fs.writeFileSync(logFile, "");

  const tr = T.createTransport({
    log: () => {},
    translate: () => Promise.resolve(REPLY),
  });

  overlay.reset();
  overlay.start({
    log: () => {},
    getConfig: () => ({ deadlockConsoleLog: logFile, chatLog: { enabled: false } }),
    isGameRunning: () => false,
    onLine: (line) => tr.handleLogLine(line),
  });

  // start() 的首次 tailOnce 已把 offset 定位到文件末尾(空文件 → 0)。
  // 现在追加内容,模拟游戏侧新写入。
  fs.appendFileSync(logFile,
    '20:00:01 [PanoramaScript] [LCT-CHAT]{"o":0,"n":"Bob","c":"chat","h":"Haze","t":"push top"}\n' +
    reqLine(WIN, 0x0042, "push top") + "\n");

  await sleep(1600); // > overlay POLL_MS(800)

  ok("REQ 行经 tail 建成窗口", tr.size() === 1, "size=" + tr.size());
  ok("同批 [LCT-CHAT] 仍进悬浮窗管线", overlay.list(0).length === 1,
    "ring=" + overlay.list(0).length);

  const busy = tr.serveDL({ w: WIN, r: 1 });
  ok("/btipc/dl 200(帧已就绪时)", busy.status === 200, "status=" + busy.status);
  const decoded = [];
  for (let i = 0; i < 40; i += 1) {
    const s = tr.serveDL({ w: WIN, r: 1 + i });
    if (s.status !== 200) break;
    const d = F.decodeFrame(s.frame);
    if (!d.ok) break;
    decoded.push(d);
    if (d.end) break;
  }
  ok("取回的帧拼装 = 桥给出的译文", F.assembleFrames(decoded) === REPLY,
    JSON.stringify(F.assembleFrames(decoded)));

  ok("未知窗口仍 404", tr.serveDL({ w: "000000", r: 1 }).status === 404);

  overlay.stop();
  fs.rmSync(dir, { recursive: true, force: true });

  console.log(fail ? "e2e_tail.test FAIL " + fail : "e2e_tail.test PASS");
  process.exit(fail ? 1 : 0);
})();
