// Babel Tower - Provider 注册表
// 内置:
//   bing      Bing Translator(公共免费接口,免 Key,默认)
//   microsoft Microsoft Translator(Azure,需自己的 Key,质量/额度更稳)
// 后续 Provider(DeepL / OpenAI 兼容 / Ollama 等)只需在 providers/ 下新增文件
// 并在下方注册,即可被 Core 使用,游戏侧无需改动。
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
