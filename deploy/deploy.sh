#!/usr/bin/env bash
# RemoteVoice 中继一键部署脚本（Ubuntu/Debian 服务器）
#
# 用法：
#   sudo DOMAIN=voice.example.com ./deploy/deploy.sh
#
# 做的事：
#   1. 装依赖（node、nginx、certbot）
#   2. 创建专用用户 remotevoice，部署代码到 /opt/remotevoice
#   3. 构建中继（npm ci + npm run build）
#   4. 申请 Let's Encrypt 证书并配置 nginx
#   5. 注册 systemd 服务并启动
set -euo pipefail

DOMAIN="${DOMAIN:?用法: sudo DOMAIN=voice.example.com ./deploy/deploy.sh}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
APP_DIR="/opt/remotevoice"
USER_NAME="remotevoice"

echo "==> 1/6 系统依赖（node nginx certbot）"
if ! command -v node >/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
apt-get update -y
apt-get install -y nginx certbot python3-certbot-nginx

echo "==> 2/6 创建用户与目录"
id -u "$USER_NAME" >/dev/null 2>&1 || useradd -r -m -d /home/$USER_NAME -s /usr/sbin/nologin "$USER_NAME"
mkdir -p "$APP_DIR"
rsync -a --delete --exclude node_modules --exclude dist "$ROOT/" "$APP_DIR/"
chown -R "$USER_NAME":"$USER_NAME" "$APP_DIR"

echo "==> 3/6 安装依赖并构建中继"
sudo -u "$USER_NAME" bash -lc "cd $APP_DIR/relay && npm ci && npm run build"

# 准备 .env（首次部署才创建，避免覆盖已有密钥）
if [ ! -f "$APP_DIR/relay/.env" ]; then
  sudo -u "$USER_NAME" cp "$APP_DIR/relay/.env.example" "$APP_DIR/relay/.env"
  echo "    ⚠️  请编辑 $APP_DIR/relay/.env 填入豆包凭证与 ARK_API_KEY 后重启服务"
fi
mkdir -p "$APP_DIR/relay/logs" && chown -R "$USER_NAME":"$USER_NAME" "$APP_DIR/relay/logs"

echo "==> 4/6 申请 TLS 证书（Let's Encrypt）"
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "admin@$DOMAIN" || true

echo "==> 5/6 配置 nginx"
# 替换模板里的域名与静态根
sed "s#voice.example.com#$DOMAIN#g; s#/opt/remotevoice/web#$APP_DIR/web#g" \
  "$HERE/nginx.conf" > /etc/nginx/sites-available/remotevoice
ln -sf /etc/nginx/sites-available/remotevoice /etc/nginx/sites-enabled/remotevoice
nginx -t && systemctl reload nginx

echo "==> 6/6 注册并启动 systemd 服务"
cp "$HERE/remotevoice.service" /etc/systemd/system/remotevoice.service
# WorkingDirectory 指向 APP_DIR/relay
sed -i "s#/opt/remotevoice/relay#$APP_DIR/relay#g" /etc/systemd/system/remotevoice.service
systemctl daemon-reload
systemctl enable --now remotevoice

echo
echo "✅ 部署完成：https://$DOMAIN"
echo "   - 中继日志：journalctl -u remotevoice -f"
echo "   - 健康检查：curl https://$DOMAIN/healthz"
echo "   - 若 .env 未填密钥，请编辑后：sudo systemctl restart remotevoice"
