# RemoteVoice 复现指南

> 给「想用 Claude Code 把这套远程语音输入系统在自己机器上从零跑起来」的人。
>
> 你（或你让 Claude）会得到：一个飞书机器人，私聊它发文字/语音 → 文字直接打进你 Mac 当前焦点的输入框（再经 UU 远程等转发到被控主机），回执是一张带「⏎ 回车」按钮的卡片，点一下就在那个窗口按回车提交。

---

## 0. 整体架构（先看懂再动手）

```
[飞书 App 发文字/语音]
      │  (im.message.receive_v1，长连接)
      ▼
[飞书监听器  feishu/listener.mjs]  ← 在你 Mac 上常驻的 Node 进程
      │  文字直接用；语音 → ffmpeg 转 PCM → 飞书 STT 转写
      │  作为 phone 角色连云中继，发 {type:"inject_text", id, text}
      ▼
[云中继  Cloudflare Worker]  ← cf/，一个 Worker 同时托管中继 + 手机 PWA
      │  广播 {type:"final", id, text} 给 Mac
      ▼
[Mac App  RemoteVoiceInput]  ← 菜单栏 App，CGEvent 把文字注入当前窗口
      │  注入后回 {type:"inject_ack", id, ok, mode}
      ▼
[UU 远程 / 向日葵 等窗口] --键盘事件转发--> [被控主机]
```

两条输入通道，**互为独立**，按需取用：

- **飞书通道（推荐，最稳）**：飞书发文字/语音 → 落字。**不碰实时音频**，靠飞书自己的多模态。
- **PWA 实时通道（可选）**：手机浏览器开 PWA，按住说话 → 豆包流式 ASR 实时识别 → 落字。需要额外的火山引擎（豆包）密钥。

> 只想要飞书通道的话，**不需要任何火山引擎/豆包密钥**——飞书的语音转写用的是飞书应用自带的能力。下面标了「(仅 PWA)」的步骤可跳过。

---

## 1. 准备账号与密钥

