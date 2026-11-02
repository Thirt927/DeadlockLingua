// Babel Tower - OpenAI 兼容 Provider(可接 OpenAI / Ollama / LM Studio / OneAPI 等)
// ------------------------------------------------------------------
// 支持任何 OpenAI Chat Completions 兼容端点:
//   baseUrl 默认 https://api.openai.com/v1
//   model   默认 gpt-4o-mini(可改成任意模型名,如 ollama 的 llama3、LM Studio 的本地模型)
// 用法(设置面板或 config/config.json):
//   { "openai": { "apiKey": "...", "baseUrl": "https://api.openai.com/v1", "model": "gpt-4o-mini" } }
"use strict";

const https = require("https");
const http = require("http");
const glossary = require("../glossary");

// Keep-alive: 每次翻译都重新握手的话,TCP+TLS 要 100~300ms,和短译文本身同量级。
// 同一个 Agent 复用连接;http 分支(Ollama / 本地网关)同理。
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 4 });
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 4 });

const DEFAULT_BASE = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-4o-mini";

function describeHttpError(status, bodyText) {
  const body = String(bodyText || "");
  let msg = "";
  try {
    const j = JSON.parse(body);
    msg = (j.error && (j.error.message || j.error.code)) || "";
  } catch (e) {}
  switch (status) {
    case 401: return "API Key 无效(401)" + (msg ? ": " + msg : "");
    case 403: return "无权限/额度问题(403)" + (msg ? ": " + msg : "");
    case 404: return "接口地址或模型不存在(404): 检查 baseUrl 是否带对前缀(OpenAI 需 /v1,DeepSeek 需 https://api.deepseek.com)以及 model 名是否正确" + (msg ? ": " + msg : "");
    case 429: return "请求过于频繁或额度不足(429)" + (msg ? ": " + msg : "");
    default:
      if (status >= 500) return "服务商错误(" + status + ")" + (msg ? ": " + msg : "");
      return "翻译失败(" + status + ")" + (msg ? ": " + msg : "");
  }
}

function requestJson(url, apiKey, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === "http:" ? http : https;
    const req = mod.request(
      url,
      {
        method: "POST",
        agent: url.protocol === "http:" ? httpAgent : httpsAgent,
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + String(apiKey || ""),
          "User-Agent": "BabelTower/0.1",
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => resolve({ status: res.statusCode || 0, body: data }));
      }
    );
    req.on("error", (err) => reject(err));
    req.setTimeout(timeoutMs || 15000, () => { req.destroy(new Error("provider_timeout")); });
    req.write(JSON.stringify(payload));
    req.end();
  });
}

function buildPayload(model, messages, withTemperature, noMaxTokens, disableThinking) {  const payload = { model: model, messages: messages };
  // 显式 max_tokens 避免部分模型默认输出上限把译文截断
  if (!noMaxTokens) payload.max_tokens = 2048; // 长句安全:避免默认输出上限把译文截断
  if (withTemperature) payload.temperature = 0.2;
  // DeepSeek v4 等模型服务端默认开思考模式(响应带 reasoning_content),
  // 简单翻译任务开思考会拖慢到 10s+。配置 disableThinking 时关闭。
  if (disableThinking) payload.thinking = { type: "disabled" };
  return payload;
}

// 「测试连接」用小输出上限(经 callOnce 的 opts.maxTokens 生效)

// language code -> human label used in the translation instruction
function languageLabel(code) {
  const m = {
    "zh": "Simplified Chinese",
    "zh-Hans": "Simplified Chinese",
    "zh-CN": "Simplified Chinese",
    "zh-Hant": "Traditional Chinese",
    "zh-TW": "Traditional Chinese",
    "zh-HK": "Traditional Chinese",
    "en": "English",
    "en-US": "English",
    "en-GB": "English",
    "ja": "Japanese",
    "ja-JP": "Japanese",
    "ko": "Korean",
    "ko-KR": "Korean",
    "ru": "Russian",
    "ru-RU": "Russian",
    "fr": "French",
    "fr-FR": "French",
    "de": "German",
    "de-DE": "German",
    "es": "Spanish",
    "es-ES": "Spanish",
    "pt": "Portuguese",
    "pt-BR": "Portuguese",
    "it": "Italian",
    "it-IT": "Italian",
    "pl": "Polish",
    "uk": "Ukrainian",
    "ar": "Arabic",
    "tr": "Turkish",
    "th": "Thai",
    "vi": "Vietnamese",
    "id": "Indonesian",
  };
  return m[String(code || "")] || String(code || "Simplified Chinese");
}

