#include "core/log.h"

#include <windows.h>

#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <mutex>
#include <string>

namespace lct {
namespace {

std::mutex g_logMutex;
std::ofstream g_logFile;
std::wstring g_logPath;
bool g_logOpen = false;
bool g_truncatedOnce = false;

void WriteLine(const char* level, const char* format, va_list args) {
  char message[2048] = {};
  _vsnprintf_s(message, sizeof(message), _TRUNCATE, format, args);

  SYSTEMTIME localTime = {};
  GetLocalTime(&localTime);
  char line[2304] = {};
  _snprintf_s(line, sizeof(line), _TRUNCATE, "[%02u:%02u:%02u.%03u] [%s] %s\r\n",
              static_cast<unsigned>(localTime.wHour), static_cast<unsigned>(localTime.wMinute),
              static_cast<unsigned>(localTime.wSecond), static_cast<unsigned>(localTime.wMilliseconds),
              level, message);

  std::lock_guard<std::mutex> lock(g_logMutex);
  if (g_logOpen) {
    g_logFile.write(line, static_cast<std::streamsize>(std::strlen(line)));
    g_logFile.flush();
  }
  OutputDebugStringA(line);
}

}  // namespace

bool LogInit() {
  std::lock_guard<std::mutex> lock(g_logMutex);
  if (g_logOpen) return true;

  wchar_t tempPath[MAX_PATH + 1] = {};
  const DWORD length = GetTempPathW(static_cast<DWORD>(sizeof(tempPath) / sizeof(tempPath[0])), tempPath);
  if (length == 0) return false;

  std::wstring path(tempPath);
  path += L"lct-native.log";

  const std::ios::openmode mode =
      std::ios::out | std::ios::binary | (g_truncatedOnce ? std::ios::app : std::ios::trunc);
  g_logFile.open(path.c_str(), mode);
  if (!g_logFile.is_open()) return false;

  g_logPath = path;
  g_truncatedOnce = true;
  g_logOpen = true;
  return true;
}

void LogShutdown() {
  std::lock_guard<std::mutex> lock(g_logMutex);
  if (!g_logOpen) return;
  g_logFile.flush();
  g_logFile.close();
  g_logOpen = false;
}

void LogInfo(const char* format, ...) {
  va_list args;
  va_start(args, format);
  WriteLine("info", format, args);
  va_end(args);
}

void LogWarn(const char* format, ...) {
  va_list args;
  va_start(args, format);
  WriteLine("warn", format, args);
  va_end(args);
}

void LogError(const char* format, ...) {
  va_list args;
  va_start(args, format);
  WriteLine("error", format, args);
  va_end(args);
}

}  // namespace lct
