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

echo "==> 3/4 ad-hoc 签名"
codesign --force --sign - "$APP_DIR"
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
