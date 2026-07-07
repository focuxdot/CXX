# CXX macOS menu-bar shell

A thin AppKit menu-bar app (`NSStatusItem`, no dock icon). It is a **pure view**: the
daemon runs as an independent LaunchAgent, and the shell shells out to
`cxx-daemon <subcommand>` for every action (argv subcommand in → single JSON object
out), polling `status` each time the menu opens. Quitting the tray does **not** stop
the daemon — launchd owns its lifecycle.

## Build

The shell is built with `swiftc` directly (not SwiftPM). `Package.swift` is kept for
full-Xcode users, but the standalone Command Line Tools ship a broken SwiftPM ManifestAPI,
so the packaging script and the command below invoke `swiftc`.

```bash
# from the repo root: build the whole .app (daemon SEA + shell), ad-hoc signed
npm run build:app

# add a DMG
node scripts/build-app.mjs --dmg

# distributable build (signed + notarizable)
CODESIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)" node scripts/build-app.mjs --dmg
```

## Run in development

Point the shell at a locally-built daemon and run the executable directly:

```bash
npm run build:sea                      # build dist/sea/cxx-daemon
CXX_DAEMON_BIN="$PWD/dist/sea/cxx-daemon" \
  swiftc -O shell/macos/Sources/CXXMenuBar/*.swift -o /tmp/cxx-menubar \
  -framework AppKit -framework CoreImage -framework ServiceManagement \
  -target arm64-apple-macosx13.0
CXX_DAEMON_BIN="$PWD/dist/sea/cxx-daemon" /tmp/cxx-menubar
```

`CXX_DAEMON_BIN` overrides daemon discovery (otherwise the shell looks in the app bundle's
`Contents/Resources/cxx-daemon`, then a repo-relative dev fallback).

## Backend commands

The shell → daemon interface is a set of one-shot subcommands (`Sources/CXXMenuBar/Backend.swift`
→ `backend([...])`), implemented on the daemon side in `daemon/src/menu-backend.mjs`
(pure config verbs) and `daemon/src/mac-agent.mjs` (launchd lifecycle), dispatched from
`daemon/src/main.mjs`. Each prints a single JSON line to stdout.

| Subcommand | Result |
| --- | --- |
| `status` | `{ enabled, running, deviceCount, notifierCount, relay }` |
| `enable` / `disable` | install / remove the `ai.wokey.cxx.remote` LaunchAgent |
| `pair` | `{ url }` — permanent `#d=` device link |
| `pair-once` | `{ url }` — one-time `#p=` link (5-min TTL) |
| `devices` | `{ devices:[…] }` (viewer links include online counts) |
| `revoke <id>` / `prune-unused` | edit the device list (daemon hot-reloads via config-watch) |
| `notify-list` / `notify-add <file>` / `notify-remove <i>` / `notify-test` | notifier CRUD + test |

The daemon and shell communicate only through the config JSON on disk (device/notifier
edits) and `launchctl` (lifecycle) — there is no persistent socket/IPC.

## Localization

The UI shows **one** language chosen by the system language, not both at once. `Backend.swift`
defines `cxxIsChineseUI` (true when `Locale.preferredLanguages.first` is a `zh` variant) and a
helper `L(zh, en)`; every user-facing label is built through `L(...)`. Chinese is shown on a
Chinese system, English otherwise. The language is read once at launch — after changing the
system language, quit and reopen the tray to pick it up. Windows are matched for close/refresh
by a stable `NSUserInterfaceItemIdentifier` (`cxx.devices` / `cxx.notify`), not by their
localized titles.
