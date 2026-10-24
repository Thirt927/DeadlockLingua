#include "overlay/d3d11_overlay.h"

#include <d2d1_1.h>
#include <d2d1helper.h>
#include <d3d11.h>
#include <dwrite.h>
#include <dxgi1_6.h>
#include <wrl/client.h>

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <vector>

#include "core/log.h"

using Microsoft::WRL::ComPtr;

namespace lct {
namespace {

// IDXGISwapChain vtable layout (see the DXGI headers):
//   0 QueryInterface, 1 AddRef, 2 Release, 3 SetPrivateData, 4 SetPrivateDataInterface,
//   5 GetPrivateData, 6 GetParent, 7 GetDevice, 8 Present, 9 GetBuffer,
//   10 SetFullscreenState, 11 GetFullscreenState, 12 GetDesc, 13 ResizeBuffers, ...
constexpr size_t kPresentIndex = 8;
constexpr size_t kResizeBuffersIndex = 13;
constexpr size_t kMaxStoredLines = 64;
constexpr uint64_t kInitRetryDelayMs = 5000;
const wchar_t kPendingText[] = L"\u2026";

using PresentFn = HRESULT(STDMETHODCALLTYPE*)(IDXGISwapChain*, UINT, UINT);
using ResizeBuffersFn = HRESULT(STDMETHODCALLTYPE*)(IDXGISwapChain*, UINT, UINT, UINT, DXGI_FORMAT, UINT);

PresentFn g_originalPresent = nullptr;
ResizeBuffersFn g_originalResizeBuffers = nullptr;
std::atomic<D3D11Overlay*> g_activeOverlay{nullptr};

struct VtablePatch {
  void** slot = nullptr;
  void* original = nullptr;
  DWORD originalProtect = 0;
};

std::mutex g_patchMutex;
std::vector<VtablePatch> g_patches;

// Function pointers and data pointers have the same representation on Win64.
// memcpy keeps the conversion well-defined and avoids compiler warnings that a
// direct cast between the two pointer kinds would trigger.
template <typename T>
void* VoidFromFunction(T function) {
  static_assert(sizeof(void*) == sizeof(function), "function pointer size mismatch");
  void* result = nullptr;
  std::memcpy(&result, &function, sizeof(result));
  return result;
}

template <typename T>
T FunctionFromVoid(void* pointer) {
  static_assert(sizeof(void*) == sizeof(T), "function pointer size mismatch");
  T result = nullptr;
  std::memcpy(&result, &pointer, sizeof(result));
  return result;
}

// Writes `replacement` into vtable[index]. The caller must hold g_patchMutex.
bool PatchVtableSlot(void* vtable, size_t index, void* replacement) {
  if (vtable == nullptr || replacement == nullptr) return false;
  void** slot = reinterpret_cast<void**>(static_cast<uint8_t*>(vtable) + index * sizeof(void*));
  DWORD oldProtect = 0;
  if (!VirtualProtect(slot, sizeof(void*), PAGE_READWRITE, &oldProtect)) return false;

  if (*slot == replacement) {
    VirtualProtect(slot, sizeof(void*), oldProtect, &oldProtect);
    return true;
  }

  VtablePatch patch;
  patch.slot = slot;
  patch.original = *slot;
  patch.originalProtect = oldProtect;

  // Store the originals BEFORE publishing the detour: a render thread may call
  // through the patched slot immediately after the write below.
  if (index == kPresentIndex && g_originalPresent == nullptr) {
    g_originalPresent = FunctionFromVoid<PresentFn>(patch.original);
  }
  if (index == kResizeBuffersIndex && g_originalResizeBuffers == nullptr) {
    g_originalResizeBuffers = FunctionFromVoid<ResizeBuffersFn>(patch.original);
  }

  *slot = replacement;
  VirtualProtect(slot, sizeof(void*), oldProtect, &oldProtect);
  g_patches.push_back(patch);
  return true;
}

// The caller must hold g_patchMutex.
void RestorePatchesLocked() {
  for (const VtablePatch& patch : g_patches) {
    DWORD currentProtect = 0;
    if (!VirtualProtect(patch.slot, sizeof(void*), PAGE_READWRITE, &currentProtect)) continue;
    *patch.slot = patch.original;
    VirtualProtect(patch.slot, sizeof(void*), patch.originalProtect, &currentProtect);
  }
  g_patches.clear();
}

void AddVtableFromObject(IUnknown* object, std::vector<void*>& vtables) {
  if (object == nullptr) return;
  void* vtable = *reinterpret_cast<void***>(object);
  if (std::find(vtables.begin(), vtables.end(), vtable) == vtables.end()) vtables.push_back(vtable);
}

// DXGI exposes IDXGISwapChain1..4 with their own vtable copies. Calls through a
// derived interface would bypass a patch on the base vtable only, so patch every
// distinct vtable pointer we can obtain.
void AddDerivedSwapChainVtables(IDXGISwapChain* swapChain, std::vector<void*>& vtables) {
  ComPtr<IDXGISwapChain1> swapChain1;
  if (SUCCEEDED(swapChain->QueryInterface(__uuidof(IDXGISwapChain1), reinterpret_cast<void**>(swapChain1.GetAddressOf())))) {
    AddVtableFromObject(swapChain1.Get(), vtables);
  }
  ComPtr<IDXGISwapChain2> swapChain2;
  if (SUCCEEDED(swapChain->QueryInterface(__uuidof(IDXGISwapChain2), reinterpret_cast<void**>(swapChain2.GetAddressOf())))) {
    AddVtableFromObject(swapChain2.Get(), vtables);
  }
  ComPtr<IDXGISwapChain3> swapChain3;
  if (SUCCEEDED(swapChain->QueryInterface(__uuidof(IDXGISwapChain3), reinterpret_cast<void**>(swapChain3.GetAddressOf())))) {
    AddVtableFromObject(swapChain3.Get(), vtables);
  }
  ComPtr<IDXGISwapChain4> swapChain4;
  if (SUCCEEDED(swapChain->QueryInterface(__uuidof(IDXGISwapChain4), reinterpret_cast<void**>(swapChain4.GetAddressOf())))) {
    AddVtableFromObject(swapChain4.Get(), vtables);
  }
}

// Creates a throw-away D3D11 swapchain only to learn the DXGI vtable addresses.
bool CreateProbeSwapChain(ComPtr<IDXGISwapChain>* swapChainOut, HWND* windowOut) {
  if (swapChainOut == nullptr || windowOut == nullptr) return false;

  static const wchar_t kWindowClass[] = L"LCTNativeProbeWindow";
  WNDCLASSEXW windowClass = {};
  windowClass.cbSize = static_cast<UINT>(sizeof(windowClass));
  windowClass.lpfnWndProc = DefWindowProcW;
  windowClass.hInstance = GetModuleHandleW(nullptr);
  windowClass.lpszClassName = kWindowClass;
  RegisterClassExW(&windowClass);  // Error when already registered is harmless.

  // A hidden popup avoids a taskbar entry; the window is never shown.
  const HWND window = CreateWindowExW(0, kWindowClass, L"", WS_POPUP, 0, 0, 2, 2, nullptr, nullptr,
                                      windowClass.hInstance, nullptr);
  if (window == nullptr) return false;

  DXGI_SWAP_CHAIN_DESC description = {};
  description.BufferDesc.Width = 2;
  description.BufferDesc.Height = 2;
  description.BufferDesc.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
  description.SampleDesc.Count = 1;
  description.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
  description.BufferCount = 1;
  description.OutputWindow = window;
  description.Windowed = TRUE;
  description.SwapEffect = DXGI_SWAP_EFFECT_DISCARD;

  const D3D_FEATURE_LEVEL featureLevels[] = {D3D_FEATURE_LEVEL_11_0};
  ComPtr<ID3D11Device> device;
  ComPtr<ID3D11DeviceContext> context;
  HRESULT result = D3D11CreateDeviceAndSwapChain(
      nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, 0, featureLevels, 1, D3D11_SDK_VERSION, &description,
      swapChainOut->GetAddressOf(), device.GetAddressOf(), nullptr, context.GetAddressOf());
  if (FAILED(result)) {
    swapChainOut->Reset();
    device.Reset();
    context.Reset();
    result = D3D11CreateDeviceAndSwapChain(
        nullptr, D3D_DRIVER_TYPE_WARP, nullptr, 0, featureLevels, 1, D3D11_SDK_VERSION, &description,
        swapChainOut->GetAddressOf(), device.GetAddressOf(), nullptr, context.GetAddressOf());
  }

  if (FAILED(result) || swapChainOut->Get() == nullptr) {
    swapChainOut->Reset();
    DestroyWindow(window);
    return false;
  }
  *windowOut = window;
  return true;
}

}  // namespace

D3D11Overlay::D3D11Overlay() = default;

D3D11Overlay::~D3D11Overlay() { Uninstall(); }

void SafePresentHook(D3D11Overlay* overlay, IDXGISwapChain* swapChain) {
  // d3d11_overlay.cpp is compiled with /EHa, so catch(...) also catches
  // structured exceptions (e.g. an access violation inside D2D). A drawing
  // failure must never escape into the game's Present call.
  try {
    overlay->OnPresent(swapChain);
  } catch (...) {
    overlay->NoteDrawException();
  }
}

HRESULT STDMETHODCALLTYPE D3D11Overlay::PresentDetour(IDXGISwapChain* swapChain, UINT syncInterval, UINT flags) {
  D3D11Overlay* overlay = g_activeOverlay.load(std::memory_order_acquire);
  if (overlay != nullptr) {
    overlay->inFlight_.fetch_add(1, std::memory_order_acq_rel);
    SafePresentHook(overlay, swapChain);
    overlay->inFlight_.fetch_sub(1, std::memory_order_acq_rel);
  }
  const PresentFn original = g_originalPresent;
  if (original == nullptr) return E_FAIL;
  return original(swapChain, syncInterval, flags);
}

HRESULT STDMETHODCALLTYPE D3D11Overlay::ResizeBuffersDetour(IDXGISwapChain* swapChain, UINT bufferCount, UINT width,
                                                           UINT height, DXGI_FORMAT newFormat,
                                                           UINT swapChainFlags) {
  D3D11Overlay* overlay = g_activeOverlay.load(std::memory_order_acquire);
  if (overlay != nullptr) {
    overlay->inFlight_.fetch_add(1, std::memory_order_acq_rel);
    {
      // The cached back-buffer surface reference must be gone before the game
      // is allowed to resize, otherwise DXGI returns DXGI_ERROR_INVALID_CALL.
      std::lock_guard<std::mutex> lock(overlay->resourceMutex_);
      overlay->ReleaseTarget();
    }
    overlay->inFlight_.fetch_sub(1, std::memory_order_acq_rel);
  }
  const ResizeBuffersFn original = g_originalResizeBuffers;
  if (original == nullptr) return E_FAIL;
  return original(swapChain, bufferCount, width, height, newFormat, swapChainFlags);
}

bool D3D11Overlay::Install() {
  if (installed_.load(std::memory_order_acquire)) return true;

  {
    std::lock_guard<std::mutex> resourceLock(resourceMutex_);
    ReleaseAllResources();
    nextInitRetryMs_ = 0;
    initFailureLogged_ = false;
    exceptionLogged_ = false;
  }

  std::lock_guard<std::mutex> patchLock(g_patchMutex);
  if (!g_patches.empty()) RestorePatchesLocked();

  ComPtr<IDXGISwapChain> probeSwapChain;
  HWND probeWindow = nullptr;
  if (!CreateProbeSwapChain(&probeSwapChain, &probeWindow)) {
    LogError("overlay: could not create a probe D3D11 swapchain; Present hook not installed");
    return false;
  }

  std::vector<void*> vtables;
  AddVtableFromObject(static_cast<IUnknown*>(probeSwapChain.Get()), vtables);
  AddDerivedSwapChainVtables(probeSwapChain.Get(), vtables);

  bool ok = true;
  for (void* vtable : vtables) {
    ok = PatchVtableSlot(vtable, kPresentIndex, VoidFromFunction(&D3D11Overlay::PresentDetour)) && ok;
    ok = PatchVtableSlot(vtable, kResizeBuffersIndex, VoidFromFunction(&D3D11Overlay::ResizeBuffersDetour)) && ok;
  }

  probeSwapChain.Reset();
  if (probeWindow != nullptr) DestroyWindow(probeWindow);

  if (!ok || g_originalPresent == nullptr || g_originalResizeBuffers == nullptr) {
    RestorePatchesLocked();
    LogError("overlay: vtable patching failed; overlay disabled (game unaffected)");
    return false;
  }

  g_activeOverlay.store(this, std::memory_order_release);
  installed_.store(true, std::memory_order_release);
  LogInfo("overlay: hooked Present/ResizeBuffers on %zu swapchain vtable(s)", vtables.size());
  return true;
}

void D3D11Overlay::Uninstall() {
  if (!installed_.exchange(false, std::memory_order_acq_rel)) return;
  g_activeOverlay.store(nullptr, std::memory_order_release);

  {
    std::lock_guard<std::mutex> patchLock(g_patchMutex);
    RestorePatchesLocked();
  }

  // A detour that is already running on the render thread must finish before
  // the D2D resources can be released.
  for (int attempt = 0; attempt < 200 && inFlight_.load(std::memory_order_acquire) > 0; ++attempt) {
    Sleep(10);
  }
  if (inFlight_.load(std::memory_order_acquire) > 0) {
    LogWarn("overlay: a Present detour is still in flight during uninstall");
  }

  {
    std::lock_guard<std::mutex> resourceLock(resourceMutex_);
    ReleaseAllResources();
  }
  LogInfo("overlay: hook removed");
}

void D3D11Overlay::EmergencyRestoreHooks() {
  g_activeOverlay.store(nullptr, std::memory_order_release);
  std::lock_guard<std::mutex> patchLock(g_patchMutex);
  RestorePatchesLocked();
}

void D3D11Overlay::SetSettings(const OverlaySettings& settings) {
  std::lock_guard<std::mutex> lock(stateMutex_);
  settings_ = settings;
}

void D3D11Overlay::AddLine(const OverlayLine& line) {
  std::lock_guard<std::mutex> lock(stateMutex_);
  if (lines_.size() >= kMaxStoredLines) lines_.pop_front();
  lines_.push_back(line);
}

void D3D11Overlay::UpdateTranslation(uint64_t seq, const std::wstring& translation) {
  std::lock_guard<std::mutex> lock(stateMutex_);
  for (auto it = lines_.rbegin(); it != lines_.rend(); ++it) {
    if (it->seq == seq) {
      it->translation = translation;
      it->pending = false;
      return;
    }
  }
}

void D3D11Overlay::MarkTranslationFailed(uint64_t seq) {
  std::lock_guard<std::mutex> lock(stateMutex_);
  for (auto it = lines_.rbegin(); it != lines_.rend(); ++it) {
    if (it->seq == seq) {
      it->translation.clear();
      it->pending = false;
      return;
    }
  }
}

void D3D11Overlay::Clear() {
  std::lock_guard<std::mutex> lock(stateMutex_);
  lines_.clear();
}

void D3D11Overlay::TakeSnapshot(OverlaySettings* settings, std::vector<OverlayLine>* lines) {
  std::lock_guard<std::mutex> lock(stateMutex_);
  *settings = settings_;
  int maxLines = settings_.maxLines;
  if (maxLines < 1) maxLines = 1;
  if (maxLines > 32) maxLines = 32;
  const size_t count = std::min<size_t>(lines_.size(), static_cast<size_t>(maxLines));
  lines->assign(lines_.end() - static_cast<std::ptrdiff_t>(count), lines_.end());
}

void D3D11Overlay::OnPresent(IDXGISwapChain* swapChain) {
  if (swapChain == nullptr) return;
  OverlaySettings settings;
  std::vector<OverlayLine> lines;
  TakeSnapshot(&settings, &lines);
  if (!settings.visible || lines.empty()) return;

  std::lock_guard<std::mutex> lock(resourceMutex_);
  if (!EnsureTarget(swapChain, settings)) return;
  Render(settings, lines);
}

void D3D11Overlay::NoteDrawException() {
  if (exceptionLogged_) return;
  exceptionLogged_ = true;
  LogError("overlay: an exception was caught while drawing; the frame was skipped");
}

void D3D11Overlay::MaybeLogInitFailure(const char* message) {
  if (initFailureLogged_) return;
  initFailureLogged_ = true;
  LogWarn("overlay: %s; the game keeps running without the overlay", message);
}

bool D3D11Overlay::EnsureTarget(IDXGISwapChain* swapChain, const OverlaySettings& settings) {
  const uint64_t now = GetTickCount64();
  if (now < nextInitRetryMs_) return false;

  const auto fail = [this](const char* message) -> bool {
    MaybeLogInitFailure(message);
    nextInitRetryMs_ = GetTickCount64() + kInitRetryDelayMs;
    return false;
  };

  DXGI_SWAP_CHAIN_DESC description = {};
  if (FAILED(swapChain->GetDesc(&description))) return false;
  if (description.BufferDesc.Width == 0 || description.BufferDesc.Height == 0) return false;

  if (d3dDevice_ == nullptr) {
    ComPtr<ID3D11Device> device;
    if (FAILED(swapChain->GetDevice(__uuidof(ID3D11Device), reinterpret_cast<void**>(device.GetAddressOf()))) ||
        device.Get() == nullptr) {
      return fail("swapchain does not expose a D3D11 device (D3D12/Vulkan are not supported)");
    }
    d3dDevice_ = device.Detach();
  }

  if (d2dFactory_ == nullptr) {
    D2D1_FACTORY_OPTIONS options = {};
    // Ask for ID2D1Factory1 directly: CreateDevice() only exists on the 1.1
    // factory interface, not on the base ID2D1Factory.
    if (FAILED(D2D1CreateFactory(D2D1_FACTORY_TYPE_SINGLE_THREADED, __uuidof(ID2D1Factory1), &options,
                                 reinterpret_cast<void**>(&d2dFactory_)))) {
      return fail("D2D1CreateFactory failed");
    }
  }
  if (dwriteFactory_ == nullptr) {
    if (FAILED(DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED, __uuidof(IDWriteFactory),
                                   reinterpret_cast<IUnknown**>(&dwriteFactory_)))) {
      return fail("DWriteCreateFactory failed");
    }
  }

