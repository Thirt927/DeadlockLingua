// Babel Tower - core/overlay.js 单测
//
// 背景:2026/10/01 的 Deadlock 更新移除了 Panorama 的全部 HTTP 能力,游戏内不再可能
// 收发文;唯一活着的通道是「游戏 -> console.log -> 桥」。core/overlay.js 负责增量 tail
// 游戏 console.log 里的 [LCT-CHAT] 行、翻译、并在环形缓冲里供悬浮窗页面轮询。
// 这里用一个临时日志文件把整条链路跑一遍,不依赖真实游戏与真实桥。
//
// 用法: node scripts/overlay_test.js
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const overlay = require("../core/overlay");

const MARKER = overlay.CHAT_MARKER;

let passCount = 0;
let failCount = 0;
function assert(name, cond, extra) {
  if (cond) { passCount++; console.log("  PASS " + name); }
  else { failCount++; console.log("  FAIL " + name + (extra ? "  [" + extra + "]" : "")); }
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function waitFor(cond, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { if (cond()) return true; } catch (e) {}
    await sleep(100);
  }
  return false;
}

// 模拟游戏 console.log 的一行(带引擎自己的时间戳/来源前缀)
function gameChatLine(payload) {
  return "10/01 20:15:03 [PanoramaScript] " + MARKER + JSON.stringify(payload) + "\n";
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "babeltower-overlay-test-"));
  const logFile = path.join(tmpDir, "console.log");
  fs.writeFileSync(logFile, "");

  const translated = [];
  let gameRunning = false;
  overlay.start({
    log: function () {},
    getConfig: () => ({ deadlockConsoleLog: logFile, defaults: { targetLanguage: "zh-Hans" } }),
    isGameRunning: () => gameRunning,
    translate: async (text) => {
      translated.push(text);
      return "译:" + text;
    },
  });

  console.log("=== core/overlay.js tests (temp console.log) ===");

  // 阶段 1:追加三行 —— 英文聊天(需翻译)、中文聊天(不需翻译)、非聊天噪声行
  fs.appendFileSync(logFile, gameChatLine({ o: 0, n: "Alice", c: "chat", h: "Wraith", t: "push mid now" }));
  fs.appendFileSync(logFile, "10/01 20:15:04 [PanoramaScript] [LCT] unrelated log line\n");
  fs.appendFileSync(logFile, gameChatLine({ o: 1, n: "Me", c: "chat", h: "Haze", t: "我来中路" }));
  // 同一条英文消息的顶栏气泡副本(文本相同)-> 应被去重
  fs.appendFileSync(logFile, gameChatLine({ o: 0, n: "Alice", c: "hud", h: "Wraith", t: "push mid now" }));

  await waitFor(() => overlay.list(0).length >= 2, 6000);
  await waitFor(() => overlay.list(0).some((m) => m.translation), 6000);

  const msgs = overlay.list(0);
  assert("only [LCT-CHAT] lines become messages (noise ignored)", msgs.length === 2, "count=" + msgs.length);
  const alice = msgs.find((m) => m.sender === "Alice");
  const me = msgs.find((m) => m.sender === "Me");
  assert("non-own english message captured with sender/hero/text",
    !!alice && alice.text === "push mid now" && alice.hero === "Wraith" && alice.own === false,
    JSON.stringify(alice));
  assert("english message translated via injected translator",
    !!alice && alice.translation === "译:push mid now" && !alice.error && alice.pending === false,
    alice && (alice.translation + "/" + alice.error));
  assert("duplicate (hud copy) deduped", msgs.filter((m) => m.text === "push mid now").length === 1);
  assert("own message flagged and NOT sent to translator",
    !!me && me.own === true && me.translation === "" && translated.indexOf("我来中路") === -1,
    JSON.stringify(me));
  assert("chinese text skipped by translator (already target language)", translated.length === 1, "translated=" + JSON.stringify(translated));

  // 阶段 2:增量读取不应重复投递已见过的行
  const before = overlay.latestSeq();
  fs.appendFileSync(logFile, "\n");
  await sleep(1600);
  assert("no re-delivery of already-seen lines", overlay.latestSeq() === before, "latest=" + overlay.latestSeq());

  // 阶段 3:game 重启会清空重写 console.log -> 从头重新 tail,去重表作废,
  //         并且清空缓冲/换会话标识(否则上一局的聊天会残留在悬浮窗里)
  const sessBefore = overlay.sessionId();
  fs.writeFileSync(logFile, gameChatLine({ o: 0, n: "Bob", c: "chat", h: "", t: "gg" }));
  await waitFor(() => overlay.list(before).some((m) => m.sender === "Bob"), 6000);
  const after = overlay.list(before);
  assert("truncated/rewritten log is re-tailed from start", after.length === 1 && after[0].sender === "Bob", JSON.stringify(after));
  assert("new game session clears the previous match's buffer", overlay.list(0).length === 1, "total=" + overlay.list(0).length);
  assert("new game session changes the session id (overlay clears stale chats)", overlay.sessionId() !== sessBefore);

  // 阶段 4:after 游标语义(悬浮窗轮询用)
  assert("list(after) only returns newer messages",
    overlay.list(overlay.latestSeq()).length === 0 && overlay.list(0).length === 1,
    "total=" + overlay.list(0).length);

  // 阶段 5:桥中途重启(游戏仍在运行)-> prime 回填本局已有聊天,不再直接 seek 到末尾
  fs.writeFileSync(logFile,
    gameChatLine({ o: 0, n: "Ann", c: "chat", h: "", t: "rotate top" }) +
    gameChatLine({ o: 0, n: "Ben", c: "chat", h: "", t: "care mid" }));
  gameRunning = true;
  overlay.reset(); // 模拟桥进程重启:内存状态全清
  await waitFor(() => overlay.list(0).length >= 2, 6000);
  const backfilled = overlay.list(0);
  assert("bridge restart mid-match backfills earlier chats",
    backfilled.length === 2 && backfilled[0].sender === "Ann" && backfilled[1].sender === "Ben",
    JSON.stringify(backfilled.map((m) => m.sender)));
  assert("backfilled chats are queued for translation",
    await waitFor(() => backfilled.some((m) => m.translation), 6000),
    JSON.stringify(backfilled.map((m) => m.translation)));

  overlay.stop();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}

  console.log("\n=== RESULT: PASS " + passCount + " / FAIL " + failCount + " ===");
  process.exit(failCount === 0 ? 0 : 1);
}

main();