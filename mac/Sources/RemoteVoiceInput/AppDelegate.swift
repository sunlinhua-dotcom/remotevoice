import AppKit
import ApplicationServices
import Combine

final class AppDelegate: NSObject, NSApplicationDelegate {

    private var statusItem: NSStatusItem!
    private let menu = NSMenu()

    // 菜单项
    private let connItem = NSMenuItem(title: "状态：未连接", action: nil, keyEquivalent: "")
    private let peerItem = NSMenuItem(title: "对端：等待手机", action: nil, keyEquivalent: "")
    private let pairingItem = NSMenuItem(title: "配对 / 设备…", action: #selector(openPairing), keyEquivalent: "")
    private let devicesItem = NSMenuItem(title: "已配对设备：0", action: nil, keyEquivalent: "")
    private let resetItem = NSMenuItem(title: "重置配对（换新二维码）…", action: #selector(resetPairing), keyEquivalent: "")
    private let lastTextItem = NSMenuItem(title: "最近：——", action: nil, keyEquivalent: "")
    private let llmItem = NSMenuItem(title: "标点纠错：开", action: #selector(toggleLlm), keyEquivalent: "")
    private let relayItem = NSMenuItem(title: "服务器：——", action: #selector(editRelay), keyEquivalent: "")
    private let rescanItem = NSMenuItem(title: "重新连接", action: #selector(reconnect), keyEquivalent: "r")
    private let quitItem = NSMenuItem(title: "退出", action: #selector(quit), keyEquivalent: "q")

    private let client = RelayClient()
    private let injector = TextInjector()
    private var llmOn = true
    private var pairingWC: PairingWindowController?
    private var pulsing = false

    private let defaults = UserDefaults.standard
    private var relayUrl: String {
        get { RelayClient.resolveRelayURL(defaults.string(forKey: "relayUrl")) }
        set { defaults.set(newValue, forKey: "relayUrl") }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.imagePosition = .imageOnly
        statusItem.button?.toolTip = "RemoteVoice"
        updateIcon(.disconnected)

        buildMenu()
        statusItem.menu = menu
        relayItem.title = "服务器：\(relayUrl)"

        client.macId = MacIdentity.current      // 启用「扫码 + 记住设备」新流程
        client.onState = { [weak self] in self?.handleState($0) }
        client.onEvent = { [weak self] in self?.handleEvent($0) }

        // 启动即请求辅助功能权限（CGEvent 注入需要），并把本 App 注册进列表。
        if !AXIsProcessTrusted() {
            let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
            _ = AXIsProcessTrustedWithOptions(opts)
        }

        client.connect(to: relayUrl)

        // 启动即弹出「配对 / 设备」窗口，用户一眼能看到二维码/数字码（也便于在 Dock 找到本 App）。
        openPairing()
    }

    func applicationWillTerminate(_ notification: Notification) {
        DictationHUD.shared.teardown()
    }

    /// 点 Dock 图标（无可见窗口时）→ 重新打开配对窗口。
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { openPairing() }
        return true
    }

    private func buildMenu() {
        let sep = { NSMenuItem.separator() }
        for item in [connItem, peerItem, sep(),
                     pairingItem, devicesItem, resetItem, sep(),
                     lastTextItem, sep(),
                     llmItem, relayItem, rescanItem, sep(),
                     quitItem] {
            menu.addItem(item)
        }
        menu.items.forEach { $0.target = self }
    }

    // ---------- 状态栏图标（单色模板图，跟随明暗自动反色） ----------
    enum IconState { case disconnected, standby, recording }

    private func statusImage(_ symbol: String, weight: NSFont.Weight = .medium) -> NSImage? {
        let cfg = NSImage.SymbolConfiguration(pointSize: 16, weight: weight)
        let img = NSImage(systemSymbolName: symbol, accessibilityDescription: "RemoteVoice")?
            .withSymbolConfiguration(cfg)
        img?.isTemplate = true
        return img
    }

    private func updateIcon(_ state: IconState) {
        guard let button = statusItem?.button else { return }
        switch state {
        case .disconnected:
            button.image = statusImage("mic.slash", weight: .regular)
            button.contentTintColor = nil
            stopPulse()
        case .standby:
            button.image = statusImage("waveform.badge.mic")
            button.contentTintColor = nil
            stopPulse()
        case .recording:
            let cfg = NSImage.SymbolConfiguration(pointSize: 16, weight: .medium)
            let img = NSImage(systemSymbolName: "mic.fill", accessibilityDescription: "Recording")?
                .withSymbolConfiguration(cfg)
            img?.isTemplate = false        // 关掉模板才能上色
            button.image = img
            button.contentTintColor = .systemRed
            startPulse()
        }
    }

    private func startPulse() {
        guard !pulsing, let button = statusItem?.button else { return }
        pulsing = true
        button.wantsLayer = true
        let anim = CABasicAnimation(keyPath: "opacity")
        anim.fromValue = 1.0; anim.toValue = 0.35; anim.duration = 0.7
        anim.autoreverses = true; anim.repeatCount = .infinity
        anim.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        button.layer?.add(anim, forKey: "recordingPulse")
    }
    private func stopPulse() {
        pulsing = false
        statusItem?.button?.layer?.removeAnimation(forKey: "recordingPulse")
    }

    // ---------- 回调 ----------
    private func handleState(_ state: RelayClient.State) {
        switch state {
        case .connecting:
            connItem.title = "状态：连接中…"
        case .connected:
            connItem.title = "状态：已连接"
            updateIcon(.standby)
        case .disconnected:
            connItem.title = "状态：未连接"
            peerItem.title = "对端：等待手机"
            updateIcon(.disconnected)
            DictationHUD.shared.hide()
        }
    }

    private func handleEvent(_ event: RelayClient.Event) {
        switch event {
        case .macReady:
            peerItem.title = "对端：等待手机"
            updateIcon(.standby)
            pairingWC?.refreshIfOpen()      // 重连/重置后刷新二维码与数字码
        case .shortCode(let code):
            pairingWC?.applyShortCode(code)
        case .devices(let list):
            devicesItem.title = "已配对设备：\(list.count)"
            pairingWC?.applyDevices(list)
        case .unpaired:
            peerItem.title = "对端：已被移除，请重新扫码"
            DictationHUD.shared.hide()
        case .assign(let code):
            // 旧随机码流程（理论上 V2 不会收到）；兜底显示。
            peerItem.title = "配对码：\(code)"
        case .paired(let peer):
            if peer == "phone" {
                peerItem.title = "对端：手机已就绪"
                updateIcon(.standby)
                client.send(["type": "config", "llm_postprocess": llmOn])
            }
        case .peerGone:
            peerItem.title = "对端：已断开"
            updateIcon(.standby)
            DictationHUD.shared.hide()
        case .config(let llm):
            llmOn = llm
            llmItem.title = "标点纠错：\(llm ? "开" : "关")"
        case .partial(let text):
            updateIcon(.recording)
            DictationHUD.shared.showPartial(text)
        case .final(let text):
            updateIcon(.standby)
            DictationHUD.shared.showFinal(text)
            if !text.isEmpty {
                lastTextItem.title = "最近：\(text)"
                injector.inject(text)
            }
        case .error(let msg):
            DictationHUD.shared.showFinal("⚠️ \(msg)")
        }
    }

    // ---------- 菜单动作 ----------
    @objc func openPairing() {
        if pairingWC == nil {
            pairingWC = PairingWindowController(relay: client, relayUrl: relayUrl)
        }
        pairingWC?.showAndRequest()
    }

    @objc func resetPairing() {
        let alert = NSAlert()
        alert.messageText = "重置配对？"
        alert.informativeText = "将生成全新的二维码与数字码。已配对的所有手机都会失效，需要重新扫码。"
        alert.alertStyle = .warning
        alert.addButton(withTitle: "重置")
        alert.addButton(withTitle: "取消")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        client.macId = MacIdentity.rotate()   // 换新 macId
        client.connect(to: relayUrl)            // 用新身份重连注册房间 → 触发 .macReady 刷新窗口
        devicesItem.title = "已配对设备：0"
        pairingWC?.applyDevices([])
    }

    @objc func toggleLlm() {
        llmOn.toggle()
        llmItem.title = "标点纠错：\(llmOn ? "开" : "关")"
        client.send(["type": "config", "llm_postprocess": llmOn])
    }

    @objc func editRelay() {
        let alert = NSAlert()
        alert.messageText = "中继地址"
        alert.informativeText = "WebSocket URL，例如 wss://your-host/ws"
        let input = NSTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24))
        input.stringValue = relayUrl
        alert.accessoryView = input
        alert.addButton(withTitle: "保存")
        alert.addButton(withTitle: "取消")
        if alert.runModal() == .alertFirstButtonReturn {
            let v = input.stringValue.trimmingCharacters(in: .whitespaces)
            guard !v.isEmpty else { return }
            relayUrl = v
            relayItem.title = "服务器：\(v)"
            client.connect(to: v)
        }
    }

    @objc func reconnect() {
        client.connect(to: relayUrl)
    }

    @objc func quit() {
        client.disconnect()
        DictationHUD.shared.teardown()
        NSApp.terminate(nil)
    }
}