  if (d2dDevice_ == nullptr) {
    ComPtr<IDXGIDevice> dxgiDevice;
    if (FAILED(d3dDevice_->QueryInterface(__uuidof(IDXGIDevice), reinterpret_cast<void**>(dxgiDevice.GetAddressOf())))) {
      return fail("D3D11 device does not expose IDXGIDevice");
    }
    if (FAILED(d2dFactory_->CreateDevice(dxgiDevice.Get(), &d2dDevice_))) return fail("D2D CreateDevice failed");
  }
  if (d2dContext_ == nullptr) {
    if (FAILED(d2dDevice_->CreateDeviceContext(D2D1_DEVICE_CONTEXT_OPTIONS_NONE, &d2dContext_))) {
      return fail("D2D CreateDeviceContext failed");
    }
    // Pinning DPI to 96 makes 1 DIP == 1 back-buffer pixel, so chatRect and
    // fontSize are simple pixel fractions. Multi-monitor DPI is a Tier-1
    // limitation (see docs/DESIGN.md).
    d2dContext_->SetDpi(96.0f, 96.0f);
    d2dContext_->SetTextAntialiasMode(D2D1_TEXT_ANTIALIAS_MODE_GRAYSCALE);
  }

  if (backgroundBrush_ == nullptr) {
    // Create all brushes into locals first: a partial failure must not leave the
    // overlay with some brushes null and others valid.
    ComPtr<ID2D1SolidColorBrush> background;
    ComPtr<ID2D1SolidColorBrush> original;
    ComPtr<ID2D1SolidColorBrush> translation;
    if (FAILED(d2dContext_->CreateSolidColorBrush(D2D1::ColorF(0.04f, 0.05f, 0.07f, 0.55f),
                                                  background.GetAddressOf())) ||
        FAILED(d2dContext_->CreateSolidColorBrush(D2D1::ColorF(0.62f, 0.66f, 0.70f, 0.90f),
                                                  original.GetAddressOf())) ||
        FAILED(d2dContext_->CreateSolidColorBrush(D2D1::ColorF(0.96f, 0.97f, 0.99f, 1.00f),
                                                  translation.GetAddressOf()))) {
      return fail("D2D brush creation failed");
    }
    backgroundBrush_ = background.Detach();
    originalBrush_ = original.Detach();
    translationBrush_ = translation.Detach();
  }

