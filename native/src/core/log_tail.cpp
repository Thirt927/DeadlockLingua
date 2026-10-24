#include "core/log_tail.h"

#include <algorithm>
#include <utility>

#include "core/log.h"
#include "core/util.h"

namespace lct {
namespace {

constexpr char kChatMarker[] = "[LCT-CHAT]";
constexpr size_t kFingerprintBytes = 256;
constexpr size_t kMaxTextBytes = 400;
constexpr size_t kMaxSenderBytes = 64;
constexpr size_t kMaxPartialBytes = 64 * 1024;
constexpr uint64_t kReadChunkBytes = 1024 * 1024;

bool ContainsMarker(const std::string& line, const char* marker, size_t& position) {
  position = line.find(marker);
  return position != std::string::npos;
}

}  // namespace

LogTail::LogTail() = default;
LogTail::~LogTail() = default;

void LogTail::Configure(const std::wstring& explicitPath) {
  if (explicitPath == configuredPath_) return;
  configuredPath_ = explicitPath;
  resolvedPath_.clear();
  primed_ = false;
  missingLogged_ = false;
  rewriteLogged_ = false;
  ResetReadState();
  LogInfo("log tail: configured console.log path %s",
          configuredPath_.empty() ? "(auto-detect)" : WideToUtf8(configuredPath_).c_str());
}

void LogTail::ResetReadState() {
  offset_ = 0;
  partial_.clear();
  fingerprint_.clear();
  fingerprintBuffer_.clear();
}

void LogTail::Shutdown() {
  configuredPath_.clear();
  resolvedPath_.clear();
  primed_ = false;
  ResetReadState();
}

std::wstring LogTail::ResolvePath() const {
  if (!configuredPath_.empty()) {
    // Expand %ENV% references so users can point at their own game install.
    if (configuredPath_.find(L'%') != std::wstring::npos) {
      wchar_t expanded[32768] = {};
      const DWORD length = ExpandEnvironmentStringsW(configuredPath_.c_str(), expanded,
                                                     static_cast<DWORD>(sizeof(expanded) / sizeof(expanded[0])));
      if (length > 0 && length < sizeof(expanded) / sizeof(expanded[0])) return std::wstring(expanded, length - 1);
    }
    return configuredPath_;
  }

  std::vector<std::wstring> candidates;

  // The DLL runs inside the game process, so the process image path already
  // tells us where Deadlock is installed: <game>/game/bin/win64/deadlock.exe.
  // Walk a few levels up looking for the usual console.log locations.
  wchar_t imagePath[32768] = {};
  const DWORD imageLength = GetModuleFileNameW(nullptr, imagePath, static_cast<DWORD>(sizeof(imagePath) / sizeof(imagePath[0])));
  if (imageLength > 0 && imageLength < sizeof(imagePath) / sizeof(imagePath[0])) {
    std::wstring directory(imagePath, imageLength);
    const size_t slash = directory.find_last_of(L"\\/");
    if (slash != std::wstring::npos) directory.resize(slash);
    for (int depth = 0; depth < 6 && !directory.empty(); ++depth) {
      candidates.push_back(directory + L"\\game\\citadel\\console.log");
      candidates.push_back(directory + L"\\citadel\\console.log");
      const size_t parent = directory.find_last_of(L"\\/");
      if (parent == std::wstring::npos) break;
      directory.resize(parent);
    }
  }

  wchar_t currentDirectory[32768] = {};
  const DWORD currentLength = GetCurrentDirectoryW(static_cast<DWORD>(sizeof(currentDirectory) / sizeof(currentDirectory[0])), currentDirectory);
  if (currentLength > 0) {
    candidates.push_back(std::wstring(currentDirectory) + L"\\game\\citadel\\console.log");
    candidates.push_back(std::wstring(currentDirectory) + L"\\console.log");
  }

  for (const std::wstring& candidate : candidates) {
    if (GetFileAttributesW(candidate.c_str()) != INVALID_FILE_ATTRIBUTES) return candidate;
  }
  return std::wstring();
}

void LogTail::SeedFingerprint(HANDLE fileHandle, uint64_t fileSize) {
  fingerprint_.clear();
  fingerprintBuffer_.clear();
  if (fileSize == 0) return;
  const uint64_t length = std::min<uint64_t>(fileSize, kFingerprintBytes);
  LARGE_INTEGER position = {};
  position.QuadPart = static_cast<LONGLONG>(fileSize - length);
  if (!SetFilePointerEx(fileHandle, position, nullptr, FILE_BEGIN)) return;
  std::string buffer(static_cast<size_t>(length), '\0');
  DWORD read = 0;
  if (ReadFile(fileHandle, &buffer[0], static_cast<DWORD>(buffer.size()), &read, nullptr) && read > 0) {
    buffer.resize(read);
    fingerprint_ = buffer;
    fingerprintBuffer_ = buffer;
  }
}

void LogTail::Poll(std::vector<ChatLine>& out) {
  if (resolvedPath_.empty()) {
    resolvedPath_ = ResolvePath();
    if (resolvedPath_.empty()) {
      if (!missingLogged_) {
        LogWarn("log tail: console.log not found; start Deadlock with -condebug or set consoleLogPath in native.json");
        missingLogged_ = true;
      }
      return;
    }
    missingLogged_ = false;
    primed_ = false;
    ResetReadState();
    LogInfo("log tail: using %s", WideToUtf8(resolvedPath_).c_str());
  }

  const HANDLE fileHandle = CreateFileW(resolvedPath_.c_str(), GENERIC_READ,
                                        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
                                        OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (fileHandle == INVALID_HANDLE_VALUE) {
    if (!missingLogged_) {
      LogWarn("log tail: cannot open %s; check that Deadlock is running with -condebug",
              WideToUtf8(resolvedPath_).c_str());
      missingLogged_ = true;
    }
    return;
  }

  LARGE_INTEGER fileSize = {};
  if (!GetFileSizeEx(fileHandle, &fileSize) || fileSize.QuadPart < 0) {
    CloseHandle(fileHandle);
    return;
  }
  const uint64_t size = static_cast<uint64_t>(fileSize.QuadPart);

  if (!primed_) {
    // First attach: skip the history that is already on disk so we do not
    // translate a previous match. New lines are picked up from here on.
    primed_ = true;
    offset_ = size;
    SeedFingerprint(fileHandle, size);
    LogInfo("log tail: attached at offset %llu", static_cast<unsigned long long>(size));
    CloseHandle(fileHandle);
    return;
  }

  bool reset = false;
  if (size < offset_) {
    reset = true;
  } else if (!fingerprint_.empty() && offset_ >= fingerprint_.size()) {
    LARGE_INTEGER position = {};
    position.QuadPart = static_cast<LONGLONG>(offset_ - fingerprint_.size());
    std::string probe(fingerprint_.size(), '\0');
    DWORD read = 0;
    if (SetFilePointerEx(fileHandle, position, nullptr, FILE_BEGIN) &&
        ReadFile(fileHandle, &probe[0], static_cast<DWORD>(probe.size()), &read, nullptr) && read == probe.size() &&
        probe != fingerprint_) {
      reset = true;
    }
  }

  if (reset) {
    // The engine truncates and rewrites console.log on every game start.
    if (!rewriteLogged_) {
      LogInfo("log tail: console.log was rewritten; re-reading from the start");
      rewriteLogged_ = true;
    }
    primed_ = true;
    ResetReadState();
    offset_ = 0;
  }

  LARGE_INTEGER start = {};
  start.QuadPart = static_cast<LONGLONG>(offset_);
  if (!SetFilePointerEx(fileHandle, start, nullptr, FILE_BEGIN)) {
    CloseHandle(fileHandle);
    return;
  }

  const uint64_t previousOffset = offset_;
  while (offset_ < size) {
    const DWORD wanted = static_cast<DWORD>(std::min<uint64_t>(size - offset_, kReadChunkBytes));
    std::string chunk(wanted, '\0');
    DWORD read = 0;
    if (!ReadFile(fileHandle, &chunk[0], wanted, &read, nullptr) || read == 0) break;
    chunk.resize(read);
    offset_ += read;

    fingerprintBuffer_ += chunk;
    if (fingerprintBuffer_.size() > kFingerprintBytes) {
      fingerprintBuffer_.erase(0, fingerprintBuffer_.size() - kFingerprintBytes);
    }

    size_t lineStart = 0;
    for (;;) {
      const size_t newline = chunk.find('\n', lineStart);
      if (newline == std::string::npos) {
        partial_.append(chunk, lineStart, std::string::npos);
        break;
      }
      std::string line = partial_;
      line.append(chunk, lineStart, newline - lineStart);
      partial_.clear();
      if (!line.empty() && line.back() == '\r') line.pop_back();
      HandleLine(line, out);
      lineStart = newline + 1;
    }

    if (partial_.size() > kMaxPartialBytes) {
      // A single line this long cannot be a chat record; drop it instead of
      // growing memory without bound.
      partial_.clear();
      ++droppedLines_;
      LogWarn("log tail: dropped an oversized partial line");
    }
    if (read < wanted) break;
  }

  if (offset_ != previousOffset) fingerprint_ = fingerprintBuffer_;
  CloseHandle(fileHandle);
}

void LogTail::HandleLine(const std::string& line, std::vector<ChatLine>& out) {
  size_t markerPosition = 0;
  if (!ContainsMarker(line, kChatMarker, markerPosition)) return;

  const std::string json = TrimAscii(line.substr(markerPosition + sizeof(kChatMarker) - 1));
  if (json.empty()) return;

  std::string raw;
  std::string text;
  if (!JsonFindMember(json, "t", raw) || !JsonAsString(raw, text)) return;
  if (text.empty()) return;
  text = TruncateUtf8(text, kMaxTextBytes);

  std::string sender;
  if (JsonFindMember(json, "n", raw)) JsonAsString(raw, sender);
  sender = TruncateUtf8(sender, kMaxSenderBytes);

  bool own = false;
  if (JsonFindMember(json, "o", raw)) {
    bool flag = false;
    double number = 0.0;
    if (JsonAsBool(raw, flag)) {
      own = flag;
    } else if (JsonAsDouble(raw, number)) {
      own = number != 0.0;
    }
  }

  ChatLine record;
  record.seq = ++seq_;
  record.own = own;
  record.sender = std::move(sender);
  record.text = std::move(text);
  out.push_back(std::move(record));
}

}  // namespace lct
