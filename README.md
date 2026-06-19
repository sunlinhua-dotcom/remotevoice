# RemoteVoice

> 异地语音输入：手机按住说话，文字直接打到 Mac（再经 UU 远程的键盘转发落到被控主机）。

## 为什么做这个

用 UU 远程控制异地主机时，"语音输入"各种 bug 的根因是 **音频被转发**（Mac 麦克风 → UU 远程 → 被控主机输入法）这条链路不稳。

RemoteVoice **绕开音频转发**：手机采集音频 → 云中继跑豆包流式 ASR + LLM 后处理 → 只把**文字**发回 Mac → Mac 用 CGEvent 注入当前焦点窗口 → 文字经 UU 远程的**键盘转发**落到被控主机。**键盘转发比音频转发稳得多**，从根上消除 bug。

```
[手机/PWA] --音频--> [中继: 豆包ASR + LLM纠错] --文字--> [Mac: CGEvent注入]
                                                              └──> [UU远程窗口] --键盘转发--> [被控主机]
```

## 架构（确认的决策）

| 维度 | 决策 |
|---|---|
| Mac 文字注入 | 后台听写 App（CGEvent）已跑通，后续可套原生 IME 外壳 |
| 手机端 | Web/PWA（浏览器 + Web Audio API，免安装） |
| 异地连接 | 自建云中继。两种等价实现：**A** Cloudflare Worker + Durable Object（`cf/`，已上线，免运维）；**B** Node.js + TypeScript 常驻服务（`relay/`，本地调试 / 自有服务器） |
| ASR 位置 | **中继端调用**（密钥留在服务器，手机/Mac 都不持密钥） |
| 触发方式 | **手机按住说话 PTT**（按下录音、松开发送） |
| 后处理 | **doubao-seed-2-0-lite** 加标点 + 纠错（运行时可开关，默认开） |

## 目录结构

```
REMOTEVOICE/
├── cf/         Cloudflare 中继（Worker + Durable Object）：与 relay/ 同协议，已上线
├── relay/      云中继（Node + TS）：配对/房间 + 豆包ASR + LLM后处理（本地/自有服务器）
├── web/        手机 PWA：配对 + PTT 录音（AudioWorklet 16k PCM）
├── mac/        macOS 状态栏 App（SwiftPM）：WS 客户端 + CGEvent 注入
├── wrangler.jsonc     Cloudflare 统一部署配置（PWA 静态资产 + DO 中继同源）
├── docs/PROTOCOL.md   三端通信协议规约
└── README.md
```

## 快速开始（本地三端）

### 1. 中继

```bash
cd relay
cp .env.example .env        # 填入豆包语音凭证（已预填示例值）
npm install
npm run dev                 # tsx 热重载，监听 :8787，并托管 ../web
```

启动后访问：
- 健康：`http://localhost:8787/healthz`
- 手机页：`http://localhost:8787/`（同源托管 web）
- WS：`ws://localhost:8787/ws`

> 手机麦克风要求**安全上下文**（HTTPS）。本机调试可用 `http://localhost`；真机访问需配 HTTPS 或反向代理（见下方"部署"）。

### 2. Mac 客户端

提供两种文字注入方式，按需选其一（也可都用）：

**A. 后台听写 App（CGEvent 注入，开箱即用）**

调试跑：`cd mac && swift run RemoteVoiceInput`。
正式装成 `.app`（放进「应用程序」、可双击启动、默认连云端）：

```bash
cd mac
./build-app.sh            # release 编译 + 打 .app + 签名 + 装到 /Applications
open /Applications/RemoteVoiceInput.app
```

首次启动会弹「辅助功能」授权（CGEvent 注入需要）：到 **系统设置 → 隐私与安全性 → 辅助功能** 打开 RemoteVoiceInput。
状态栏出现 🎙 图标，菜单里可看到 6 位配对码、修改服务器地址、切换 LLM 后处理。
> ad-hoc 签名：每次重新 `build-app.sh` 后辅助功能授权可能需要重开一次。

**B. 原生输入法外壳（InputMethodKit，更"正统"的注入）**

```bash
cd mac/ime
./build.sh                 # 编译 + 组装 .app + 签名 + 装到 ~/Library/Input Methods/
```

安装后到「系统设置 → 键盘 → 输入法 → 编辑 → 添加」选 "RemoteVoice 输入法"。
切换到它后，文字由 IMK 直接交给当前输入框（不依赖辅助功能权限）。
> 注：IME 不用 SPM，用 `build.sh`（swiftc 编译 + 拼 bundle），因为 SPM 产不出可被系统识别的输入法 bundle。

### 3. 手机端

手机浏览器打开中继地址（如 `https://your-host/`），输入 Mac 状态栏显示的 6 位配对码 → 配对 → 按住大按钮说话 → 松开，文字就打到 Mac 当前焦点窗口。

## 配置说明

`relay/.env`（复制自 `.env.example`）：

| 变量 | 说明 |
|---|---|
| `PORT` | 中继监听端口，默认 8787 |
| `WEB_DIR` | 静态站目录（相对 cwd），默认 `../web`；留空则不托管 |
| `DOUBAO_ASR_APP_ID` / `DOUBAO_ASR_ACCESS_TOKEN` / `DOUBAO_ASR_SECRET_KEY` | 豆包**语音服务**凭证（token 鉴权） |
| `DOUBAO_ASR_WSS_URL` | 豆包流式 ASR 的 wss 端点 |
| `DOUBAO_ASR_RESOURCE_ID` | 大模型 ASR 资源 ID，默认 `volc.bigasr.sauc.duration` |
| `ARK_API_KEY` | 火山**方舟** API Key（LLM 后处理用，**与语音 Access Token 不同**；未配则降级） |
| `ARK_MODEL` | 默认 `doubao-seed-2-0-lite-260215` |
| `PAIR_CODE_TTL_MS` | 配对码有效期，默认 5 分钟 |
| `MAX_SESSION_MS` | 单次会话上限，默认 2 分钟 |

