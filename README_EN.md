# DeadlockLingua

<p align="center">
  <img src="./assets/readme/hero.svg" width="100%" alt="DeadlockLingua: real-time Deadlock chat translation, appended right under the original message; the right side shows the BTIPC bit channel bringing the translation back into the game" />
</p>

<div align="center"><img alt="License: GPL-3.0" src="./assets/readme/badge-license.svg" height="26" /><img alt="Version 2.1.0" src="./assets/readme/badge-version.svg" height="26" /><img alt="Platform: Windows 10/11" src="./assets/readme/badge-platform.svg" height="26" /><img alt="Runtime: Node.js" src="./assets/readme/badge-runtime.svg" height="26" /><img alt="Providers: 5 services" src="./assets/readme/badge-providers.svg" height="26" /></div>

<p align="center">
🇨🇳 <a href="./README.md">简体中文</a> | 🇺🇸 <a href="./README_EN.md">English</a>
</p>

> A real-time chat translator for *Deadlock*, forked from [BabelTower](https://github.com/c1375rick/BabelTower) and maintained by [Thirt927](https://github.com/Thirt927).

It translates your teammates' and opponents' chat into Chinese in real time, **right under the original message** — no alt-tab, no second window.

<details>
<summary>Is the v2.0.x overlay still around?</summary>

Yes. v2.0.0 (after the game removed Panorama's HTTP capability) moved translation to a **desktop overlay** as an interim solution. Since **v2.1.0** the translation is back inside the game; the overlay code is kept in the repo as a fallback (`core/overlay.js`, `scripts/overlay_window.ps1`).

</details>

---

## Table of Contents

- [How in-game display works](#how-in-game-display-works)
- [Features](#features)
- [Installation](#installation)
- [Usage](#usage)
- [API Reference](#api-reference)
- [Configuration](#configuration)
- [Glossary](#glossary)
- [Chat Logs & SteamID](#chat-logs--steamid)
- [Building from Source](#building-from-source)
- [Tests](#tests)
- [Packaging a Release](#packaging-a-release)
- [Project Layout](#project-layout)
- [How It Works](#how-it-works)
- [FAQ](#faq)
- [Contributing](#contributing)
- [License](#license)

---

## How in-game display works

Deadlock's 2026-10-01 update removed Panorama's HTTP capability (`$.AsyncWebRequest` throws on call, and hidden HTML panels no longer get a browser instance). So "the game can't send requests" is true.

But **inbound is still possible** — the engine still fetches network resources for things *it* has to render, and image loading was not removed:

| Bridge response | What the game observes | Bit |
|---|---|---|
| `200` + PNG | `ImageLoaded` fires | **1** |
| `404` empty body | event stays silent | **0** |

The mod creates **128 hidden 2×2 Image panels** and asks all 128 bits once per round — that is 16 bytes per frame. With CRC and retries, a translation round-trips in roughly 2–6 seconds. This two-way channel is called **BTIPC**; the spec lives in [`docs/btipc-v1.md`](docs/btipc-v1.md).

> [!NOTE]
> The key insight: image loading is driven by the **engine's render pipeline**, not by Panorama's JS HTTP API — so removing `AsyncWebRequest` doesn't affect it.

---

## Features

**Understand others**

- **Translations appear directly under the original chat line** — no second window
- Works for HUD top-bar bubbles and lobby chat history too
- Messages already in Chinese are skipped; pure numbers/symbols and `/` commands are skipped

**Say what you mean**

- **Translate-before-send**: type in Chinese, press Enter — it is translated to English first and then sent through the game's own send path (translation-only or original|translation bilingual mode)

**Translation services**

- Multiple providers: Bing (no key), Microsoft, OpenAI-compatible (e.g. DeepSeek), DeepL, Google Cloud
- Automatic **fallback** to backup providers on timeout or failure
- Built-in **game glossary**: 46 playable heroes, 194 shop items, common tactics — consistent naming
- **Adaptive dictionary**: frequent short phrases get pinned and answered instantly

**Other**

- Chat logs written as JSONL per match for post-game review
- SteamID backfill: chat nicknames resolved to SteamID64
- The desktop overlay (the v2.0.x display path) is still available and switchable in settings

---

## Installation

Download the latest release: `https://github.com/Thirt927/DeadlockLingua/releases/latest`

1. Extract `DeadlockLingua-<version>-win64.zip` to a path **without spaces or non-ASCII characters**, e.g. `D:\DeadlockLingua`.

2. **Add the `-condebug` launch option to Deadlock** (**required**, once only)

   Without it the game does not write `game/citadel/console.log`, which is the **only outbound path** for requests and logs. Without it the mod looks like "installed but doing nothing".

   Steam Library → right-click Deadlock → Properties → General → **Launch Options**:

   ```text
   -condebug
   ```

3. **Install the mod into the game**
   - The VPK inside the archive is named `pak01_dir.vpk`; **rename it first** — any name that doesn't collide with existing files in `addons/` works. `pak22_dir.vpk` is recommended (the number is arbitrary; 22 is just the free slot this project uses).
   - ⚠️ **Do not keep the name `pak01_dir.vpk`**: `pak01` is the game's own pak group and will conflict. Also **never place it in `citadel\`** (that would override game resources) — it must go in `citadel\addons\`.
   - Deadlock Mod Manager is recommended; or copy manually to:
     `<Steam Library>\steamapps\common\Deadlock\game\citadel\addons\`
4. **Start the local bridge** (either one)
   - Double-click `install-autostart.bat` to install as a startup task (recommended)
   - Or double-click `StartBridgeSilent.vbs` to start it in the background
5. **Restart Deadlock**

> [!TIP]
> Launching via `StartDeadlock.bat` adds `-condebug` automatically (`steam://run/.../-condebug`), so step 2 becomes optional.

---

## Usage

### Reading translations

Just play. When someone types in a foreign language, the translation appears **right under that message** (light blue background, italic).

- Each translation takes about **2–6 seconds** (the bit channel carries roughly 16 bytes/second — a hard limit of the current channel)
- After chat scroll recycling, translations are rebuilt from cache

If nothing shows up in game, check in order:

1. Is `-condebug` in the launch options? (by far the most common cause)
2. Is the bridge running? Open `http://127.0.0.1:8791/api/v1/health` — JSON means it's fine
3. Does `logs/bridge.log` contain lines like `BTIPC TRQ` / `BTIPC: r=.. seq=.. OK`?

### Sending messages

Type Chinese in the chat box and press Enter — it is translated to English before being sent. To disable or switch to bilingual, see [Settings](#settings).

### Settings

Settings live in the **overlay's "Settings" page** (the in-game `/tr` panel was removed in v2.0.0 together with the old channels).

Double-click `ShowOverlay.bat` to open the overlay (**no need to start the game**), then click "Settings" in the title bar. Configurable:

- **Translation**: provider, API key, target language, display mode, send mode (translate-before-send), timeout
- **Overlay**: view mode, opacity, background colour, corner radius, accent colour, snap edge
- **Subtitle layer**: keep-alive, lifetime, fade duration, font size, text colours, max on-screen entries

Configuration is stored in `config/config.json`, generated on first run. It contains your API key, is listed in `.gitignore`, and **must never be committed**.

> [!IMPORTANT]
> In-game translation and the overlay share the same configuration. After clicking "Save", the **next message** uses the new settings; send-mode changes apply immediately.

### Starting / stopping the bridge

| Action | How |
|---|---|
| Start in background | `StartBridgeSilent.vbs` |
| Start in a terminal (see logs) | `StartDeadlock.bat` |
| Stop | `StopBridge.bat` |
| Restart | `RestartBridge.bat` |
| Install / remove autostart | `install-autostart.bat` / `remove-autostart.bat` |

---

## API Reference

The bridge listens on `127.0.0.1:8791` only. It is not exposed externally and provides no arbitrary URL proxy. Request bodies are capped at 64 KB, single texts at 4000 characters.

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/btipc/dl` | **In-game bit channel, downlink.** Fetch a frame by `w` (window) + `r` (round): bit=1 returns `200` + PNG, bit=0 returns `404`. Each of the game's 128 Image panels reads its own bit |
| `POST` / `GET` | `/api/v1/translate` | Translate text, returns `{ ok, translation, detectedLanguage }` |
| `POST` / `GET` | `/api/v1/test` | Test provider connectivity with the current config |
| `GET` | `/api/v1/health` | Health check: version, current provider, fallback chain |
| `GET` / `POST` | `/api/v1/config` | Read (keys masked) / save configuration |
| `GET` | `/api/v1/quickchat` | Quick-chat template corpus |
| `GET` | `/api/v1/gamenames` | Hero/item name-protection list |
| `POST` / `GET` | `/api/v1/log` | Write a chat log entry (now driven by the `console.log` channel — see [How It Works](#how-it-works)) |
| `POST` / `GET` | `/api/v1/diag` | Write in-game diagnostics into the bridge log |
| `GET` | `/api/v1/overlay/messages` | Overlay polling: recent chat, session id, target language |
| `POST` / `GET` | `/api/v1/overlay/translate` | Overlay send: translate Chinese to English for copying |
| `GET` | `/bridge` | Legacy in-game panel page (deprecated, diagnostics only) |
| `GET` | `/overlay` | Web overlay page (fallback when `overlay.mode = "web"`) |

<details>
<summary>Example calls</summary>

```bash
# Health check
curl.exe http://127.0.0.1:8791/api/v1/health

# Translate (POST)
curl.exe -X POST http://127.0.0.1:8791/api/v1/translate ^
  -H "Content-Type: application/json" ^
  -d "{\"text\":\"gg wp\",\"targetLanguage\":\"zh-Hans\"}"

# Bit channel: an unknown window must be 404 (this distinguishes the route from the generic 404)
curl.exe -i "http://127.0.0.1:8791/btipc/dl?w=abcdef&r=1&p=0&t=x"
```

```json
{ "ok": true, "translation": "打得好", "detectedLanguage": "en" }
```

</details>

---

## Configuration

The config file is `config/config.json` (generated from `config/config.example.json` on first run). Main fields:

| Field | Default | Description |
|---|---|---|
| `port` | `8791` | Bridge port |
| `provider` | `"bing"` | Primary provider: `bing` / `microsoft` / `openai` / `deepl` / `google` |
| `fallbackProviders` | `[]` | Fallback order on failure (only providers with a configured key are tried) |
| `defaults.sourceLanguage` | `"auto"` | Source language |
| `defaults.targetLanguage` | `"zh-Hans"` | Target language |
| `timeoutMs` | `15000` | Translation timeout budget |
| `chatLog.enabled` | `true` | Whether to write chat logs |
| `chatLog.dir` | `"logs/chat"` | Chat log directory |
| `deadlockConsoleLog` | auto-detected | Path to the game's `console.log` (only exists with `-condebug`) |
| `steamIdEnrichment.enabled` | `false` | Enable SteamID backfill |
| `overlay.enabled` | `true` | Enable the overlay |
| `overlay.autoOpen` | `true` | Open the overlay when the game starts |
| `overlay.mode` | `"native"` | `native` = native WPF window; `web` = browser fallback |
| `overlay.view` | `"panel"` | `panel` = panel window; `subtitle` = subtitle layer |
| `overlay.edge` | `"right"` | Collapse to which screen edge: `left` / `right` / `top` / `bottom` / `float` |

> [!CAUTION]
> `config/config.json` contains your provider API keys. Logs **never** include the apiKey, and the file is listed in `.gitignore` — **never commit it**.

---

## Glossary

[`core/glossary.js`](core/glossary.js) injects the glossary into **every** translation prompt and corrects hero names in the output:

- `heroNames` — official English names of the 46 playable heroes
- `heroCnToEn` — Chinese nicknames → English hero names
- `itemEnToCn` — 194 official EN/CN pairs for shop items
- `termsCnToEn` — tactical terms (lane, push, recall, …)

The authoritative sources are `https://api.deadlock-api.com/v1/assets/heroes` and `/v1/assets/items`, both supporting `?language=english|schinese`.

---

## Chat Logs & SteamID

Chat logs are written to `logs/chat/<matchId>.jsonl`; the identity cache to `logs/chat/identity_cache.json`.

> [!NOTE]
> The **bridge** is what writes these logs: the game emits one `[LCT-CHAT]{json}` line per deduplicated, sender-resolved chat message into `console.log`, and the bridge tails that file and persists it. This is why `-condebug` is mandatory.

The cache holds two kinds of keys:

- **Nickname keys**: used to backfill SteamID for chat messages
- **`account:<account_id>` keys**: authoritative per-match player records, avoiding name collisions and renames

Policy:

- Named players in chat messages are backfilled by nickname 3 minutes after the file is written
- The full 12-player roster triggers a public API request 6 hours after the match file is written
- Failed requests retry hourly
- Encountering the same account across matches increments `matchCount` instead of duplicating records

Logs and caches are ignored by `.gitignore`.

---

## Building from Source

Requires Reduced CSDK 12 and [VPKEdit CLI](https://github.com/craftablescience/VPKEdit/releases) (place it in `tools/`):

```powershell
powershell -ExecutionPolicy Bypass -File scripts/build.ps1 -Csdk12Root "<CSDK_DIR>"
```

The output is `dist/pak01_dir.vpk`. **Rename it before deploying** (recommended: `pak22_dir.vpk`) so it doesn't collide with existing files in `addons/`, then copy it into Deadlock's `game/citadel/addons/`.

> [!WARNING]
> Don't use the bare name `pak01_dir.vpk`: `pak01` is the game's own pak group and will conflict.

---

## Tests

**BTIPC protocol (offline, no game needed)**

```powershell
node tests\btipc\crc.test.js        # CRC-16/CCITT-FALSE test vectors
node tests\btipc\frame.test.js      # frame round-trip / bit order / BUSY frame / CRC tampering
node tests\btipc\transport.test.js  # REQ validation / round semantics / GC invariant
node tests\btipc\e2e_tail.test.js   # console.log -> tail -> window -> frames
node tests\btipc\route.test.js      # /btipc/dl route wiring (stubbed transport)
node tests\btipc\live_http.test.js  # real listening port + real tail + per-panel status codes -> bit reassembly
```

**Simulator (requires the bridge to be running)**

```powershell
node scripts\lingua_chat_simtest.js   # panel tree + BTIPC bit channel end-to-end (encoded with the real bridge framer)
node scripts\overlay_test.js
node scripts\test_sender_backfill.js
node scripts\test_steamid_roster.js
node scripts\test_bridge_dedup.js
node scripts\test_bridge_fallback.js
```

Bridge health check:

```powershell
curl.exe http://127.0.0.1:8791/api/v1/health
```

---

## Packaging a Release

```powershell
powershell -ExecutionPolicy Bypass -File scripts\package_release.ps1 -Version 2.1.0
```

Produces `dist/DeadlockLingua-2.1.0-win64.zip`, containing the VPK, the bridge, a portable Node runtime, start/stop scripts and docs.

---

## Project Layout

```text
DeadlockLingua/
├── mod/                          Panorama UI source
│   └── panorama/
│       ├── layout/               Layout overrides
│       ├── scripts/              Chat scanning / BTIPC client / bridging (lingua_chat.js)
│       └── styles/               Translation styling
├── core/                         Local Node.js bridge
│   ├── bridge_server.js          HTTP server, /btipc/dl route, config API
│   ├── btipc/                    BTIPC channel (crc16 / framer / window / transport)
│   ├── config.js                 Local config management
│   ├── glossary.js               Game glossary (heroes / items / tactics)
│   ├── hero_names.js             Hero names and abbreviations
│   ├── dictionary.js             Adaptive learning dictionary
│   ├── overlay.js                Overlay data source (tails console.log, legacy)
│   ├── overlay_page.html         Web overlay page (legacy)
│   ├── steamid_enrich.js         SteamID backfill and roster
│   └── providers/                Translation providers (bing/microsoft/openai/deepl/google)
├── tests/btipc/                  BTIPC protocol tests (offline)
├── scripts/
│   ├── overlay_window.ps1        Desktop overlay (native WPF, legacy)
│   ├── build.ps1                 Build
│   ├── package_release.ps1       Release packaging
│   └── *_test.js / *simtest.js   Simulation tests
├── config/                       Config and dictionaries
├── docs/                         Architecture, BTIPC spec, optimization log
├── assets/readme/                README visual assets
├── ShowOverlay.bat               Open the overlay manually (game not required)
├── StartDeadlock.bat             Launch the game with -condebug
├── StartBridgeSilent.vbs         Start the bridge silently
├── StopBridge.bat / RestartBridge.bat
└── LICENSE / LICENSE_NOTICE.md
```

These runtime directories are not tracked by Git:

- `config/config.json` — local secrets
- `logs/` — bridge and chat logs
- `dist/` — build output
- `portable-node/` — local Node runtime
- `tools/` — local packaging tools

---

## How It Works

Three parts: a Panorama mod inside the game, a local Node.js bridge, and (optionally) a desktop overlay. Data flows **both ways**:

<p align="center">
  <img src="./assets/readme/architecture.svg" width="100%" alt="Data flow: the game scans chat rows; the uplink sends a structured single line through console.log to the local bridge; the bridge translates and encodes the result into 16-byte frames; 128 hidden Image panels in the game read them back round by round; the mod appends the translation under the original chat row" />
</p>

**Uplink (game → bridge)**: a structured single line in `console.log`

```text
[LCT] BTIPC REQ w=<window> id=<request> len=<bytes> crc=<checksum> b64=<text>
```

The bridge incrementally tails this file every 0.8 s. This is why `-condebug` is mandatory.

**Downlink (bridge → game)**: the **status code** of `GET /btipc/dl?w=&r=&p=&t=`

128 hidden Image panels ask once per round; `200` = bit 1, `404` = bit 0, and 16 bits form one byte. Each frame carries `seq` / `VALID` / `LEN` plus a CRC-16; advancing the round number `r` is the implicit acknowledgement, and a failed check re-shoots the same round while the bridge idempotently re-serves the same frame.

**Rendering**: the mod appends the translation as a `Label` under the chat row — rendering was never removed; only the data source was missing.

> [!NOTE]
> The overlay (the v2.0.x display path) uses a separate **one-way** channel: the bridge tails `[LCT-CHAT]` and the WPF window polls it. Both paths share the same `console.log` tail and the same translation pipeline.

---

## FAQ

**Q: No translation ever appears in game?**
A: First check that `-condebug` is in the launch options — that's the most common cause. Then confirm the bridge is running (`http://127.0.0.1:8791/api/v1/health` returns JSON), and finally check `logs/bridge.log` for `BTIPC TRQ` / `BTIPC: r=.. seq=.. OK`.

**Q: Translations take several seconds?**
A: That's expected. The bit channel carries about 16 bytes/second, so a 60-byte translation takes roughly 4 seconds. That is the current channel's physical limit, not a hang.

**Q: What happens when translation fails?**
A: A provider failure falls back to the original text (no hang); when the bridge itself is absent it gives up in about 3 seconds and skips, without injecting red error labels into the chat.

**Q: The bridge isn't running / shows "bridge offline"?**
A: Double-click `StartBridgeSilent.vbs`, or check Task Manager for `node.exe`.

**Q: Can I still change settings in game? Typing `/tr` does nothing.**
A: Yes. The in-game `/tr` panel was restored together with the BTIPC channel in v2.1.0 — type `/tr` (or click the "set" button right of the chat input) to open the quick toggles instantly; provider / API key and other one-time settings live on the web settings page `http://127.0.0.1:8791/settings` (the bit channel carries 10 bytes per frame and the full config is ~1.3 KB, so it does not fit).

**Q: I'd rather use the overlay to read translations.**
A: Still possible — the code is there. Switch the view mode in settings; `overlay.mode="web"` falls back to a browser window.

**Q: Translations occasionally slow down or fail?**
A: Raise the translation timeout in settings, or configure backup providers (`fallbackProviders`) for automatic fallback.

---

## Contributing

Issues and pull requests are welcome.

- Before committing, self-check: no `apiKey` / `sk-` keys / SteamIDs / `matchId` / raw chat text / absolute local paths
- `config/config.json`, `logs/`, `dist/`, `*.vpk` and `portable-node/` are ignored — don't force-add them
- Keep `.js` files CRLF-terminated and UTF-8 encoded
- If you change the BTIPC protocol on either side, **update the other side too** (the game side inlines copies of crc16 / bit order / UTF-8 / base64), and run `tests/btipc/*` plus `scripts/lingua_chat_simtest.js`

Roadmap:

- [x] **In-game translation display** (BTIPC two-way channel + Image bit encoding)
- [x] Translate-before-send (rewrite the input box, then use the vanilla send path)
- [x] Desktop overlay (native WPF, kept as a fallback)
- [x] Subtitle layer (click-through + draggable)
- [x] Full glossary (46 heroes / 194 items)
- [x] Passive SteamID backfill
- [ ] Faster bit channel (spec v1.1: precise closure + compact frames, targeting ≤2.5 s for 60 B)

---

## License

- Project code: GNU GPL v3, see [`LICENSE`](LICENSE)
- Third-party notices: see [`LICENSE_NOTICE.md`](LICENSE_NOTICE.md)
- In-game Valve layout assets are used for compatibility only; copyright belongs to Valve
