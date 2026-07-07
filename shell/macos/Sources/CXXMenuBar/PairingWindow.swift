import AppKit

// The pairing (QR) window. Shows a permanent device link as a scannable QR + a
// click-to-copy button, plus a one-time invite link for temporary sharing. Mirrors
// codex-zh's showQR. All colors use system semantic colors so it follows light/dark.
extension AppDelegate {
    func showQR(_ url: String) {
        qrPermURL = url
        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 16
        stack.edgeInsets = NSEdgeInsets(top: 26, left: 28, bottom: 26, right: 28)

        let title = NSTextField(labelWithString: L("微信扫码 · 配对C叉叉", "Pair with WeChat"))
        title.font = .boldSystemFont(ofSize: 20)

        // 诚实披露：点「扫码配对」已隐式开启远程，让「远程现在是开着的」这件事对用户可见。
        let statusLabel = NSTextField(labelWithString: L("● 远程已开启", "● Remote is on"))
        statusLabel.textColor = .secondaryLabelColor
        statusLabel.font = .systemFont(ofSize: 13)

        // 二维码垫一张恒定白底卡片（带留白/圆角）：CIQRCodeGenerator 出的是黑码透明底，
        // 暗色窗口下会「黑底黑码」扫不出；白卡保证明暗两种模式下都清晰可扫。
        let qrSize: CGFloat = 288
        let qrPad: CGFloat = 16
        let qrCard = NSView()
        qrCard.wantsLayer = true
        qrCard.layer?.backgroundColor = NSColor.white.cgColor
        qrCard.layer?.cornerRadius = 14
        qrCard.translatesAutoresizingMaskIntoConstraints = false
        qrCard.widthAnchor.constraint(equalToConstant: qrSize + qrPad * 2).isActive = true
        qrCard.heightAnchor.constraint(equalToConstant: qrSize + qrPad * 2).isActive = true
        let imgView = NSImageView()
        imgView.image = makeQRImage(url, size: qrSize)
        imgView.translatesAutoresizingMaskIntoConstraints = false
        qrCard.addSubview(imgView)
        imgView.centerXAnchor.constraint(equalTo: qrCard.centerXAnchor).isActive = true
        imgView.centerYAnchor.constraint(equalTo: qrCard.centerYAnchor).isActive = true
        imgView.widthAnchor.constraint(equalToConstant: qrSize).isActive = true
        imgView.heightAnchor.constraint(equalToConstant: qrSize).isActive = true

        let note = NSTextField(labelWithString: L("扫码链接长期有效，请勿轻易转发", "This link stays valid — don’t forward it casually"))
        note.textColor = .secondaryLabelColor
        note.alignment = .center
        note.font = .systemFont(ofSize: 13)
        note.maximumNumberOfLines = 2
        note.translatesAutoresizingMaskIntoConstraints = false
        note.widthAnchor.constraint(equalToConstant: 340).isActive = true

        // 永久链接：整块可点、点击即复制完整 url（展示时中部截断）。
        let copyBtn = NSButton(title: middleTruncate(linkForDisplay(url), 46), target: self, action: #selector(copyPermLink(_:)))
        copyBtn.bezelStyle = .rounded
        copyBtn.font = .systemFont(ofSize: 15, weight: .medium)
        copyBtn.toolTip = L("点击复制永久链接", "Click to copy the permanent link")
        copyBtn.translatesAutoresizingMaskIntoConstraints = false
        copyBtn.widthAnchor.constraint(equalToConstant: 340).isActive = true

        let hint = NSTextField(labelWithString: L("↑ 点击链接即可复制到剪贴板", "↑ Click the link to copy it"))
        hint.textColor = .tertiaryLabelColor
        hint.font = .systemFont(ofSize: 12)

        // 一次性链接：临时发出去用，5 分钟内有效、仅一次。
        let onceBtn = NSButton(title: Self.onceLinkTitle, target: self, action: #selector(copyOnceLink(_:)))
        onceBtn.bezelStyle = .rounded
        onceBtn.font = .systemFont(ofSize: 13)

        stack.addArrangedSubview(title)
        stack.addArrangedSubview(statusLabel)
        stack.setCustomSpacing(10, after: title)
        stack.addArrangedSubview(qrCard)
        stack.addArrangedSubview(note)
        stack.addArrangedSubview(copyBtn)
        stack.addArrangedSubview(hint)
        stack.setCustomSpacing(22, after: hint)
        stack.addArrangedSubview(onceBtn)
        makeWindow(L("微信扫码 · 配对C叉叉", "Pair a device"), stack, width: 400, height: 560)
    }

    // One-time-invite button title (also the flash-restore target, so keep it a single source).
    static var onceLinkTitle: String { L("复制邀请链接（一次性 · 5 分钟）", "Copy one-time invite (5 min)") }

    @objc func copyPermLink(_ sender: NSButton) {
        copyToPasteboard(qrPermURL)
        flashCopied(sender, restore: middleTruncate(linkForDisplay(qrPermURL), 46))
    }

    @objc func copyOnceLink(_ sender: NSButton) {
        let res = backend(["pair-once"])
        guard let url = res["url"] as? String else {
            alert(L("生成失败", "Failed"), "\(res["error"] ?? L("未知错误", "Unknown error"))"); return
        }
        copyToPasteboard(url)
        flashCopied(sender, restore: Self.onceLinkTitle)
    }

    // 复制后短暂把按钮标题变为「已复制 ✓」再复原。
    func flashCopied(_ button: NSButton, restore: String) {
        button.title = L("已复制 ✓", "Copied ✓")
        button.isEnabled = false
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
            button.title = restore
            button.isEnabled = true
        }
    }
}
