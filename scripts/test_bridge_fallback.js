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
const runTranslate = sandbox.runTranslate;

(async () => {
  // primary openai with INVALID key -> must fail -> fallback bing -> translated
  const cfg = {
    provider: "openai",
    defaults: { sourceLanguage: "auto", targetLanguage: "zh-Hans" },
    fallbackProviders: ["bing"],
    openai: { apiKey: "sk-invalid-test-key", baseUrl: "https://api.deepseek.com", model: "deepseek-v4-flash" },
    bing: {},
  };
  const r = await runTranslate(cfg, { text: "You can give up tower 1", sourceLanguage: "auto", targetLanguage: "zh-Hans", timeoutMs: 8000 });
  console.log("result:", JSON.stringify(r));
  if (r && r.translation && r.viaFallback && r.provider === "bing") { console.log("PASS fallback works"); process.exit(0); }
  console.log("FAIL: expected viaFallback translation");
  process.exit(1);
})().catch((e) => { console.log("ERROR:", e); process.exit(1); });

