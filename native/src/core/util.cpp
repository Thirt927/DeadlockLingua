#include "core/util.h"

#include <windows.h>

#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <cstring>

namespace lct {
namespace {

size_t SkipWhitespace(const std::string& text, size_t pos) {
  while (pos < text.size()) {
    const char c = text[pos];
    if (c != ' ' && c != '\t' && c != '\r' && c != '\n') break;
    ++pos;
  }
  return pos;
}

// Reads one JSON string token starting at the opening quote. `raw` receives the
// token *including* the surrounding quotes; `pos` is advanced past the closing
// quote. Escapes are skipped here and decoded later by JsonAsString.
bool ParseJsonStringToken(const std::string& text, size_t& pos, std::string& raw) {
  if (pos >= text.size() || text[pos] != '"') return false;
  const size_t start = pos;
  ++pos;
  while (pos < text.size()) {
    const char c = text[pos];
    if (c == '\\') {
      pos += 2;
      continue;
    }
    if (c == '"') {
      ++pos;
      raw.assign(text, start, pos - start);
      return true;
    }
    ++pos;
  }
  return false;
}

// Advances `pos` past a single JSON value (string, object/array or scalar).
bool SkipJsonValue(const std::string& text, size_t& pos) {
  pos = SkipWhitespace(text, pos);
  if (pos >= text.size()) return false;
  const char first = text[pos];
  if (first == '"') {
    std::string ignored;
    return ParseJsonStringToken(text, pos, ignored);
  }
  if (first == '{' || first == '[') {
    int depth = 0;
    while (pos < text.size()) {
      const char c = text[pos];
      if (c == '"') {
        std::string ignored;
        if (!ParseJsonStringToken(text, pos, ignored)) return false;
        continue;
      }
      if (c == '{' || c == '[') {
        ++depth;
      } else if (c == '}' || c == ']') {
        --depth;
        ++pos;
        if (depth == 0) return true;
        continue;
      }
      ++pos;
    }
    return false;
  }
  // Number, true, false or null: consume until a structural delimiter.
  const size_t start = pos;
  while (pos < text.size()) {
    const char c = text[pos];
    if (c == ',' || c == '}' || c == ']' || c == ' ' || c == '\t' || c == '\r' || c == '\n') break;
    ++pos;
  }
  return pos > start;
}

int HexValue(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

void AppendUtf8(std::string& out, unsigned codePoint) {
  if (codePoint <= 0x7F) {
    out.push_back(static_cast<char>(codePoint));
  } else if (codePoint <= 0x7FF) {
    out.push_back(static_cast<char>(0xC0 | (codePoint >> 6)));
    out.push_back(static_cast<char>(0x80 | (codePoint & 0x3F)));
  } else if (codePoint <= 0xFFFF) {
    out.push_back(static_cast<char>(0xE0 | (codePoint >> 12)));
    out.push_back(static_cast<char>(0x80 | ((codePoint >> 6) & 0x3F)));
    out.push_back(static_cast<char>(0x80 | (codePoint & 0x3F)));
  } else {
    out.push_back(static_cast<char>(0xF0 | (codePoint >> 18)));
    out.push_back(static_cast<char>(0x80 | ((codePoint >> 12) & 0x3F)));
    out.push_back(static_cast<char>(0x80 | ((codePoint >> 6) & 0x3F)));
    out.push_back(static_cast<char>(0x80 | (codePoint & 0x3F)));
  }
}

}  // namespace

std::wstring GetModuleDirectory() {
  HMODULE module = nullptr;
  const DWORD flags = GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT;
  if (!GetModuleHandleExW(flags, reinterpret_cast<LPCWSTR>(&GetModuleDirectory), &module) || module == nullptr) {
    return std::wstring();
  }
  wchar_t buffer[32768] = {};
  const DWORD length = GetModuleFileNameW(module, buffer, static_cast<DWORD>(sizeof(buffer) / sizeof(buffer[0])));
  if (length == 0 || length >= sizeof(buffer) / sizeof(buffer[0])) return std::wstring();
  std::wstring path(buffer, length);
  const size_t slash = path.find_last_of(L"\\/");
  if (slash == std::wstring::npos) return std::wstring();
  return path.substr(0, slash);
}

std::wstring Utf8ToWide(const std::string& in) {
  if (in.empty()) return std::wstring();
  const int needed = MultiByteToWideChar(CP_UTF8, 0, in.data(), static_cast<int>(in.size()), nullptr, 0);
  if (needed <= 0) return std::wstring();
  std::wstring out(static_cast<size_t>(needed), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, in.data(), static_cast<int>(in.size()), &out[0], needed);
  return out;
}

std::string WideToUtf8(const std::wstring& in) {
  if (in.empty()) return std::string();
  const int needed = WideCharToMultiByte(CP_UTF8, 0, in.data(), static_cast<int>(in.size()), nullptr, 0, nullptr, nullptr);
  if (needed <= 0) return std::string();
  std::string out(static_cast<size_t>(needed), '\0');
  WideCharToMultiByte(CP_UTF8, 0, in.data(), static_cast<int>(in.size()), &out[0], needed, nullptr, nullptr);
  return out;
}

std::string TrimAscii(const std::string& in) {
  size_t begin = 0;
  size_t end = in.size();
  while (begin < end && std::isspace(static_cast<unsigned char>(in[begin]))) ++begin;
  while (end > begin && std::isspace(static_cast<unsigned char>(in[end - 1]))) --end;
  return in.substr(begin, end - begin);
}

std::string TruncateUtf8(const std::string& in, size_t maxBytes) {
  if (in.size() <= maxBytes) return in;

  size_t length = maxBytes;
  // Step back to the lead byte of the code point straddling the cut.
  while (length > 0 && (static_cast<unsigned char>(in[length - 1]) & 0xC0) == 0x80) --length;
  // If that lead byte needs more bytes than fit, drop the whole sequence.
  while (length > 0) {
    const unsigned char lead = static_cast<unsigned char>(in[length - 1]);
    size_t needed = 0;
    if ((lead & 0xE0) == 0xC0) {
      needed = 2;
    } else if ((lead & 0xF0) == 0xE0) {
      needed = 3;
    } else if ((lead & 0xF8) == 0xF0) {
      needed = 4;
    }
    if (needed != 0 && maxBytes - (length - 1) < needed) {
      --length;
      continue;
    }
    break;
  }
  return in.substr(0, length);
}

std::string JsonEscape(const std::string& utf8) {
  std::string out;
  out.reserve(utf8.size() + 16);
  for (const char raw : utf8) {
    const unsigned char byte = static_cast<unsigned char>(raw);
    switch (raw) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\b': out += "\\b"; break;
      case '\f': out += "\\f"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (byte < 0x20) {
          char buffer[8] = {};
          std::snprintf(buffer, sizeof(buffer), "\\u%04x", static_cast<unsigned>(byte));
          out += buffer;
        } else {
          out.push_back(raw);
        }
        break;
    }
  }
  return out;
}

bool JsonFindMember(const std::string& json, const char* key, std::string& rawOut) {
  if (key == nullptr) return false;
  size_t pos = SkipWhitespace(json, 0);
  if (pos >= json.size() || json[pos] != '{') return false;
  ++pos;
  for (;;) {
    pos = SkipWhitespace(json, pos);
    if (pos >= json.size() || json[pos] == '}') return false;
    std::string keyToken;
    if (!ParseJsonStringToken(json, pos, keyToken)) return false;
    std::string keyName;
    if (!JsonAsString(keyToken, keyName)) return false;
    pos = SkipWhitespace(json, pos);
    if (pos >= json.size() || json[pos] != ':') return false;
    ++pos;
    const size_t valueStart = SkipWhitespace(json, pos);
    size_t valueEnd = valueStart;
    if (!SkipJsonValue(json, valueEnd)) return false;
    if (keyName == key) {
      rawOut.assign(json, valueStart, valueEnd - valueStart);
      return true;
    }
    pos = SkipWhitespace(json, valueEnd);
    if (pos < json.size() && json[pos] == ',') {
      ++pos;
      continue;
    }
    return false;
  }
}

bool JsonAsString(const std::string& raw, std::string& out) {
  std::string token;
  size_t pos = 0;
  if (!ParseJsonStringToken(raw, pos, token)) return false;
  if (SkipWhitespace(raw, pos) != raw.size()) return false;
  out.clear();
  for (size_t i = 1; i + 1 < token.size(); ++i) {
    const char c = token[i];
    if (c != '\\') {
      out.push_back(c);
      continue;
    }
    ++i;
    if (i + 1 >= token.size()) return false;
    const char escape = token[i];
    switch (escape) {
      case '"': out.push_back('"'); break;
      case '\\': out.push_back('\\'); break;
      case '/': out.push_back('/'); break;
      case 'b': out.push_back('\b'); break;
      case 'f': out.push_back('\f'); break;
      case 'n': out.push_back('\n'); break;
      case 'r': out.push_back('\r'); break;
      case 't': out.push_back('\t'); break;
      case 'u': {
        if (i + 4 >= token.size()) return false;
        unsigned codePoint = 0;
        for (size_t k = 1; k <= 4; ++k) {
          const int value = HexValue(token[i + k]);
          if (value < 0) return false;
          codePoint = (codePoint << 4) | static_cast<unsigned>(value);
        }
        i += 4;
        // Decode a UTF-16 surrogate pair when present; otherwise emit the BMP
        // code point directly (lone surrogates become U+FFFD).
        if (codePoint >= 0xD800 && codePoint <= 0xDBFF) {
          bool paired = false;
          if (i + 6 < token.size() && token[i + 1] == '\\' && token[i + 2] == 'u') {
            unsigned low = 0;
            bool valid = true;
            for (size_t k = 3; k <= 6; ++k) {
              const int value = HexValue(token[i + k]);
              if (value < 0) {
                valid = false;
                break;
              }
              low = (low << 4) | static_cast<unsigned>(value);
            }
            if (valid && low >= 0xDC00 && low <= 0xDFFF) {
              codePoint = 0x10000 + ((codePoint - 0xD800) << 10) + (low - 0xDC00);
              i += 6;
              paired = true;
            }
          }
          if (!paired) codePoint = 0xFFFD;
        } else if (codePoint >= 0xDC00 && codePoint <= 0xDFFF) {
          codePoint = 0xFFFD;
        }
        AppendUtf8(out, codePoint);
        break;
      }
      default: out.push_back(escape); break;
    }
  }
  return true;
}

bool JsonAsBool(const std::string& raw, bool& out) {
  const std::string value = TrimAscii(raw);
  if (value == "true") {
    out = true;
    return true;
  }
  if (value == "false") {
    out = false;
    return true;
  }
  return false;
}

bool JsonAsDouble(const std::string& raw, double& out) {
  const std::string value = TrimAscii(raw);
  if (value.empty()) return false;
  char* end = nullptr;
  const double parsed = std::strtod(value.c_str(), &end);
  if (end == nullptr || *end != '\0') return false;
  out = parsed;
  return true;
}

}  // namespace lct
