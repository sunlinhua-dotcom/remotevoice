#!/usr/bin/env bash
# 一次性创建一个"稳定的自签名代码签名证书"，放进一个专用 keychain。
#
# 为什么：macOS 的 TCC 把"辅助功能"授权绑定在 App 签名的 designated requirement（DR）上。
# ad-hoc 签名（codesign -s -）没有稳定证书，DR 退化成 cdhash，每次重编译都变 → 授权失效要重授。
# 用同一张自签名证书签名 → DR 不变（identifier + 证书指纹）→ 反复 swift build 后授权依然保留。
#
# 跑一次即可（幂等：重复跑会先删旧的再建）。之后 build-app.sh 会自动用它签名。
# 这张证书只用于本机签名、不参与 Gatekeeper 信任，不需要 99 美元开发者账号。
set -euo pipefail

KC="$HOME/Library/Keychains/remotevoice-signing.keychain-db"
KCPASS="${RV_KCPASS:-rvlocal-signing}"   # 仅保护这个一次性签名 keychain，不是任何敏感口令
CN="${RV_SIGN_ID:-RemoteVoice Local Signing}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "==> 1) 生成带 codeSigning EKU 的自签名证书"
cat > "$TMP/cert.cnf" <<CNF
[req]
distinguished_name=dn
x509_extensions=v3
prompt=no
[dn]
CN=$CN
[v3]
basicConstraints=critical,CA:false
keyUsage=critical,digitalSignature
extendedKeyUsage=critical,codeSigning
CNF
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$TMP/key.pem" -out "$TMP/cert.pem" \
  -days 7300 -config "$TMP/cert.cnf" >/dev/null 2>&1
# -legacy：让 macOS 的 security 能读懂 p12 的 MAC（OpenSSL 3.x 默认算法 security 不认）
openssl pkcs12 -export -out "$TMP/id.p12" -inkey "$TMP/key.pem" -in "$TMP/cert.pem" \
  -passout pass:rv -name "$CN" -legacy >/dev/null 2>&1

echo "==> 2) 建专用 keychain 并导入（用本脚本生成的密码，全程免交互）"
security delete-keychain "$KC" 2>/dev/null || true
security create-keychain -p "$KCPASS" "$KC"
security set-keychain-settings "$KC"                       # 去掉自动锁定超时
security unlock-keychain -p "$KCPASS" "$KC"
security import "$TMP/id.p12" -k "$KC" -P rv -A -T /usr/bin/codesign
# 关键：设 partition list（用我们自己的 keychain 密码），否则 codesign 报 errSecInternalComponent / 弹框
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KCPASS" "$KC" >/dev/null 2>&1

echo "==> 3) 自检：用它签一个临时二进制"
cp /bin/echo "$TMP/testbin"
if codesign --force --keychain "$KC" --sign "$CN" --identifier com.test.rv "$TMP/testbin" 2>/dev/null; then
  AUTH=$(codesign -dvvv "$TMP/testbin" 2>&1 | grep -i "Authority=" | head -1)
  echo "✅ 证书可用：$AUTH"
  echo "   现在跑 ./build-app.sh 就会自动用它签名；授权一次后，以后重编译不再需要重新授权。"
else
  echo "❌ 签名自检失败，请把上面的输出贴出来排查。"
  exit 1
fi
