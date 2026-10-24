# DeadlockLingua · native mod experimental branch (`feat/native-mod`)

> **This is a different architecture, not a newer version of the main mod.** [`main`](https://github.com/Thirt927/DeadlockLingua/tree/main)
> is a "Panorama mod + local bridge". This branch keeps the same bridge but adds a **native DLL**:
> it is injected into the game process, calls the bridge over WinHTTP in-process, and draws the
> translation with Direct2D.
>
> ⚠️ **Not compiled, not validated in-game.** Injecting a DLL into the game carries
> **anti-cheat / ban risk**. Experimental only — not a release.

[简体中文](README.md) · [English](README_EN.md) · [Back to main](https://github.com/Thirt927/DeadlockLingua/tree/main)

## 1. The difference in one table

| | `main` | this branch |
|---|---|---|
| Where the translation is **drawn** | A `Label` under the chat row (**inside chat history**, scrolls with it) | An in-process D2D **overlay** above the chat area (**not** in chat history) |
| How it **gets into the game** | Hidden HTML panel over https (<1 s) or the BTIPC bit channel (fallback) | The DLL calls the bridge over **WinHTTP in-process** — **no return channel at all** |
| What you need | VPK + bridge + `-condebug` (cert optional) | The same VPK + bridge + `-condebug`, **plus an injected DLL** |
| Anti-cheat risk | None (no injection) | **Yes** (unknown, may ban) |
| Survives game updates | Depends on engine behavior | Depends on DXGI/vtable and the build |
| Maturity | validated in-game | skeleton + design only |

> Key point: **capture and translation are shared.** Both architectures rely on the main mod
> writing chat into `console.log` (`[LCT-CHAT]` lines) and on the bridge's `/api/v1/translate`.
> What differs is the **last hop**: main sends the result *back into* the game (panel / bit channel),
> while this branch receives it inside the game process and paints it itself.

## 2. Data flow

```text
main:
  chat DOM ──(Panorama mod)──> console.log ──tail──> bridge ──/api/v1/translate──> provider
                                                      │
                        https panel / BTIPC bits <────┘
                                 │
                                 ▼
                        in-game Label (under chat row)

this branch (Tier 1):
  chat DOM ──(same Panorama mod)──> console.log ──tail──> bridge ──/api/v1/translate──> provider
                                                                ▲
                        DLL in-process WinHTTP (worker) ─────────┘
                                 │
                                 ▼
                   Direct2D overlay (D3D11 Present hook)
```

For normal users **main is faster, safer and more native-looking**. This branch matters only if you
refuse the certificate route, want a fully custom overlay, or are researching injection/overlays.

## 3. What is in this branch

Merged up to main (`8a25049`); **no mainline code changed** — it only adds one directory and these READMEs:

```text
native/
├── README.md              build / install / config / troubleshooting for this directory
├── docs/DESIGN.md         Tier 1 implementation, Tier 2 design only, trade-offs, unverified list
├── CMakeLists.txt         C++17 / x64 / SHARED → LCTNative.dll
├── build.ps1              detects VS + CMake and builds
└── src/
    ├── dllmain.cpp        minimal DllMain + exported LCTNativeInit/Shutdown
    ├── app.cpp            lifecycle, config hot reload, tick loop
    ├── core/              logging, UTF-8/JSON helpers, config, console.log tail, WinHTTP client
    ├── overlay/           IDXGISwapChain Present/ResizeBuffers vtable hook + D2D/DWrite
    └── hooks/             sigscan (reserved for Tier 2, currently unused)
```

Three tiers (see [`native/docs/DESIGN.md`](native/docs/DESIGN.md)):

- **Tier 1 (implemented)**: in-process overlay; `native.json` next to the DLL configures rect/font/hotkey; `F8` toggles it.
- **Tier 2 (design only)**: hook Panorama and inject the translation into the chat row — the only way to be
  native *and* inside chat history, but it needs reverse-engineered structures and per-update offsets.
- **Tier 3 (design only)**: outbound (write translation back into the input box / simulate send) and input-injection risk.

## 4. Status (honest)

- **Not compiled**: the development machine has no C++ toolchain (no `cl` / `cmake` / VS / Windows SDK).
  Expect 1–2 rounds of compile fixes on the first real build.
- **Not run in-game**: vtable indices, D3D version, HDR/10-bit back buffers, font fallback, fullscreen/resize,
  multi-monitor and DPI are all **unverified**.
- **Anti-cheat behavior unknown** — the main reason this must not be distributed to normal users.
- Known limits: **D3D11 only** (D3D12 can be hooked but `ID3D11Device` is unavailable → silently draws nothing;
  Vulkan unsupported); overlay is not chat history; flip-model swapchains may rebuild D2D bitmaps every frame;
  no dedup / no backfill.

## 5. Build

Windows 10/11 x64 + **VS2022 Build Tools** (workload "Desktop development with C++") + **CMake 3.21+**.
No third-party dependencies (Windows SDK only).

```powershell
# from the repository root
cmake -B native/build -A x64
cmake --build native/build --config Release
# or
powershell -ExecutionPolicy Bypass -File native\build.ps1
```

Output: `native/build/LCTNative.dll` (Release also ships a `.pdb` for troubleshooting).

## 6. Install / run / uninstall

1. Set up the mainline as usual: VPK in `addons/`, bridge running, game started with `-condebug`
   (`StartDeadlock.bat` already adds it).
2. Put `LCTNative.dll` and an optional `native.json` in the same directory.
3. **Load the DLL with an injector you trust** — this repo ships none and contains no anti-cheat bypass.
4. In a match, the lower-left chat area should show "name: original / Chinese translation"; `F8` (configurable) toggles it.
5. Log: `%TEMP%\lct-native.log`.

Uninstall: hide with `F8`, then quit the game normally. **Do not `FreeLibrary` while running** (DllMain does not
handle detach); deleting the DLL and `native.json` completes removal.

`native.json` fields: `bridgeUrl` / `consoleLogPath` / `targetLanguage` / `chatRect` / `fontSize` / `maxLines` /
`hotkey` / `enabled`, hot-reloaded within ~1 s. See [`native/README.md`](native/README.md).

## 7. Why you probably don't need it

Main already reaches **<1 s** via the trusted https panel ([`docs/https-panel.md`](docs/https-panel.md)) with zero
injection and translations inside chat history. This branch only makes sense if:

- you refuse to install a local certificate and find the BTIPC bit channel too slow, or
- you want a fully custom overlay (font/position/style), not a chat-row label, or
- you are researching injection/overlays and accept the risk.

For "normal players should just use it", **stay on main**. That is why this branch is not merged.

## 8. Risk notice

- Injecting DLLs and hooking rendering is what anti-cheat looks for; **your account may be banned**. Use at your own risk.
- Game updates can break DXGI/vtable/log parsing; this branch makes no maintenance promise.
- Not affiliated with Valve; no injector is shipped and no evasion is implemented.

## 9. License

- GPL-3.0 for the whole repository, see [`LICENSE`](LICENSE).
- Zero third-party code; the design follows [`docs/from-scratch-architectures.md`](docs/from-scratch-architectures.md)
  (architecture B) and [`native/docs/DESIGN.md`](native/docs/DESIGN.md).