| 用途 | 需要什么 | 必需性 |
|---|---|---|
| 云中继 | Cloudflare 账号（免费版即可，有 Workers + Durable Objects SQLite） | 必需 |
| 飞书机器人 | 飞书账号 + 能进[飞书开放平台](https://open.feishu.cn/)开发者后台 | 必需 |
| Mac App | macOS + Xcode 命令行工具（`swift`）；`ffmpeg`（飞书语音转写要） | 必需 |
| LLM 加标点 | 火山方舟 Ark API Key（`doubao-seed-2-0-lite`） | 可选（不配则不加标点） |
| 实时 ASR | 火山引擎豆包流式语音识别：App ID / Access Token / Secret Key | 仅 PWA |

本机工具：Node ≥ 20、`npx`（装 wrangler / pm2）、`swift`、`ffmpeg`（`brew install ffmpeg`）。

> ⚠️ **国内网络**：中继跑在 `*.workers.dev`，国内访问常需科学上网。手机端、Mac、监听器都要能连上你的 worker 域名。

---

## 2. 最重要的一条：飞书后台全部用「浏览器控制」完成

**飞书自建应用的创建、能力开通、权限、事件/回调订阅、发版——没有 API 可以做，必须在开发者后台网页上点。** 所以这套流程的标准做法是：

> **让 Claude 用「浏览器控制」（Claude in Chrome / `mcp__Claude_in_Chrome__*` 工具）驱动 [open.feishu.cn](https://open.feishu.cn/) 的开发者后台，一步步点完。**

不要试图用 lark-cli 或 OpenAPI 去「创建应用 / 改权限 / 发版」——那些只能管运行时数据，管不了应用本身的配置。运行时（收消息、转写、发卡片）才用 SDK（`@larksuiteoapi/node-sdk`，已在 `feishu/` 里）。

给 Claude 的话术示例（第 5 步会展开）：

> 「用浏览器帮我在飞书开放平台创建一个自建应用『远程语音』，开机器人能力，加这几个权限……，事件和回调都用长连接，然后发版。我会在弹出的地方给你授权。」

---

## 3. 第一步：部署云中继（Cloudflare Worker）

```bash
cd cf && npm install && cd ..
npx wrangler login                # 浏览器授权 Cloudflare
# 改 wrangler.jsonc 里的 name（如 remotevoice-pwa-<你的标识>），避免和别人撞名
npx wrangler deploy               # 部署 → 记下 https://<name>.<子域>.workers.dev
```

部署后设密钥（**只有要 LLM 加标点 / PWA 实时通道才需要**；纯飞书文字可全跳过）：

```bash
# LLM 加标点（可选）
npx wrangler secret put ARK_API_KEY
# PWA 实时 ASR（仅 PWA）
npx wrangler secret put DOUBAO_ASR_APP_ID
npx wrangler secret put DOUBAO_ASR_ACCESS_TOKEN
npx wrangler secret put DOUBAO_ASR_SECRET_KEY
npx wrangler deploy                # 改完 secret 必须再 deploy 一次让 DO 拿到新值
```

验证：`curl https://<你的域名>/healthz` → `{"ok":true,...}`。`llm:true` 说明 Ark key 生效。

> 中继实现要点（踩过的坑，复现时一般不用动）：Workers 里出站 WebSocket 必须用 `fetch(https://..., {headers:{Upgrade:"websocket"}})` 取 `resp.webSocket`，**不能用 ws:// scheme**；gzip 用 `CompressionStream`。`doubao-seed-2.0` 是推理模型，LLM 请求体必须带 `thinking:{type:"disabled"}`，否则补个标点也烧 1500+ token、延迟 30~50s（见 `cf/src/doubao-llm.ts`）。

---

## 4. 第二步：编译安装 Mac App + 授权

```bash
cd mac
./create-signing-cert.sh          # 一次性：建稳定自签名证书（让辅助功能授权跨重编译保留）
./build-app.sh                    # release 编译 + 组装 .app + 用该证书签名 + 装到 /Applications
open /Applications/RemoteVoiceInput.app
```

**先跑一次 `create-signing-cert.sh`**：它建一张稳定的自签名代码签名证书放进专用 keychain。
之后 `build-app.sh` 自动用它签名——这样辅助功能授权**只需给一次，以后反复重编译都不会失效**
（原因见下方 ⚠️）。不跑也能用，但会回退 ad-hoc 签名、每次重编译都要重新授权。

中继地址：本仓库源码里 `defaultRelayURL` 是占位符。**改成你自己的 worker 域名**后重新 `./build-app.sh`，
或启动后在 App 菜单「服务器地址」填一次（存 UserDefaults，优先于源码默认值、rebuild 不丢）。

启动后：

1. 菜单栏出现图标，Dock 也有（点开是「配对 / 设备」窗口）。
2. **开辅助功能授权**（CGEvent 注入必须）：系统设置 → 隐私与安全性 → 辅助功能 → 打开 `RemoteVoiceInput`。
3. 取本机 macId（监听器要用）：`defaults read com.remotevoice.input rv.macId`。

> ⚠️ **为什么要那张证书**：macOS 的 TCC 把「辅助功能」授权绑在 App 签名的 designated requirement 上。ad-hoc 签名没有稳定证书，DR 退化成每次都变的 cdhash，于是每次重编译授权就失效（开关看着是开的、其实绑在旧签名上）。`create-signing-cert.sh` 用一张固定的自签名证书签名 → DR 不变 → 授权一次后永久保留（实测连续两次构建 DR 完全一致）。**第一次从 ad-hoc 切到证书签名时，因签名变了，需重新授权一次**：跑 `tccutil reset Accessibility com.remotevoice.input` 清干净，再到辅助功能里打开一次，之后就不用再动了。
>
> ⚠️ **macId 会变**：菜单里点过「重置配对」、或换机/重装，macId 会 rotate。一旦变了，`feishu/.env` 的 `MAC_ID` 必须同步改，否则注入进空房间（中继 `/healthz` 显示 `rooms:2` 就是监听器和 Mac 不在一个房间的典型症状，改对后回 `rooms:1`）。

---

## 5. 第三步：用浏览器控制创建并配置飞书机器人

**这一步全程让 Claude 用浏览器控制完成。** 打开 [open.feishu.cn](https://open.feishu.cn/) 开发者后台，按顺序：

### 5.1 创建应用
- 创建企业自建应用，名字「远程语音」，描述随意。
- 记下 **App ID**（形如 `cli_xxxx`，非密钥）。

### 5.2 开「机器人」能力
- 左侧「添加应用能力」→ 启用 **机器人**。

### 5.3 加权限（权限管理，全部「免审」，开通即生效）
- `im:message` —— 发消息（回执卡片要）
- `im:message.p2p_msg:readonly` —— **读取用户发给机器人的单聊消息**。⚠️ **最关键也最容易漏**：默认只有「群里 @ 机器人」的权限，私聊消息要的是这个 p2p 权限，缺了它你私聊机器人**一条事件都收不到**。
- `im:resource` —— 下载语音文件（语音通道要）
- `speech_to_text:speech` —— 语音转文字（语音通道要）

### 5.4 事件订阅（事件与回调 → 事件配置）
- 订阅方式：**使用长连接接收事件**（无需公网回调地址）。
- 添加事件：**接收消息 `im.message.receive_v1`**。

### 5.5 回调订阅（事件与回调 → 回调配置）⚠️ 卡片按钮靠这个
- 订阅方式：**使用长连接接收回调**。
- ⚠️ 卡片按钮的点击在飞书里算「**回调**」不是「事件」，是**单独的一栏**。不配这个，卡片上的「⏎ 回车」按钮点了**没有任何反应**。

### 5.6 发布版本（版本管理与发布）
- 可用范围：选「部分成员」加上你自己（≤5 人免审），或全员。
- 创建版本 → 确认发布。范围小时**免审、提交即上线**。
- ⚠️ **权限是开通即生效，但「订阅方式」（事件/回调长连接）的变更必须发一次版本才生效**。所以 5.4 / 5.5 改完，一定要在这里发版。改了订阅又收不到？十有八九是没发版。

### 5.7 取凭证
- 「凭证与基础信息」里复制 **App ID** 和 **App Secret**，填进下一步的 `feishu/.env`。App Secret 是密钥，别外泄、别入库。

---

## 6. 第四步：配置并常驻飞书监听器

```bash
cd feishu && npm install
cp .env.example .env
# 编辑 .env：FEISHU_APP_ID / FEISHU_APP_SECRET / RELAY_URL(你的worker /ws) / MAC_ID(第4步取的)
npm start                          # 先前台跑，看到下面三行就绪：
#   飞书长连接已启动 …
#   [ws] ws client ready
#   relay 已配对 ✅  Mac 房间 xxxxxxxx…
```

常驻（关终端不死、崩溃自重启）：

```bash
npx pm2 start listener.mjs --name rv-feishu --cwd "$(pwd)"
npx pm2 save
# 开机自启（可选，要 sudo，pm2 会打印具体命令）：
npx pm2 startup
```

监听器做的事（`feishu/listener.mjs`，复现时一般不用改）：
- 文字消息 → 直接注入，且明确告诉中继 `postprocess:false`（**手打的成文文字不让 LLM 再改标点/纠错**）。
- 语音消息 → `im.messageResource.get` 下载 opus → **ffmpeg 转 16k/单声道/s16le 裸 PCM**（飞书 `speech_to_text.file_recognize` 只吃裸 PCM，直接送 opus 必失败）→ 转写 → 注入。
- 注入后等中继的 `inject_result`（来自 Mac 的真实 ack）→ 回**卡片**：成功显示「✅ 已注入到电脑输入框」+「⏎ 回车」按钮；离线/失败如实显示。
- 卡片「⏎ 回车」按钮 → `card.action.trigger` 回调 → 给 Mac 注入一个回车键（提交）。
- `device_token` 持久化到 `feishu/.device_token.<macId>`（重启复用，不会每次在中继设备表新增一条）。

---

## 7. 配对与联调

监听器以 `MAC_ID` 为房间号连中继，和 Mac App 在同一房间即自动配对（永久信任，首次自动签发 device_token）。

**端到端测试**：
1. Mac 上点进一个输入框（备忘录 / UU 远程窗口）。
2. 飞书私聊机器人「远程语音」发一句文字。
3. 那个输入框直接出现文字；机器人回一张卡片，带「⏎ 回车（提交）」按钮。
4. 点「⏎ 回车」→ Mac 在那个窗口按下回车。

**不联人也能自检**（确认中继↔Mac 这半段）：连一个临时 phone 客户端发 `{type:"inject_text", id, text, postprocess:false}`，看回的 `inject_result`：
- `{ok:true, mode:"type"}` = 全通，已打字。
- `{ok:true, mode:"clipboard"}` = 到了 Mac，但走剪贴板（没授权辅助功能，或当时没输入框焦点）。
- `{ok:false, reason:"mac_offline"}` = Mac 没连上中继。

---

## 8. 已知坑 / 排错速查

| 症状 | 原因 | 解 |
|---|---|---|
| 私聊机器人，监听器一条事件都没有 | 缺 `im:message.p2p_msg:readonly`（单聊权限） | 加该权限（5.3） |
| 卡片「回车」按钮点了没反应 | 回调没配 / 没发版 | 回调配置设长连接（5.5）+ 发版（5.6） |
| 改了事件或回调订阅仍不生效 | 订阅方式变更需发版 | 版本管理与发布 → 发版 |
| 回执「✅」但输入框没字、字在剪贴板 | 辅助功能授权失效（ad-hoc 签名变了） | `tccutil reset Accessibility com.remotevoice.input` 后重新授权 |
| 「电脑端没在线」 | Mac 没连中继（睡眠/网络/重新部署后半开死连） | 已加心跳看门狗自愈；仍不行就重启 Mac App |
| `/healthz` 显示 `rooms:2` | 监听器和 Mac 不在同一房间（macId 不一致） | 同步 `feishu/.env` 的 `MAC_ID` = `defaults read com.remotevoice.input rv.macId` |
| 语音转写报格式错 | 直接送了 opus | 监听器已用 ffmpeg 转 PCM；确认本机装了 ffmpeg |
| 手打文字被加了标点/改了字 | LLM 后处理 | 文字消息已发 `postprocess:false`；PWA/语音才后处理 |
| 中继连不上（连接中…） | `workers.dev` 国内需科学上网 | 挂代理 |

诊断口诀：**`mac_offline` = Mac 没连中继；`mode=clipboard` = 没授权辅助功能（或没焦点）；`rooms:2` = macId 对不上。**

---

## 9. 给 Claude 操作者的提示词（直接抄）

> 我要复现 RemoteVoice（这个仓库）。请按 `REPRODUCE.md`：
> 1. 帮我 `npx wrangler deploy` 部署中继，告诉我 worker 域名（我已 `wrangler login`）。
> 2. 帮我 `./build-app.sh` 编译安装 Mac App，提醒我开辅助功能授权，并读出我的 macId。
> 3. **用浏览器控制**在飞书开放平台创建自建应用「远程语音」：开机器人能力；加权限 `im:message` / `im:message.p2p_msg:readonly` / `im:resource` / `speech_to_text:speech`；事件订阅用长连接加 `im.message.receive_v1`；**回调订阅也用长连接**（卡片按钮要）；发版（部分成员含我自己，免审）。需要授权的地方我来点。
> 4. App Secret 我会贴给你（或你引导我填进 `feishu/.env`）；其余 `.env` 字段你帮我填。
> 5. `npx pm2 start` 把监听器常驻，然后帮我端到端自检，确认 `mode=type`。

复现完，删掉我打进去的测试文字即可。
