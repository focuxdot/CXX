import AppKit

// The notification-channels window. Add/remove webhook channels (Bark / Server酱 /
// WeCom / DingTalk / custom) and send a test push. Channel edits are written to the
// config; the running daemon hot-reloads them (see main.mjs onConfig). Mirrors
// codex-zh's showNotify.
extension AppDelegate {
    func showNotify() {
        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 10
        stack.edgeInsets = NSEdgeInsets(top: 16, left: 16, bottom: 16, right: 16)

        let popup = NSPopUpButton(frame: .zero, pullsDown: false)
        // Order must stay aligned with the `types` array in notifyAddTapped (index → type).
        popup.addItems(withTitles: ["Bark", L("Server酱", "ServerChan"), L("企业微信", "WeCom"), L("钉钉", "DingTalk"), L("自定义", "Custom")])
        let field = NSTextField()
        field.placeholderString = L("Bark/Server酱 填 Key；其余填 Webhook URL", "Bark/ServerChan: key; others: webhook URL")
        field.translatesAutoresizingMaskIntoConstraints = false
        field.widthAnchor.constraint(equalToConstant: 340).isActive = true
        notifyPopup = popup
        notifyField = field

        let addBtn = NSButton(title: L("添加", "Add"), target: self, action: #selector(notifyAddTapped))
        let testBtn = NSButton(title: L("发送测试", "Test"), target: self, action: #selector(notifyTestTapped))
        let btnRow = NSStackView(views: [addBtn, testBtn])
        btnRow.spacing = 10

        stack.addArrangedSubview(NSTextField(labelWithString: L("添加通知渠道", "Add a channel")))
        stack.addArrangedSubview(popup)
        stack.addArrangedSubview(field)
        stack.addArrangedSubview(btnRow)
        stack.addArrangedSubview(NSTextField(labelWithString: L("已配置", "Configured:")))
        let list = backend(["notify-list"])["notifiers"] as? [[String: Any]] ?? []
        for n in list {
            let label = n["label"] as? String ?? ""
            let idx = n["index"] as? Int ?? 0
            let row = NSStackView()
            row.spacing = 10
            let l = NSTextField(labelWithString: label)
            l.translatesAutoresizingMaskIntoConstraints = false
            l.widthAnchor.constraint(equalToConstant: 160).isActive = true
            // Per-channel test button (left of Remove) — pushes a test through THIS saved channel.
            let test = NSButton(title: L("测试", "Test"), target: self, action: #selector(notifyTestRowTapped(_:)))
            test.identifier = NSUserInterfaceItemIdentifier(String(idx))
            let rm = NSButton(title: L("删除", "Remove"), target: self, action: #selector(notifyRemoveTapped(_:)))
            rm.identifier = NSUserInterfaceItemIdentifier(String(idx))
            row.addArrangedSubview(l)
            row.addArrangedSubview(test)
            row.addArrangedSubview(rm)
            stack.addArrangedSubview(row)
        }
        let w = makeWindow(L("通知设置", "Notifications"), stack, width: 400, height: max(240, CGFloat(220 + list.count * 34)))
        w.identifier = Self.notifyWindowID
    }

    // Build a notifier payload from the current popup + field selection, or nil if the
    // field is empty. Shared by Add and Test so both read the same type→field mapping.
    private func currentNotifyPayload() -> [String: Any]? {
        guard let popup = notifyPopup, let field = notifyField else { return nil }
        let value = field.stringValue.trimmingCharacters(in: .whitespaces)
        if value.isEmpty { return nil }
        let types = ["bark", "serverchan", "wecom", "dingtalk", "custom"]
        let type = types[popup.indexOfSelectedItem]
        var payload: [String: Any] = ["type": type]
        if type == "bark" || type == "serverchan" { payload["key"] = value } else { payload["url"] = value }
        return payload
    }

    @objc func notifyAddTapped() {
        guard let payload = currentNotifyPayload() else {
            alert(L("请填写", "Missing"), L("请填入 Key 或 Webhook URL", "Enter a key or webhook URL")); return
        }
        backendWithInput("notify-add", payload)
        closeNotifyWindows()
        showNotify()
    }

    // The top "发送测试" button tests ONLY the key/URL currently in the input box — a
    // pre-add dry run. To test a saved channel, use the per-row 测试 button instead.
    @objc func notifyTestTapped() {
        guard let payload = currentNotifyPayload() else {
            alert(L("请填写", "Missing"), L("请先填入 Key 或 Webhook URL 再测试。", "Enter a key or webhook URL first.")); return
        }
        let count = backendWithInput("notify-test", payload)["count"] as? Int ?? 0
        if count == 0 {
            alert(L("未发送", "Not sent"), L("未能发送，请检查所选类型与填写的 Key/URL。", "Nothing sent — check the type and key/URL."))
            return
        }
        alert(L("已发送", "Sent"), L("已向当前填写的渠道发送测试通知，请检查手机。", "Sent a test to the entered channel — check your phone."))
    }

    // Per-row test: push a test through the already-saved channel at this index.
    @objc func notifyTestRowTapped(_ sender: NSButton) {
        guard let idx = sender.identifier?.rawValue else { return }
        let count = backend(["notify-test-index", idx])["count"] as? Int ?? 0
        if count == 0 {
            alert(L("未发送", "Not sent"), L("发送失败，请检查该渠道配置。", "Send failed — check this channel."))
            return
        }
        alert(L("已发送", "Sent"), L("已向该渠道发送测试通知，请检查手机。", "Sent a test to this channel — check your phone."))
    }

    @objc func notifyRemoveTapped(_ sender: NSButton) {
        guard let idx = sender.identifier?.rawValue else { return }
        backend(["notify-remove", idx])
        closeNotifyWindows()
        showNotify()
    }

    // Match the notify window by a stable identifier (not localized title).
    static let notifyWindowID = NSUserInterfaceItemIdentifier("cxx.notify")
    func closeNotifyWindows() {
        for w in windows where w.identifier == Self.notifyWindowID { w.close() }
    }
}
