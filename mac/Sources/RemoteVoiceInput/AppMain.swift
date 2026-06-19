// RemoteVoiceInput —— macOS 状态栏听写 App（主入口）
//
// 职责：
//   1. 状态栏图标 + 菜单（显示配对码、连接状态、LLM 开关、退出）
//   2. 连接中继 WebSocket，按 PROTOCOL.md 收发信令
//   3. 收到 final 文字后用 CGEvent 注入到当前焦点窗口（经 UU 远程键盘转发到被控主机）
//
// 需要权限：辅助功能（CGEvent 注入）。启动时检测并提示。

import AppKit

@main
struct RemoteVoiceInputApp {
    static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.accessory) // 不在 Dock 显示
        app.run()
    }
}
