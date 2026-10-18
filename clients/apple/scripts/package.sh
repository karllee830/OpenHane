#!/usr/bin/env bash
# 打包苹果客户端（发布流程和本机共用）：
#   ./scripts/package.sh macos 0.1.0-beta.1 [构建号]   → dist/OpenHane-<版本>-macOS.dmg / .zip（通用二进制）
#   ./scripts/package.sh ios   0.1.0-beta.1 [构建号]   → dist/OpenHane-<版本>-iOS-unsigned.ipa（未签名，需要自行重新签名后安装）
# 版本号可以带 -beta 等后缀；写入应用时只保留 x.y.z（苹果要求 CFBundleShortVersionString 为纯数字）。
#
# macOS 的签名方式：
#   设置了 HANE_SIGN_IDENTITY（钥匙串里的「Developer ID Application: …」证书名）时，用开发者证书签名、开启强化运行时，
#   并用 App Store Connect API 密钥公证（ASC_KEY_PATH / ASC_KEY_ID / ASC_ISSUER_ID），公证票据钉在应用和 dmg 上；
#   没有设置时临时签名、不公证（本机测试用；首次打开需要右键「打开」）。HANE_REQUIRE_SIGNING=1 时没有证书直接失败。
set -euo pipefail
cd "$(dirname "$0")/.."
PLATFORM=${1:?用法：package.sh macos|ios <版本号> [构建号]}
VERSION=${2:?缺少版本号}
BUILD=${3:-1}
MARKETING=$(echo "$VERSION" | sed -E 's/^v//; s/^([0-9]+\.[0-9]+\.[0-9]+).*/\1/')
DERIVED=${DERIVED:-build/DerivedData-$PLATFORM}
OUT=${OUT:-dist}
mkdir -p "$OUT"

./scripts/setup.sh
command -v xcodegen >/dev/null || { echo "需要 xcodegen（brew install xcodegen）" >&2; exit 1; }
xcodegen generate --quiet

# DEPLOYMENT_POSTPROCESSING：去掉符号表（与 Archive 相同）。AI 降噪的 Rust 静态库带了大量符号，不去掉时 iOS 安装包多约 3 MB
common=(-project OpenHane.xcodeproj -configuration Release -derivedDataPath "$DERIVED"
  MARKETING_VERSION="$MARKETING" CURRENT_PROJECT_VERSION="$BUILD" HANE_VERSION="$VERSION" DEPLOYMENT_POSTPROCESSING=YES)

