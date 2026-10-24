// Minimal WinHTTP client for the local bridge.
//
// One worker thread drains a bounded queue and POSTs
//   {"text":"...","targetLanguage":"zh-Hans"}
// to <bridgeUrl>/api/v1/translate, then parses
//   {"ok":true,"translation":"..."}
//
// The caller never blocks: Submit() only enqueues, and failures are reported
// through the callback so a dead bridge can never stall the game.
#pragma once

#include <atomic>
#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <functional>
#include <mutex>
#include <string>
#include <thread>

#include "core/config.h"

namespace lct {

struct TranslateRequest {
  uint64_t seq = 0;
  std::string text;              // UTF-8
  std::string targetLanguage;    // empty = use the configured default
};

struct TranslateResult {
  uint64_t seq = 0;
  bool ok = false;
  std::string translation;   // UTF-8, empty when ok == false
  std::string error;         // short machine-readable reason, never chat text
};

class TranslateClient {
 public:
  using Callback = std::function<void(const TranslateResult&)>;

  TranslateClient();
  ~TranslateClient();

  TranslateClient(const TranslateClient&) = delete;
  TranslateClient& operator=(const TranslateClient&) = delete;

  bool Start(const Config& config, Callback callback);
  void Stop();
  void UpdateConfig(const Config& config);

  // Returns false when the queue is full or the client is stopping; the caller
  // is expected to drop the line (translation is best effort).
  bool Submit(const TranslateRequest& request);

  size_t QueueSize();

 private:
  void WorkerMain();
  bool PostOnce(const TranslateRequest& request, TranslateResult& result);
  std::wstring EndpointUrl();

  mutable std::mutex mutex_;
  std::condition_variable condition_;
  std::deque<TranslateRequest> queue_;
  Callback callback_;
  std::wstring bridgeUrl_ = L"http://127.0.0.1:8791";
  std::wstring defaultTarget_ = L"zh-Hans";
  std::thread worker_;
  bool started_ = false;
  bool stopping_ = false;
  uint64_t lastFailureLogMs_ = 0;
};

}  // namespace lct
