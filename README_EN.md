# DeadlockLingua

[简体中文](README.md) | **English**

> Real-time in-game chat translation mod for Deadlock, forked from [BabelTower](https://github.com/c1375rick/BabelTower) and further maintained and optimized by [Thirt927](https://github.com/Thirt927).

Translates foreign-language messages in Deadlock chat into your language in real time, with the translation shown directly under the original message. You can also translate your own outgoing messages into the target language before sending them.

## Features

- Multiple translation providers: Bing (no key required), Microsoft, OpenAI-compatible, DeepL, Google Cloud
- Automatic fallback to a configured backup provider when the primary one fails
- Pre-send translation: your language (e.g. Chinese) -> target language (e.g. English)
- Chat logs: written as JSONL per match ID for post-match review
- SteamID backfill: chat nicknames are automatically enriched with SteamID64
- Per-match player cache: fetches the 12-player roster 6 hours after a match and deduplicates by `account_id`
- Runs in the background: the bridge can start without a console window and keeps running after the terminal is closed

## Installation

Download the latest release:

```text
https://github.com/Thirt927/DeadlockLingua/releases/latest
```

1. Extract `DeadlockLingua-<version>-win64.zip` to a path without spaces, for example `D:\DeadlockLingua`.
2. Install `pak01_dir.vpk` into the Deadlock addons folder:
   - Recommended: import it with Deadlock Mod Manager.
   - Or copy it manually to `<Steam library>\steamapps\common\Deadlock\game\citadel\addons\`.
3. Double-click `install-autostart.bat` to enable launch at startup, or double-click `StartBridgeSilent.vbs` to start the bridge in the background for this session.
4. Restart Deadlock, press `Enter` in a match to open chat, then type `/tr` to open the settings panel.

Building from source:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/build.ps1 -Csdk12Root "<CSDK_DIR>"
```

## Usage

### Starting the bridge

Background start (recommended):

```bat
StartBridgeSilent.vbs
```

Or from a terminal:

```bat
StartDeadlock.bat
```

Stopping the bridge:

```bat
StopBridge.bat
```

### Settings

Type `/tr` in game to open the settings panel. On first run `config/config.json` is generated; you can also copy `config/config.example.json` and edit it manually.

`config/config.json` holds your API keys. It is ignored through `.gitignore`, so never commit it to Git.

> Note: the in-game settings panel labels are currently Chinese only. The mod itself works with any target language.

## Update Notes

### v1.0.0

- Renamed the project to `DeadlockLingua`; public repository: `https://github.com/Thirt927/DeadlockLingua`
- Removed GameBanana-only release content and scripts, plus the `puppeteer` dependency
- Built-in background bridge start, automatic retry, SteamID backfill, and per-match roster deduplication
- Fixed autostart being impossible to re-enable after Windows Task Manager or Lenovo Vantage disabled it

How to update:

1. Back up your existing `config/config.json`, then download and extract the new release.
2. Remove the old VPK and import the new `pak01_dir.vpk`.
3. Copy the backed-up `config/config.json` into the new directory.
4. Double-click `StopBridge.bat` to stop the old bridge, then `StartBridgeSilent.vbs` to start the new one.
5. Fully restart Deadlock, join a match, and verify saving with `/tr`.

See `CHANGELOG.md` for the detailed change history.

## Chat Logs and SteamID

Chat logs are written to:

```text
logs/chat/<matchId>.jsonl
```

Identity cache:

```text
logs/chat/identity_cache.json
```

The cache contains two kinds of keys:

- Nickname keys: used to backfill SteamID for chat messages
- `account:<account_id>` keys: authoritative per-match player records, avoiding collisions from duplicate or changed names

SteamID handling:

- Named players in chat messages are backfilled by nickname 3 minutes after the file is written.
- The full 12-player roster is requested from the public API 6 hours after the match file is written.
- If the first roster request fails, it retries automatically once per hour.
- When the same account appears across matches, `matchCount` increments without creating duplicate cache entries.

## Build

Requires Reduced CSDK 12 and the VPKEdit CLI:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/build.ps1 -Csdk12Root "<CSDK_DIR>"
```

After building, rename the VPK according to the project deployment convention, then copy it into the Deadlock addons folder.

## Tests

```powershell
node scripts/lingua_chat_simtest.js
node scripts/test_sender_backfill.js
node scripts/test_steamid_roster.js
node scripts/test_bridge_dedup.js
node scripts/test_bridge_fallback.js
```

Bridge health check:

```powershell
curl.exe http://127.0.0.1:8791/api/v1/health
```

## Packaging a Release

```powershell
powershell -ExecutionPolicy Bypass -File scripts/package_release.ps1 -Version 1.0.0
```

The release package contains the bridge, bundled Node runtime, start/stop scripts, and documentation.

## Project Layout

```text
DeadlockLingua/
├── mod/                          Panorama UI source
│   ├── panorama/layout/          Layout overrides
│   ├── panorama/scripts/         Chat scanning and bridge logic
│   └── panorama/styles/          Translation and settings panel styles
├── core/                         Local Node.js bridge
│   ├── bridge_server.js          HTTP server and hidden panel page
│   ├── config.js                 Local config management
│   ├── dictionary.js             Adaptive learning dictionary
│   ├── glossary.js               Game glossary
│   ├── hero_names.js             Hero name translations
│   ├── steamid_enrich.js         SteamID backfill and per-match roster
│   └── providers/                Translation providers
├── config/                       Config and dictionaries
├── scripts/                      Build, packaging, and test scripts
├── docs/                         Architecture, optimization log, references
├── StartBridgeSilent.vbs         Windowless background start
├── StartDeadlock.bat             Terminal / launch with the game
├── StopBridge.bat                Stop the bridge
├── RestartBridge.bat             Restart the bridge
└── LICENSE / LICENSE_NOTICE.md
```

Runtime directories are not tracked by Git:

- `config/config.json`: local secrets
- `logs/`: bridge and chat logs
- `dist/`: build output
- `portable-node/`: local Node runtime
- `tools/`: local packaging tools

## License

- Project code: GNU GPL v3, see `LICENSE`
- Third-party notices: `LICENSE_NOTICE.md`
- In-game Valve layout assets are used for compatibility only; copyright belongs to Valve
