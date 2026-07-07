import AppKit

// The paired-devices window. Lists full devices and viewer (read-only) links with
// their status, offers per-device revoke/remove, and a one-click cleanup of links
// that were generated but never connected. Mirrors codex-zh's showDevices.
extension AppDelegate {
    func showDevices(_ devices: [[String: Any]]) {
        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 8
        stack.edgeInsets = NSEdgeInsets(top: 16, left: 16, bottom: 16, right: 16)

        if devices.isEmpty {
            stack.addArrangedSubview(NSTextField(labelWithString: L("暂无已配对设备", "No paired devices")))
        }
        for d in devices {
            let row = NSStackView()
            row.orientation = .horizontal
            row.spacing = 10
            row.alignment = .centerY
            let id = d["deviceId"] as? String ?? "?"
            let isViewer = (d["role"] as? String) == "viewer"
            let name = (d["name"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? L("设备 \(id.prefix(6))", "Device \(id.prefix(6))")

            let title = NSTextField(labelWithString: isViewer ? L("🔗 \(name)（只读）", "🔗 \(name) (read-only)") : name)
            let idTag = "#\(id.prefix(6))"
            let subtitle: String
            if isViewer {
                // 围观链接：时效 + 在线观众数（daemon 落盘的 viewer-status），撤销即全场踢。
                let expiry: String
                if let exp = (d["expiresAt"] as? NSNumber)?.doubleValue, exp > 0 {
                    expiry = exp <= Date().timeIntervalSince1970 * 1000
                        ? L("已过期", "expired") : L("至 \(formatEpochMs(exp) ?? "-")", "until \(formatEpochMs(exp) ?? "-")")
                } else {
                    expiry = L("永久", "permanent")
                }
                let viewers = (d["viewers"] as? NSNumber)?.intValue ?? 0
                let watching = viewers > 0 ? L("\(viewers) 人正在围观", "\(viewers) watching") : L("暂无人围观", "no viewers")
                subtitle = "\(expiry) · \(watching) · \(idTag)"
            } else if let seen = formatEpochMs((d["lastSeenAt"] as? NSNumber)?.doubleValue) {
                subtitle = L("最近连接：\(seen) · \(idTag)", "Last seen: \(seen) · \(idTag)")
            } else if let made = formatEpochMs((d["createdAt"] as? NSNumber)?.doubleValue) {
                subtitle = L("从未连接（配对于 \(made)） · \(idTag)", "Never connected (paired \(made)) · \(idTag)")
            } else {
                subtitle = L("从未连接 · \(idTag)", "Never connected · \(idTag)")
            }
            let sub = NSTextField(labelWithString: subtitle)
            sub.font = .systemFont(ofSize: 11)
            sub.textColor = .secondaryLabelColor
            let col = NSStackView(views: [title, sub])
            col.orientation = .vertical
            col.alignment = .leading
            col.spacing = 2
            col.translatesAutoresizingMaskIntoConstraints = false
            col.widthAnchor.constraint(equalToConstant: 220).isActive = true

            let btn = NSButton(title: isViewer ? L("撤销", "Revoke") : L("移除", "Remove"), target: self, action: #selector(revokeTapped(_:)))
            btn.identifier = NSUserInterfaceItemIdentifier(id)
            row.addArrangedSubview(col)
            row.addArrangedSubview(btn)
            stack.addArrangedSubview(row)
        }

        // 「从未连接」= 生成过但没人扫过的链接（lastSeenAt 空）。给一键清理，作废这些悬空令牌。
        // 围观链接不算在内（分享永久链接长期无人点开是合法状态，后端 prune 也会跳过）。
        let unused = devices.filter {
            (($0["lastSeenAt"] as? NSNumber)?.doubleValue ?? 0) <= 0 && ($0["role"] as? String) != "viewer"
        }.count
        var extra = 0
        if unused > 0 {
            let tip = NSTextField(labelWithString: L("有 \(unused) 条从未连接的链接（生成过但没被扫过）",
                                                     "\(unused) link(s) generated but never connected"))
            tip.font = .systemFont(ofSize: 11)
            tip.textColor = .secondaryLabelColor
            let prune = NSButton(title: L("清理从未连接的链接（\(unused)）", "Clean up unused (\(unused))"), target: self, action: #selector(pruneUnusedTapped))
            prune.bezelStyle = .rounded
            stack.addArrangedSubview(tip)
            stack.addArrangedSubview(prune)
            extra = 56
        }
        let w = makeWindow(L("已配对设备", "Devices"), stack, width: 380, height: max(140, CGFloat(60 + devices.count * 50 + extra)))
        w.identifier = Self.devicesWindowID
    }

    @objc func revokeTapped(_ sender: NSButton) {
        guard let id = sender.identifier?.rawValue else { return }
        backend(["revoke", id])
        closeDevicesWindows()
        showDevices(backend(["devices"])["devices"] as? [[String: Any]] ?? [])
    }

    @objc func pruneUnusedTapped() {
        let a = NSAlert()
        a.messageText = L("清理从未连接的链接", "Clean up unused links")
        a.informativeText = L(
            "将移除所有「生成过但从未连接」的链接，作废这些悬空凭据——曾外泄或转发出去、但没被使用的链接会随即失效。不影响任何已连接过的设备。",
            "Removes every link that was generated but never connected, voiding those dangling credentials — any link that leaked or was forwarded but never used stops working. Devices that have connected are unaffected.")
        a.addButton(withTitle: L("清理", "Clean up"))
        a.addButton(withTitle: L("取消", "Cancel"))
        NSApp.activate(ignoringOtherApps: true)
        guard a.runModal() == .alertFirstButtonReturn else { return }
        let res = backend(["prune-unused"])
        let removed = res["removed"] as? Int ?? 0
        closeDevicesWindows()
        showDevices(backend(["devices"])["devices"] as? [[String: Any]] ?? [])
        alert(L("已清理", "Cleaned up"), L("已作废 \(removed) 条从未使用的链接。", "Voided \(removed) unused link(s)."))
    }

    // Match the devices window by a stable identifier (not localized title, which varies by language).
    static let devicesWindowID = NSUserInterfaceItemIdentifier("cxx.devices")
    func closeDevicesWindows() {
        for w in windows where w.identifier == Self.devicesWindowID { w.close() }
    }
}
