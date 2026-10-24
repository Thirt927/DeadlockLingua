#include "core/translate_client.h"

#include <windows.h>
#include <winhttp.h>

#include <algorithm>
#include <string>
#include <utility>

#include "core/log.h"
#include "core/util.h"

namespace lct {
namespace {

constexpr size_t kMaxQueue = 64;
constexpr size_t kMaxResponseBytes = 256 * 1024;
constexpr DWORD kResolveTimeoutMs = 2000;
constexpr DWORD kConnectTimeoutMs = 2000;
constexpr DWORD kSendTimeoutMs = 4000;
constexpr DWORD kReceiveTimeoutMs = 8000;
constexpr uint64_t kFailureLogIntervalMs = 5000;

// RAII wrapper for HINTERNET so every early return closes its handles.
class WinHttpHandle {
 public:
  WinHttpHandle() = default;
  explicit WinHttpHandle(HINTERNET handle) : handle_(handle) {}
  ~WinHttpHandle() {
    if (handle_ != nullptr) WinHttpCloseHandle(handle_);
  }

  WinHttpHandle(const WinHttpHandle&) = delete;
  WinHttpHandle& operator=(const WinHttpHandle&) = delete;

  HINTERNET get() const { return handle_; }
  explicit operator bool() const { return handle_ != nullptr; }

 private:
  HINTERNET handle_ = nullptr;
};

}  // namespace

TranslateClient::TranslateClient() = default;

TranslateClient::~TranslateClient() { Stop(); }

bool TranslateClient::Start(const Config& config, Callback callback) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (started_) return true;
  bridgeUrl_ = Utf8ToWide(config.bridgeUrl);
  defaultTarget_ = config.targetLanguage.empty() ? L"zh-Hans" : config.targetLanguage;
  callback_ = std::move(callback);
  stopping_ = false;
  started_ = true;
  worker_ = std::thread(&TranslateClient::WorkerMain, this);
  LogInfo("translate: worker started (bridge=%s)", config.bridgeUrl.c_str());
  return true;
}

void TranslateClient::Stop() {
  {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!started_) return;
    stopping_ = true;
    queue_.clear();
  }
  condition_.notify_all();
  if (worker_.joinable()) worker_.join();
  {
    std::lock_guard<std::mutex> lock(mutex_);
    started_ = false;
    callback_ = nullptr;
  }
  LogInfo("translate: worker stopped");
}

void TranslateClient::UpdateConfig(const Config& config) {
  std::lock_guard<std::mutex> lock(mutex_);
  bridgeUrl_ = Utf8ToWide(config.bridgeUrl);
  defaultTarget_ = config.targetLanguage.empty() ? L"zh-Hans" : config.targetLanguage;
}

bool TranslateClient::Submit(const TranslateRequest& request) {
  {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!started_ || stopping_) return false;
    if (queue_.size() >= kMaxQueue) return false;
    if (request.text.empty()) return false;
    queue_.push_back(request);
  }
  condition_.notify_one();
  return true;
}

size_t TranslateClient::QueueSize() {
  std::lock_guard<std::mutex> lock(mutex_);
  return queue_.size();
}

void TranslateClient::WorkerMain() {
  LogInfo("translate: worker thread running");
  for (;;) {
    TranslateRequest request;
    {
      std::unique_lock<std::mutex> lock(mutex_);
      condition_.wait(lock, [this] { return stopping_ || !queue_.empty(); });
      if (stopping_) break;
      request = queue_.front();
      queue_.pop_front();
    }

    TranslateResult result;
    result.seq = request.seq;
    try {
      result.ok = PostOnce(request, result);
    } catch (...) {
      result.ok = false;
      result.error = "exception";
    }

    Callback callback;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      callback = callback_;
    }
    if (callback) {
      try {
        callback(result);
      } catch (...) {
        // A throwing callback must not kill the worker thread.
      }
    }

    if (!result.ok) {
      const uint64_t now = GetTickCount64();
      bool shouldLog = false;
      {
        std::lock_guard<std::mutex> lock(mutex_);
        if (now - lastFailureLogMs_ >= kFailureLogIntervalMs) {
          lastFailureLogMs_ = now;
          shouldLog = true;
        }
      }
      if (shouldLog) {
        LogWarn("translate: request seq=%llu failed (%s)",
                static_cast<unsigned long long>(result.seq), result.error.c_str());
      }
    }
  }
  LogInfo("translate: worker thread exiting");
}

std::wstring TranslateClient::EndpointUrl() {
  std::lock_guard<std::mutex> lock(mutex_);
  std::wstring base = bridgeUrl_;
  while (!base.empty() && (base.back() == L'/' || base.back() == L' ')) base.pop_back();
  return base + L"/api/v1/translate";
}

