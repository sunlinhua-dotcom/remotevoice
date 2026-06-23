// 文字注入：用 CGEvent 把识别出的文字注入到当前焦点窗口。
// 这一步是核心——文字（键盘事件）经 UU 远程转发到被控主机，比音频转发稳得多。
//
// 实现思路：遍历字符串的 Unicode 标量，逐个用 CGEvent_KEYBOARD 触发。
// 基本多文种平面（BMP）内的字符用 keycode 0 + Unicode payload；
// 代理对（emoji 等）按 UTF-16 代理对发送。

import AppKit
import ApplicationServices
import CoreGraphics
import Carbon // IsSecureEventInputEnabled()

final class TextInjector {

    /// 注入结果——如实区分「真打字 / 退剪贴板 / 彻底失败」，供 HUD 与回执使用。
    enum Outcome {
        case typed, copied, failed
        var mode: String { switch self { case .typed: return "type"; case .copied: return "clipboard"; case .failed: return "failed" } }
        var ok: Bool { self != .failed }
    }

    /// 上次弹辅助功能提示的时间——避免连发多条 final 时叠出一堆模态框。
    private var lastPromptAt: Date?

    /// 把整段文字送达，返回真实结果：
    ///  - 焦点是可编辑文本框 / 前台是远程桌面类 App，且键盘事件确实发出 → .typed
    ///  - 没权限 / Secure Input / 没输入框 / 打字失败 → 退剪贴板 .copied
    ///  - 连剪贴板都失败 → .failed
    @discardableResult
    func inject(_ text: String) -> Outcome {
        guard !text.isEmpty else { return .failed }
        // 没有辅助功能权限：CGEvent 会被静默丢弃，别假装打字成功，直接退剪贴板并（节流地）提示。
        guard AXIsProcessTrusted() else {
            promptAccessibilityThrottled()
            return copyToClipboard(text) ? .copied : .failed
        }
        // Secure Input（密码/安全输入框）开启时，合成键盘事件会被系统静默吞掉 → 退剪贴板。
        if IsSecureEventInputEnabled() {
            return copyToClipboard(text) ? .copied : .failed
        }
        if shouldType() {
            if cgType(text) { return .typed }
            // 打字真失败了（事件源创建失败等）→ 退剪贴板，绝不假报成功。
            return copyToClipboard(text) ? .copied : .failed
        }
        return copyToClipboard(text) ? .copied : .failed
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
        //    用较"长"的标识词，避免 "uu"/"vnc" 这类两三字母子串误命中无关 App 的 bundle id。
        if let app = NSWorkspace.shared.frontmostApplication {
            let name = (app.localizedName ?? "").lowercased()
            let bid = (app.bundleIdentifier ?? "").lowercased()
            // 名字命中（中文名/较长英文名，子串误判概率低）。
            let nameKeys = ["向日葵", "uu远程", "todesk", "rustdesk", "parsec", "anydesk",
                            "teamviewer", "splashtop", "远程桌面", "remote desktop",
                            "vnc viewer", "chrome remote", "镜像"]
            if nameKeys.contains(where: { name.contains($0) }) { return true }
            // bundle id 命中（用厂商/产品片段，不用 "uu"/"vnc" 这种短词）。
            let bidKeys = ["todesk", "rustdesk", "parsec", "anydesk", "teamviewer", "splashtop",
                           "realvnc", "oray", "sunlogin", "chromeremotedesktop", "microsoft.rdc", "netease.uu"]
            if bidKeys.contains(where: { bid.contains($0) }) { return true }
        }
        return false
    }

    @discardableResult
    private func copyToClipboard(_ text: String) -> Bool {
        let pb = NSPasteboard.general
        pb.clearContents()
        return pb.setString(text, forType: .string)
    }

    /// 用 CGEvent 把整段文字"打"到当前焦点窗口（经远程转发可落到被控主机）。
    /// 返回 false = 事件源/事件创建失败（注入未发生），让上层退回剪贴板。
    private func cgType(_ text: String) -> Bool {
        guard let src = CGEventSource(stateID: .hidSystemState),
              let event = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: true) else { return false }
        // 按 Unicode 标量边界分块（每块 ≤10 个 UTF-16 单元），保证代理对（emoji 等）不被切断。
        for units in chunkedScalars(text, size: 10) {
            event.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
            event.type = .keyDown
            event.post(tap: .cgSessionEventTap)
            event.type = .keyUp
            event.post(tap: .cgSessionEventTap)
        }
        return true
    }

    /// 注入一个功能键（enter/tab/esc…）到当前焦点窗口——卡片「回车」按钮用来"提交"。
    /// 按键没法退剪贴板，缺权限/Secure Input/未知键 → .failed。
    func pressKey(_ key: String) -> Outcome {
        guard AXIsProcessTrusted() else { promptAccessibilityThrottled(); return .failed }
        if IsSecureEventInputEnabled() { return .failed }
        // "paste" = Cmd+V，把剪贴板（监听器已写好的图片/文字）粘到当前窗口。
        if key.lowercased() == "paste" {
            guard let src = CGEventSource(stateID: .hidSystemState),
                  let down = CGEvent(keyboardEventSource: src, virtualKey: 9, keyDown: true),   // V = 9
                  let up = CGEvent(keyboardEventSource: src, virtualKey: 9, keyDown: false) else { return .failed }
            down.flags = .maskCommand
            up.flags = .maskCommand
            down.post(tap: .cgSessionEventTap)
            up.post(tap: .cgSessionEventTap)
            return .typed
        }
        let map: [String: CGKeyCode] = ["enter": 36, "return": 36, "tab": 48, "escape": 53, "esc": 53]
        guard let code = map[key.lowercased()],
              let src = CGEventSource(stateID: .hidSystemState),
              let down = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: true),
              let up = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: false) else { return .failed }
        down.post(tap: .cgSessionEventTap)
        up.post(tap: .cgSessionEventTap)
        return .typed
    }

    /// 是否已具备辅助功能权限。
    static var isAuthorized: Bool { AXIsProcessTrusted() }

    /// 节流版提示：30s 内最多弹一次，避免连发多条 final 叠出一堆模态框阻塞主线程。
    private func promptAccessibilityThrottled() {
        if let t = lastPromptAt, Date().timeIntervalSince(t) < 30 { return }
        lastPromptAt = Date()
        promptAccessibility()
    }

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