## 凭证用途区分（重要）

你提供的 `APP ID / Access Token / Secret Key`（填在本机 `relay/.env`，不入库）是**豆包语音服务**凭证，用于流式 ASR。
而 `doubao-seed-2-0-lite/pro/mini` 走的是**火山方舟（Ark）**，需要**另一个** Ark API Key（不是语音 Access Token）。
LLM 后处理这一环需要单独提供 `ARK_API_KEY`；未配置时中继自动回退为只用 ASR 原文，不阻断主流程。

## 协议

三端通信规约见 [`docs/PROTOCOL.md`](docs/PROTOCOL.md)：配对流程、信令消息、音频格式（16k/16bit/mono PCM）、错误码、安全约束。

## 部署（生产）

### 方案 A：Cloudflare（已上线，推荐，免运维）

PWA 与中继**同一个 Worker、同一个 origin**：静态资产由 Worker 直接服务，`/ws` 落到 Durable Object `RelayHub`（配对/房间/豆包 ASR/LLM 全在其中）。因此 PWA 默认的同源 `wss://host/ws` 直接可用，**无需在设置里手填中继地址**。

- 代码仓库（私有）：https://github.com/sunlinhua-dotcom/remotevoice
- 线上地址（PWA + 中继，HTTPS/WSS）：https://remotevoice-pwa.sunlinhua.workers.dev
- 健康检查：`/healthz` → `{"ok":true,"rooms":N,"llm":true}`
- 配置：[`wrangler.jsonc`](wrangler.jsonc)（`main` + `assets` + DO 绑定 + 迁移）；中继实现见 [`cf/`](cf)。

```bash
# 部署（仓库根目录）
npx wrangler deploy
# 设置密钥（明文不入库；只这三个，其余有默认值）
printf '<APP_ID>'        | npx wrangler secret put DOUBAO_ASR_APP_ID
printf '<ACCESS_TOKEN>'  | npx wrangler secret put DOUBAO_ASR_ACCESS_TOKEN
printf '<ARK_API_KEY>'   | npx wrangler secret put ARK_API_KEY
# 改完密钥后重新部署一次，让 DO 实例拿到新值
npx wrangler deploy
```

> 端到端联调（无需手机，合成音验证链路）：`cd relay && npm run e2e:cf`。
> Mac 端**默认就连这个云端地址**（写死在 `RelayClient.defaultRelayURL`），开 App 即自动连、出配对码，无需手输；状态栏菜单仍可改成别的中继。

### 方案 B：自有服务器（Node 常驻）

完整方案见 [`deploy/`](deploy/)：一键脚本、nginx 配置、systemd 服务、PM2 配置、详细文档。

```bash
sudo DOMAIN=voice.example.com ./deploy/deploy.sh
```

要点：
1. **HTTPS/WSS**：手机麦克风要求安全上下文。nginx 反代 + Let's Encrypt（脚本自动处理）。
2. **进程常驻**：`npm run build` 后用 systemd / PM2 跑 `node dist/server.js`。
3. **密钥**：`.env` 只在服务器上，不入库、不下发。
4. **配对码**：6 位 + TTL + 单次绑定 + room 隔离（已实现）。

## 分阶段路线图

- [x] **P0** 协议 + 中继/手机/Mac 三端骨架，配对与数据通道联通（已联调通过）
- [x] **P1** PTT 录音链路（AudioWorklet 16k PCM）
- [x] **P2** 接豆包流式 ASR（二进制 framing 已核实并用真实凭证联调通过：握手/鉴权/gzip/sequence 全部正确）
- [x] **P3** Mac CGEvent 文字注入
- [x] **P4** LLM 后处理（已实现，含超时降级；配 Ark Key 即生效，未配则用 ASR 原文）
- [x] **P5** 原生 IME 外壳（InputMethodKit，`build.sh` 组装 .app 并安装）
- [x] **P6** 生产部署文档与打包（`deploy/` 一键脚本 + nginx + systemd/PM2）
- [x] **P7** Cloudflare 一体化部署（`cf/` Worker + Durable Object，PWA 与中继同源上线；出站 ASR/gzip framing、配对、端到端均在边缘验证通过）

## 待你提供才能完全跑通的项

- **真实中文语音验证**：ASR 协议已用真实凭证连通豆包（握手/鉴权/gzip/sequence/配对/端到端全部联调通过），但合成波形无法产出可读中文，需用手机录真人语音验证识别效果。
- ~~**`ARK_API_KEY`**~~ ✅ 已配置并验证（本地 + 线上）：LLM 后处理在线，加标点/顿号/纠错正常。
- ~~**公网服务器 + 域名**~~ ✅ 已用 Cloudflare 解决：PWA + 中继同源上线，无需自备服务器。

> **注（doubao-seed-2.0 是推理模型）**：后处理调用必须带 `thinking:{type:"disabled"}`（`relay/src/doubao-llm.ts` 与 `cf/src/doubao-llm.ts` 均已写死）。否则补标点也会触发思维链，实测延迟 30~50s，必然撞 8s 超时回退原文。换非推理模型时可去掉该字段。本地验证脚本：`npm run e2e:pair` / `e2e:asr` / `e2e:llm` / `e2e:cf`。

## License

Private / 个人使用。
