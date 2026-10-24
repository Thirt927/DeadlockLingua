# DeadlockLingua

> Real-time chat translation for *Deadlock*: your teammates' and opponents' foreign chat is translated into Chinese and **shown right under the original message** — no tabbing out, no second window.

`GPL-3.0` · `v2.1.0` · Windows 10/11 · Node.js 18+ · Forked from [BabelTower](https://github.com/c1375rick/BabelTower), maintained by [Thirt927](https://github.com/Thirt927)

[简体中文](README.md) · [English](README_EN.md)

## Contents

- [Overview](#overview)
- [Installation](#installation)
- [Usage](#usage)
- [Configuration & API](#configuration--api)
- [Under the hood](#under-the-hood)
- [FAQ](#faq)
- [Development](#development)

## Overview

DeadlockLingua has two parts:

- **In-game mod** (Panorama): scans chat, requests translations, and appends the result under the original message.
- **Local bridge** (Node.js, bound to `127.0.0.1:8791`): calls the translation providers and sends results back into the game over the **BTIPC** two-way channel.

Since v2.1.0 translations are back in-game, and settings are back in-game too (ESC → "Translation Settings", or `/tr` in chat). The v2.0.x desktop overlay is kept as a fallback and can be switched on in settings.

## Features

**Reading others**

- Translation appears under the original chat line; HUD top-bar bubbles and lobby chat are covered too
- Messages already in Chinese, pure numbers/symbols, and `/` commands are skipped

**Saying what you mean**

- Translate-before-send: type Chinese, press Enter — it is translated to English first and then sent through the vanilla path
- Display mode: translation only, or original + translation

**Translation**

- 5 providers: Bing (no key), Microsoft, OpenAI-compatible (DeepSeek etc.), DeepL, Google Cloud
- Automatic fallback when the primary provider times out or fails
- Built-in glossary: 42 playable heroes, 194 shop items, common tactical terms
- Adaptive dictionary: frequent short phrases are pinned and answered instantly

**Other**

- Chat logs per match as JSONL, for post-game review
- Passive SteamID backfill (nickname → SteamID64)
- Desktop overlay (the v2.0.x path) still available

## Installation

1. Download the latest release and extract it to a path **without spaces or non-ASCII characters** (e.g. `D:\DeadlockLingua`):
   <https://github.com/Thirt927/DeadlockLingua/releases/latest>

2. **Add the `-condebug` launch option to Deadlock** (**required**, once only)

   Steam Library → right-click Deadlock → Properties → General → **Launch Options**:

   ```text
   -condebug
   ```

   Without it the game does not write `game/citadel/console.log`, which is the only path for requests out and translations back. Without it the mod looks like "installed but doing nothing".

3. **Put the VPK into `addons`**

   - Rename the bundled `pak01_dir.vpk` first (any name that doesn't collide with existing files in `addons/`; `pak22_dir.vpk` is recommended)
   - It must go in `game/citadel/addons/`; do **not** use the name `pak01` (it conflicts with the game's own pak), and never put it in `citadel/` itself (that would override game resources)
   - Deadlock Mod Manager is recommended; or copy manually to:
     `<Steam Library>\steamapps\common\Deadlock\game\citadel\addons\`

4. **Start the local bridge** (either one)

   - `install-autostart.bat` — install as a login auto-start (recommended)
   - `StartBridgeSilent.vbs` — start it in the background for this session

5. **Restart Deadlock**

> [!TIP]
> `StartDeadlock.bat` starts the bridge and can also launch the game through Steam (`StartDeadlock.bat -game`); `-condebug` still comes from the game's launch options.

## Usage

### Reading translations

Just play. When someone types in a foreign language, the translation appears under that message (light blue, italic).

- Each translation takes about **2–6 seconds** (the bit channel carries roughly 16 bytes/s — the current channel's limit)
- After chat scroll recycling, translations are rebuilt from cache

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
> The in-game channel is narrowband: one frame carries 10 bytes of payload, the protocol caps at 128 frames (~1280 bytes), and the full config is ~1.3 KB — it does not fit. So the in-game panel opens instantly for common toggles and only gets an ack on save; use the web page for the full config.

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
| `overlay.enabled` | `false` | Enable the overlay (off by default since v2.1.0) |
| `overlay.mode` / `overlay.view` | `"native"` / `"panel"` | `native` WPF / `web` browser; `panel` window / `subtitle` layer |
| `overlay.edge` | `"right"` | Screen edge to collapse to: `left` / `right` / `top` / `bottom` / `float` |

> [!CAUTION]
> `config/config.json` contains your provider API keys. Logs **never** include the apiKey, and the file is ignored by `.gitignore` — never commit it.

### HTTP API

The bridge listens on `127.0.0.1:8791` only. It is not exposed externally and provides no arbitrary URL proxy. Request bodies are capped at 64 KB, single texts at 4000 characters.

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/btipc/dl` | In-game bit channel downlink: a frame by `w` / `r`; bit=1 returns `200` + PNG, bit=0 returns `404` |
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
| `GET` | `/bridge` | Legacy in-game panel page (deprecated, diagnostics only) |

Example:

```bash
curl.exe http://127.0.0.1:8791/api/v1/health
```

## Under the hood

### Data flow

**Uplink (game → bridge)**: the game writes one structured line per request into `console.log`, and the bridge tails that file (`-condebug` is required):

```text
[LCT] BTIPC REQ w=<window> id=<request> len=<bytes> crc=<checksum> b64=<text>
```

**Downlink (bridge → game)**: the bridge encodes the translation into 16-byte frames; 128 hidden 2×2 `Image` panels in the game read the **status code** of `GET /btipc/dl?w=&r=&p=&t=` round by round — `200` = bit 1, `404` = bit 0. Frames carry `seq` / `VALID` / `LEN` plus a CRC-16; advancing the round number `r` is the implicit acknowledgement, and a failed check re-shoots the same round while the bridge idempotently re-serves the frame.

**Rendering**: the mod appends the translation as a `Label` under the chat row. Rendering was never removed; only the data source was missing.

> [!NOTE]
> Image loading is driven by the engine's render pipeline, not by Panorama's JS HTTP API — so removing `AsyncWebRequest` does not affect this downlink.
> The engine also has a trusted HTTPS panel channel that can bring the latency down to ~1 s (verified in-game upstream; the real blocker was the certificate chain, `error:-202`); this fork (2.1.0) has not ported it yet, so expect 2–6 seconds.

The full protocol spec is in [`docs/btipc-v1.md`](docs/btipc-v1.md); architecture details are in [`docs/architecture.md`](docs/architecture.md).

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
│   ├── bridge_server.js     HTTP server and /btipc/dl route
│   ├── btipc/               BTIPC framing / windows / transport
│   ├── providers/           Translation providers
│   ├── glossary.js          Hero / item / tactic glossary
│   ├── dictionary.js        Adaptive dictionary
│   ├── overlay.js           Overlay data source (legacy)
│   ├── steamid_enrich.js    SteamID backfill
│   └── settings_page.html   Web settings page
├── tests/btipc/             BTIPC protocol tests (offline)
├── scripts/                 Build / packaging / simulation tests / overlay
├── config/                  Config and dictionaries
├── docs/                    Architecture, BTIPC spec, optimization log
├── *.bat / *.vbs            Start, stop, autostart and overlay scripts
└── LICENSE / LICENSE_NOTICE.md
```

Runtime directories are not tracked by Git: `config/config.json` (secrets), `logs/` (logs), `dist/` (build output), `portable-node/` (local Node runtime), `tools/` (packaging tools).

## FAQ

**No translation ever appears in game?**
Check the launch options for `-condebug` first; then confirm the bridge is running (`http://127.0.0.1:8791/api/v1/health` returns JSON); finally look for `BTIPC TRQ` / `BTIPC: r=.. seq=.. OK` in `logs/bridge.log`.

**Translations take several seconds?**
Expected. The bit channel carries about 16 bytes/s, so a 60-byte translation takes roughly 4 seconds. It is not hanging.

**What happens when translation fails?**
A provider failure falls back to the original text; when the bridge is absent it gives up in about 3 seconds and skips, without injecting red error labels into the chat.

**The bridge isn't running / shows "bridge offline"?**
Double-click `StartBridgeSilent.vbs`, or check Task Manager for `node.exe`.

**Typing `/tr` does nothing?**
Use ESC → "Translation Settings" instead (it has a cursor). The `/tr` panel lives in the chat layout, so you must hold `Tab` to get a mouse cursor before clicking it.

**Can I still use the overlay?**
Yes, the code is still there. Switch the view mode in settings; `overlay.mode = "web"` falls back to a browser window.

## Development

### Building from source

Requires Reduced CSDK 12 and [VPKEdit CLI](https://github.com/craftablescience/VPKEdit/releases) (place it in `tools/`):

```powershell
powershell -ExecutionPolicy Bypass -File scripts/build.ps1 -Csdk12Root "<CSDK_DIR>"
```

The output is `dist/pak01_dir.vpk`. Rename it to a name that doesn't collide with existing files in `addons/` (recommended: `pak22_dir.vpk`), then copy it into `game/citadel/addons/`.

### Tests

```powershell
# Offline protocol tests (no game needed)
node tests\btipc\crc.test.js
node tests\btipc\frame.test.js
node tests\btipc\transport.test.js
node tests\btipc\e2e_tail.test.js
node tests\btipc\route.test.js
node tests\btipc\live_http.test.js

# Simulators (the bridge must be running)
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

Produces `dist/DeadlockLingua-2.1.0-win64.zip` with the VPK, the bridge, a portable Node runtime, start/stop scripts and docs.

### Contributing

Issues and pull requests are welcome. Before committing, check:

- No `apiKey`, `sk-` keys, SteamIDs, `matchId`, raw chat text or absolute local paths
- `config/config.json`, `logs/`, `dist/`, `*.vpk` and `portable-node/` are ignored — don't force-add them
- Keep `.js` files UTF-8 with CRLF line endings
- If you change the BTIPC protocol on either side, **update the other side too** (the game side inlines copies of crc16 / bit order / UTF-8 / base64), and run `tests/btipc/*` plus `scripts/lingua_chat_simtest.js`

Roadmap:

- [x] In-game translation display (BTIPC two-way channel + Image bit encoding)
- [x] Translate-before-send
- [x] ESC-menu settings entry and tabbed `/tr` panel
- [x] Desktop overlay / subtitle layer (fallback)
- [x] Full glossary (42 heroes / 194 items)
- [x] Passive SteamID backfill
- [ ] Faster bit channel (spec v1.1: target ≤2.5 s for 60 B)

## License

- Project code: GNU GPL v3, see [`LICENSE`](LICENSE)
- Third-party notices: see [`LICENSE_NOTICE.md`](LICENSE_NOTICE.md)
- In-game Valve layout assets are used for compatibility only; copyright belongs to Valve
