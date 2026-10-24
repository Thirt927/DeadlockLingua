# DeadlockLingua

> Real-time chat translation for *Deadlock*: your teammates' and opponents' foreign chat is translated into Chinese and **shown right under the original message** — no tabbing out, no second window. With the local certificate installed the downlink is **under 1 second**; without it the mod automatically stays on the bit channel (2–6 s). No switching required.

`GPL-3.0` · `v2.1.0 + https channel` · Windows 10/11 · Node.js 18+ · Forked from [BabelTower](https://github.com/c1375rick/BabelTower), maintained by [Thirt927](https://github.com/Thirt927)

[简体中文](README.md) · [English](README_EN.md)

> [!NOTE]
> Repository status: v2.1.0 plus the **https panel channel** (2026-10-24, not tagged yet).
> With the cert trusted → downlink ≈ one RTT. Without it → the session stays on the BTIPC bit channel, with exactly the same features.

## Contents

- [Overview](#overview)
- [Features](#features)
- [Installation](#installation)
- [Usage](#usage)
- [Configuration & API](#configuration--api)
- [Under the hood](#under-the-hood)
- [FAQ](#faq)
- [Development](#development)
- [License & credits](#license--credits)

## Overview

DeadlockLingua has two parts:

- **In-game mod** (Panorama): scans chat, writes requests into `console.log`, and appends the translation under the original message.
- **Local bridge** (Node.js, loopback only): calls the translation providers and sends results back into the game.

The downlink picks a channel automatically:

| Channel | Requirement | Latency |
|---|---|---|
| **https panel** (primary) | A trusted local self-signed cert + `core/bridge_https.js` terminating TLS on 8792 | ≈ one RTT (<1 s) |
| **BTIPC bit channel** (fallback) | Only `-condebug`; zero config | 2–6 s (≈16 B/s) |

How it chooses: at boot the bridge tells the game via `op=ui` whether https is ready. The game then probes once; alive → https for the session, dead → BTIPC for the whole session. A later cert failure, page load failure, or 3 consecutive hard failures falls back automatically — no user action.

## Features

**Reading others**

- Translation appears under the original chat line; HUD top-bar bubbles and lobby chat are covered too
- Messages already in Chinese, pure numbers/symbols, and `/` commands are skipped
- After chat scroll recycling, translations are rebuilt from cache

**Saying what you mean**

- Translate-before-send: type Chinese, press Enter — it is translated to English first, then sent through the vanilla path
- Display mode: translation only, or original + translation

**Translation**

- 5 providers: Bing (no key), Microsoft, OpenAI-compatible (DeepSeek etc.), DeepL, Google Cloud
- Automatic fallback when the primary provider times out or fails
- Built-in glossary: 42 playable heroes, 194 shop items, common tactical terms
- Adaptive dictionary: frequent short phrases are pinned and answered instantly

**Other**

- Chat logs per match as JSONL, for post-game review
- Passive SteamID backfill (nickname → SteamID64)
- Desktop overlay (the v2.0.x path) is kept and can be enabled in settings

## Installation

1. Download the latest release and extract it to a path **without spaces or non-ASCII characters** (e.g. `D:\DeadlockLingua`):
   <https://github.com/Thirt927/DeadlockLingua/releases/latest>
   (The https panel channel is **unreleased** repository work: until the next release, use
   `scripts/gen_bridge_cert.ps1` and `core/bridge_https.js` from the repo.)

2. **Add the `-condebug` launch option to Deadlock** (**required**, once only)

   Steam Library → right-click Deadlock → Properties → General → **Launch Options**:

   ```text
   -condebug
   ```

   Without it the game does not write `game/citadel/console.log`, the only path for **requests out** (both downlinks depend on it). The mod then looks like "installed but doing nothing".

3. **Put the VPK into `addons`**

   - Rename the bundled `pak01_dir.vpk` first (any name that doesn't collide with existing files in `addons/`; `pak22_dir.vpk` is recommended)
   - It must go in `game/citadel/addons/`; do **not** use the name `pak01` (it conflicts with the game's own pak), and never put it in `citadel/` itself (that would override game resources)
   - Deadlock Mod Manager is recommended; or copy manually to:
     `<Steam Library>\steamapps\common\Deadlock\game\citadel\addons\`

4. **Start the local bridge** (either one)

   - `install-autostart.bat` — install as a login auto-start (recommended)
   - `StartBridgeSilent.vbs` — start it in the background for this session

5. **Restart Deadlock**

6. **Recommended: bring the downlink under 1 second (optional but strongly advised)**

   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\gen_bridge_cert.ps1 -Trust
   ```

   Then **fully quit Steam (including the tray icon) and reopen it**, and look for `https panel: ALIVE` in the game's `console.log`.

   - The command generates a self-signed cert for `localhost` / `127.0.0.1` / `::1` only, and installs it into the **current user's** root store — no admin needed
   - Windows shows a security warning once; you must click "Yes" (do not run it from a hidden window, it will wait for the dialog forever)
   - The trust decision is cached in the Steam process: **restarting the game is not enough — Steam must be fully restarted**
   - Revoke anytime: `powershell -ExecutionPolicy Bypass -File scripts\gen_bridge_cert.ps1 -Untrust` (also needs a full Steam restart)
   - Skipping this step is fine — without a cert the bridge never spawns the https child and the session stays on BTIPC

> [!TIP]
> `StartDeadlock.bat` starts the bridge and can also launch the game through Steam (`StartDeadlock.bat -game`); `-condebug` still comes from the game's launch options.

## Usage

### Reading translations

Just play. When someone types in a foreign language, the translation appears under that message (light blue, italic).

| Active channel | Per message | How to tell |
|---|---|---|
| https panel | usually **<1 s** | `https panel: ALIVE` in `console.log` |
| BTIPC bit channel | **2–6 s** (≈16 B/s) | `https panel: not usable (...)` or no cert |

If nothing appears, check in order:

1. Is `-condebug` in the launch options? (most common cause)
2. Is the bridge running? Open `http://127.0.0.1:8791/api/v1/health` — JSON means it is
3. Does `logs/bridge.log` contain `BTIPC TRQ` / `BTIPC: r=.. seq=.. OK`?

### Sending messages

Type Chinese and press Enter: it is translated to English first, then sent through the vanilla path. Toggles and display mode are in [Settings](#settings).

### Settings

| Entry | How | Notes |
|---|---|---|
| **ESC menu** | ESC → "Translation Settings" | Opens the in-game panel; the ESC menu has a native cursor, so you can click directly (recommended) |
| **In-game shortcut** | Type `/tr`, or click `set` next to the chat box | Same panel; in the chat layout you must hold `Tab` to get a cursor |
| **Web settings** | Open `http://127.0.0.1:8791/settings` | All fields: provider, API key, endpoint, fallback chain |

> [!NOTE]
> The in-game channel is narrowband: one bit-channel frame carries 10 bytes, capped at 128 frames; the full config is ~1.3 KB and does not fit. The in-game panel therefore opens instantly for common toggles and only gets an ack on save; use the web page for the full config.

Configuration lives in `config/config.json` (generated on first run). It contains your API key, is ignored by `.gitignore`, and **must never be committed**. After saving, the **next message** uses the new settings.

### Starting / stopping the bridge

| Action | How |
|---|---|
| Start the bridge in the background | `StartBridgeSilent.vbs` (or `StartDeadlock.bat`) |
| Start the bridge and launch the game | `StartDeadlock.bat -game` |
| Stop / restart | `StopBridge.bat` / `RestartBridge.bat` |
| Auto-start at login | `install-autostart.bat` / `remove-autostart.bat` |
| Open the overlay manually (game not needed) | `ShowOverlay.bat` |

## Configuration & API

### Config file

The config file is `config/config.json`; main fields:

| Field | Default | Description |
|---|---|---|
| `port` | `8791` | Bridge port |
| `provider` | `"bing"` | Primary provider: `bing` / `microsoft` / `openai` / `deepl` / `google` |
| `fallbackProviders` | `[]` | Fallback order on failure (only providers with a configured key are tried) |
| `defaults.sourceLanguage` | `"auto"` | Source language |
| `defaults.targetLanguage` | `"zh-Hans"` | Target language |
| `timeoutMs` | `15000` | Translation timeout budget (ms) |
| `chatLog.enabled` | `true` | Whether to write chat logs |
| `chatLog.dir` | `"logs/chat"` | Chat log directory |
| `deadlockConsoleLog` | auto-detected | Path to the game's `console.log` (only exists with `-condebug`) |
| `steamIdEnrichment.enabled` | `false` | Enable SteamID backfill |
| `https.enabled` | `true` | Spawn the https panel child when a cert exists |
| `https.port` | `8792` | https port (bound to `127.0.0.1` + `::1` only) |
| `https.pfx` / `https.passFile` | `config/certs/bridge.pfx` / `.pass` | Cert and passphrase files (gitignored) |
| `https.timeoutMs` | `30000` | Reverse-proxy hard timeout; must exceed the translation timeout or long messages become 502 |
| `overlay.enabled` | `false` | Enable the overlay (off by default since v2.1.0) |
| `overlay.mode` / `overlay.view` | `"native"` / `"panel"` | `native` WPF / `web` browser; `panel` window / `subtitle` layer |
| `overlay.edge` | `"right"` | Screen edge to collapse to: `left` / `right` / `top` / `bottom` / `float` |

> [!CAUTION]
> `config/config.json` contains your provider API keys. Logs **never** include the apiKey, and the file is ignored by `.gitignore` — never commit it.

### HTTP / TLS API

The bridge listens on loopback only. It is not exposed externally and provides no arbitrary URL proxy. Request bodies are capped at 64 KB, single texts at 4000 characters.

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `https://localhost:8792/bridge` | https panel page (loaded by the hidden in-game panel; same-origin fetch, then writes `document.title`) |
| `*` | `https://localhost:8792/api/v1/*` | Transparent proxy to 8791 (method/headers/body/status preserved) |
| `GET` | `/btipc/dl` | Bit-channel downlink: a frame by `w` / `r`; bit=1 returns `200` + PNG, bit=0 returns `404` |
| `POST` / `GET` | `/api/v1/translate` | Translate text, returns `{ ok, translation, detectedLanguage }` |
| `POST` / `GET` | `/api/v1/test` | Test provider connectivity with the current config |
| `GET` | `/api/v1/health` | Health check: version, current provider, fallback chain |
| `GET` / `POST` | `/api/v1/config` | Read (keys masked) / save configuration |
| `POST` / `GET` | `/api/v1/log` | Write a chat log entry (now driven by the `console.log` channel) |
| `POST` / `GET` | `/api/v1/diag` | Write in-game diagnostics into the bridge log |
| `GET` | `/api/v1/overlay/messages` | Overlay polling: recent chat, session id, target language |
| `POST` / `GET` | `/api/v1/overlay/translate` | Overlay send: Chinese → English |
| `GET` | `/settings` | Web settings page |
| `GET` | `/overlay` | Web overlay page (when `overlay.mode = "web"`) |
| `GET` | `/bridge` | Legacy in-game panel page (http channel is dead; diagnostics and https proxy origin only) |

Example:

```powershell
curl.exe http://127.0.0.1:8791/api/v1/health
curl.exe -k https://localhost:8792/api/v1/health   # -k while the cert is untrusted
```

## Under the hood

### Uplink (game → bridge, shared by both downlinks)

The game writes one structured line per request into `console.log`, and the bridge tails that file (`-condebug` is required):

```text
[LCT] BTIPC REQ w=<window> id=<request> len=<bytes> crc=<checksum> b64=<text>
```

### Downlink A: https panel (primary, <1 s)

A hidden HTML panel navigates to `https://localhost:8792/bridge?...`; the page does a **same-origin** `fetch('/api/v1/translate')` and writes the whole result into `document.title`; the game reads it back (event, plus a 0.1 s poll as fallback).

- TLS terminates in a **separate process** (`core/bridge_https.js`): a broken cert/handshake can never take BTIPC down with it, and the bridge itself still has exactly one `listen`.
- The cert comes from `scripts/gen_bridge_cert.ps1`: `CN=BabelTower-localhost`, SAN = `DNS:localhost` + **IP** `127.0.0.1` + **IP** `::1`, EKU serverAuth.
- The engine validates the chain **before** loading the page; an untrusted cert shows up as `panel.title` never updating (upstream measured `error:-202` = `ERR_CERT_AUTHORITY_INVALID`), and a trust change only takes effect after a **full Steam restart**.
- Client policy: one probe decides the session; hard failures (page never loaded / panel unavailable / payload truncated by the title limit) hand the job back to BTIPC unchanged; soft failures (page alive but slow) settle as before; 3 consecutive hard failures drop https for the session.

Details, troubleshooting and security boundaries: [`docs/https-panel.md`](docs/https-panel.md).

### Downlink B: BTIPC bit channel (fallback, 2–6 s)

The bridge encodes the translation into 16-byte frames; 128 hidden 2×2 `Image` panels in the game read the **status code** of `GET /btipc/dl?w=&r=&p=&t=` round by round — `200` = bit 1, `404` = bit 0. Frames carry `seq` / `VALID` / `LEN` plus a CRC-16; advancing the round number `r` is the implicit acknowledgement, and a failed check re-shoots the same round while the bridge idempotently re-serves the frame.

> [!NOTE]
> Image loading is driven by the engine's render pipeline, not by Panorama's JS HTTP API — so removing `AsyncWebRequest` does not affect this downlink.

Recent Phase 1 speed-ups: the bridge tails `console.log` with `fs.watch` (~50 ms instead of 800 ms polling), first shot 1.2 s → 0.3 s, BUSY backoff 500 ms → 180 ms, and providers reuse keep-alive connections. Full spec: [`docs/btipc-v1.md`](docs/btipc-v1.md); architecture: [`docs/architecture.md`](docs/architecture.md).

### Glossary

[`core/glossary.js`](core/glossary.js) injects the glossary into **every** translation prompt and corrects hero names in the output:

- `heroNames`: official English names of the 42 playable heroes
- `heroCnToEn`: Chinese nicknames → English hero names
- `itemEnToCn`: 194 official EN/CN pairs for shop items
- `termsCnToEn`: tactical terms (lane, push, recall, …)

Refresh hero and item data with `node scripts/sync_heroes.js` (dry-run by default, add `--write` to save). Authoritative sources: `https://api.deadlock-api.com/v1/assets/heroes` and `/v1/assets/items`.

### Chat logs & SteamID

- Chat logs: `logs/chat/<matchId>.jsonl`; identity cache: `logs/chat/identity_cache.json`
- The **bridge** writes the logs: the game emits one `[LCT-CHAT]{json}` line per deduplicated, sender-resolved message into `console.log`, and the bridge tails and persists it
- The cache is keyed by nickname and by `account:<account_id>`; nickname backfill is attempted 3 minutes after the file is written, the full 12-player roster triggers a public API request 6 hours later, and failures retry hourly

### Project layout

```text
DeadlockLingua/
├── mod/panorama/            Panorama mod (layout / scripts / styles)
├── core/                    Local Node.js bridge
│   ├── bridge_server.js     HTTP server, /btipc/dl route, https child lifecycle
│   ├── bridge_https.js      https panel channel: TLS on 8792 + reverse proxy (separate process)
│   ├── btipc/               BTIPC framing / windows / transport
│   ├── providers/           Translation providers
│   ├── glossary.js          Hero / item / tactic glossary
│   ├── dictionary.js        Adaptive dictionary
│   ├── overlay.js           Overlay data source (legacy)
│   ├── steamid_enrich.js    SteamID backfill
│   └── settings_page.html   Web settings page
├── tests/btipc/             BTIPC protocol tests (offline)
├── tests/https_panel_server.test.js   https channel test (offline)
├── scripts/                 Build / packaging / simulation tests / cert / overlay
├── config/                  Config and dictionaries (config/certs/ holds local certs, gitignored)
├── docs/                    Architecture, https/BTIPC specs, optimization log
├── *.bat / *.vbs            Start, stop, autostart and overlay scripts
└── LICENSE / LICENSE_NOTICE.md
```

Runtime directories are not tracked by Git: `config/config.json` (secrets), `config/certs/` (private keys), `logs/`, `dist/`, `portable-node/`, `tools/`.

### Experimental branch: native mod

The `feat/native-mod` branch contains an **experimental native DLL skeleton** (in-process DXGI overlay + WinHTTP) that does not depend on Panorama/CEF and needs no certificate. It is **not compiled and not validated in-game**, and injecting a DLL into the game carries anti-cheat/ban risk. It is not part of this mod.

## FAQ

**No translation ever appears in game?**
Check the launch options for `-condebug` first; then confirm the bridge is running (`http://127.0.0.1:8791/api/v1/health` returns JSON); finally look for `BTIPC TRQ` / `BTIPC: r=.. seq=.. OK` in `logs/bridge.log`.

**Still 2–6 seconds instead of under 1?**
The https channel is not up. Check the game's `console.log`: `https panel: not usable (bridge_nav_failed)` means the page never loaded — usually a missing `-Trust` or no full Steam restart. `TLS handshake rejected by client` in `bridge_https.log` is the same thing (the engine rejected the cert).

**It was fast, then fell back to the slow channel?**
3 consecutive hard failures drop https for the session (`https panel: dead ...`). Fix the cert / restart Steam and re-enter the game.

**What happens when translation fails?**
A provider failure falls back to the original text; when the bridge is absent it gives up in about 3 seconds and skips, without injecting red error labels into the chat.

**The bridge isn't running / shows "bridge offline"?**
Double-click `StartBridgeSilent.vbs`, or check Task Manager for `node.exe`.

**Typing `/tr` does nothing?**
Use ESC → "Translation Settings" instead (it has a cursor). The `/tr` panel lives in the chat layout, so you must hold `Tab` to get a mouse cursor before clicking it.

**Can I still use the overlay?**
Yes, the code is still there. Switch the view mode in settings; `overlay.mode = "web"` falls back to a browser window.

**Is installing the certificate safe?**
The cert is valid for `localhost` / `127.0.0.1` / `::1` only and cannot impersonate any public domain; the private key stays local in `config/certs/` (gitignored). It goes into the **current user's** store (not machine-wide) and can be removed with `-Untrust` at any time.

## Development

### Building from source

Requires Reduced CSDK 12 and [VPKEdit CLI](https://github.com/craftablescience/VPKEdit/releases) (place it in `tools/`):

```powershell
powershell -ExecutionPolicy Bypass -File scripts/build.ps1 -Csdk12Root "<CSDK_DIR>"
```

The output is `dist/pak01_dir.vpk`. Rename it to a name that doesn't collide with existing files in `addons/` (recommended: `pak22_dir.vpk`), then copy it into `game/citadel/addons/`.

### Tests

```powershell
# Offline protocol / channel tests (no game needed)
node tests\btipc\crc.test.js
node tests\btipc\frame.test.js
node tests\btipc\transport.test.js
node tests\btipc\e2e_tail.test.js
node tests\btipc\route.test.js
node tests\btipc\live_http.test.js
node tests\https_panel_server.test.js   # temp cert + stub upstream: TLS / proxy / degrade

# Simulators and bridge regressions (some need the bridge running)
node scripts\lingua_chat_simtest.js
node scripts\overlay_test.js
node scripts\test_sender_backfill.js
node scripts\test_steamid_roster.js
node scripts\test_bridge_dedup.js
node scripts\test_bridge_fallback.js
```

### Packaging a release

```powershell
powershell -ExecutionPolicy Bypass -File scripts\package_release.ps1 -Version 2.1.0
```

Produces `dist/DeadlockLingua-2.1.0-win64.zip` with the VPK, the bridge (including `bridge_https.js`), a portable Node runtime, start/stop scripts, the cert script and docs.

### Contributing

Issues and pull requests are welcome. Before committing, check:

- No `apiKey`, `sk-` keys, SteamIDs, `matchId`, raw chat text or absolute local paths
- `config/config.json`, `config/certs/`, `logs/`, `dist/`, `*.vpk` and `portable-node/` are ignored — don't force-add them
- Keep `.js` files UTF-8 with CRLF line endings
- If you change the BTIPC protocol on either side, **update the other side too** (the game side inlines copies of crc16 / bit order / UTF-8 / base64), and run `tests/btipc/*` plus `scripts/lingua_chat_simtest.js`
- If you change the https channel, run `tests/https_panel_server.test.js` and confirm the "no cert → whole session on BTIPC" fallback still holds

Roadmap:

- [x] In-game translation display (BTIPC two-way channel + Image bit encoding)
- [x] Translate-before-send
- [x] ESC-menu settings entry and tabbed `/tr` panel
- [x] Desktop overlay / subtitle layer (fallback)
- [x] Full glossary (42 heroes / 194 items)
- [x] Passive SteamID backfill
- [x] **https panel channel (2026-10-24, <1 s downlink, BTIPC fallback)**
- [x] BTIPC Phase 1 speed-ups (fs.watch / 300 ms first shot / 180 ms BUSY / keep-alive)
- [ ] Bit channel v1.1 (slim frames + CJK UTF-16, target ≤2.5 s for 60 B)
- [ ] Native mod (experimental branch, not compiled or validated)

## License & credits

- Project code: GNU GPL v3, see [`LICENSE`](LICENSE)
- Third-party notices: see [`LICENSE_NOTICE.md`](LICENSE_NOTICE.md)
- In-game Valve layout assets are used for compatibility only; copyright belongs to Valve

**https panel channel credits**: the protocol semantics follow upstream [BabelTower `docs/btipc-https-v1.md`](https://github.com/c1375rick/BabelTower/blob/main/docs/btipc-https-v1.md) (separate TLS terminator, same-origin fetch writing `document.title`, probe-once gating, hard/soft failure split); this repository implements them independently without copying its code. The original in-game precedent for "self-signed cert + `CurrentUser\Root` + full Steam restart" is **DeadlockTranslate 0.6.19**, as cited by that document. The `SetURL` / `panel.title` mechanism facts come from publicly observable behavior of DLCT and `Hantu-Raya/Deadlock-mods-collection` (Apache-2.0); the implementation here is independent.
