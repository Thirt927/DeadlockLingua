// Incremental reader for the game's console.log.
//
// The Panorama mod already writes one structured line per chat entry:
//   <timestamp> [PanoramaScript] [LCT-CHAT]{"o":0,"n":"Alice","c":"chat","h":"","k":"chat","t":"hello"}
// This class tails that file and turns every LCT-CHAT line into a ChatLine.
//
// Hard requirement: the game must be started with -condebug, otherwise Source 2
// never writes console.log at all (this mirrors the panorama mod's BTIPC uplink).
#pragma once

#include <windows.h>

#include <cstdint>
#include <string>
#include <vector>

namespace lct {

struct ChatLine {
  uint64_t seq = 0;      // monotonic, unique for the lifetime of the process
  bool own = false;      // message sent by the local player
  std::string sender;    // UTF-8, may be empty
  std::string text;      // UTF-8 original text
};

class LogTail {
 public:
  LogTail();
  ~LogTail();

  LogTail(const LogTail&) = delete;
  LogTail& operator=(const LogTail&) = delete;

  // `explicitPath` comes from native.json; empty means auto-detect. Calling it
  // again (config reload) resets the incremental state only when the path
  // actually changed.
  void Configure(const std::wstring& explicitPath);

  // Reads everything appended since the previous call and appends parsed chat
  // records to `out`.
  void Poll(std::vector<ChatLine>& out);

  const std::wstring& ResolvedPath() const { return resolvedPath_; }
  uint64_t DroppedLines() const { return droppedLines_; }
  void Shutdown();

 private:
  std::wstring ResolvePath() const;
  void ResetReadState();
  void SeedFingerprint(HANDLE fileHandle, uint64_t fileSize);
  void HandleLine(const std::string& line, std::vector<ChatLine>& out);

  std::wstring configuredPath_;
  std::wstring resolvedPath_;
  uint64_t offset_ = 0;
  uint64_t seq_ = 0;
  uint64_t droppedLines_ = 0;
  bool primed_ = false;
  bool missingLogged_ = false;
  bool rewriteLogged_ = false;
  std::string partial_;
  std::string fingerprint_;
  std::string fingerprintBuffer_;
};

}  // namespace lct
