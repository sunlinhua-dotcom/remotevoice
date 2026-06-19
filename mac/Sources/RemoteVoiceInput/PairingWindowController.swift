// 「配对 / 设备」窗口：上方大二维码（手机相机扫一扫即配对），下方已配对设备列表（可单独移除）。
// 事件不由本窗口私吞 onEvent，而是由 AppDelegate 收到 .pairCode / .devices 时转发进来（applyPairCode/applyDevices）。

import AppKit

final class PairingWindowController: NSWindowController, NSTableViewDataSource, NSTableViewDelegate {

    private weak var relay: RelayClient?
    private let relayUrl: String
    private var devices: [Device] = []
    private var currentToken: String?

    private let qrView = NSImageView()
    private let table = NSTableView()
    private let scroll = NSScrollView()
    private let hint = NSTextField(labelWithString: "")

    init(relay: RelayClient, relayUrl: String) {
        self.relay = relay
        self.relayUrl = relayUrl
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 460, height: 620),
                         styleMask: [.titled, .closable, .miniaturizable],
                         backing: .buffered, defer: false)
        w.title = "配对 / 设备"
        w.isReleasedWhenClosed = false
        w.center()
        super.init(window: w)
        buildUI()
    }
    required init?(coder: NSCoder) { fatalError() }

    /// 打开并主动拉一次设备列表 + 生成新的扫码令牌。
    func showAndRequest() {
        showWindow(nil)
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        relay?.requestDeviceList()
        relay?.requestNewPairCode()
    }

    // AppDelegate 转发进来：
    func applyPairCode(_ token: String) { currentToken = token; renderQR() }
    func applyDevices(_ list: [Device]) { devices = list; table.reloadData() }

    // MARK: - UI

    private func buildUI() {
        guard let content = window?.contentView else { return }

        let title = NSTextField(labelWithString: "扫码配对")
        title.font = .systemFont(ofSize: 20, weight: .semibold)
        title.translatesAutoresizingMaskIntoConstraints = false

        qrView.translatesAutoresizingMaskIntoConstraints = false
        qrView.imageScaling = .scaleProportionallyUpOrDown
        qrView.wantsLayer = true
        qrView.layer?.backgroundColor = NSColor.white.cgColor
        qrView.layer?.cornerRadius = 12

        hint.stringValue = "用手机相机扫上方二维码，即可把这台 Mac 与手机配对。\n二维码 5 分钟内有效，过期点下方按钮重新生成。"
        hint.font = .systemFont(ofSize: 13)
        hint.textColor = .secondaryLabelColor
        hint.alignment = .center
        hint.maximumNumberOfLines = 0
        hint.lineBreakMode = .byWordWrapping
        hint.translatesAutoresizingMaskIntoConstraints = false

        let regen = NSButton(title: "重新生成二维码", target: self, action: #selector(onRegen))
        regen.bezelStyle = .rounded
        regen.translatesAutoresizingMaskIntoConstraints = false

        let sep = NSBox()
        sep.boxType = .separator
        sep.translatesAutoresizingMaskIntoConstraints = false

        let devTitle = NSTextField(labelWithString: "已配对设备")
        devTitle.font = .systemFont(ofSize: 14, weight: .semibold)
        devTitle.translatesAutoresizingMaskIntoConstraints = false

        configureTable()
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.hasVerticalScroller = true
        scroll.documentView = table
        scroll.borderType = .bezelBorder

        [title, qrView, hint, regen, sep, devTitle, scroll].forEach { content.addSubview($0) }

        NSLayoutConstraint.activate([
            title.topAnchor.constraint(equalTo: content.topAnchor, constant: 20),
            title.centerXAnchor.constraint(equalTo: content.centerXAnchor),
            qrView.topAnchor.constraint(equalTo: title.bottomAnchor, constant: 16),
            qrView.centerXAnchor.constraint(equalTo: content.centerXAnchor),
            qrView.widthAnchor.constraint(equalToConstant: 230),
            qrView.heightAnchor.constraint(equalToConstant: 230),
            hint.topAnchor.constraint(equalTo: qrView.bottomAnchor, constant: 14),
            hint.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 32),
            hint.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -32),
            regen.topAnchor.constraint(equalTo: hint.bottomAnchor, constant: 14),
            regen.centerXAnchor.constraint(equalTo: content.centerXAnchor),
            sep.topAnchor.constraint(equalTo: regen.bottomAnchor, constant: 18),
            sep.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 20),
            sep.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -20),
            devTitle.topAnchor.constraint(equalTo: sep.bottomAnchor, constant: 14),
            devTitle.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 20),
            scroll.topAnchor.constraint(equalTo: devTitle.bottomAnchor, constant: 8),
            scroll.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 20),
            scroll.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -20),
            scroll.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -20),
        ])
    }

    private func configureTable() {
        table.translatesAutoresizingMaskIntoConstraints = false
        table.usesAlternatingRowBackgroundColors = true
        table.rowHeight = 40
        table.dataSource = self
        table.delegate = self
        let name = NSTableColumn(identifier: .init("name")); name.title = "设备"; name.width = 130
        let created = NSTableColumn(identifier: .init("created")); created.title = "配对时间"; created.width = 120
        let seen = NSTableColumn(identifier: .init("seen")); seen.title = "最近使用"; seen.width = 120
        let action = NSTableColumn(identifier: .init("action")); action.title = ""; action.width = 64
        [name, created, seen, action].forEach { table.addTableColumn($0) }
    }

    private func renderQR() {
        guard let token = currentToken else { return }
        let host = RelayClient.httpsHost(fromRelayURL: relayUrl)
        var comps = URLComponents(string: host)
        comps?.path = "/"
        comps?.queryItems = [URLQueryItem(name: "m", value: MacIdentity.current),
                             URLQueryItem(name: "p", value: token)]
        let urlString = comps?.url?.absoluteString ?? "\(host)/?m=\(MacIdentity.current)&p=\(token)"
        qrView.image = QRCode.image(from: urlString, sizePoints: 230)
    }

    @objc private func onRegen() { relay?.requestNewPairCode() }

    @objc private func onRemove(_ sender: NSButton) {
        let row = sender.tag
        guard row >= 0, row < devices.count else { return }
        let device = devices[row]
        let alert = NSAlert()
        alert.messageText = "移除「\(device.name)」？"
        alert.informativeText = "移除后，该设备需重新扫码才能继续使用。"
        alert.alertStyle = .warning
        alert.addButton(withTitle: "移除")
        alert.addButton(withTitle: "取消")
        if alert.runModal() == .alertFirstButtonReturn {
            relay?.revokeDevice(token: device.id)   // 中继回新的 devices
        }
    }

    private static let fmt: DateFormatter = {
        let f = DateFormatter(); f.locale = Locale(identifier: "zh_CN"); f.dateFormat = "MM-dd HH:mm"; return f
    }()
    private func dateStr(_ ms: TimeInterval) -> String {
        guard ms > 0 else { return "—" }
        return Self.fmt.string(from: Date(timeIntervalSince1970: ms / 1000))
    }

    // MARK: - Table

    func numberOfRows(in tableView: NSTableView) -> Int { devices.count }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        guard let col = tableColumn, row < devices.count else { return nil }
        let d = devices[row]
        if col.identifier.rawValue == "action" {
            let id = NSUserInterfaceItemIdentifier("actionCell")
            let button = (tableView.makeView(withIdentifier: id, owner: self) as? NSButton) ?? {
                let b = NSButton(title: "移除", target: self, action: #selector(onRemove(_:)))
                b.identifier = id; b.bezelStyle = .rounded; b.controlSize = .small
                return b
            }()
            button.tag = row
            return button
        }
        let text: String
        switch col.identifier.rawValue {
        case "name": text = d.name
        case "created": text = dateStr(d.createdAt)
        case "seen": text = dateStr(d.lastSeen)
        default: text = ""
        }
        let id = NSUserInterfaceItemIdentifier("text_\(col.identifier.rawValue)")
        let field = (tableView.makeView(withIdentifier: id, owner: self) as? NSTextField) ?? {
            let f = NSTextField(labelWithString: "")
            f.identifier = id; f.lineBreakMode = .byTruncatingTail
            if col.identifier.rawValue != "name" {
                f.font = .monospacedDigitSystemFont(ofSize: 12, weight: .regular)
                f.textColor = .secondaryLabelColor
            }
            return f
        }()
        field.stringValue = text
        return field
    }
}
