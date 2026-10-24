// In-process Direct2D overlay.
//
// Two DXGI vtable slots are patched so the DLL can draw on top of the game:
//   * IDXGISwapChain::Present          (vtable index 8)
//   * IDXGISwapChain::ResizeBuffers    (vtable index 13)
//
// The patch is a plain vtable pointer swap (no trampoline / no code patching),
// which makes it trivially reversible: Uninstall() restores every original
// pointer. Drawing is strictly best effort: every failure path only disables the
// overlay, it never touches the game's own rendering state beyond calling
// through to the original functions.
//
// Known limits (see native/docs/DESIGN.md): D3D11 only (D2D target), one chat
// rectangle, no game-UI integration. A D3D12 swapchain is detected and ignored.
#pragma once

#include <windows.h>
#include <dxgi.h>

#include <atomic>
#include <cstdint>
#include <deque>
#include <mutex>
#include <string>
#include <vector>

// Forward declarations keep the Direct2D/DirectWrite headers out of this file.
struct ID3D11Device;
struct ID3D11DeviceContext;
struct ID2D1Factory;
struct ID2D1Factory1;
struct ID2D1Device;
struct ID2D1DeviceContext;
struct ID2D1Bitmap1;
struct ID2D1SolidColorBrush;
struct IDWriteFactory;
struct IDWriteTextFormat;
struct IDXGISurface;

namespace lct {

struct OverlayLine {
  uint64_t seq = 0;
  std::wstring sender;
  std::wstring original;
  std::wstring translation;
  bool pending = true;  // true until a translation arrives or is marked failed
};

struct OverlaySettings {
  float x = 0.01f;      // fraction of back-buffer width/height, 0..1
  float y = 0.61f;
  float w = 0.30f;
  float h = 0.36f;
  float fontSize = 16.0f;  // in pixels (DIP == pixel because DPI is pinned to 96)
  int maxLines = 6;
  bool visible = true;
};

class D3D11Overlay {
 public:
  D3D11Overlay();
  ~D3D11Overlay();

  D3D11Overlay(const D3D11Overlay&) = delete;
  D3D11Overlay& operator=(const D3D11Overlay&) = delete;

  // Installs the Present/ResizeBuffers hook. Returns false (and leaves the game
  // untouched) when no hook could be placed.
  bool Install();

  // Removes the hook, waits for in-flight detours and releases D2D resources.
  void Uninstall();

  // Path used by a loader that must detach the DLL without joining threads:
  // restores the vtable slots only, leaks the D2D resources. Prefer Uninstall().
  static void EmergencyRestoreHooks();

  bool IsInstalled() const { return installed_.load(std::memory_order_acquire); }

  void SetSettings(const OverlaySettings& settings);
  void AddLine(const OverlayLine& line);
  void UpdateTranslation(uint64_t seq, const std::wstring& translation);
  void MarkTranslationFailed(uint64_t seq);
  void Clear();

  uint64_t RenderedFrames() const { return renderedFrames_.load(std::memory_order_relaxed); }

 private:
  friend void SafePresentHook(D3D11Overlay* overlay, IDXGISwapChain* swapChain);

  static HRESULT STDMETHODCALLTYPE PresentDetour(IDXGISwapChain* swapChain, UINT syncInterval, UINT flags);
  static HRESULT STDMETHODCALLTYPE ResizeBuffersDetour(IDXGISwapChain* swapChain, UINT bufferCount, UINT width,
                                                      UINT height, DXGI_FORMAT newFormat, UINT swapChainFlags);

  void OnPresent(IDXGISwapChain* swapChain);
  bool EnsureTarget(IDXGISwapChain* swapChain, const OverlaySettings& settings);
  bool EnsureTextResources(float fontSize);
  void ReleaseTarget();        // caller must hold resourceMutex_
  void ReleaseAllResources();  // caller must hold resourceMutex_
  void Render(const OverlaySettings& settings, const std::vector<OverlayLine>& lines);
  void TakeSnapshot(OverlaySettings* settings, std::vector<OverlayLine>* lines);
  void NoteDrawException();
  void MaybeLogInitFailure(const char* message);

  // UI state, touched by the tick thread and the render thread.
  std::mutex stateMutex_;
  std::deque<OverlayLine> lines_;
  OverlaySettings settings_;

  // Device resources, only touched by the render thread (and Uninstall()).
  std::mutex resourceMutex_;
  ID3D11Device* d3dDevice_ = nullptr;
  ID2D1Factory1* d2dFactory_ = nullptr;
  ID2D1Device* d2dDevice_ = nullptr;
  ID2D1DeviceContext* d2dContext_ = nullptr;
  ID2D1Bitmap1* targetBitmap_ = nullptr;
  IDXGISurface* boundSurface_ = nullptr;
  ID2D1SolidColorBrush* backgroundBrush_ = nullptr;
  ID2D1SolidColorBrush* originalBrush_ = nullptr;
  ID2D1SolidColorBrush* translationBrush_ = nullptr;
  IDWriteFactory* dwriteFactory_ = nullptr;
  IDWriteTextFormat* senderFormat_ = nullptr;
  IDWriteTextFormat* translationFormat_ = nullptr;
  UINT targetWidth_ = 0;
  UINT targetHeight_ = 0;
  float currentFontSize_ = 0.0f;
  uint64_t nextInitRetryMs_ = 0;
  bool initFailureLogged_ = false;

  std::atomic<bool> installed_{false};
  std::atomic<int> inFlight_{0};
  std::atomic<uint64_t> renderedFrames_{0};
  bool exceptionLogged_ = false;
};

}  // namespace lct
