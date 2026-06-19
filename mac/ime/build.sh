#!/usr/bin/env bash
# 构建 RemoteVoiceInputMethod 并安装为系统输入法。
#
# 用法：
#   ./build.sh            # 编译 + 组装 + 签名 + 安装到 ~/Library/Input Methods/
#   ./build.sh build      # 只编译组装，不安装
#
# 说明：
#   - 复用 ../Sources/RemoteVoiceInput/RelayClient.swift（与后台 App 同一套中继客户端）。
#   - 用 swiftc 直接编译（不依赖 SPM 的 target 引用限制）。
#   - 组装为 .app bundle，嵌入 Info.plist，ad-hoc 签名。
#   - 安装后需在「系统设置 → 键盘 → 输入法 → 编辑」里手动添加 "RemoteVoice 输入法"，
#     并在「隐私与安全性」允许运行。必要时注销/重启使系统重新扫描输入法。
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
APP_NAME="RemoteVoiceInputMethod"
APP_DIR="$HERE/build/$APP_NAME.app"
BUNDLE_ID="com.remotevoice.inputmethod"
SHARED="$(cd "$HERE/../Sources/RemoteVoiceInput" && pwd)"

ACTION="${1:-install}"

echo "==> 1/5 编译（swiftc）"
mkdir -p "$HERE/build"
SWIFT_SOURCES=("$HERE/Sources/AppMain.swift" "$HERE/Sources/RVInputController.swift" "$SHARED/RelayClient.swift")
swiftc \
  -target "$(uname -m)-apple-macos12" \
  -sdk "$(xcrun --sdk macosx --show-sdk-path)" \
  -framework Cocoa -framework InputMethodKit \
  -O \
  "${SWIFT_SOURCES[@]}" \
  -o "$HERE/build/$APP_NAME"

echo "==> 2/5 组装 .app bundle"
rm -rf "$APP_DIR"
mkdir -p "$APP_DIR/Contents/MacOS"
cp "$HERE/build/$APP_NAME" "$APP_DIR/Contents/MacOS/$APP_NAME"
mkdir -p "$APP_DIR/Contents/Resources"
cp "$HERE/Info.plist" "$APP_DIR/Contents/Info.plist"

# 图标（若有则拷入，否则用占位）
if [ -f "$HERE/Icon.icns" ]; then
  cp "$HERE/Icon.icns" "$APP_DIR/Contents/Resources/Icon.icns"
fi

echo "==> 3/5 ad-hoc 签名"
codesign --force --sign - "$APP_DIR"

echo "==> 4/5 校验 bundle"
/usr/libexec/PlistBuddy -c "Print :CFBundleExecutable" "$APP_DIR/Contents/Info.plist" >/dev/null
/usr/libexec/PlistBuddy -c "Print :InputMethodServerControllerClass" "$APP_DIR/Contents/Info.plist" >/dev/null
# 无 ComponentInputModeDict 系统不会枚举输入模式，输入法不会出现在可添加列表里。
/usr/libexec/PlistBuddy -c "Print :ComponentInputModeDict" "$APP_DIR/Contents/Info.plist" >/dev/null
echo "    bundle ok: $APP_DIR"

if [ "$ACTION" != "install" ]; then
  echo "==> 跳过安装（仅 build）。产物：$APP_DIR"
  exit 0
fi

echo "==> 5/5 安装到 ~/Library/Input Methods/"
DEST="$HOME/Library/Input Methods"
mkdir -p "$DEST"
rm -rf "$DEST/$APP_NAME.app"
cp -R "$APP_DIR" "$DEST/"
echo
echo "✅ 已安装。接下来："
echo "   1) 打开「系统设置 → 键盘 → 输入法 → 编辑 → 添加」选择 \"RemoteVoice 输入法\""
echo "   2) 首次运行需在「隐私与安全性」允许打开"
echo "   3) 切换到本输入法后，文字会通过 IMK 注入当前焦点输入框"
echo "   4) 中继地址可在 '~/Library/Preferences' 用 defaults 写 com.remotevoice.inputmethod relayUrl <ws>"
echo "   若未出现，注销/重新登录让系统重新扫描输入法目录。"
