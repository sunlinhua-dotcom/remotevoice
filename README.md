<div align="center">

<img src="docs/images/logo.png" width="116" alt="RemoteVoice" />

# RemoteVoice

### 对飞书说句话，文字就落进你的远程电脑

**手机上不装任何东西，也不用打字** —— 给飞书机器人发一条语音，
用飞书自带的语音转写，文字直接出现在你 Mac 当前的输入框里，
再经 UU 远程等转发到被控主机。发图片也行：自动复制 + 粘贴。

<br/>

<img src="docs/images/hero.png" width="760" alt="说话 → 云端 → 电脑自动落字" />

<br/>

![platform](https://img.shields.io/badge/Mac-菜单栏%20App-111?logo=apple)
![relay](https://img.shields.io/badge/中继-Cloudflare%20Workers-F38020?logo=cloudflare&logoColor=white)
![phone](https://img.shields.io/badge/手机端-飞书机器人%20·%20免安装-00D6B9)
![license](https://img.shields.io/badge/license-MIT-blue)

</div>

---

## 为什么会有这个项目

用 UU 远程、向日葵这类工具控制异地电脑时，**语音输入几乎都是坏的**。根因是音频被层层转发——本机麦克风 → 远程软件 → 被控主机输入法——这条链路又长又脆，延迟、丢字、识别错乱。

**RemoteVoice 换了个思路：不转发音频，只转发文字。**

声音只在「手机 → 云端」这一段走；到你电脑的是**键盘事件**。键盘转发比音频转发稳得多，从根上消除了那些 bug。而最妙的一点是——

> **手机端你什么都不用装、什么都不用配。** 打开飞书，对着机器人说句话，靠飞书自己的语音转文字，文字就到了你的远程电脑。

---

## 它能做什么

- 🎙 **语音落字**：飞书发语音 → 文字注入到电脑当前输入框（焦点是远程桌面窗口时，经键盘转发落到被控主机）。
- ⌨️ **手打也行**：懒得说话就打字，发文字消息同样注入；手打文本不会被改写。
- 🖼 **图片粘贴**：发图片 → 自动复制到剪贴板并在当前窗口 `Cmd+V` 粘贴；同时给一条公网短链，远端打不开剪贴板时也能取图。
- ⏎ **一键回车**：每次注入后回一张卡片，点「回车」按钮就在远端窗口按下回车提交。
- 🧠 **自动标点**：语音转写结果经大模型补标点、纠错（可关）。
- 🔒 **密钥不下发**：所有凭证只在你自己的云中继里，手机和 Mac 都不持密钥。
- 📲 **设备配对**：扫永久二维码或输 4 位码一次配对，之后自动重连；可按设备单独吊销。

---

## 它怎么工作

```mermaid
flowchart LR
    P["📱 飞书机器人<br/>语音 / 文字 / 图片"]
    R["☁️ Cloudflare Worker<br/>中继 · 飞书STT · 大模型标点"]
    M["💻 Mac 菜单栏 App<br/>CGEvent 注入当前窗口"]
    H["🖥️ 被控主机<br/>经 UU 远程键盘转发"]
    P -- 长连接 --> R
    R -- 文字 / 按键 --> M
    M -- 键盘事件 --> H
```

三端通过一个你自己部署的云中继互联。**音频只走「手机 → 中继」**，到 Mac 的永远是文字或按键——这就是它稳的原因。

| 端 | 角色 |
|---|---|
| **手机** | 飞书机器人（私聊发语音/文字/图片，零安装） |
| **中继** | 一个 Cloudflare Worker：跑飞书语音转写、可选大模型标点、转发文字/按键、临时图片中转 |
| **Mac** | 菜单栏 App：用 CGEvent 把文字/回车注入当前焦点窗口，并回执真实结果 |

> 还有一条可选的**实时 PWA 通道**：手机浏览器打开网页，按住说话、豆包流式 ASR 实时识别。需要额外的火山引擎密钥，纯飞书通道用不到。

---

## 快速开始

完整、可复现的分步指南见 **[REPRODUCE.md](REPRODUCE.md)**（含每一步命令 + 排错速查 + 可直接抄给 AI 助手的提示词）。三步概览：

```bash
# 1) 部署云中继（你自己的 Cloudflare 账号）
cd cf && npm install && cd ..
npx wrangler deploy                      # → 记下 https://<你的>.workers.dev

# 2) 编译安装 Mac App（首次先建稳定签名证书，授权一次永久有效）
cd mac && ./create-signing-cert.sh && ./build-app.sh
#   到「系统设置 → 隐私与安全性 → 辅助功能」打开 RemoteVoiceInput

# 3) 跑飞书监听器
cd feishu && npm install && cp .env.example .env   # 填好后：
npx pm2 start listener.mjs --name rv-feishu
```

飞书机器人本身的创建/权限/发版**全程在飞书开放平台网页上点**（没有 API 能建应用），
[REPRODUCE.md](REPRODUCE.md) 第 5 步把每一次点击都写清楚了——可以让 AI 用浏览器控制替你点完。

---

## 一次性配置都需要什么

| 用途 | 需要 | 必需性 |
|---|---|---|
| 云中继 | Cloudflare 账号（免费版即可） | 必需 |
| 手机端 | 飞书账号 + 一个自建机器人 | 必需 |
| Mac | macOS + `swift` + `ffmpeg` | 必需 |
| 自动标点 | 火山方舟 Ark Key | 可选 |
| 实时 PWA | 火山引擎豆包流式 ASR 凭证 | 仅 PWA 通道 |

> 只用飞书通道的话，**连火山引擎密钥都不用**——语音转写走飞书自带能力。

---

## 技术栈

- **中继**：Cloudflare Workers + Durable Objects（SQLite 持久化配对、内存图片中转），单 Worker 同时托管 PWA 静态站与 WebSocket 中继。
- **Mac**：Swift（SwiftPM），`NSStatusItem` 菜单栏、`CGEvent` 注入、`AXUIElement` 焦点判定、稳定自签名证书签名（辅助功能授权跨重编译保留）。
- **手机**：飞书开放平台自建应用（长连接收事件/回调，免公网回调地址）+ `@larksuiteoapi/node-sdk` 监听器。
- **语音/标点**：飞书 `speech_to_text`、豆包流式 ASR、火山方舟 `doubao-seed` 大模型。

---

## 安全与隐私

- 豆包/方舟/飞书凭证只存在你自己的中继 `.env` / `wrangler secret`，**永不下发**到手机或 Mac。
- 配对走设备信任模型：永久二维码 + 4 位短码 + 长期 device token，可按设备单独吊销。
- 中继按房间（macId）严格隔离，绝不跨房转发；配对失败有限流防爆破。

---

## 路线图

- [x] 飞书语音 / 文字 / 图片 → 远程落字 / 粘贴
- [x] 卡片回执 + 一键回车
- [x] 稳定签名，告别每次重编译重新授权
- [ ] 把图片短链自动打进被控窗口（可选模式）
- [ ] 原生 IME 外壳 / Windows 控制端

---

## License

MIT —— 详见 [LICENSE](LICENSE)。欢迎 issue、PR 与 star ⭐