// Translation instruction: pulls the model back from "chat mode" to "translate mode".
// Instruction is placed in both system and user (some OpenAI-compatible endpoints ignore system).
function buildMessages(text, opts) {
  const target = languageLabel(opts.targetLanguage || "zh-Hans");
  const system = [
    "You are a translation engine for multiplayer game chat.",
    "The input may be written in ANY language (or a mix of languages) - detect it, then translate it into the target language.",
    "Always reply with ONLY the translated text in " + target + ".",
    "Never answer the message as a conversation, never ask questions, never add explanations, quotes, or notes.",
    "Preserve the tone (gg, glhf, ty etc.) and keep it short.",
    "Translate the ENTIRE message completely. Never truncate, never omit any part of the meaning.",
    glossary.buildHint(opts.targetLanguage || "zh-Hans"),
  ].join(" ");
  const user = "Translate the game chat message below to " + target + ". The input may be written in ANY language (or a mix of languages). If it is already in " + target + ", output it unchanged. Reply with ONLY the complete translation.\n\n" + String(text);
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

// Clean model output: strip wrapping quotes/brackets and code fences, keep only the translation
function cleanTranslation(raw) {
  let s = String(raw || "").trim();
  if (/^```[\s\S]*```$/.test(s)) {
    s = s.replace(/^```[^\n]*\n?/, "").replace(/\n?```$/, "").trim();
  }
  const pairs = [['"', '"'], ["'", "'"], ["\u201c", "\u201d"], ["\u2018", "\u2019"], ["\u300c", "\u300d"], ["\u300e", "\u300f"], ["(", ")"], ["\uff08", "\uff09"]];
  let changed = true;
  while (changed && s.length >= 2) {
    changed = false;
    for (const [l, r] of pairs) {
      if (s.startsWith(l) && s.endsWith(r)) {
        s = s.slice(l.length, s.length - r.length).trim();
        changed = true;
        break;
      }
    }
  }
  return s;
}

// 输出是否看起来被截断:以英文字母结尾、末缺句末标点、且输出较长时,大概率是被截断("…save yo" / "…fire her")
function looksTruncated(content) {
  const s = String(content || "").trim();
  if (!s) return true;
  if (!/[A-Za-z]$/.test(s)) return false;
  const m = /([A-Za-z]+)$/.exec(s);
  if (!m || m[1].length < 2) return false;
  return s.length >= 30 && !/[.!?。、！？…]$/.test(s);
}

// ---------- 多端点 + Key 池 (v2.3.0, DSH 行式) ----------
// 行顺序 = 回退顺序;行内多把 Key 轮询(游标),失败 Key 自动冷却跳过,成功后自动回池:
//   429(限额) → 60s 冷却;401/403(Key 坏) → 300s 冷却;5xx/超时/404 不罚 Key,
//   直接跳下一行(端点级问题)。冷却到期自动恢复,不用手动管。
const keyState = new Map();   // "rowId/keyId" -> {fails, disabledUntil}
const rowCursor = new Map();  // rowId -> 下一把 Key 的下标(轮询游标)

function keyStateKey(rowId, keyId) { return String(rowId) + "/" + String(keyId); }

function markKeyFailure(rowId, keyId, status) {
  const k = keyStateKey(rowId, keyId);
  const s = keyState.get(k) || { fails: 0, disabledUntil: 0 };
  s.fails += 1;
  if (status === 429) s.disabledUntil = Date.now() + 60000;
  else if (status === 401 || status === 403) s.disabledUntil = Date.now() + 300000;
  // 5xx/超时/404:不罚 Key,只换下一把/下一行
  keyState.set(k, s);
}

function markKeySuccess(rowId, keyId) {
  const s = keyState.get(keyStateKey(rowId, keyId));
  if (s) { s.fails = 0; s.disabledUntil = 0; }
}

// 单行单 Key 调一次(带 400 参数自适应重试,从旧 translate 抽出复用)
async function callOnce(baseUrl, model, apiKey, msgs, opts) {
  const base = String(baseUrl || DEFAULT_BASE).replace(/\/+$/, "");
  let url;
  try { url = new URL(base + "/chat/completions"); } catch {
    const err = new Error("baseUrl 非法: " + base);
    err.status = 404;
    throw err;
  }
  const noThinking = !!opts.disableThinking;
  let payload;
  if (opts.maxTokens) {
    payload = buildPayload(model, msgs, true, false, noThinking);
    payload.max_tokens = opts.maxTokens;
  } else {
    payload = buildPayload(model, msgs, true, false, noThinking);
  }
  let res = await requestJson(url, apiKey, payload, opts.timeoutMs);
  if (res.status === 400) {
    const body = String(res.body).toLowerCase();
    if (body.indexOf("temperature") !== -1) {
      res = await requestJson(url, apiKey, buildPayload(model, msgs, false, false, noThinking), opts.timeoutMs);
    } else if (body.indexOf("max_tokens") !== -1 || body.indexOf("max tokens") !== -1) {
      res = await requestJson(url, apiKey, buildPayload(model, msgs, true, true, noThinking), opts.timeoutMs);
    } else if (body.indexOf("thinking") !== -1) {
      res = await requestJson(url, apiKey, buildPayload(model, msgs, true, false, false), opts.timeoutMs);
    }
  }
  if (res.status !== 200) {
    const err = new Error(describeHttpError(res.status, res.body));
    err.status = res.status;
    throw err;
  }
  let parsed;
  try { parsed = JSON.parse(res.body); } catch { throw new Error("翻译服务返回了无法解析的数据"); }
  const content = parsed && parsed.choices && parsed.choices[0] && parsed.choices[0].message && parsed.choices[0].message.content;
  if (!content) throw new Error("翻译服务返回为空");
  return { content: String(content), finish: parsed.choices[0].finish_reason };
}

// 候选计划:行序 × 行内轮询游标,跳过冷却中的 Key
function buildCandidatePlan(rows) {
  const now = Date.now();
  const plan = [];
  for (const row of rows || []) {
    if (!row || row.enabled === false) continue;
    const onKeys = [];
    (row.keys || []).forEach(function (k, i) {
      if (k && k.enabled !== false && k.value) {
        const st = keyState.get(keyStateKey(row.id, k.id));
        if (!st || st.disabledUntil < now) onKeys.push({ k: k, i: i });
      }
    });
    if (!onKeys.length) continue;
    const start = Math.abs(Number(rowCursor.get(row.id)) || 0) % onKeys.length;
    for (let s = 0; s < onKeys.length; s += 1) {
      const pick = onKeys[(start + s) % onKeys.length];
      if (!pick) continue;
      plan.push({ row: row, key: pick.k, idx: pick.i });
    }
  }
  return plan;
}

// 多端点翻译:按行序回退,行内换 Key。全挂时返回 {error} 由调用方走跨类别回退
async function translateRows(text, opts, rows) {
  const plan = buildCandidatePlan(rows);
  if (!plan.length) {
    const e = new Error("openai 端点列表没有可用端点(全部停用或未配 Key)");
    e.status = 502;
    return { error: e };
  }
  const errors = [];
  const t0 = Date.now();
  let lastLat = 0;
  for (let n = 0; n < plan.length; n += 1) {
    const c = plan[n];
    try {
      const msgs = buildMessages(text, opts);
      const out = await callOnce(c.row.baseUrl, c.row.model, c.key.value, msgs, opts);
      lastLat = Date.now() - t0;
      markKeySuccess(c.row.id, c.key.id);
      rowCursor.set(c.row.id, c.idx + 1); // 真轮询:下次从下一把 Key 开始
      // 截断重试(只在首行,避免多端点连环烧 token)
      let content = out.content;
      if (n === 0 && (out.finish === "length" || looksTruncated(content))) {
        const retryMsgs = [
          { role: "system", content: "You are a translation engine for multiplayer game chat. Translate the message completely. Never truncate or omit any part. Reply with ONLY the complete translation." },
          { role: "user", content: "Translate the ENTIRE message below completely. Do not cut off.\n\n" + String(text) },
        ];
        const out2 = await callOnce(c.row.baseUrl, c.row.model, c.key.value, retryMsgs, opts);
        content = out2.content;
      }
      return {
        translation: glossary.fixHeroTerms(text, cleanTranslation(content), opts.targetLanguage),
        provider: "openai",
        viaRow: c.row.name,
        viaKey: c.key.id,
        latencyMs: lastLat,
      };
    } catch (e) {
      const st = e && e.status;
      markKeyFailure(c.row.id, c.key.id, st);
      errors.push(c.row.name + ": " + (e && e.message ? e.message : String(e)));
      // 端点级失败(5xx/超时/404/解析失败):跳整行;Key 级失败(401/403/429):继续下一把 Key
      if (st !== 401 && st !== 403 && st !== 429) break;
    }
  }
  const last = new Error("openai 全部端点失败: " + errors.join(" | ").slice(0, 300));
  last.status = 502;
  return { error: last };
}

// 网页设置页「测试连接」:对该行(或指定 Key)发一句小请求
async function testRow(row, keyId, timeoutMs) {
  const k = (row.keys || []).find(function (x) { return keyId && x.id === keyId && x.enabled !== false; }) ||
    (row.keys || []).find(function (x) { return x.enabled !== false && x.value; });
  if (!k) return { ok: false, error: "没有可用 Key" };
  const t0 = Date.now();
  try {
    await callOnce(row.baseUrl, row.model, k.value, [
      { role: "user", content: "Reply with: ok" },
    ], { targetLanguage: "en", timeoutMs: timeoutMs || 8000, maxTokens: 8 });
    return { ok: true, latencyMs: Date.now() - t0, keyId: k.id };
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - t0, error: (e && e.message) || String(e), keyId: k.id };
  }
}