case "$PLATFORM" in
macos)
  if [ -n "${HANE_SIGN_IDENTITY:-}" ]; then
    : "${ASC_KEY_PATH:?签名时需要 ASC_KEY_PATH（App Store Connect API 密钥 .p8）}" "${ASC_KEY_ID:?缺少 ASC_KEY_ID}" "${ASC_ISSUER_ID:?缺少 ASC_ISSUER_ID}"
    team=$(echo "$HANE_SIGN_IDENTITY" | sed -nE 's/.*\(([A-Z0-9]{10})\)$/\1/p')
    [ -n "$team" ] || { echo "无法从证书名中取得团队 ID：$HANE_SIGN_IDENTITY" >&2; exit 1; }
    sign=(CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY="$HANE_SIGN_IDENTITY" DEVELOPMENT_TEAM="$team"
      ENABLE_HARDENED_RUNTIME=YES CODE_SIGN_INJECT_BASE_ENTITLEMENTS=NO OTHER_CODE_SIGN_FLAGS=--timestamp)
  elif [ "${HANE_REQUIRE_SIGNING:-}" = 1 ]; then
    echo "HANE_REQUIRE_SIGNING=1 但没有设置 HANE_SIGN_IDENTITY（Developer ID 证书）" >&2; exit 1
  else
    # 临时签名（没有开发者证书）时必须关闭强化运行时：强化运行时强制「库校验」，要求嵌入的框架与主程序属于同一个团队，
    # 而临时签名没有团队 ID，启动时加载 LiveKitWebRTC.framework 就会被拒绝。
    sign=(CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM= ENABLE_HARDENED_RUNTIME=NO CODE_SIGN_INJECT_BASE_ENTITLEMENTS=NO)
  fi
  xcodebuild "${common[@]}" -scheme OpenHane-macOS -destination 'generic/platform=macOS' \
    ARCHS="arm64 x86_64" ONLY_ACTIVE_ARCH=NO "${sign[@]}" \
    build | tail -3
  app="$DERIVED/Build/Products/Release/OpenHane.app"
  if [ -n "${HANE_SIGN_IDENTITY:-}" ]; then
    # Xcode 复制 Sparkle.framework 时只重签框架本身，里面的辅助程序仍是 Sparkle 自带的签名，公证会拒绝。
    # 按从里到外的顺序用 Developer ID 重签（Downloader.xpc 保留自带的沙盒权限），最后重签整个应用
    sparkle="$app/Contents/Frameworks/Sparkle.framework"
    cs=(codesign --force --sign "$HANE_SIGN_IDENTITY" --options runtime --timestamp)
    "${cs[@]}" "$sparkle/Versions/B/XPCServices/Installer.xpc"
    "${cs[@]}" --preserve-metadata=entitlements "$sparkle/Versions/B/XPCServices/Downloader.xpc"
    "${cs[@]}" "$sparkle/Versions/B/Autoupdate"
    "${cs[@]}" "$sparkle/Versions/B/Updater.app"
    "${cs[@]}" "$sparkle"
    "${cs[@]}" --entitlements App-macOS/OpenHane.entitlements "$app"
  fi
  codesign --verify --deep --strict "$app"
  lipo -archs "$app/Contents/MacOS/OpenHane"
  # 启动检查：签名格式正确不代表能启动（dyld 的库校验只在加载时发生）。启动 5 秒后进程必须还在
  log=$(mktemp)
  HANE_E2E=1 "$app/Contents/MacOS/OpenHane" >"$log" 2>&1 &
  pid=$!
  sleep 5
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "打包出来的应用无法启动：" >&2
    cat "$log" >&2
    exit 1
  fi
  kill "$pid"
  wait "$pid" 2>/dev/null || true
  echo "启动检查通过"

  # 提交公证并等结果；不通过时打印苹果给的原因
  notarize() {
    local res id
    res=$(xcrun notarytool submit "$1" --key "$ASC_KEY_PATH" --key-id "$ASC_KEY_ID" --issuer "$ASC_ISSUER_ID" --wait --output-format json || true)
    id=$(echo "$res" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("id",""))' 2>/dev/null || true)
    if ! echo "$res" | grep -q '"status" *: *"Accepted"'; then
      echo "$res" >&2
      [ -n "$id" ] && xcrun notarytool log "$id" --key "$ASC_KEY_PATH" --key-id "$ASC_KEY_ID" --issuer "$ASC_ISSUER_ID" >&2
      echo "公证没有通过：$1" >&2
      exit 1
    fi
    echo "公证通过：$(basename "$1")"
  }
  if [ -n "${HANE_SIGN_IDENTITY:-}" ]; then
    [[ "$(codesign -dv "$app" 2>&1)" == *"flags="*"(runtime)"* ]] || { echo "没有开启强化运行时" >&2; exit 1; }
    zip=$(mktemp -d)/notarize.zip
    ditto -c -k --keepParent "$app" "$zip"
    notarize "$zip"
    xcrun stapler staple -q "$app"
    spctl -a -vv "$app"
  fi

  name="OpenHane-$VERSION-macOS"
  ditto -c -k --keepParent "$app" "$OUT/$name.zip"
  staging=$(mktemp -d)
  cp -R "$app" "$staging/"
  ln -s /Applications "$staging/Applications"
  # hdiutil 在 CI 机器上偶尔报 Resource busy，失败时重试
  for try in 1 2 3 4 5; do
    hdiutil create -volname "OpenHane $VERSION" -srcfolder "$staging" -format UDZO -ov "$OUT/$name.dmg" >/dev/null && break
    [ "$try" -lt 5 ] || exit 1
    echo "创建 dmg 失败，$((try * 10)) 秒后重试" >&2
    sleep $((try * 10))
  done
  rm -rf "$staging"
  if [ -n "${HANE_SIGN_IDENTITY:-}" ]; then
    codesign --force --sign "$HANE_SIGN_IDENTITY" --timestamp "$OUT/$name.dmg"
    notarize "$OUT/$name.dmg"
    xcrun stapler staple -q "$OUT/$name.dmg"
    spctl -a -t open --context context:primary-signature -vv "$OUT/$name.dmg"
  fi
  ;;
ios)
  xcodebuild "${common[@]}" -scheme OpenHane-iOS -destination 'generic/platform=iOS' \
    CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO \
    build | tail -3
  app="$DERIVED/Build/Products/Release-iphoneos/OpenHane.app"
  staging=$(mktemp -d)
  mkdir -p "$staging/Payload"
  cp -R "$app" "$staging/Payload/"
  (cd "$staging" && zip -qr - Payload) > "$OUT/OpenHane-$VERSION-iOS-unsigned.ipa"
  rm -rf "$staging"
  ;;
*)
  echo "未知平台 $PLATFORM" >&2; exit 1 ;;
esac
ls -la "$OUT"
