// RemoteVoiceInputMethod 主入口
// 启动 IMKServer，注册为输入法。bundle id 由 Info.plist 的 tsInputMethodCharacteristics 决定。

import Cocoa
import InputMethodKit

let kConnectionName = "RVInputMethod_Connection" // 必须与 Info.plist 的 InputMethodConnectionName 一致

@main
struct RVInputMethodMain {
    static func main() {
        let app = NSApplication.shared
        let server = IMKServer(name: kConnectionName, bundleIdentifier: Bundle.main.bundleIdentifier)
        _ = server // 保持引用
        // 全输入法共享的中继连接：在此启动一次（单连接、单配对码、单 final 投递点）。
        RVInputController.startSharedClient()
        app.setActivationPolicy(.accessory)
        app.run()
    }
}
