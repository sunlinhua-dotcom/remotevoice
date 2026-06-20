// 文字注入：用 CGEvent 把识别出的文字注入到当前焦点窗口。
// 这一步是核心——文字（键盘事件）经 UU 远程转发到被控主机，比音频转发稳得多。
//
// 实现思路：遍历字符串的 Unicode 标量，逐个用 CGEvent_KEYBOARD 触发。
// 基本多文种平面（BMP）内的字符用 keycode 0 + Unicode payload；
// 代理对（emoji 等）按 UTF-16 代理对发送。

import AppKit
import ApplicationServices
import CoreGraphics

final class TextInjector {

    /// 把整段文字送达：
    ///  - 当前焦点是可编辑文本框，或前台是远程桌面/转发类 App（被控端有输入框）→ 用 CGEvent 直接打字。
    ///  - 否则（没有输入框）→ 存进剪贴板，用户可手动粘贴。
    /// 返回 true = 已注入打字；false = 已复制到剪贴板。
    @discardableResult
    func inject(_ text: String) -> Bool {
        guard !text.isEmpty else { return false }
        guard AXIsProcessTrusted() else {
            promptAccessibility()
            copyToClipboard(text)   // 没权限也别丢字，先放剪贴板
            return false
        }
        if shouldType() {
            cgType(text)
            return true
        } else {
            copyToClipboard(text)
            return false
        }
    }

    /// 是否应该"打字"（而不是存剪贴板）。
    private func shouldType() -> Bool {
        // 1) 系统焦点是可编辑文本元素？
        let sys = AXUIElementCreateSystemWide()
        var focused: CFTypeRef?
        if AXUIElementCopyAttributeValue(sys, kAXFocusedUIElementAttribute as CFString, &focused) == .success,
           let el = focused, CFGetTypeID(el) == AXUIElementGetTypeID() {
            let element = el as! AXUIElement
            var roleObj: CFTypeRef?
            AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &roleObj)
            let role = (roleObj as? String) ?? ""
            let textRoles: Set<String> = ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"]
            if textRoles.contains(role) { return true }
            var settable: DarwinBoolean = false
            if AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable) == .success, settable.boolValue {
                return true
            }
        }
        // 2) 前台是远程桌面/转发类 App（焦点在它的窗口，真正的输入框在被控端）→ 也打字。
        if let app = NSWorkspace.shared.frontmostApplication {
            let name = (app.localizedName ?? "").lowercased()
            let bid = (app.bundleIdentifier ?? "").lowercased()
            let keys = ["远程", "向日葵", "uu", "todesk", "rustdesk", "parsec", "vnc",
                        "anydesk", "teamviewer", "splashtop", "remote", "镜像"]
            if keys.contains(where: { !$0.isEmpty && (name.contains($0) || bid.contains($0)) }) { return true }
        }
        return false
    }

    private func copyToClipboard(_ text: String) {
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString(text, forType: .string)
    }

    /// 用 CGEvent 把整段文字"打"到当前焦点窗口（经远程转发可落到被控主机）。
    private func cgType(_ text: String) {
        let src = CGEventSource(stateID: .hidSystemState)
        guard let event = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: true) else { return }
        // 按 Unicode 标量边界分块（每块 ≤10 个 UTF-16 单元），保证代理对（emoji 等）不被切断。
        for units in chunkedScalars(text, size: 10) {
            event.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
            event.type = .keyDown
            event.post(tap: .cgSessionEventTap)
            event.type = .keyUp
            event.post(tap: .cgSessionEventTap)
        }
    }

    /// 是否已具备辅助功能权限。
    static var isAuthorized: Bool { AXIsProcessTrusted() }

    private func promptAccessibility() {
        DispatchQueue.main.async {
            let alert = NSAlert()
            alert.messageText = "需要“辅助功能”权限"
            alert.informativeText = "RemoteVoice 需要辅助功能权限才能把语音识别的文字输入到当前窗口。请前往 系统设置 → 隐私与安全性 → 辅助功能，开启 RemoteVoiceInput。"
            alert.addButton(withTitle: "打开系统设置")
            alert.addButton(withTitle: "稍后")
            if alert.runModal() == .alertFirstButtonReturn {
                NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!)
            }
        }
    }

    /// 按 Unicode 标量边界把字符串切成若干 UTF-16 单元块，每块不超过 size 个单元，
    /// 且任何一个标量（含 2 单元的代理对）都完整落在同一块内。
    private func chunkedScalars(_ text: String, size: Int) -> [[UInt16]] {
        var chunks: [[UInt16]] = []
        var buf: [UInt16] = []
        for scalar in text.unicodeScalars {
            let units = Array(String(scalar).utf16) // 1 或 2 个单元，始终是完整代理对
            if !buf.isEmpty && buf.count + units.count > size {
                chunks.append(buf)
                buf.removeAll(keepingCapacity: true)
            }
            buf.append(contentsOf: units)
        }
        if !buf.isEmpty { chunks.append(buf) }
        return chunks
    }
}
