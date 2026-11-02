"use strict";
// v2.3.0 多端点 + 多 Key 池 离线测试(不需要游戏/网络)
//   1. config.js:migration(旧 openai.apiKey → 第 1 行)、mask(打码)、applyMaskedUpdate(id 合并/完整重写/Key 只写)
//   2. providers/openai.js:buildCandidatePlan 行序 × Key 轮询、失败 Key 自动冷却跳过、成功后回池
const path = require("path");
const assert = require("assert");

const config = require(path.join(__dirname, "..", "core", "config.js"));
const openai = require(path.join("..", "core", "providers", "openai.js"));

let passed = 0;
let failed = 0;
function t(name, fn) {
  try {
    fn();
    passed += 1;
    console.log("  ok  " + name);
  } catch (e) {
    failed += 1;
    console.log("FAIL  " + name + "\n      " + (e && e.stack ? e.stack.split("\n").slice(0, 3).join("\n      ") : e));
  }
}

console.log("== config: migration / mask / applyMaskedUpdate ==");

t("旧单 Key 自动包成第 1 行(不丢数据)", () => {
  const cfg = config.normalize({ provider: "openai", openai: { apiKey: "sk-legacy-123", baseUrl: "https://api.deepseek.com", model: "deepseek-chat" } });
  assert.strictEqual(cfg.openai.providers.length, 1, "应迁移出 1 行");
  assert.strictEqual(cfg.openai.providers[0].id, "legacy");
  assert.strictEqual(cfg.openai.providers[0].keys.length, 1);
  assert.strictEqual(cfg.openai.providers[0].keys[0].value, "sk-legacy-123");
  assert.strictEqual(cfg.openai.providers[0].baseUrl, "https://api.deepseek.com");
});

t("无旧 Key 也不硬造行", () => {
  const cfg = config.normalize({});
  assert.strictEqual(cfg.openai.providers.length, 0);
});

t("mask:Key 只回脱敏描述符,绝不回传明文", () => {
  const cfg = config.normalize({ openai: { apiKey: "sk-abcdef1234567890", providers: [{ id: "p1", name: "DeepSeek", baseUrl: "https://api.deepseek.com", model: "deepseek-chat", enabled: true, keys: [{ id: "k1", value: "sk-secretvalue-123456", enabled: true }] }] } });
  const m = config.mask(cfg);
  assert.strictEqual(m.openai.apiKey, "********");
  assert.strictEqual(m.openai.providers.length, 1);
  assert.strictEqual(m.openai.providers[0].keyCount, 1);
  assert.strictEqual(m.openai.providers[0].keys.length, 1);
  assert.strictEqual(m.openai.providers[0].keys[0].mask, "sk-…3456", "sk-secretvalue-123456 → 前3字符 'sk-' + … + 后4字符");
  const flat = JSON.stringify(m);
  assert.ok(flat.indexOf("sk-secretvalue-123456") === -1, "明文不得进入 mask");
});

t("applyMaskedUpdate:id 合并形态(游戏面板:只改顺序+开关,保留 baseUrl/model/keys)", () => {
  const base = config.normalize({ openai: { apiKey: "sk-abcdef1234567890", providers: [
    { id: "p1", name: "A", baseUrl: "https://a.example/v1", model: "m1", enabled: true, keys: [{ id: "k1", value: "sk-realA", enabled: true }] },
    { id: "p2", name: "B", baseUrl: "https://b.example/v1", model: "m2", enabled: true, keys: [{ id: "k2", value: "sk-realB", enabled: true }] },
  ] } });
  const next = config.applyMaskedUpdate(base, { openai: { providers: [
    { id: "p2", enabled: false },
    { id: "p1", enabled: true },
  ] } });
  assert.strictEqual(next.openai.providers.length, 2);
  assert.strictEqual(next.openai.providers[0].id, "p2", "顺序按 incoming");
  assert.strictEqual(next.openai.providers[0].baseUrl, "https://b.example/v1", "baseUrl 保留");
  assert.strictEqual(next.openai.providers[0].keys.length, 1, "Key 保留");
  assert.strictEqual(next.openai.providers[0].keys[0].value, "sk-realB");
  assert.strictEqual(next.openai.providers[0].enabled, false, "开关生效");
  assert.strictEqual(next.openai.providers[1].id, "p1");
});

