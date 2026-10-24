#include "app.h"

#include <windows.h>

#include <algorithm>
#include <cctype>
#include <cstdint>
#include <string>
#include <utility>
#include <vector>

#include "core/log.h"
#include "core/util.h"

namespace lct {
namespace {

constexpr uint64_t kTailPollIntervalMs = 250;
constexpr uint64_t kConfigCheckIntervalMs = 1000;
constexpr uint64_t kHotkeyPollIntervalMs = 100;
constexpr uint64_t kQueueWarningIntervalMs = 5000;
constexpr size_t kMaxOriginalBytes = 200;
constexpr size_t kMaxTranslationChars = 600;

void AppendEllipsis(std::wstring& text) {
  if (text.size() < 400) text += L"...";
}

}  // namespace

App& App::Instance() {
  // Intentionally leaked: the DLL is expected to live until the process exits,
  // and running the destructor from CRT teardown (or loader lock) would try to
  // join threads while the process is already shutting down.
  static App* instance = new App();
  return *instance;
}

App::App() = default;

App::~App() { Shutdown(); }

bool App::EnsureStarted() {
  std::lock_guard<std::mutex> lifecycleLock(lifecycleMutex_);
  if (running_.load(std::memory_order_acquire)) return true;

  LogInit();
  LogInfo("LCTNative: starting (pid=%lu)", static_cast<unsigned long>(GetCurrentProcessId()));

  Config loaded;
  std::wstring path;
  if (!ConfigLoad(loaded, &path)) {
    LogWarn("config: native.json could not be read; using defaults");
  }
  config_ = loaded;
  configPath_ = path;
  configStamp_ = ConfigStamp();
  hotkeyVirtualKey_ = ParseHotkey(config_.hotkey);

  overlayReady_ = overlay_.Install();
  if (!overlayReady_) {
    LogWarn("overlay: install failed; translation pipeline disabled (the game is unaffected)");
  }
  ApplyOverlaySettings();

  translatorReady_ = translator_.Start(config_, [this](const TranslateResult& result) { OnTranslated(result); });
  if (!translatorReady_) LogWarn("translate: client failed to start; translation disabled");

  logTail_.Configure(config_.consoleLogPath);

  shuttingDown_.store(false, std::memory_order_release);
  running_.store(true, std::memory_order_release);
  tickThread_ = std::thread(&App::TickLoop, this);

  LogInfo("LCTNative: running (overlay=%d translate=%d)", overlayReady_ ? 1 : 0, translatorReady_ ? 1 : 0);
  return true;
}

void App::Shutdown() {
  std::lock_guard<std::mutex> lifecycleLock(lifecycleMutex_);
  if (!running_.exchange(false, std::memory_order_acq_rel)) return;
  shuttingDown_.store(true, std::memory_order_release);

  if (tickThread_.joinable()) tickThread_.join();
  translator_.Stop();
  overlay_.Uninstall();
  logTail_.Shutdown();

  LogInfo("LCTNative: shutdown complete");
  LogShutdown();
}

void App::TickLoop() {
  LogInfo("tick: loop started");
  while (!shuttingDown_.load(std::memory_order_acquire)) {
    const uint64_t now = GetTickCount64();
    try {
      if (now - lastTailPollMs_ >= kTailPollIntervalMs) {
        lastTailPollMs_ = now;
        PollChat();
      }

      if (now - lastConfigCheckMs_ >= kConfigCheckIntervalMs) {
        lastConfigCheckMs_ = now;
        MaybeReloadConfig();
      }

      PollHotkey();
    } catch (...) {
      // A failed allocation inside the tick must never take the game down.
      LogError("tick: unexpected exception; continuing");
    }
    Sleep(50);
  }
  LogInfo("tick: loop stopped");
}

void App::PollChat() {
  std::vector<ChatLine> lines;
  logTail_.Poll(lines);
  if (lines.empty()) return;

  if (!config_.enabled || !overlayReady_ || !translatorReady_) return;

  const std::string targetLanguage = WideToUtf8(config_.targetLanguage);
  for (const ChatLine& line : lines) {
    if (line.own) continue;
    if (!ShouldTranslate(line)) continue;

    OverlayLine overlayLine;
    overlayLine.seq = line.seq;
    overlayLine.sender = Utf8ToWide(line.sender);
    const std::wstring fullOriginal = Utf8ToWide(line.text);
    overlayLine.original = Utf8ToWide(TruncateUtf8(line.text, kMaxOriginalBytes));
    if (overlayLine.original.size() < fullOriginal.size()) AppendEllipsis(overlayLine.original);
    overlayLine.pending = true;
    overlay_.AddLine(overlayLine);

    TranslateRequest request;
    request.seq = line.seq;
    request.text = line.text;
    request.targetLanguage = targetLanguage;
    if (!translator_.Submit(request)) {
      overlay_.MarkTranslationFailed(line.seq);
      const uint64_t now = GetTickCount64();
      if (now - lastQueueWarningMs_ >= kQueueWarningIntervalMs) {
        lastQueueWarningMs_ = now;
        LogWarn("translate: queue full; dropping translated lines until it drains");
      }
    }
  }
}

void App::PollHotkey() {
  if (hotkeyVirtualKey_ == 0) return;

  // Poll faster than the interval so a quick tap is not missed.
  if (GetTickCount64() - lastHotkeyPollMs_ < kHotkeyPollIntervalMs) return;
  lastHotkeyPollMs_ = GetTickCount64();

  const bool down = (GetAsyncKeyState(static_cast<int>(hotkeyVirtualKey_)) & 0x8000) != 0;
  if (down && !hotkeyDown_) {
    const bool visible = !overlayVisible_.load(std::memory_order_acquire);
    overlayVisible_.store(visible, std::memory_order_release);
    ApplyOverlaySettings();
    LogInfo("hotkey: overlay %s", visible ? "shown" : "hidden");
  }
  hotkeyDown_ = down;
}

void App::MaybeReloadConfig() {
  const uint64_t stamp = ConfigStamp();
  if (stamp == configStamp_) return;

  Config loaded;
  std::wstring path;
  if (!ConfigLoad(loaded, &path)) {
    LogWarn("config: reload failed; keeping the previous settings");
    configStamp_ = stamp;
    return;
  }

  config_ = loaded;
  configPath_ = path;
  configStamp_ = stamp;
  hotkeyVirtualKey_ = ParseHotkey(config_.hotkey);
  ApplyOverlaySettings();
  translator_.UpdateConfig(config_);
  logTail_.Configure(config_.consoleLogPath);
  LogInfo("config: reloaded native.json");
}

void App::ApplyOverlaySettings() {
  OverlaySettings settings;
  settings.x = config_.chatRect.x;
  settings.y = config_.chatRect.y;
  settings.w = config_.chatRect.w;
  settings.h = config_.chatRect.h;
  settings.fontSize = config_.fontSize;
  settings.maxLines = config_.maxLines;
  settings.visible = config_.enabled && overlayVisible_.load(std::memory_order_acquire);
  overlay_.SetSettings(settings);
}

void App::OnTranslated(const TranslateResult& result) {
  if (shuttingDown_.load(std::memory_order_acquire)) return;
  if (!result.ok || result.translation.empty()) {
    overlay_.MarkTranslationFailed(result.seq);
    return;
  }
  std::wstring translation = Utf8ToWide(result.translation);
  if (translation.size() > kMaxTranslationChars) translation.resize(kMaxTranslationChars);
  overlay_.UpdateTranslation(result.seq, translation);
}

bool App::ShouldTranslate(const ChatLine& line) const {
  if (line.text.empty()) return false;

  std::string target = WideToUtf8(config_.targetLanguage);
  for (char& c : target) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  const bool targetIsChinese = target.rfind("zh", 0) == 0;
  if (targetIsChinese && ContainsCjk(line.text)) return false;
  return true;
}

bool App::ContainsCjk(const std::string& utf8) {
  // Heuristic: any 3-byte UTF-8 sequence starting with 0xE4..0xE9 covers the
  // CJK Unified Ideographs block (U+4E00..U+9FFF), which is enough to tell
  // "already Chinese" from "needs translating" without a full Unicode table.
  for (size_t i = 0; i < utf8.size();) {
    const unsigned char byte = static_cast<unsigned char>(utf8[i]);
    if (byte >= 0xE4 && byte <= 0xE9 && i + 2 < utf8.size()) {
      const unsigned char second = static_cast<unsigned char>(utf8[i + 1]);
      const unsigned char third = static_cast<unsigned char>(utf8[i + 2]);
      if ((second & 0xC0) == 0x80 && (third & 0xC0) == 0x80) return true;
    }
    if (byte < 0x80) {
      i += 1;
    } else if ((byte & 0xE0) == 0xC0) {
      i += 2;
    } else if ((byte & 0xF0) == 0xE0) {
      i += 3;
    } else if ((byte & 0xF8) == 0xF0) {
      i += 4;
    } else {
      i += 1;
    }
  }
  return false;
}

}  // namespace lct
