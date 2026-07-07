import AppKit
import Darwin

// Single-instance guard: a login item plus a manual launch could otherwise put two
// icons in the menu bar. flock a lockfile; a second instance fails the non-blocking
// lock and exits. The fd is intentionally never closed — the lock is held for the
// process lifetime and released only on exit.
let lockDir = NSHomeDirectory() + "/.cxx/remote"
try? FileManager.default.createDirectory(atPath: lockDir, withIntermediateDirectories: true)
let lockFd = open(lockDir + "/menu.lock", O_CREAT | O_RDWR, 0o644)
if lockFd < 0 || flock(lockFd, LOCK_EX | LOCK_NB) != 0 {
    exit(0) // another instance is already running
}

// Menu-bar-only app: no dock icon, no main window (.accessory activation policy).
let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