  ComPtr<IDXGISurface> currentSurface;
  if (FAILED(swapChain->GetBuffer(0, __uuidof(IDXGISurface), reinterpret_cast<void**>(currentSurface.GetAddressOf())))) {
    return fail("IDXGISwapChain::GetBuffer(0) failed");
  }

  const bool targetNeedsRebuild = targetBitmap_ == nullptr || boundSurface_ != currentSurface.Get() ||
                                  targetWidth_ != description.BufferDesc.Width ||
                                  targetHeight_ != description.BufferDesc.Height;
  if (targetNeedsRebuild) {
    ReleaseTarget();
    // Built field by field instead of using D2D1::BitmapProperties1 so the
    // pixel format / DPI choices are explicit and not helper-overload dependent.
    D2D1_BITMAP_PROPERTIES1 properties = {};
    properties.bitmapOptions = D2D1_BITMAP_OPTIONS_TARGET | D2D1_BITMAP_OPTIONS_CANNOT_DRAW;
    properties.pixelFormat = D2D1::PixelFormat(description.BufferDesc.Format, D2D1_ALPHA_MODE_IGNORE);
    properties.dpiX = 96.0f;
    properties.dpiY = 96.0f;
    if (FAILED(d2dContext_->CreateBitmapFromDxgiSurface(currentSurface.Get(), &properties, &targetBitmap_))) {
      return fail("D2D cannot draw into this swapchain format (HDR/10-bit formats are not supported yet)");
    }
    d2dContext_->SetTarget(targetBitmap_);
    boundSurface_ = currentSurface.Detach();
    targetWidth_ = description.BufferDesc.Width;
    targetHeight_ = description.BufferDesc.Height;
  }

