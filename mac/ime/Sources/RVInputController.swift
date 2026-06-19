// RemoteVoiceInputMethod —— 原生输入法外壳（InputMethodKit / IMK）
//
// 与后台听写 App（CGEvent 注入）的区别：
//   - 这是真正的系统输入法，会出现在「系统设置 → 键盘 → 输入法」里，用户可切换选中。
//   - 当用户选中本输入法、把焦点放在任意文本框时，文字通过 IMK 的 insertText() 注入，
//     由输入法框架直接交给目标控件（比 CGEvent 更"正统"，不受辅助功能权限影响）。
//   - 它内部复用同一套 RelayClient（连接中继、收 final 文字）。
//
// 工程要求：必须是签名的 .app bundle，Info.plist 声明 InputMethodServerController 等。
// 详见同目录 Info.plist 与 build.sh。

import InputMethodKit
import Cocoa

@objc(RVInputController)
final class RVInputController: IMKInputController {

    // 全输入法共享一个中继连接：IMK 会为每个文本框频繁新建/销毁 controller，
    // 若每个 controller 各开一条 RelayClient，就会泄漏 N 条 WS + N 个 25s ping timer，
    // 并向中继重复发 N 次 hello。共享单例保证单连接、单配对码、单 final 投递点。
    static let shared = RelayClient()
    /// 当前持有焦点的注入目标，仅在 activate/deactivate 时更新（不再回退到 client()）。
    static weak var activeTarget: (any IMKTextInput)?
    private static var didStart = false

    /// app 启动时调用一次：注册事件路由并建立唯一连接。
    static func startSharedClient() {
        guard !didStart else { return }
        didStart = true
        shared.onEvent = { event in
            switch event {
            case .assign(let code):
                // IME 没有状态栏，配对码只能记录到 Console，供用户查看后在手机上输入。
                NSLog("[RemoteVoice IME] 配对码：%@", code)
            case .final(let text):
                guard !text.isEmpty, let target = RVInputController.activeTarget else { return }
                target.insertText(text, replacementRange: NSRange(location: NSNotFound, length: 0))
            default:
                break
            }
        }
        let url = RelayClient.resolveRelayURL(UserDefaults.standard.string(forKey: "relayUrl"))
        shared.connect(to: url)
    }

    override init!(server: IMKServer!, delegate: Any!, client inputClient: Any!) {
        super.init(server: server, delegate: delegate, client: inputClient)
        if let c = inputClient as? any IMKTextInput { RVInputController.activeTarget = c }
    }

    // 当输入法被激活（用户切到本输入法 / 切换文本框）时刷新目标。
    override func activateServer(_ sender: Any!) {
        RVInputController.activeTarget = sender as? any IMKTextInput
    }

    override func deactivateServer(_ sender: Any!) {
        // 仅当被停用的正是当前目标时才清空，避免误清掉刚激活的新目标。
        if let active = RVInputController.activeTarget,
           (sender as AnyObject) === (active as AnyObject) {
            RVInputController.activeTarget = nil
        }
    }
}
