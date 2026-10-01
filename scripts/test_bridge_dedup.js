"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const coreDir = path.resolve("core");
const fakeHttp = { createServer: () => ({ on: () => {}, listen: () => {} }) };
const sandbox = {
  require: (m) => {
    if (m === "http") return fakeHttp;
    if (m.startsWith("./") || m.startsWith("../")) m = path.join(coreDir, m);
    return require(m);
  },
  module: { exports: {} }, exports: {}, process, console, Buffer, URL,
  setTimeout, clearTimeout, setInterval, clearInterval,
  __dirname: coreDir, __filename: path.join(coreDir, "bridge_server.js"),
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
const code = fs.readFileSync(path.join(coreDir, "bridge_server.js"), "utf8");
vm.runInContext(code, sandbox, { filename: "bridge_server.js" });
const appendChatLog = sandbox.appendChatLog;

const tmpDir = path.resolve("logs/chat/_dedup_test");
fs.rmSync(tmpDir, { recursive: true, force: true });
fs.mkdirSync(tmpDir, { recursive: true });
const cfg = { chatLog: { enabled: true, dir: "logs/chat/_dedup_test" } };
const mid = "testdupe001";
function post(lines) { appendChatLog(cfg, { matchId: mid, lines: lines }); }

post([{ type: "player", name: "Alice", hero: "silver", heroId: "80", steamid: "" }]);
post([{ type: "msg", t: "t1", kind: "chat", sender: "Alice", hero: "silver", heroId: "", steamid: "", channel: "[Team]", isOwn: false, text: "hi" }]);
post([{ type: "msg", t: "t2", kind: "chat", sender: "Alice", hero: "silver", heroId: "", steamid: "76561199000000001", channel: "[Team]", isOwn: false, text: "yo" }]);
post([{ type: "msg", t: "t3", kind: "chat", sender: "Alice", hero: "silver", heroId: "", steamid: "76561199000000001", channel: "[Team]", isOwn: false, text: "again" }]);
post([{ type: "msg", t: "t4", kind: "chat", sender: "Alice", hero: "graves", heroId: "76", steamid: "76561199000000001", channel: "[Team]", isOwn: false, text: "x" }]);
post([{ type: "player", name: "Alice", hero: "silver", heroId: "", steamid: "76561199000000001" }]);

const file = path.join(tmpDir, mid + ".jsonl");
const lines = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const players = lines.filter((l) => l.type === "player");
const msgs = lines.filter((l) => l.type === "msg");
players.forEach((p) => console.log("  " + JSON.stringify(p)));

let fail = 0;
const aliceSilver = players.filter((p) => p.name === "Alice" && p.hero === "silver");
const dupEmpty = aliceSilver.filter((p) => p.heroId === "" && p.steamid === "");
const withSteam = aliceSilver.filter((p) => p.steamid === "76561199000000001");
const graves = players.filter((p) => p.name === "Alice" && p.hero === "graves");
if (aliceSilver.length !== 2) { console.log("FAIL: silver records =", aliceSilver.length, "expect 2"); fail++; }
if (dupEmpty.length !== 0) { console.log("FAIL: empty heroId/steamid duplicate exists"); fail++; }
if (withSteam.length !== 1) { console.log("FAIL: silver+steamid =", withSteam.length, "expect 1"); fail++; }
if (graves.length !== 1) { console.log("FAIL: graves =", graves.length, "expect 1"); fail++; }
if (msgs.length !== 4) { console.log("FAIL: msgs =", msgs.length, "expect 4"); fail++; }

// msg format: isOwn removed, steamid present
for (const m of msgs) {
  if ("isOwn" in m) { console.log("FAIL: msg still has isOwn", JSON.stringify(m)); fail++; }
  if (!("steamid" in m)) { console.log("FAIL: msg missing steamid", JSON.stringify(m)); fail++; }
}
if (msgs[0].steamid !== "") { console.log("FAIL: msg0 steamid =", msgs[0].steamid, "expect empty"); fail++; }
if (msgs[1].steamid !== "76561199000000001") { console.log("FAIL: msg1 steamid =", msgs[1].steamid, "expect 76561199000000001"); fail++; }

// steamid-only message (no hero): no empty player record should be emitted
const mid3 = "testdupe003";
appendChatLog(cfg, { matchId: mid3, lines: [
  { type: "msg", t: "t5", kind: "chat", sender: "NoHero", hero: "", heroId: "", steamid: "76561199000000002", channel: "", isOwn: false, text: "hi" },
  { type: "msg", t: "t6", kind: "chat", sender: "<unknown>", hero: "", heroId: "", steamid: "76561199000000003", channel: "hud", isOwn: false, text: "yo" }] });
const file3 = path.join(tmpDir, mid3 + ".jsonl");
const lines3 = fs.readFileSync(file3, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const players3 = lines3.filter((l) => l.type === "player");
if (players3.length !== 0) { console.log("FAIL: empty-hero player records emitted", JSON.stringify(players3)); fail++; }
const msgs3 = lines3.filter((l) => l.type === "msg");
if (msgs3.length !== 2) { console.log("FAIL: msgs3 =", msgs3.length, "expect 2"); fail++; }
if (msgs3[0].steamid !== "76561199000000002") { console.log("FAIL: msg steamid lost", JSON.stringify(msgs3[0])); fail++; }
if (msgs3[1].sender !== "<unknown>") { console.log("FAIL: unknown sender changed", JSON.stringify(msgs3[1])); fail++; }

// out-of-order batch: bridge must sort msg lines by t (client pending fallback can reorder)
const mid2 = "testdupe002";
appendChatLog(cfg, { matchId: mid2, lines: [
  { type: "msg", t: "2026-08-24T16:05:01.000Z", kind: "chat", sender: "A", hero: "", heroId: "", steamid: "", channel: "", isOwn: false, text: "late" },
  { type: "msg", t: "2026-08-24T16:05:00.000Z", kind: "chat", sender: "B", hero: "", heroId: "", steamid: "", channel: "", isOwn: false, text: "early" }] });
const file2 = path.join(tmpDir, mid2 + ".jsonl");
const lines2 = fs.readFileSync(file2, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const msgs2 = lines2.filter((l) => l.type === "msg");
if (msgs2.length !== 2 || msgs2[0].text !== "early" || msgs2[1].text !== "late") {
  console.log("FAIL: batch not sorted by t", JSON.stringify(msgs2.map((m) => m.t))); fail++;
}

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(fail === 0 ? "PASS" : ("FAILURES: " + fail));
process.exit(fail === 0 ? 0 : 1);