  if (!EnsureTextResources(settings.fontSize)) return fail("DWrite text format creation failed");

  initFailureLogged_ = false;
  return true;
}

bool D3D11Overlay::EnsureTextResources(float fontSize) {
  if (fontSize < 8.0f) fontSize = 8.0f;
  if (fontSize > 72.0f) fontSize = 72.0f;
  if (senderFormat_ != nullptr && translationFormat_ != nullptr && std::fabs(currentFontSize_ - fontSize) < 0.5f) {
    return true;
  }

  if (senderFormat_ != nullptr) {
    senderFormat_->Release();
    senderFormat_ = nullptr;
  }
  if (translationFormat_ != nullptr) {
    translationFormat_->Release();
    translationFormat_ = nullptr;
  }
  if (dwriteFactory_ == nullptr) return false;

  HRESULT result = dwriteFactory_->CreateTextFormat(L"Segoe UI", nullptr, DWRITE_FONT_WEIGHT_SEMI_BOLD,
                                                    DWRITE_FONT_STYLE_NORMAL, DWRITE_FONT_STRETCH_NORMAL,
                                                    fontSize * 0.85f, L"zh-Hans", &senderFormat_);
  if (FAILED(result) || senderFormat_ == nullptr) return false;
  senderFormat_->SetWordWrapping(DWRITE_WORD_WRAPPING_WRAP);

  result = dwriteFactory_->CreateTextFormat(L"Segoe UI", nullptr, DWRITE_FONT_WEIGHT_NORMAL, DWRITE_FONT_STYLE_NORMAL,
                                            DWRITE_FONT_STRETCH_NORMAL, fontSize, L"zh-Hans", &translationFormat_);
  if (FAILED(result) || translationFormat_ == nullptr) return false;
  translationFormat_->SetWordWrapping(DWRITE_WORD_WRAPPING_WRAP);

  currentFontSize_ = fontSize;
  return true;
}

