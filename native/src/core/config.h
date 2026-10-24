// Runtime configuration loaded from native.json next to the DLL.
//
// native.json is optional: every field falls back to the defaults below when
// the file, the field or its type is missing. See native/README.md for the
// documented schema.
#pragma once

#include <cstdint>
#include <string>

namespace lct {

// Fractional chat-area rectangle, relative to the back buffer (0..1).
struct ChatRect {
  float x = 0.01f;
  float y = 0.61f;
  float w = 0.30f;
  float h = 0.36f;
};

struct Config {
  // Base URL of the local bridge, no trailing slash required.
  std::string bridgeUrl = "http://127.0.0.1:8791";
  // Empty means "auto-detect from the game process image path".
  std::wstring consoleLogPath;
  // Passed to /api/v1/translate as targetLanguage.
  std::wstring targetLanguage = L"zh-Hans";
  ChatRect chatRect;
  float fontSize = 16.0f;
  int maxLines = 6;
  // Single virtual key that toggles overlay visibility; empty disables it.
  std::string hotkey = "F8";
  bool enabled = true;
};

// Loads native.json from the DLL directory. Returns false only when the file
// exists but cannot be read; malformed fields are logged and skipped.
bool ConfigLoad(Config& config, std::wstring* pathOut = nullptr);

// Change stamp of native.json (0 when missing) used to detect edits at runtime.
uint64_t ConfigStamp();

// Maps "F8" / "HOME" / "X" to a Win32 virtual-key code; 0 when unknown.
unsigned ParseHotkey(const std::string& name);

}  // namespace lct
