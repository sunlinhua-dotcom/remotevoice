#!/usr/bin/env bash
# 把状态栏听写 App 打包成正经 .app 并安装。
#
# 用法：
#   ./build-app.sh            # release 编译 + 组装 .app + 签名 + 装到 /Applications（失败则装到 ~/Applications）
#   ./build-app.sh build      # 只产出 .app，不安装
#   DEST=~/Applications ./build-app.sh   # 指定安装目录
#
# 安装后双击启动；状态栏出现 🎙，自动连云端中继并显示 6 位配对码。
# 首次运行会弹「辅助功能」授权（CGEvent 注入需要），到「系统设置 → 隐私与安全性 → 辅助功能」打开本 App。
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
APP_NAME="RemoteVoiceInput"
APP_DIR="$HERE/build/$APP_NAME.app"
ACTION="${1:-install}"

echo "==> 1/4 release 编译"
swift build -c release --package-path "$HERE"
BIN_DIR="$(swift build -c release --package-path "$HERE" --show-bin-path)"

echo "==> 2/4 组装 .app bundle"
rm -rf "$APP_DIR"
mkdir -p "$APP_DIR/Contents/MacOS" "$APP_DIR/Contents/Resources"
cp "$BIN_DIR/$APP_NAME" "$APP_DIR/Contents/MacOS/$APP_NAME"
cp "$HERE/Info.plist" "$APP_DIR/Contents/Info.plist"
[ -f "$HERE/Icon.icns" ] && cp "$HERE/Icon.icns" "$APP_DIR/Contents/Resources/Icon.icns" || true

echo "==> 3/4 代码签名"
# 优先用稳定的自签名证书签名：TCC 把"辅助功能"授权绑定在签名的 designated requirement 上，
# 同一证书 → DR 不变 → 反复重编译后授权依然保留（不再每次重新授权）。
# 没有该证书时回退 ad-hoc。证书一次性创建见 mac/create-signing-cert.sh。
RV_KEYCHAIN="$HOME/Library/Keychains/remotevoice-signing.keychain-db"
RV_SIGN_ID="${RV_SIGN_ID:-RemoteVoice Local Signing}"
RV_KCPASS="${RV_KCPASS:-rvlocal-signing}"
[ -f "$RV_KEYCHAIN" ] && security unlock-keychain -p "$RV_KCPASS" "$RV_KEYCHAIN" 2>/dev/null || true
if [ -f "$RV_KEYCHAIN" ] && codesign --force --keychain "$RV_KEYCHAIN" --sign "$RV_SIGN_ID" --identifier com.remotevoice.input "$APP_DIR" 2>/dev/null; then
  echo "    ✅ 用稳定自签名身份「$RV_SIGN_ID」——辅助功能授权可跨重编译保留"
else
  echo "    ⚠️ 未找到稳定签名证书，回退 ad-hoc（授权每次重编译会失效）。跑 mac/create-signing-cert.sh 一次即可一劳永逸"
  codesign --force --sign - --identifier com.remotevoice.input "$APP_DIR"
fi
/usr/libexec/PlistBuddy -c "Print :CFBundleExecutable" "$APP_DIR/Contents/Info.plist" >/dev/null
echo "    bundle ok: $APP_DIR"

if [ "$ACTION" = "build" ]; then
  echo "==> 跳过安装（仅 build）。产物：$APP_DIR"
  exit 0
fi

echo "==> 4/4 安装"
DEST="${DEST:-/Applications}"
if ! { rm -rf "$DEST/$APP_NAME.app" && cp -R "$APP_DIR" "$DEST/"; } 2>/dev/null; then
  echo "    /Applications 不可写，改装到 ~/Applications"
  DEST="$HOME/Applications"
  mkdir -p "$DEST"
  rm -rf "$DEST/$APP_NAME.app"
  cp -R "$APP_DIR" "$DEST/"
fi
echo "✅ 已安装：$DEST/$APP_NAME.app"
echo "   启动： open \"$DEST/$APP_NAME.app\""
