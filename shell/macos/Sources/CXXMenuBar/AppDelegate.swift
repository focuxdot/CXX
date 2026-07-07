import AppKit
import ServiceManagement

// The menu-bar controller (Model A). A pure view over the cxx-daemon LaunchAgent: it
// polls `backend(["status"])` on each menu open and rebuilds a three-state menu, and
// turns clicks into one-shot backend subcommands. It never spawns or owns the daemon —
// the daemon runs under launchd, so quitting the tray leaves remote running.
// Window builders live in extensions (PairingWindow / DevicesWindow / NotifyWindow).
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)

    // Open windows are retained here (menu-bar apps have no window controller stack).
    var windows: [NSWindow] = []
    var qrPermURL = ""                 // permanent link shown in the current QR window (click-to-copy)
    var notifyPopup: NSPopUpButton?    // notify window controls (set while that window is open)
    var notifyField: NSTextField?

    func applicationDidFinishLaunching(_ notification: Notification) {
        installMainMenu()
        let menu = NSMenu()
        menu.delegate = self
        statusItem.menu = menu
        refreshIcon(status())
    }

    private func installMainMenu() {
        let main = NSMenu()

        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(NSMenuItem(title: L("退出托盘", "Quit"), action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        appItem.submenu = appMenu
        main.addItem(appItem)

        let editItem = NSMenuItem()
        let editMenu = NSMenu(title: L("编辑", "Edit"))
        editMenu.addItem(NSMenuItem(title: L("撤销", "Undo"), action: Selector(("undo:")), keyEquivalent: "z"))
        editMenu.addItem(NSMenuItem(title: L("重做", "Redo"), action: Selector(("redo:")), keyEquivalent: "Z"))
        editMenu.addItem(.separator())
        editMenu.addItem(NSMenuItem(title: L("剪切", "Cut"), action: #selector(NSText.cut(_:)), keyEquivalent: "x"))
        editMenu.addItem(NSMenuItem(title: L("复制", "Copy"), action: #selector(NSText.copy(_:)), keyEquivalent: "c"))
        editMenu.addItem(NSMenuItem(title: L("粘贴", "Paste"), action: #selector(NSText.paste(_:)), keyEquivalent: "v"))
        editMenu.addItem(NSMenuItem(title: L("全选", "Select All"), action: #selector(NSText.selectAll(_:)), keyEquivalent: "a"))
        editItem.submenu = editMenu
        main.addItem(editItem)

        NSApp.mainMenu = main
    }

    // MARK: - Status + icon

    func status() -> [String: Any] { backend(["status"]) }

    private func bundledMenuBarIcon() -> NSImage? {
        let fm = FileManager.default
        let candidates: [URL?] = [
            Bundle.main.url(forResource: "menubar", withExtension: "png"),
            ProcessInfo.processInfo.environment["CXX_MENUBAR_ICON"].map { URL(fileURLWithPath: $0) },
            URL(fileURLWithPath: fm.currentDirectoryPath).appendingPathComponent("web/icons/menubar.png"),
        ]
        for candidate in candidates {
            guard let url = candidate, fm.isReadableFile(atPath: url.path),
                  let image = NSImage(contentsOf: url) else { continue }
            image.isTemplate = false
            image.size = NSSize(width: 24, height: 16)
            return image
        }
        return nil
    }

    func refreshIcon(_ st: [String: Any]) {
        let enabled = st["enabled"] as? Bool ?? false
        let running = st["running"] as? Bool ?? false
        guard let button = statusItem.button else { return }
        if let image = bundledMenuBarIcon() {
            button.image = image
            button.imagePosition = .imageOnly
            button.imageScaling = .scaleProportionallyDown
            button.title = ""
            button.toolTip = !enabled
                ? L("C叉叉远程未开启", "CXX Remote off")
                : (running ? L("C叉叉远程运行中", "CXX Remote on")
                           : L("C叉叉已启用但未运行", "CXX enabled, not running"))
            button.appearsDisabled = false
            return
        }
        // Distinguish states by icon shape (not dimming — a dimmed glyph vanishes on a
        // dark menu bar). Template images auto-adapt to light/dark. Off = slashed
        // antenna, running = solid antenna, error = warning triangle.
        let candidates: [String]
        if !enabled {
            candidates = ["antenna.radiowaves.left.and.right.slash", "antenna.radiowaves.left.and.right"]
        } else if running {
            candidates = ["antenna.radiowaves.left.and.right"]
        } else {
            candidates = ["exclamationmark.triangle"]
        }
        var img: NSImage?
        for name in candidates {
            if let i = NSImage(systemSymbolName: name, accessibilityDescription: L("CXX 远程", "CXX Remote")) { img = i; break }
        }
        if let img = img {
            img.isTemplate = true
            button.image = img
            button.title = ""
        } else {
            button.image = nil
            button.title = enabled ? "📶" : "📴"
        }
        button.appearsDisabled = false
    }

    // MARK: - Menu (rebuilt each open)

    func menuNeedsUpdate(_ menu: NSMenu) {
        let st = status()
        refreshIcon(st)
        menu.removeAllItems()
        let enabled = st["enabled"] as? Bool ?? false
        let running = st["running"] as? Bool ?? false
        let devices = st["deviceCount"] as? Int ?? 0

        let stateText: String
        if !enabled { stateText = L("○ 远程未开启", "○ Remote off") }
        else if running { stateText = L("● 远程运行中", "● Remote on") }
        else { stateText = L("⚠ 已启用但未运行", "⚠ Enabled, not running") }
        let head = NSMenuItem(title: stateText, action: nil, keyEquivalent: "")
        head.isEnabled = false
        menu.addItem(head)
        if enabled {
            menu.addItem(disabled(L("已配对设备：\(devices)", "Devices: \(devices)")))
        }
        menu.addItem(.separator())

        // 「扫码配对」两态都在：未开启时点它即隐式开启远程（见 doPair），配对与启用合并为一步。
        if enabled {
            add(menu, L("扫码配对…", "Pair a device…"), #selector(doPair))
            add(menu, L("已配对设备…", "Devices…"), #selector(doDevices))
            add(menu, L("通知设置…", "Notifications…"), #selector(doNotify))
            menu.addItem(.separator())
            add(menu, L("停用远程", "Disable remote"), #selector(doDisable))
        } else {
            // 未开启态极简：只暴露入口动作，其余（设备/通知/停用）开启后才有意义。
            add(menu, L("扫码配对手机…", "Pair a device…"), #selector(doPair))
        }

        menu.addItem(.separator())
        // 开机自启：standalone CXX 无启动器按需拉起托盘，重启后须靠登录项让菜单图标重现。
        let launch = NSMenuItem(title: L("开机自启", "Launch at login"), action: #selector(toggleLaunchAtLogin), keyEquivalent: "")
        launch.target = self
        launch.state = Self.launchAtLoginEnabled ? .on : .off
        menu.addItem(launch)

        menu.addItem(.separator())
        add(menu, enabled ? L("退出托盘（远程继续运行）", "Quit tray (remote keeps running)") : L("退出托盘", "Quit tray"), #selector(doQuit))
    }

    func add(_ menu: NSMenu, _ title: String, _ sel: Selector) {
        let item = NSMenuItem(title: title, action: sel, keyEquivalent: "")
        item.target = self
        menu.addItem(item)
    }

    private func disabled(_ title: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.isEnabled = false
        return item
    }

    // MARK: - Actions

    // 扫码 = 开启。未启用时先隐式开启远程（装 LaunchAgent + launchctl 拉起 daemon），daemon
    // 在用户扫码的几秒间隙里完成 relay 预热；已启用则直接出码，不重启 daemon（避免打断在连的会话）。
    @objc func doPair() {
        if !(status()["enabled"] as? Bool ?? false) {
            let en = backend(["enable"])
            if let err = en["error"] { alert(L("开启失败", "Enable failed"), "\(err)"); return } // daemon 起不来就别出码
            refreshIcon(status())
        }
        let res = backend(["pair"])
        guard let url = res["url"] as? String else {
            alert(L("配对失败", "Pair failed"), "\(res["error"] ?? L("未知错误", "Unknown error"))"); return
        }
        showQR(url)
    }

    @objc func doDevices() {
        let devices = backend(["devices"])["devices"] as? [[String: Any]] ?? []
        showDevices(devices)
    }

    @objc func doNotify() { showNotify() }

    @objc func doDisable() {
        backend(["disable"])
        refreshIcon(status())
    }

    @objc func doQuit() { NSApp.terminate(nil) }

    @objc func toggleLaunchAtLogin() {
        Self.setLaunchAtLogin(!Self.launchAtLoginEnabled)
    }

    // MARK: - Windows

    @discardableResult
    func makeWindow(_ title: String, _ content: NSView, width: CGFloat, height: CGFloat) -> NSWindow {
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: width, height: height),
                         styleMask: [.titled, .closable], backing: .buffered, defer: false)
        w.title = title
        w.contentView = content
        w.center()
        w.isReleasedWhenClosed = false
        windows.append(w)
        NSApp.activate(ignoringOtherApps: true)
        w.makeKeyAndOrderFront(nil)
        return w
    }

    func alert(_ title: String, _ message: String) {
        let a = NSAlert()
        a.messageText = title
        a.informativeText = message
        a.addButton(withTitle: L("好", "OK"))
        NSApp.activate(ignoringOtherApps: true)
        a.runModal()
    }

    // MARK: - Launch at login (SMAppService, macOS 13+)

    static var launchAtLoginEnabled: Bool {
        SMAppService.mainApp.status == .enabled
    }

    static func setLaunchAtLogin(_ enabled: Bool) {
        do {
            if enabled { try SMAppService.mainApp.register() }
            else { try SMAppService.mainApp.unregister() }
        } catch {
            NSLog("launch-at-login toggle failed: \(error.localizedDescription)")
        }
    }
}
