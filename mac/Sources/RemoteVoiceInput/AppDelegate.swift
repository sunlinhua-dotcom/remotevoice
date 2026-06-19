import AppKit
import Combine

final class AppDelegate: NSObject, NSApplicationDelegate {

    private var statusItem: NSStatusItem!
    private let menu = NSMenu()

    // 菜单项
    private let codeItem = NSMenuItem(title: "配对码：——", action: nil, keyEquivalent: "")
    private let connItem = NSMenuItem(title: "状态：未连接", action: nil, keyEquivalent: "")
    private let peerItem = NSMenuItem(title: "对端：等待手机", action: nil, keyEquivalent: "")
    private let partialItem = NSMenuItem(title: "识别中：——", action: nil, keyEquivalent: "")
    private let llmItem = NSMenuItem(title: "标点纠错：开", action: #selector(toggleLlm), keyEquivalent: "")
    private let relayItem = NSMenuItem(title: "服务器：——", action: #selector(editRelay), keyEquivalent: "")
    private let rescanItem = NSMenuItem(title: "重新配对", action: #selector(reconnect), keyEquivalent: "r")
    private let lastTextItem = NSMenuItem(title: "最近：——", action: nil, keyEquivalent: "")
    private let quitItem = NSMenuItem(title: "退出", action: #selector(quit), keyEquivalent: "q")

    private let client = RelayClient()
    private let injector = TextInjector()
    private var llmOn = true
    // 配对码独立保存，绝不与“识别中/错误”等共用 codeItem.title，避免互相覆盖后丢码。
    private var pairCode = "——"

    // 设置存储
    private let defaults = UserDefaults.standard
    private var relayUrl: String {
        get { RelayClient.resolveRelayURL(defaults.string(forKey: "relayUrl")) }
        set { defaults.set(newValue, forKey: "relayUrl") }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.title = "🎙"

        buildMenu()
        statusItem.menu = menu

        relayItem.title = "服务器：\(relayUrl)"

        client.onState = { [weak self] in self?.handleState($0) }
        client.onEvent = { [weak self] in self?.handleEvent($0) }

        client.connect(to: relayUrl)
    }

    private func buildMenu() {
        let sep = { NSMenuItem.separator() }
        for item in [codeItem, connItem, peerItem, sep(),
                     partialItem, lastTextItem, sep(),
                     llmItem, relayItem, rescanItem, sep(),
                     quitItem] {
            menu.addItem(item)
        }
        // 让本对象成为 target
        menu.items.forEach { $0.target = self }
    }

    // ---------- 回调 ----------
    private func handleState(_ state: RelayClient.State) {
        switch state {
        case .connecting:
            connItem.title = "状态：连接中…"
            statusItem.button?.title = "🎙…"
        case .connected:
            connItem.title = "状态：已连接"
        case .disconnected:
            connItem.title = "状态：未连接"
            pairCode = "——"
            codeItem.title = "配对码：——"
            peerItem.title = "对端：等待手机"
            statusItem.button?.title = "🎙"
        }
    }

    private func handleEvent(_ event: RelayClient.Event) {
        switch event {
        case .assign(let code):
            pairCode = code
            codeItem.title = "配对码：\(code)"
            statusItem.button?.title = "\(code.prefix(4))…"
            peerItem.title = "对端：等待手机"
        case .paired(let peer):
            if peer == "phone" {
                peerItem.title = "对端：手机已就绪"
                // 配对成功后把 mac 真实的 LLM 开关下发（rooms 默认 true，需覆盖为本地状态）。
                client.send(["type": "config", "llm_postprocess": llmOn])
            }
        case .peerGone:
            peerItem.title = "对端：已断开"
        case .config(let llm):
            llmOn = llm
            llmItem.title = "标点纠错：\(llm ? "开" : "关")"
        case .partial(let text):
            // 实时回显到独立的“识别中”项，不动配对码。
            partialItem.title = "识别中：\(text)"
        case .final(let text):
            // 从独立保存的 pairCode 还原，不再从标题里反解析。
            codeItem.title = "配对码：\(pairCode)"
            partialItem.title = "识别中：——"
            lastTextItem.title = "最近：\(text)"
            // 注入文字到焦点窗口
            if !text.isEmpty {
                injector.inject(text)
            }
        case .error(let msg):
            // 错误不覆盖配对码，落到独立项。
            partialItem.title = "错误：\(msg)"
        }
    }

    // ---------- 菜单动作 ----------
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
        NSApp.terminate(nil)
    }
}
