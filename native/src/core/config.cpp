#include "core/config.h"

#include <windows.h>

#include <cctype>
#include <cstdlib>

#include "core/log.h"
#include "core/util.h"

namespace lct {
namespace {

constexpr float kMinFontSize = 8.0f;
constexpr float kMaxFontSize = 72.0f;
constexpr int kMinLines = 1;
constexpr int kMaxLines = 32;

float Clamp01(float value) {
  if (value < 0.0f) return 0.0f;
  if (value > 1.0f) return 1.0f;
  return value;
}

void ClampRect(ChatRect& rect) {
  rect.x = Clamp01(rect.x);
  rect.y = Clamp01(rect.y);
  rect.w = Clamp01(rect.w);
  rect.h = Clamp01(rect.h);
  if (rect.w < 0.05f) rect.w = 0.05f;
  if (rect.h < 0.05f) rect.h = 0.05f;
  if (rect.x + rect.w > 1.0f) rect.x = 1.0f - rect.w;
  if (rect.y + rect.h > 1.0f) rect.y = 1.0f - rect.h;
}

bool ReadTextFile(const std::wstring& path, std::string& out) {
  const HANDLE file = CreateFileW(path.c_str(), GENERIC_READ,
                                  FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
                                  FILE_ATTRIBUTE_NORMAL, nullptr);
  if (file == INVALID_HANDLE_VALUE) return false;

  bool ok = false;
  LARGE_INTEGER size = {};
  if (GetFileSizeEx(file, &size) && size.QuadPart >= 0 && size.QuadPart <= 1024 * 1024) {
    out.resize(static_cast<size_t>(size.QuadPart));
    DWORD read = 0;
    if (out.empty()) {
      ok = true;
    } else if (ReadFile(file, &out[0], static_cast<DWORD>(out.size()), &read, nullptr) != 0) {
      out.resize(read);
      ok = true;
    }
  }
  CloseHandle(file);
  return ok;
}

bool ReadStringField(const std::string& json, const char* key, std::string& out) {
  std::string raw;
  if (!JsonFindMember(json, key, raw)) return false;
  return JsonAsString(raw, out);
}

bool ReadNumberField(const std::string& json, const char* key, double& out) {
  std::string raw;
  if (!JsonFindMember(json, key, raw)) return false;
  return JsonAsDouble(raw, out);
}

bool ReadBoolField(const std::string& json, const char* key, bool& out) {
  std::string raw;
  if (!JsonFindMember(json, key, raw)) return false;
  return JsonAsBool(raw, out);
}

}  // namespace

bool ConfigLoad(Config& config, std::wstring* pathOut) {
  const std::wstring directory = GetModuleDirectory();
  std::wstring path = L"native.json";
  if (!directory.empty()) path = directory + L"\\native.json";
  if (pathOut != nullptr) *pathOut = path;

  std::string text;
  if (!ReadTextFile(path, text)) {
    // Missing file is the normal first-run case, not an error.
    LogInfo("config: native.json not readable at %s; using defaults", WideToUtf8(path).c_str());
    return true;
  }

  std::string value;
  if (ReadStringField(text, "bridgeUrl", value) && !value.empty()) {
    const bool looksLikeHttp = value.rfind("http://", 0) == 0 || value.rfind("https://", 0) == 0;
    if (looksLikeHttp) {
      config.bridgeUrl = value;
    } else {
      LogWarn("config: bridgeUrl must start with http:// or https://; keeping default");
    }
  }

  if (ReadStringField(text, "consoleLogPath", value)) {
    config.consoleLogPath = Utf8ToWide(value);
  }

  if (ReadStringField(text, "targetLanguage", value) && !value.empty()) {
    config.targetLanguage = Utf8ToWide(value);
  }

  std::string rectJson;
  if (JsonFindMember(text, "chatRect", rectJson)) {
    double number = 0.0;
    if (ReadNumberField(rectJson, "x", number)) config.chatRect.x = static_cast<float>(number);
    if (ReadNumberField(rectJson, "y", number)) config.chatRect.y = static_cast<float>(number);
    if (ReadNumberField(rectJson, "w", number)) config.chatRect.w = static_cast<float>(number);
    if (ReadNumberField(rectJson, "h", number)) config.chatRect.h = static_cast<float>(number);
  }
  ClampRect(config.chatRect);

  double number = 0.0;
  if (ReadNumberField(text, "fontSize", number)) {
    config.fontSize = static_cast<float>(number);
    if (config.fontSize < kMinFontSize) config.fontSize = kMinFontSize;
    if (config.fontSize > kMaxFontSize) config.fontSize = kMaxFontSize;
  }

  if (ReadNumberField(text, "maxLines", number)) {
    int lines = static_cast<int>(number);
    if (lines < kMinLines) lines = kMinLines;
    if (lines > kMaxLines) lines = kMaxLines;
    config.maxLines = lines;
  }

  if (ReadStringField(text, "hotkey", value)) {
    config.hotkey = value;
    if (!value.empty() && ParseHotkey(value) == 0) {
      LogWarn("config: unknown hotkey \"%s\"; hotkey disabled", value.c_str());
      config.hotkey.clear();
    }
  }

  bool enabled = config.enabled;
  if (ReadBoolField(text, "enabled", enabled)) {
    config.enabled = enabled;
  }

  LogInfo("config: loaded %s (enabled=%d maxLines=%d fontSize=%.1f)",
          WideToUtf8(path).c_str(), config.enabled ? 1 : 0, config.maxLines, static_cast<double>(config.fontSize));
  return true;
}

uint64_t ConfigStamp() {
  const std::wstring directory = GetModuleDirectory();
  std::wstring path = L"native.json";
  if (!directory.empty()) path = directory + L"\\native.json";

  WIN32_FILE_ATTRIBUTE_DATA data = {};
  if (!GetFileAttributesExW(path.c_str(), GetFileExInfoStandard, &data)) return 0;

  ULARGE_INTEGER writeTime = {};
  writeTime.LowPart = data.ftLastWriteTime.dwLowDateTime;
  writeTime.HighPart = data.ftLastWriteTime.dwHighDateTime;
  ULARGE_INTEGER fileSize = {};
  fileSize.LowPart = data.nFileSizeLow;
  fileSize.HighPart = data.nFileSizeHigh;
  return writeTime.QuadPart ^ (fileSize.QuadPart << 1);
}

unsigned ParseHotkey(const std::string& name) {
  std::string key;
  key.reserve(name.size());
  for (const char c : name) {
    if (!std::isspace(static_cast<unsigned char>(c))) {
      key.push_back(static_cast<char>(std::toupper(static_cast<unsigned char>(c))));
    }
  }
  if (key.empty()) return 0;

  if (key.size() == 1) {
    const char c = key[0];
    if (c >= 'A' && c <= 'Z') return static_cast<unsigned>(c);
    if (c >= '0' && c <= '9') return static_cast<unsigned>(c);
    return 0;
  }

  if (key[0] == 'F') {
    const int number = std::atoi(key.c_str() + 1);
    if (number >= 1 && number <= 24) return VK_F1 + static_cast<unsigned>(number - 1);
  }

  struct KeyName {
    const char* name;
    unsigned code;
  };
  static const KeyName kNames[] = {
      {"TAB", VK_TAB},       {"ESC", VK_ESCAPE},   {"ESCAPE", VK_ESCAPE}, {"HOME", VK_HOME},
      {"END", VK_END},       {"INSERT", VK_INSERT}, {"INS", VK_INSERT},   {"DELETE", VK_DELETE},
      {"DEL", VK_DELETE},    {"PGUP", VK_PRIOR},   {"PAGEDOWN", VK_NEXT}, {"PGDN", VK_NEXT},
      {"SPACE", VK_SPACE},   {"PAUSE", VK_PAUSE},  {"SCROLL", VK_SCROLL},
  };
  for (const KeyName& candidate : kNames) {
    if (key == candidate.name) return candidate.code;
  }
  return 0;
}

}  // namespace lct