// 网页设置页「获取可用模型」:打端点 /models(Ollama 本地免 Key)
async function fetchModels(row, timeoutMs) {
  const k = (row.keys || []).find(function (x) { return x.enabled !== false && x.value; });
  const base = String(row.baseUrl || DEFAULT_BASE).replace(/\/+$/, "");
  let url;
  try { url = new URL(base + "/models"); } catch { return { ok: false, error: "baseUrl 非法: " + base }; }
  return new Promise(function (resolve) {
    const mod = url.protocol === "http:" ? http : https;
    const req = mod.request(url, {
      method: "GET",
      agent: url.protocol === "http:" ? httpAgent : httpsAgent,
      headers: k ? { "Authorization": "Bearer " + k.value, "User-Agent": "BabelTower/0.1" } : { "User-Agent": "BabelTower/0.1" },
    }, function (res) {
      let data = "";
      res.on("data", function (c) { data += c; });
      res.on("end", function () {
        if (res.statusCode !== 200) {
          resolve({ ok: false, error: "端点 /models 返回 " + res.statusCode });
          return;
        }
        try {
          const j = JSON.parse(data);
          const ids = (j.data || j.models || j).map(function (m) { return m.id || m.name; }).filter(Boolean);
          resolve({ ok: true, models: ids.slice(0, 50) });
        } catch {
          resolve({ ok: false, error: "端点 /models 返回无法解析" });
        }
      });
    });
    req.on("error", function (e) { resolve({ ok: false, error: e.message }); });
    req.setTimeout(timeoutMs || 8000, function () { req.destroy(new Error("fetch_models_timeout")); });
    req.end();
  });
}