void D3D11Overlay::ReleaseTarget() {
  if (d2dContext_ != nullptr) d2dContext_->SetTarget(nullptr);
  if (targetBitmap_ != nullptr) {
    targetBitmap_->Release();
    targetBitmap_ = nullptr;
  }
  if (boundSurface_ != nullptr) {
    boundSurface_->Release();
    boundSurface_ = nullptr;
  }
  targetWidth_ = 0;
  targetHeight_ = 0;
}

void D3D11Overlay::ReleaseAllResources() {
  ReleaseTarget();
  if (backgroundBrush_ != nullptr) {
    backgroundBrush_->Release();
    backgroundBrush_ = nullptr;
  }
  if (originalBrush_ != nullptr) {
    originalBrush_->Release();
    originalBrush_ = nullptr;
  }
  if (translationBrush_ != nullptr) {
    translationBrush_->Release();
    translationBrush_ = nullptr;
  }
  if (senderFormat_ != nullptr) {
    senderFormat_->Release();
    senderFormat_ = nullptr;
  }
  if (translationFormat_ != nullptr) {
    translationFormat_->Release();
    translationFormat_ = nullptr;
  }
  if (d2dContext_ != nullptr) {
    d2dContext_->Release();
    d2dContext_ = nullptr;
  }
  if (d2dDevice_ != nullptr) {
    d2dDevice_->Release();
    d2dDevice_ = nullptr;
  }
  if (dwriteFactory_ != nullptr) {
    dwriteFactory_->Release();
    dwriteFactory_ = nullptr;
  }
  if (d2dFactory_ != nullptr) {
    d2dFactory_->Release();
    d2dFactory_ = nullptr;
  }
  if (d3dDevice_ != nullptr) {
    d3dDevice_->Release();
    d3dDevice_ = nullptr;
  }
  currentFontSize_ = 0.0f;
}

