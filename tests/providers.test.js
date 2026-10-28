// Provider 纯函数 + glossary/hero_names 离线回归
//
// 目的:providers 是真正对外产生费用/失败的高风险路径,此前 0 测试。
// 本文件只测**不依赖网络**的纯逻辑(错误文案 / 提示词构造 / 输出清洗 / 英雄术语纠正 / 英雄简写),
// 用真实模块导出驱动,不 mock https。运行: node tests/providers.test.js
"use strict";

const path = require("path");
const assert = require("assert");

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); pass += 1; console.log("  ok   " + name); }
  catch (e) { fail += 1; console.log("  FAIL " + name + "  " + (e && e.message ? e.message : e)); }
}

const httpErrors = require(path.resolve("core/providers/http_errors.js"));
const openai = require(path.resolve("core/providers/openai.js"));
const glossary = require(path.resolve("core/glossary.js"));
const heroNames = require(path.resolve("core/hero_names.js"));

// ---------- http_errors:共享文案 + 服务商覆写 ----------
ok("默认 401 = API Key 无效", () => {
  assert.strictEqual(httpErrors.describeHttpError(401, ""), "API Key 无效(401)");
});
ok("403/404 覆写优先于默认", () => {
  const m = httpErrors.describeHttpError(403, "", {
    providerLabel: "Microsoft", overrides: { 403: "Key 无权限或缺少区域(403)" },
  });
  assert.strictEqual(m, "Key 无权限或缺少区域(403)");
});
ok("5xx 带服务商标签", () => {
  const s = httpErrors.describeHttpError(503, "", { providerLabel: "Google" });
  assert.strictEqual(s, "Google 服务错误(503)");
});
ok("JSON 体里的 error.message 附到提示后", () => {
  const t = httpErrors.describeHttpError(400, JSON.stringify({ error: { message: "bad model" } }), { providerLabel: "x" });
  assert.ok(t.indexOf("bad model") !== -1, t);
});
ok("DeepL 特有 456 额度文案走覆写", () => {
  const d = httpErrors.describeHttpError(456, "", { overrides: { 456: "DeepL 本月额度已用完(456)" } });
  assert.strictEqual(d, "DeepL 本月额度已用完(456)");
});

// ---------- openai:语言标签 ----------
ok("languageLabel 命中已知码", () => {
  assert.strictEqual(openai.languageLabel("zh-Hans"), "Simplified Chinese");
  assert.strictEqual(openai.languageLabel("en"), "English");
});
ok("languageLabel 未知名回退为代码本身", () => {
  assert.strictEqual(openai.languageLabel("xx-YY"), "xx-YY");
});

// ---------- openai:输出清洗(去引号 / 代码栅栏 / 括号) ----------
ok("cleanTranslation 去 markdown 代码栅栏", () => {
  assert.strictEqual(openai.cleanTranslation("```\nhello\n```"), "hello");
});
ok("cleanTranslation 去成对引号", () => {
  assert.strictEqual(openai.cleanTranslation('"你好"'), "你好");
  assert.strictEqual(openai.cleanTranslation("「你好」"), "你好");
});
ok("cleanTranslation 保留未成对引号", () => {
  assert.strictEqual(openai.cleanTranslation('"未闭合'), '"未闭合');
});

// ---------- openai:提示词构造(双 system/user 注入) ----------
ok("buildMessages 同时写 system 与 user", () => {
  const msgs = openai.buildMessages("gg", { targetLanguage: "en" });
  assert.strictEqual(msgs.length, 2);
  assert.strictEqual(msgs[0].role, "system");
  assert.strictEqual(msgs[1].role, "user");
  assert.ok(msgs[0].content.indexOf("translation engine") !== -1);
  assert.ok(msgs[1].content.indexOf("gg") !== -1);
});

// ---------- glossary:fixHeroTerms 只纠正 en 目标 ----------
ok("fixHeroTerms 非 en 目标原样返回", () => {
  const out = glossary.fixHeroTerms("牛", "ox", "zh-Hans");
  assert.strictEqual(out, "ox");
});
ok("fixHeroTerms 命中昵称纠正英雄英文名", () => {
  // "牛" 在 heroCnToEn -> Abrams;译文若含 "ox/bull" 类泛词应纠正为 Abrams
  const out = glossary.fixHeroTerms("牛推中", "ox pushes mid", "en");
  assert.strictEqual(out, "Abrams pushes mid");
});
ok("fixHeroTerms 空译文原样返回", () => {
  assert.strictEqual(glossary.fixHeroTerms("牛", "", "en"), "");
});

// ---------- hero_names:简写查表 ----------
ok("lookupHeroAbbr 命中官方简写", () => {
  const v = heroNames.lookupHeroAbbr("abr");
  assert.ok(v, "abr should resolve");
});
ok("isHeroAbbr 识别已收录简写", () => {
  assert.strictEqual(heroNames.isHeroAbbr("abr"), true);
  assert.strictEqual(heroNames.isHeroAbbr("zzzznotahero"), false);
});

console.log("\nproviders.test: PASS " + pass + " / FAIL " + fail);
process.exit(fail ? 1 : 0);
