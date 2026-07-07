import AppKit
import CoreImage
import CoreImage.CIFilterBuiltins
import Foundation

// —— Localization ——
// The UI shows ONE language, chosen by the user's system language — not both at once.
// Chinese if the preferred language is a zh variant, English otherwise. `L(zh, en)`
// picks the string; call it everywhere a user-facing label is built.
let cxxIsChineseUI: Bool = (Locale.preferredLanguages.first ?? "en").hasPrefix("zh")
func L(_ zh: String, _ en: String) -> String { cxxIsChineseUI ? zh : en }

// Per-action backend bridge (Model A). The menu-bar app is a pure view: it shells
// out to `cxx-daemon <subcommand>` for every action (argv subcommand in → single
// JSON object out) and holds no persistent connection. The daemon itself runs as an
// independent LaunchAgent, so quitting the tray does not stop it. Mirrors codex-zh's
// CodexZhRemoteMenu.swift `backend()`.

// Locate the cxx-daemon binary (SEA). Resolution order, cached after first success:
//   1. CXX_DAEMON_BIN env override (dev / testing)
//   2. bundled inside the .app (Contents/Resources/cxx-daemon)
//   3. dev fallback: repo dist/sea/cxx-daemon relative to the built executable
private var cachedDaemonBinary: URL?
func daemonBinaryURL() -> URL? {
    if let cached = cachedDaemonBinary { return cached }
    let fm = FileManager.default

    if let env = ProcessInfo.processInfo.environment["CXX_DAEMON_BIN"] {
        let url = URL(fileURLWithPath: env)
        if fm.isExecutableFile(atPath: url.path) { cachedDaemonBinary = url; return url }
    }
    if let res = Bundle.main.resourceURL?.appendingPathComponent("cxx-daemon"),
       fm.isExecutableFile(atPath: res.path) {
        cachedDaemonBinary = res
        return res
    }
    let exe = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
    let devGuess = exe
        .deletingLastPathComponent()  // .build/debug (or MacOS)
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .appendingPathComponent("dist/sea/cxx-daemon")
    if fm.isExecutableFile(atPath: devGuess.path) { cachedDaemonBinary = devGuess; return devGuess }
    return nil
}

// Run `cxx-daemon <args...>` and parse its single-line JSON stdout. stderr is
// discarded (daemon CLI keeps stdout pure JSON, logs to stderr). Blocking — every
// call is a short-lived process, so keep them off the main run loop where practical.
@discardableResult
func backend(_ args: [String]) -> [String: Any] {
    guard let binary = daemonBinaryURL() else {
        return ["error": L("找不到 cxx-daemon 可执行文件（设置 CXX_DAEMON_BIN 或放入 App 资源目录）",
                            "cxx-daemon executable not found (set CXX_DAEMON_BIN or place it in the app’s Resources)")]
    }
    let process = Process()
    process.executableURL = binary
    process.arguments = args
    let stdout = Pipe()
    process.standardOutput = stdout
    process.standardError = Pipe()
    do { try process.run() } catch {
        return ["error": L("无法启动后端: \(error.localizedDescription)", "Failed to launch backend: \(error.localizedDescription)")]
    }
    let data = stdout.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    return ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any]) ?? [:]
}

// Backend call whose input is a JSON payload passed via a temp file (notify-add).
@discardableResult
func backendWithInput(_ subcommand: String, _ payload: [String: Any]) -> [String: Any] {
    let tmp = NSTemporaryDirectory()
        + "cxx-remote-\(ProcessInfo.processInfo.processIdentifier)-\(UUID().uuidString).json"
    guard let data = try? JSONSerialization.data(withJSONObject: payload) else {
        return ["error": L("序列化失败", "Serialization failed")]
    }
    try? data.write(to: URL(fileURLWithPath: tmp))
    defer { try? FileManager.default.removeItem(atPath: tmp) }
    return backend([subcommand, tmp])
}

// —— Shared UI helpers ——

// Render an error-corrected QR and scale it up crisply.
func makeQRImage(_ text: String, size: CGFloat) -> NSImage? {
    let filter = CIFilter.qrCodeGenerator()
    filter.message = Data(text.utf8)
    filter.correctionLevel = "M"
    guard let output = filter.outputImage else { return nil }
    let scale = size / output.extent.width
    let scaled = output.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
    let context = CIContext()
    guard let cg = context.createCGImage(scaled, from: scaled.extent) else { return nil }
    return NSImage(cgImage: cg, size: NSSize(width: size, height: size))
}

func copyToPasteboard(_ text: String) {
    let pb = NSPasteboard.general
    pb.clearContents()
    pb.setString(text, forType: .string)
}

// epoch ms → local "MM-dd HH:mm"; nil for missing/invalid.
func formatEpochMs(_ ms: Double?) -> String? {
    guard let ms = ms, ms > 0 else { return nil }
    let fmt = DateFormatter()
    fmt.dateFormat = "MM-dd HH:mm"
    return fmt.string(from: Date(timeIntervalSince1970: ms / 1000))
}

// Middle-truncate a long link for display (full string is still copied).
func middleTruncate(_ s: String, _ max: Int) -> String {
    guard s.count > max else { return s }
    let head = max / 2 - 1
    let tail = max - head - 1
    return String(s.prefix(head)) + "…" + String(s.suffix(tail))
}

// Display form: start the shown link at github.io (hide the https://user. prefix) so
// it's recognizable as the open-source GitHub Pages target. Display only — the copied
// value is always the full URL. Non-github.io links fall back to stripping the scheme.
func linkForDisplay(_ url: String) -> String {
    if let r = url.range(of: "github.io") { return String(url[r.lowerBound...]) }
    if let r = url.range(of: "://") { return String(url[r.upperBound...]) }
    return url
}