void D3D11Overlay::Render(const OverlaySettings& settings, const std::vector<OverlayLine>& lines) {
  if (d2dContext_ == nullptr || targetBitmap_ == nullptr || senderFormat_ == nullptr ||
      translationFormat_ == nullptr || targetWidth_ == 0 || targetHeight_ == 0) {
    return;
  }

  const float width = static_cast<float>(targetWidth_);
  const float height = static_cast<float>(targetHeight_);
  const auto clamp01 = [](float value) { return value < 0.0f ? 0.0f : (value > 1.0f ? 1.0f : value); };

  const D2D1_RECT_F area = D2D1::RectF(clamp01(settings.x) * width, clamp01(settings.y) * height,
                                       clamp01(settings.x + settings.w) * width,
                                       clamp01(settings.y + settings.h) * height);
  if (area.right - area.left < 16.0f || area.bottom - area.top < 16.0f) return;

  float fontSize = settings.fontSize;
  if (fontSize < 8.0f) fontSize = 8.0f;
  if (fontSize > 72.0f) fontSize = 72.0f;

  const float padding = std::max(4.0f, fontSize * 0.4f);
  const float senderHeight = fontSize * 1.15f;
  const float translationHeight = fontSize * 1.5f;
  const float lineGap = fontSize * 0.35f;
  const float textTop = area.top + padding;
  const float bottom = area.bottom - padding;
  if (bottom - textTop < senderHeight + translationHeight) return;

  d2dContext_->BeginDraw();
  d2dContext_->SetTransform(D2D1::Matrix3x2F::Identity());
  d2dContext_->FillRoundedRectangle(D2D1::RoundedRect(area, fontSize * 0.35f, fontSize * 0.35f), backgroundBrush_);

  const float textLeft = area.left + padding;
  const float textRight = area.right - padding;
  float y = textTop;
  bool drewAnyLine = false;

  for (const OverlayLine& line : lines) {
    const float translationTop = y + senderHeight;
    if (translationTop + translationHeight > bottom) break;

    std::wstring header;
    if (!line.sender.empty()) {
      header = line.sender;
      header += L": ";
    }
    header += line.original;
    d2dContext_->DrawText(header.c_str(), static_cast<UINT32>(header.size()), senderFormat_,
                          D2D1::RectF(textLeft, y, textRight, translationTop), originalBrush_,
                          D2D1_DRAW_TEXT_OPTIONS_CLIP, DWRITE_MEASURING_MODE_NATURAL);

    const wchar_t* translationText = L"";
    UINT32 translationLength = 0;
    if (line.pending) {
      translationText = kPendingText;
      translationLength = static_cast<UINT32>(sizeof(kPendingText) / sizeof(kPendingText[0]) - 1);
    } else if (!line.translation.empty()) {
      translationText = line.translation.c_str();
      translationLength = static_cast<UINT32>(line.translation.size());
    }
    if (translationLength > 0) {
      d2dContext_->DrawText(translationText, translationLength, translationFormat_,
                            D2D1::RectF(textLeft, translationTop, textRight, translationTop + translationHeight),
                            translationBrush_, D2D1_DRAW_TEXT_OPTIONS_CLIP, DWRITE_MEASURING_MODE_NATURAL);
    }

    y = translationTop + translationHeight + lineGap;
    drewAnyLine = true;
  }

  const HRESULT result = d2dContext_->EndDraw();
  if (SUCCEEDED(result)) {
    if (drewAnyLine) renderedFrames_.fetch_add(1, std::memory_order_relaxed);
  } else if (result == D2DERR_RECREATE_TARGET) {
    ReleaseTarget();
  } else {
    MaybeLogInitFailure("D2D EndDraw failed");
  }
}

}  // namespace lct
