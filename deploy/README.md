# 部署指南（生产）

目标：在一台公网 Linux 服务器上跑起中继，手机通过 `https://你的域名/` 访问，Mac 连 `wss://你的域名/ws`。

> 手机麦克风要求**安全上下文**（HTTPS/WSS），所以生产必须上 TLS。

## 方式 A：一键脚本（推荐，Ubuntu/Debian）

```bash
# 在服务器上 clone 项目后：
sudo DOMAIN=voice.example.com ./deploy/deploy.sh
```

脚本会：装 node/nginx/certbot → 部署到 `/opt/remotevoice` → 构建中继 → 申请 Let's Encrypt 证书 → 配置 nginx → 启动 systemd 服务。

首次部署后，**编辑 `/opt/remotevoice/relay/.env`** 填入真实凭证，然后 `sudo systemctl restart remotevoice`。

## 方式 B：手动分步

### 1. 构建中继

```bash
cd relay
cp .env.example .env        # 填凭证
npm ci
npm run build               # 产出 dist/
```

### 2. 进程常驻（二选一）

**systemd：**
```bash
sudo cp deploy/remotevoice.service /etc/systemd/system/
# 编辑该文件确认 WorkingDirectory / User
sudo systemctl daemon-reload
sudo systemctl enable --now remotevoice
```

**PM2：**
```bash
npm i -g pm2
npm run build
pm2 start deploy/ecosystem.config.cjs
pm2 save && pm2 startup
```

### 3. nginx + TLS

`deploy/nginx.conf` 提供完整配置（静态站托管 + `/ws` 反代 + WebSocket upgrade map）。

```bash
sudo cp deploy/nginx.conf /etc/nginx/sites-available/remotevoice
# 把 voice.example.com 改成你的域名；改静态根路径
sudo ln -s /etc/nginx/sites-available/remotevoice /etc/nginx/sites-enabled/
sudo certbot --nginx -d voice.example.com     # 申请证书
sudo nginx -t && sudo systemctl reload nginx
```

## 验证

```bash
curl https://voice.example.com/healthz        # {"ok":true,"rooms":0}
# 浏览器打开 https://voice.example.com/      # PWA 配对面板
# Mac 状态栏 → 服务器：wss://voice.example.com/ws
```

## 关键配置项（relay/.env）

| 变量 | 说明 |
|---|---|
| `DOUBAO_ASR_APP_ID` / `DOUBAO_ASR_ACCESS_TOKEN` | 豆包语音服务凭证 |
| `DOUBAO_ASR_RESOURCE_ID` | `volc.bigasr.sauc.duration`（大模型时长模型） |
| `ARK_API_KEY` | 火山方舟 Key（LLM 后处理；未配则降级用 ASR 原文） |
| `WEB_DIR` | 静态站目录；nginx 托管时可留空 |

## 安全清单

- [ ] `.env` 只在服务器、属主 `remotevoice`、权限 `600`
- [ ] 防火墙只放行 80/443，中继 8787 只监听 127.0.0.1（nginx 反代）
- [ ] 配对码 TTL + 单次绑定（已默认实现）
- [ ] 证书自动续期：`sudo certbot renew --dry-run`

## 常见问题

- **手机麦克风无权限**：必须是 HTTPS，且 `https://` 访问（非 `http://`）。
- **Mac 连不上 wss**：检查 nginx 的 `/ws` location 是否正确转发 upgrade 头。
- **ASR 报鉴权错**：确认 `X-Api-App-Key`/`X-Api-Access-Key`/`X-Api-Resource-Id` 三个 header 都已配置（中继日志会打印上游地址）。
