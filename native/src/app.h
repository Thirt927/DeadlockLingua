// Application lifecycle: config, chat tail, translation queue and overlay.
//
// Threading model:
//   * init thread  - created from DllMain, calls EnsureStarted() once
//   * tick thread  - polls console.log (~250 ms), checks native.json (~1 s),
//                    polls the hotkey (~100 ms)
//   * worker       - owned by TranslateClient, performs WinHTTP requests
//   * render       - the game's own Present call (overlay detour)
//
// Only the tick thread mutates `config_`; the overlay and the translate client
// are the only components shared with other threads and they are internally
// synchronised.
#pragma once

#include <atomic>
#include <cstdint>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "core/config.h"
#include "core/log_tail.h"
#include "core/translate_client.h"
#include "overlay/d3d11_overlay.h"

namespace lct {

class App {
 public:
  static App& Instance();

  // Idempotent. Returns true once the pipeline is running (even when the
  // overlay itself could not be installed).
  bool EnsureStarted();
  void Shutdown();

  bool IsRunning() const { return running_.load(std::memory_order_acquire); }

 private:
  App();
  ~App();

  App(const App&) = delete;
  App& operator=(const App&) = delete;

  void TickLoop();
  void PollChat();
  void PollHotkey();
  void MaybeReloadConfig();
  void ApplyOverlaySettings();
  void OnTranslated(const TranslateResult& result);
  bool ShouldTranslate(const ChatLine& line) const;
  static bool ContainsCjk(const std::string& utf8);

  Config config_;
  std::wstring configPath_;
  uint64_t configStamp_ = 0;

  LogTail logTail_;
  TranslateClient translator_;
  D3D11Overlay overlay_;

  std::mutex lifecycleMutex_;
  std::atomic<bool> running_{false};
  std::atomic<bool> shuttingDown_{false};
  std::thread tickThread_;

  std::atomic<bool> overlayVisible_{true};
  unsigned hotkeyVirtualKey_ = 0;
  bool hotkeyDown_ = false;
  bool overlayReady_ = false;
  bool translatorReady_ = false;

  uint64_t lastTailPollMs_ = 0;
  uint64_t lastConfigCheckMs_ = 0;
  uint64_t lastHotkeyPollMs_ = 0;
  uint64_t lastQueueWarningMs_ = 0;
};

}  // namespace lct
