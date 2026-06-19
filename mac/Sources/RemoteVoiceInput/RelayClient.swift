// 中继 WebSocket 客户端：收发 PROTOCOL.md 定义的信令。
// 用 URLSessionWebSocketTask（系统自带，无需第三方依赖）。

import Foundation

final class RelayClient: NSObject {

    /// 默认中继地址：云端 Cloudflare（PWA 与中继同源）。个人自用固定只连这一台，写死即可，开箱即用、免手输。
    static let defaultRelayURL = "wss://remotevoice-pwa.sunlinhua.workers.dev/ws"
    /// 老版本的本地默认值；迁移成云端，省得已经跑过旧版的人还要去菜单手改。
    static let legacyLocalRelayURL = "ws://localhost:8787/ws"

    /// 解析要连的中继地址：用户显式设过别的就用它；没设过、或还停在老的 localhost 默认值，就用云端。
    /// （本机调试想连 localhost，临时改这里的常量或在菜单填一个非 localhost 的地址即可。）
    static func resolveRelayURL(_ stored: String?) -> String {
        if let s = stored, !s.isEmpty, s != legacyLocalRelayURL { return s }
        return defaultRelayURL
    }

    enum State { case connecting, connected, disconnected }

    enum Event {
        case assign(String)         // 配对码
        case paired(String)         // peer = mac|phone
        case peerGone
        case config(Bool)           // llm_postprocess
        case partial(String)
        case final(String)
        case error(String)
    }

    var onState: ((State) -> Void)?
    var onEvent: ((Event) -> Void)?

    private var task: URLSessionWebSocketTask?
    private var session: URLSession!
    private var url: URL?
    private var pingTimer: Timer?
    private var receivedHello = false

    override init() {
        super.init()
        session = URLSession(configuration: .default)
    }

    func connect(to urlString: String) {
        disconnect()
        guard let u = URL(string: urlString) else {
            onEvent?(.error("无效的地址"))
            return
        }
        url = u
        receivedHello = false
        onState?(.connecting)
        let t = session.webSocketTask(with: u)
        task = t
        t.resume()
        listen()
        startPing()
        // 中继是纯反应式的：必须由 mac 先发 hello，中继才会回 assign。
        // 不能等首帧再发，否则双方互相等待造成死锁，配对码永远不出现。
        sendHello()
    }

    func disconnect() {
        pingTimer?.invalidate(); pingTimer = nil
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        onState?(.disconnected)
    }

    func send(_ json: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: json),
              let s = String(data: data, encoding: .utf8) else { return }
        sendText(s)
    }

    private func sendText(_ text: String) {
        task?.send(.string(text)) { [weak self] err in
            if let err = err {
                DispatchQueue.main.async { self?.handleFailure(err) }
            }
        }
    }

    // ---------- 接收循环 ----------
    private func listen() {
        task?.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let msg):
                switch msg {
                case .string(let s): self.handleText(s)
                case .data(let d):
                    if let s = String(data: d, encoding: .utf8) { self.handleText(s) }
                @unknown default: break
                }
                // 首帧确认连接（hello 已在 connect() 时发出，这里只翻 UI 状态）
                if !self.receivedHello {
                    self.receivedHello = true
                    DispatchQueue.main.async { self.onState?(.connected) }
                }
                self.listen()
            case .failure(let err):
                DispatchQueue.main.async { self.handleFailure(err) }
            }
        }
    }

    private func handleText(_ text: String) {
        guard let data = text.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = obj["type"] as? String else { return }
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            switch type {
            case "assign":
                if let code = obj["code"] as? String { self.onEvent?(.assign(code)) }
            case "paired":
                if let peer = obj["peer"] as? String { self.onEvent?(.paired(peer)) }
            case "peer_gone":
                self.onEvent?(.peerGone)
            case "config":
                if let v = obj["llm_postprocess"] as? Bool { self.onEvent?(.config(v)) }
            case "partial":
                if let t = obj["text"] as? String { self.onEvent?(.partial(t)) }
            case "final":
                if let t = obj["text"] as? String { self.onEvent?(.final(t)) }
            case "error":
                let m = (obj["message"] as? String) ?? "错误"
                self.onEvent?(.error(m))
            case "asr_error":
                let m = (obj["message"] as? String) ?? "识别异常"
                self.onEvent?(.error(m))
            case "pong", "status": break
            default: break
            }
        }
    }

    private func sendHello() {
        // 仅发 hello。配对前发 config 会被中继当作 not_paired 丢弃，
        // 真正的 LLM 开关在配对成功后由 AppDelegate 在 .paired 时下发。
        send(["type": "hello", "role": "mac"])
    }

    // ---------- 心跳与重连 ----------
    private func startPing() {
        pingTimer?.invalidate()
        pingTimer = Timer.scheduledTimer(withTimeInterval: 25, repeats: true) { [weak self] _ in
            self?.send(["type": "ping"])
        }
    }

    private func handleFailure(_ err: Error) {
        onState?(.disconnected)
        // 自动重连
        DispatchQueue.global().asyncAfter(deadline: .now() + 2) { [weak self] in
            guard let self, let url = self.url else { return }
            DispatchQueue.main.async { self.connect(to: url.absoluteString) }
        }
    }
}
