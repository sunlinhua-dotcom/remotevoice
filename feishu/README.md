# 飞书机器人「远程语音」监听器

一条**不碰实时音频**的稳定输入通道：在飞书里私聊机器人发一条语音，它转写成文字，经云中继注入到你的 Mac 当前窗口。

```
飞书 App 发语音
  → (长连接) im.message.receive_v1
  → 下载 opus 语音 + 飞书 speech_to_text 转写
  → 作为 phone 连云中继，发 inject_text
  → 中继当 final 广播 → Mac 注入到当前窗口（无输入框则进剪贴板）
```

和实时 PWA 通道并存，互不影响——这条更省心，靠飞书自己的多模态做转写。

## 一次性配置

先在飞书开放平台**用浏览器控制**创建并配置好自建应用「远程语音」（开机器人能力、加权限
`im:message` / `im:message.p2p_msg:readonly` / `im:resource` / `speech_to_text:speech`、
事件与回调都用长连接、加事件 `im.message.receive_v1`、发版）——完整分步见根目录
[`REPRODUCE.md`](../REPRODUCE.md) 第 5 步。

配好后：

1. 在你应用的「凭证与基础信息」里复制 **App ID** 和 **App Secret**。
2. `cp .env.example .env`，填好 `FEISHU_APP_ID` / `FEISHU_APP_SECRET` / `RELAY_URL` / `MAC_ID`。
   `.env` 已被 gitignore，不会入库。

## 运行

```bash
cd feishu
npm install      # 首次
npm start        # 长跑这一个进程
```

看到 `飞书长连接已启动` + `relay 已配对 ✅` 即就绪。

然后在飞书里找到机器人 **远程语音**（搜索或工作台），私聊它发一条**语音**消息，
电脑当前窗口就会出现转写后的文字，机器人也会回 `✅ 已注入：…`。

## 让它常驻（可选）

```bash
npx pm2 start listener.mjs --name rv-feishu --cwd "$(pwd)"
npx pm2 save
```

## 配置项（`.env`）

| 变量 | 说明 |
|---|---|
| `FEISHU_APP_ID` | 飞书应用 ID（已填）|
| `FEISHU_APP_SECRET` | 飞书应用密钥（**需你填**）|
| `RELAY_URL` | 云中继 `/ws` 端点（已填）|
| `MAC_ID` | 目标 Mac 的永久 macId = 房间（已填）|
| `DEVICE_NAME` | 在 Mac 设备列表里显示的名字 |

## 排错

- `relay 已配对` 没出现 → 中继连不上，多半是网络（workers.dev 在国内常需科学上网）。
- 机器人收不到语音 → 确认在**私聊**里发的是语音消息；确认应用已发布且可用范围含本人。
- 回复 `处理失败：…` → 看进程日志里的具体报错（转写/下载）。若转写报格式错，
  本机装 `ffmpeg` 后可在 `transcribe()` 前把 opus 转 wav 再送。
