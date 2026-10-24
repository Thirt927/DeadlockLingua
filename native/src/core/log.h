// Line-oriented logger. Everything goes to %TEMP%\lct-native.log and to the
// debugger output. The file is truncated once per process start and appended
// afterwards, so re-initialisation (e.g. LCTNativeShutdown + LCTNativeInit)
// does not silently drop earlier lines.
#pragma once

namespace lct {

bool LogInit();
void LogShutdown();

void LogInfo(const char* format, ...);
void LogWarn(const char* format, ...);
void LogError(const char* format, ...);

}  // namespace lct
