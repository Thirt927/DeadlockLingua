// DLL entry point.
//
// DllMain is intentionally minimal (loader lock!): it only disables thread
// notifications and starts the init thread. All real work happens on that
// thread. The loader is expected to call LCTNativeShutdown() before unloading
// the DLL; the DLL is designed to stay loaded for the whole game session.
#include <windows.h>

#include "app.h"
#include "core/log.h"

namespace {

DWORD WINAPI InitThreadProc(LPVOID /*parameter*/) {
  // Never let an exception escape a thread function (that would terminate the
  // whole game process). Init failures are logged and simply disable features.
  try {
    lct::App::Instance().EnsureStarted();
  } catch (...) {
    lct::LogError("init: unexpected exception during startup; features disabled");
  }
  return 0;
}

}  // namespace

BOOL WINAPI DllMain(HMODULE module, DWORD reason, LPVOID /*reserved*/) {
  if (reason == DLL_PROCESS_ATTACH) {
    DisableThreadLibraryCalls(module);
    const HANDLE initThread = CreateThread(nullptr, 0, InitThreadProc, nullptr, 0, nullptr);
    if (initThread != nullptr) CloseHandle(initThread);
  }
  return TRUE;
}

// Explicit entry points for a loader. LCTNativeInit() is optional because
// DllMain already starts the pipeline, but it lets the loader report failure
// synchronously.
extern "C" __declspec(dllexport) BOOL WINAPI LCTNativeInit(void) {
  try {
    return lct::App::Instance().EnsureStarted() ? TRUE : FALSE;
  } catch (...) {
    return FALSE;
  }
}

extern "C" __declspec(dllexport) void WINAPI LCTNativeShutdown(void) {
  try {
    lct::App::Instance().Shutdown();
  } catch (...) {
    // Shutdown is best effort; the process is going away anyway.
  }
}