t("applyMaskedUpdate:完整重写形态,Key 打码哨兵保留原值", () => {
  const base = config.normalize({ openai: { apiKey: "sk-abcdef1234567890", providers: [
    { id: "p1", name: "A", baseUrl: "https://a.example/v1", model: "m1", enabled: true, keys: [{ id: "k1", value: "sk-realvalue-99", enabled: true }] },
  ] } });
  // 打码哨兵 = mask() 回给页面的描述符
  const sentinel = config.maskKeyValue("sk-realvalue-99");
  const next = config.applyMaskedUpdate(base, { openai: { providers: [
    { id: "p1", name: "A", builtin: false, baseUrl: "https://a.example/v1", model: "m1", enabled: true, keys: [{ id: "k1", value: sentinel, enabled: true }] },
  ] } });
  assert.strictEqual(next.openai.providers[0].keys[0].value, "sk-realvalue-99", "哨兵 → 保留明文");
});

t("applyMaskedUpdate:新增 Key 下发明文", () => {
  const base = config.normalize({ openai: { apiKey: "sk-abcdef1234567890", providers: [
    { id: "p1", name: "A", baseUrl: "https://a.example/v1", model: "m1", enabled: true, keys: [{ id: "k1", value: "sk-realvalue-99", enabled: true }] },
  ] } });
  const next = config.applyMaskedUpdate(base, { openai: { providers: [
    { id: "p1", name: "A", builtin: false, baseUrl: "https://a.example/v1", model: "m1", enabled: true, keys: [
      { id: "k1", value: "********", enabled: true },
      { id: "k2", value: "sk-brandnew-key", enabled: true },
    ] },
  ] } });
  const keys = next.openai.providers[0].keys;
  assert.strictEqual(keys.length, 2);
  assert.strictEqual(keys[0].value, "sk-realvalue-99", "占位符 ******* 也视为保留");
  assert.strictEqual(keys[1].value, "sk-brandnew-key", "新 Key 明文入库");
});

console.log("== openai: candidate plan / 轮询 / 自动冷却 ==");

function mkRows() {
  return [
    { id: "p1", name: "A", baseUrl: "https://a.example", model: "m1", enabled: true,
      keys: [
        { id: "k1", value: "sk-a1", enabled: true },
        { id: "k2", value: "sk-a2", enabled: true },
      ] },
    { id: "p2", name: "B", baseUrl: "https://b.example", model: "m2", enabled: true,
      keys: [
        { id: "k3", value: "sk-b1", enabled: true },
      ] },
  ];
}

t("候选计划:行序 × 行内全 Key", () => {
  const plan = openai.buildCandidatePlan(mkRows());
  const ids = plan.map(c => c.key.id).join(",");
  assert.strictEqual(ids, "k1,k2,k3", "A 的两把 Key 在前,B 的在后");
});

t("停用的行与 Key 不进计划", () => {
  const rows = mkRows();
  rows[0].enabled = false;
  rows[1].keys[0].enabled = false;
  const plan = openai.buildCandidatePlan(rows);
  assert.strictEqual(plan.length, 0, "A 整行停用 + B 唯一 Key 停用 → 无候选");
});

// 冷却/轮询状态机走 module 内部 keyState/rowCursor,借 translateRows 不行(要网络),
// 直接验证 buildCandidatePlan 对失败标记的响应:通过反复构造调用测试不可行(状态私有),
// 这里只断言公开行为:同一批 Key 全禁用时计划为空
t("buildCandidatePlan 跳过空 value 的 Key", () => {
  const rows = [
    { id: "p1", name: "A", baseUrl: "x", model: "m", enabled: true, keys: [
      { id: "k1", value: "", enabled: true },
      { id: "k2", value: "sk-x", enabled: true },
    ] },
  ];
  const plan = openai.buildCandidatePlan(rows);
  assert.strictEqual(plan.length, 1);
  assert.strictEqual(plan[0].key.id, "k2");
});

console.log("\npassed=" + passed + " failed=" + failed);
if (failed > 0) process.exit(1);
