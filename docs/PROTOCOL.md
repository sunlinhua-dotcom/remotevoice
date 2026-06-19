# RemoteVoice 通信协议（v1）

三端通过一个云中继（relay）互联：**手机（PWA）** 采集音频，**中继（Node）** 调豆包流式 ASR + LLM 后处理，**Mac（听写 App）** 注入文字。

设计目标：把"音频转发"替换成"文字转发"——音频只走 `手机 → 中继`，到被控主机的是键盘事件，规避 UU 远程音频链路的 bug。

---

## 1. 传输层

- **协议**：单一 WebSocket（`wss://relay/ws`），所有消息走这一条连接。
- **角色（role）**：连接建立后第一条消息必须是 `hello`，声明自己是 `mac` 还是 `phone`。
- **编码**：文本帧 = UTF-8 JSON（控制信令）；二进制帧 = 裸 PCM 音频（仅 phone→relay 方向）。
- **心跳**：任一端 30s 无消息应发送 `ping`，对端回 `pong`；60s 无响应视为断线。

---

## 2. 配对流程

```
Mac 启动                        Phone 打开 PWA
   │ hello{role:mac}               │ hello{role:phone, code:"482913"}
   │◄ assign{code:"482913"}        │
   │                               │
   │                  relay 把 phone 绑入 room
   │◄ paired{peer:"phone"}         │◄ paired{peer:"mac"}
```

- Mac 用 `hello{role:"mac"}` 申请配对码；中继生成 6 位数字码并 `assign` 回 Mac。
- Mac 把配对码展示在状态栏。
- Phone 用 `hello{role:"phone", code:"482913"}` 入房；中继校验码存在且未占用，把两端绑入同一 `room`，分别回 `paired`。
- 配对码 **5 分钟有效**、**单次绑定**（用完即废，断线后需重新配对）。

---

## 3. 信令消息（JSON 文本帧）

所有消息含 `type` 字段。下表 `方向` 列出发送方→中继方向（中继会按需转发或处理后回送）。

### 3.1 连接与配对

| type | 方向 | 字段 | 说明 |
|---|---|---|---|
| `hello` | c→r | `role`:"mac"\|"phone", `code?`:string | 入网。mac 不带 code（申请新码）；phone 带 code 入房。 |
| `assign` | r→c | `code`:string | 给 mac 分配的配对码。 |
| `paired` | r→c | `peer`:"mac"\|"phone" | 配对成功，告诉对方对端已就绪。 |
| `peer_gone` | r→c | `peer`:"mac"\|"phone" | 对端掉线。 |
| `error` | r→c | `code`:string, `message`:string | 错误。`bad_code`/`bad_role`/`room_full`/`internal`。 |
| `ping` / `pong` | 双向 | — | 心跳。 |

> `c→r` = client→relay，`r→c` = relay→client。

### 3.2 语音会话（PTT 一次说话）

| type | 方向 | 字段 | 说明 |
|---|---|---|---|
| `start` | phone→r (转发 mac) | `format`:{sampleRate:16000, channels:1, bits:16}, `ts`:ms | 按下录音开始。中继据此建到豆包 ASR 的上游连接。 |
| *(binary)* | phone→r | 裸 PCM 帧 | 约 100ms/帧（1600 samples × 2B = 3200B）。中继转发给豆包 ASR。 |
| `partial` | r→mac+phone | `text`:string | ASR 增量句（实时回显）。中继广播给房间两端，手机端据此显示“正在聆听”。 |
| `end` | phone→r | `ts`:ms | 松手，结束本次录音。中继等豆包 ASR `final`。 |
| `final` | r→mac+phone | `text`:string, `raw`:string, `llm`:bool | 最终识别结果（经 LLM 后处理后）。Mac 据此注入文字；手机端用于回显。 |
| `asr_error` | r→mac+phone | `message`:string | ASR 链路异常，房间两端都会收到。 |

### 3.3 运行期配置

| type | 方向 | 字段 | 说明 |
|---|---|---|---|
| `config` | mac→r →(中继重发 phone) | `llm_postprocess`:bool | Mac 侧开关 LLM 后处理（默认 `true`）。中继不原样转发，而是按 room 状态重发一条 `config` 给 phone。 |
| `config` | r→phone | `llm_postprocess`:bool | 配对成功后，中继主动把当前 LLM 开关推给 phone，便于其 UI 初始化。 |
| `status` | r→mac+phone | `relay_connected`:bool, `peer`:string, `asr_ok`:bool | 上线/变动/配对时推送当前状态；配对时两端各收一次。 |

---

## 4. 音频格式约定

- **格式**：PCM 16-bit signed little-endian，单声道，16 kHz。（豆包大模型流式 ASR 推荐参数）
- **采集**：PWA 用 Web Audio + AudioWorklet 在浏览器原生采样率采集，统一重采样到 16 kHz、Float32→Int16。
- **分帧**：累积到约 **100 ms**（3200 字节）作为一帧 binary 发送。
- **不在二进制帧里放头部**：格式在 `start.format` 里声明一次，二进制帧就是纯 PCM，中继与豆包都按裸 PCM 处理。

> 后续若带宽吃紧，可在 `start.format` 增加 `codec:"opus"`，中继解码后再转给豆包。v1 先用裸 PCM 求简。

---

## 5. 错误码

| code | 触发 |
|---|---|
| `bad_role` | `hello` 的 role 非法或缺 role |
| `bad_code` | phone 提交的配对码不存在/已过期/已用 |
| `room_full` | 房间已有对端，拒绝第三者 |
| `not_paired` | 未配对就发 start/binary/end |
| `bad_state` | 在错误状态下发信令（如未 start 就 end） |
| `asr_error` | 豆包 ASR 上游连接/鉴权/解析失败 |
| `internal` | 其它服务端错误 |

---

## 6. 安全

- **密钥**：豆包语音凭证、方舟 Ark Key 只存中继 `.env`，永不下发到 phone/mac。
- **传输**：生产用 `wss://`（PWA 麦克风要求安全上下文）。
- **配对**：6 位码（CSPRNG 生成）+ TTL + 单次绑定；room 之间严格隔离，按 **room（配对码/房间成员）** 路由，绝不跨房转发。
- **暴力破解防护**：配对失败按单连接（5 次）与单 IP（每分钟 20 次）双重限流，超限即断开连接。
- **限流**：单次会话时长上限 `MAX_SESSION_MS`（到点强制结束，防半开连接泄漏上游 ASR 连接）。