async function translate(text, opts) {
  const base = String(opts.baseUrl || DEFAULT_BASE).replace(/\/+$/, "");
  const url = new URL(base + "/chat/completions");
  const model = String(opts.model || DEFAULT_MODEL);
  const noThinking = !!opts.disableThinking;
  const call = async function (msgs, withTemp) {
    let res = await requestJson(url, opts.apiKey, buildPayload(model, msgs, withTemp, false, noThinking), opts.timeoutMs);
    if (res.status === 400) {
      const body = String(res.body).toLowerCase();
      if (body.indexOf("temperature") !== -1) {
        // DeepSeek reasoner 等模型不支持 temperature/top_p(400),去掉后重试一次
        res = await requestJson(url, opts.apiKey, buildPayload(model, msgs, false, false, noThinking), opts.timeoutMs);
      } else if (body.indexOf("max_tokens") !== -1 || body.indexOf("max tokens") !== -1) {
        res = await requestJson(url, opts.apiKey, buildPayload(model, msgs, withTemp, true, noThinking), opts.timeoutMs);
      } else if (body.indexOf("thinking") !== -1) {
        // 服务端不支持 thinking 参数:去掉后重试
        res = await requestJson(url, opts.apiKey, buildPayload(model, msgs, withTemp, false, false), opts.timeoutMs);
      }
    }
    if (res.status !== 200) {
      const err = new Error(describeHttpError(res.status, res.body));
      err.status = res.status;
      throw err;
    }
    let parsed;
    try {
      parsed = JSON.parse(res.body);
    } catch {
      throw new Error("翻译服务返回了无法解析的数据");
    }
    const content =
      parsed &&
      parsed.choices &&
      parsed.choices[0] &&
      parsed.choices[0].message &&
      parsed.choices[0].message.content;
    if (!content) {
      throw new Error("翻译服务返回为空");
    }
    return { content: String(content), finish: parsed.choices[0].finish_reason };
  };
  let out = await call(buildMessages(text, opts), true);
  // 输出被截断(finish_reason=length 或半词结尾启发式):重试一次,要求完整翻译
  if (out.finish === "length" || looksTruncated(out.content)) {
    const retryMsgs = [
      { role: "system", content: "You are a translation engine for multiplayer game chat. Translate the message completely. Never truncate or omit any part. Reply with ONLY the complete translation." },
      { role: "user", content: "Translate the ENTIRE message below completely. Do not cut off.\n\n" + String(text) },
    ];
    out = await call(retryMsgs, true);
  }
  return {
    translation: glossary.fixHeroTerms(text, cleanTranslation(out.content), opts.targetLanguage),
    detectedLanguage: null,
  };
}

module.exports = {
  id: "openai",
  label: "OpenAI 兼容(自定义)",
  translate,
  buildMessages,
  cleanTranslation,
  languageLabel,
  // v2.3.0 多端点 + Key 池
  translateRows,
  buildCandidatePlan,
  testRow,
  fetchModels,
  keyStateOf: function (rowId, keyId) { const s = keyState.get(keyStateKey(rowId, keyId)); return s ? { fails: s.fails, disabledUntil: s.disabledUntil } : null; },
};
