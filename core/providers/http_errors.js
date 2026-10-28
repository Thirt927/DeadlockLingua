// Babel Tower - 共享 HTTP 错误文案(供各 provider 复用,消除 5 份重复的 describeHttpError)
// 每个 provider 仍可通过 `overrides` 传入服务商特有文案(如 DeepL 456 额度)。
"use strict";

/**
 * 把 HTTP 状态码 + 响应体转成游戏内红字可读提示。
 * @param {number} status
 * @param {string} bodyText  响应体(可能是 JSON 也可能是纯文本)
 * @param {object} [opts]
 * @param {string} [opts.providerLabel]  服务商标签,用于 "X 服务错误"
 * @param {object} [opts.overrides]      { [status]: "文案" } 服务商特有文案,优先于默认
 * @returns {string}
 */
function describeHttpError(status, bodyText, opts) {
  const body = String(bodyText || "");
  const label = (opts && opts.providerLabel) || "";
  const overrides = (opts && opts.overrides) || {};
  let msg = "";
  try {
    const j = JSON.parse(body);
    msg = (j.error && (j.error.message || j.error.code)) || "";
  } catch (e) {}
  if (overrides[status]) return overrides[status];
  switch (status) {
    case 400: return "请求参数错误(400)" + (msg ? ": " + msg : "");
    case 401: return "API Key 无效(401)" + (msg ? ": " + msg : "");
    case 403: return "Key 无效或无权限(403)" + (msg ? ": " + msg : "");
    case 404: return "接口地址或资源不存在(404)" + (msg ? ": " + msg : "");
    case 408: return "请求超时(408)";
    case 402: return "额度不足(402)";
    case 429: return "请求过于频繁或额度不足(429)";
    default:
      if (status >= 500) return (label ? label + " " : "") + "服务错误(" + status + ")";
      return "翻译失败(" + status + ")" + (msg ? ": " + msg : "");
  }
}

module.exports = { describeHttpError };
