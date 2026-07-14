import AppKit

// Terminal Mode settings window (internal/TERMINAL-MODE.md §4.8 / §13.1).
// One screen for both decisions: the global switch and per-device authorization —
// flipping the switch on and ticking devices is a single flow. Below them, the
// live terminals list gives the computer-side visibility + kill switch that the
// authorization copy promises ("该设备可以执行任意命令" must be matched by the
// computer always being able to see and end what phones started).
extension AppDelegate {
    static let terminalWindowID = NSUserInterfaceItemIdentifier("cxx.terminal")

    func showTerminalSettings() {
        let st = backend(["terminal-status"])
        let enabled = st["enabled"] as? Bool ?? false
        let hostAvailable = st["hostAvailable"] as? Bool ?? false
        let devices = st["devices"] as? [[String: Any]] ?? []
        let terminals = (st["terminals"] as? [[String: Any]] ?? []).filter { ($0["alive"] as? Bool) == true }

        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 10
        stack.edgeInsets = NSEdgeInsets(top: 16, left: 16, bottom: 16, right: 16)

        if !hostAvailable {
            let warn = NSTextField(wrappingLabelWithString: L(
                "未找到终端组件（cxx-pty-host）。请重新安装 CXX 或更新到包含终端模式的版本。",
                "Terminal component (cxx-pty-host) not found. Reinstall CXX or update to a build that includes Terminal Mode."))
            warn.textColor = .secondaryLabelColor
            stack.addArrangedSubview(warn)
        }

        // —— 全局开关 ——
        let toggle = NSButton(checkboxWithTitle: L("允许已授权设备使用终端模式", "Allow authorized devices to use Terminal Mode"),
                              target: self, action: #selector(terminalEnableTapped(_:)))
        toggle.state = enabled ? .on : .off
        toggle.isEnabled = hostAvailable
        stack.addArrangedSubview(toggle)

        let caution = NSTextField(wrappingLabelWithString: L(
            "被授权的设备可以使用你当前的电脑账户执行任意命令。仅为你自己的设备开启。",
            "An authorized device can run arbitrary commands as your current computer account. Enable only for your own devices."))
        caution.font = .systemFont(ofSize: 11)
        caution.textColor = .secondaryLabelColor
        caution.translatesAutoresizingMaskIntoConstraints = false
        caution.widthAnchor.constraint(lessThanOrEqualToConstant: 400).isActive = true
        stack.addArrangedSubview(caution)

        // —— 逐设备授权（与开关同屏，§13.1）——
        stack.addArrangedSubview(sectionLabel(L("设备授权", "Device authorization")))
        if devices.isEmpty {
            stack.addArrangedSubview(dimLabel(L("暂无已配对设备（先在菜单「扫码配对」）",
                                                "No paired devices yet (use “Pair a device” first)")))
        }
        for d in devices {
            let id = d["deviceId"] as? String ?? "?"
            let name = (d["name"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? L("设备 \(id.prefix(6))", "Device \(id.prefix(6))")
            let cb = NSButton(checkboxWithTitle: name, target: self, action: #selector(terminalAccessTapped(_:)))
            cb.identifier = NSUserInterfaceItemIdentifier(id)
            cb.state = (d["terminalAccess"] as? Bool ?? false) ? .on : .off
            cb.isEnabled = enabled && hostAvailable
            stack.addArrangedSubview(cb)
        }

        // —— 运行中终端（§4.8：可见性 + 电脑侧结束）——
        stack.addArrangedSubview(sectionLabel(L("运行中的窗口（\(terminals.count)）", "Running windows (\(terminals.count))")))
        if terminals.isEmpty {
            stack.addArrangedSubview(dimLabel(L("没有正在运行的窗口", "No windows running")))
        }
        for t in terminals {
            let row = NSStackView()
            row.orientation = .horizontal
            row.spacing = 10
            row.alignment = .centerY
            let title = NSTextField(labelWithString: t["title"] as? String ?? "?")
            let sub = NSTextField(labelWithString: t["cwd"] as? String ?? "")
            sub.font = .systemFont(ofSize: 11)
            sub.textColor = .secondaryLabelColor
            sub.lineBreakMode = .byTruncatingMiddle
            let col = NSStackView(views: [title, sub])
            col.orientation = .vertical
            col.alignment = .leading
            col.spacing = 2
            col.translatesAutoresizingMaskIntoConstraints = false
            col.widthAnchor.constraint(equalToConstant: 280).isActive = true
            let end = NSButton(title: L("结束", "End"), target: self, action: #selector(terminalCloseTapped(_:)))
            end.identifier = NSUserInterfaceItemIdentifier(t["terminalId"] as? String ?? "")
            row.addArrangedSubview(col)
            row.addArrangedSubview(end)
            stack.addArrangedSubview(row)
        }

        let height = CGFloat(200 + devices.count * 26 + terminals.count * 50)
        let w = makeWindow(L("终端模式", "Terminal Mode"), stack, width: 430, height: min(560, max(240, height)))
        w.identifier = Self.terminalWindowID
    }

    private func sectionLabel(_ text: String) -> NSTextField {
        let l = NSTextField(labelWithString: text)
        l.font = .boldSystemFont(ofSize: 12)
        return l
    }

    private func dimLabel(_ text: String) -> NSTextField {
        let l = NSTextField(labelWithString: text)
        l.font = .systemFont(ofSize: 11)
        l.textColor = .secondaryLabelColor
        return l
    }

    private func reopenTerminalSettings() {
        for w in windows where w.identifier == Self.terminalWindowID { w.close() }
        showTerminalSettings()
    }

    @objc func terminalEnableTapped(_ sender: NSButton) {
        backend(["terminal-enable", sender.state == .on ? "1" : "0"])
        reopenTerminalSettings() // 设备勾选的可用态随开关变化，重建最直接
    }

    @objc func terminalAccessTapped(_ sender: NSButton) {
        guard let id = sender.identifier?.rawValue else { return }
        // deviceId 是 base64url 随机串，可能以 "-" 开头（约 1/32）；不加 "--" 的话
        // cxx-daemon 的参数解析会把它当未知选项拒掉，授权静默落空、重开弹窗回弹。
        backend(["terminal-access", "--", id, sender.state == .on ? "1" : "0"])
    }

    @objc func terminalCloseTapped(_ sender: NSButton) {
        guard let id = sender.identifier?.rawValue, !id.isEmpty else { return }
        let a = NSAlert()
        a.messageText = L("结束这个窗口？", "End this window?")
        a.informativeText = L("其中运行的程序会被终止（先尝试正常退出，随后强制结束）。",
                              "The program running inside will be terminated (graceful first, then forced).")
        a.addButton(withTitle: L("结束", "End"))
        a.addButton(withTitle: L("取消", "Cancel"))
        NSApp.activate(ignoringOtherApps: true)
        guard a.runModal() == .alertFirstButtonReturn else { return }
        DispatchQueue.global(qos: .userInitiated).async {
            backend(["terminal-close", "--", id]) // terminalId 以 "t" 开头本安全，"--" 防御性一致
            DispatchQueue.main.async { self.reopenTerminalSettings() }
        }
    }
}