bool TranslateClient::PostOnce(const TranslateRequest& request, TranslateResult& result) {
  std::wstring target;
  if (!request.targetLanguage.empty()) target = Utf8ToWide(request.targetLanguage);
  if (target.empty()) {
    std::lock_guard<std::mutex> lock(mutex_);
    target = defaultTarget_;
  }
  if (target.empty()) target = L"zh-Hans";

  const std::wstring url = EndpointUrl();
  URL_COMPONENTS components = {};
  components.dwStructSize = static_cast<DWORD>(sizeof(components));
  components.dwSchemeLength = static_cast<DWORD>(-1);
  components.dwHostNameLength = static_cast<DWORD>(-1);
  components.dwUrlPathLength = static_cast<DWORD>(-1);
  components.dwExtraInfoLength = static_cast<DWORD>(-1);
  if (url.size() <= 8 || !WinHttpCrackUrl(url.c_str(), 0, 0, &components)) {
    result.error = "bad_bridge_url";
    return false;
  }
  if (components.lpszHostName == nullptr || components.dwHostNameLength == 0) {
    result.error = "bad_bridge_url";
    return false;
  }

  std::wstring host(components.lpszHostName, components.dwHostNameLength);
  std::wstring path(components.lpszUrlPath, components.dwUrlPathLength);
  if (components.lpszExtraInfo != nullptr && components.dwExtraInfoLength > 0) {
    path.append(components.lpszExtraInfo, components.dwExtraInfoLength);
  }
  const bool secure = components.nScheme == INTERNET_SCHEME_HTTPS;

  std::string body = "{\"text\":\"";
  body += JsonEscape(request.text);
  body += "\",\"targetLanguage\":\"";
  body += JsonEscape(WideToUtf8(target));
  body += "\"}";

  WinHttpHandle session(WinHttpOpen(L"LCTNative/1.0 (DeadlockLingua native overlay)",
                                    WINHTTP_ACCESS_TYPE_NO_PROXY, WINHTTP_NO_PROXY_NAME,
                                    WINHTTP_NO_PROXY_BYPASS, 0));
  if (!session) {
    result.error = "winhttp_open_failed";
    return false;
  }
  WinHttpSetTimeouts(session.get(), static_cast<int>(kResolveTimeoutMs), static_cast<int>(kConnectTimeoutMs),
                     static_cast<int>(kSendTimeoutMs), static_cast<int>(kReceiveTimeoutMs));

  WinHttpHandle connection(WinHttpConnect(session.get(), host.c_str(), components.nPort, 0));
  if (!connection) {
    result.error = "winhttp_connect_failed";
    return false;
  }

  WinHttpHandle requestHandle(WinHttpOpenRequest(connection.get(), L"POST", path.c_str(), nullptr,
                                                 WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES,
                                                 secure ? WINHTTP_FLAG_SECURE : 0));
  if (!requestHandle) {
    result.error = "winhttp_open_request_failed";
    return false;
  }

  const wchar_t* headers = L"Content-Type: application/json; charset=utf-8\r\n";
  if (!WinHttpSendRequest(requestHandle.get(), headers, static_cast<DWORD>(-1L),
                          body.empty() ? WINHTTP_NO_REQUEST_DATA : const_cast<char*>(body.data()),
                          static_cast<DWORD>(body.size()), static_cast<DWORD>(body.size()), 0)) {
    result.error = "winhttp_send_failed";
    return false;
  }
  if (!WinHttpReceiveResponse(requestHandle.get(), nullptr)) {
    result.error = "winhttp_receive_failed";
    return false;
  }

  DWORD statusCode = 0;
  DWORD statusSize = static_cast<DWORD>(sizeof(statusCode));
  if (!WinHttpQueryHeaders(requestHandle.get(), WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                           WINHTTP_HEADER_NAME_BY_INDEX, &statusCode, &statusSize, WINHTTP_NO_HEADER_INDEX)) {
    result.error = "winhttp_query_status_failed";
    return false;
  }

  std::string response;
  for (;;) {
    char buffer[4096];
    DWORD read = 0;
    if (!WinHttpReadData(requestHandle.get(), buffer, static_cast<DWORD>(sizeof(buffer)), &read)) {
      result.error = "winhttp_read_failed";
      return false;
    }
    if (read == 0) break;
    response.append(buffer, read);
    if (response.size() > kMaxResponseBytes) break;
  }

  if (statusCode != 200) {
    result.error = "http_" + std::to_string(statusCode);
    return false;
  }

  std::string raw;
  bool ok = false;
  if (!JsonFindMember(response, "ok", raw) || !JsonAsBool(raw, ok)) {
    result.error = "bad_response";
    return false;
  }
  if (!ok) {
    std::string message;
    if (JsonFindMember(response, "error", raw) && JsonAsString(raw, message) && !message.empty()) {
      result.error = message;
    } else {
      result.error = "bridge_error";
    }
    return false;
  }

  std::string translation;
  if (!JsonFindMember(response, "translation", raw) || !JsonAsString(raw, translation)) {
    result.error = "missing_translation";
    return false;
  }
  result.translation = std::move(translation);
  return true;
}

}  // namespace lct
