// 文字注入：用 CGEvent 把识别出的文字注入到当前焦点窗口。
// 这一步是核心——文字（键盘事件）经 UU 远程转发到被控主机，比音频转发稳得多。
//
// 实现思路：遍历字符串的 Unicode 标量，逐个用 CGEvent_KEYBOARD 触发。
// 基本多文种平面（BMP）内的字符用 keycode 0 + Unicode payload；
// 代理对（emoji 等）按 UTF-16 代理对发送。

import AppKit
import CoreGraphics

final class TextInjector {

    /// 把整段文字"打"到当前焦点窗口。
    func inject(_ text: String) {
        guard AXIsProcessTrusted() else {
            // 辅助功能未授权：弹一次提示，引导用户到设置。
            promptAccessibility()
            return
        }

        let src = CGEventSource(stateID: .hidSystemState)
        guard let event = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: true) else { return }

        // 按 Unicode 标量边界分块（每块 ≤10 个 UTF-16 单元），保证代理对（emoji 等）
        // 不会被切到两个 CGEvent，否则单独的高/低代理是非法 UTF-16，字符会丢失或乱码。
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
