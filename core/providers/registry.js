// Babel Tower - Provider 注册表
// 内置:
//   bing      Bing Translator(公共免费接口,免 Key,默认)
//   microsoft Microsoft Translator(Azure,需自己的 Key,质量/额度更稳)
// 新增 Provider:在 providers/ 下加文件并在下方注册,游戏侧无需改动。
// Ollama / LM Studio / 任意 OpenAI 兼容端点走 openai.js(改 baseUrl 即可),不必单独建文件。
"use strict";

const providers = {
  bing: require("./bing"),
  microsoft: require("./microsoft"),
  openai: require("./openai"),
  deepl: require("./deepl"),
  google: require("./google"),
};

function getProvider(id) {
  return providers[id] || null;
}

function listProviders() {
  return Object.keys(providers).map((id) => ({ id, label: providers[id].label }));
}

module.exports = { getProvider, listProviders };
