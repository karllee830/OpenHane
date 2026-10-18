#!/usr/bin/env bash
# 构建各平台的独立二进制（带网页版），打包并生成 SHA256SUMS。
#   VERSION=1.0.0 ./scripts/release.sh [平台…]
# 默认平台：linux/amd64 linux/arm64 windows/amd64，在 macOS 上另加 darwin/arm64 darwin/amd64。
# Linux / Windows 是纯 Go 交叉编译；macOS 版需要 cgo（LiveKit 读取 CPU 统计），只能在 macOS 上构建。
# 网页版的 AI 降噪（WASM + 模型）由 clients/deepfilter/build.sh web 生成（发布流程会先做；没有时照常构建，只是不带 AI 降噪）。
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=${VERSION:-dev}
BUILD=${BUILD:-}
OUT=${OUT:-dist}

if [ $# -gt 0 ]; then
  targets=("$@")
else
  targets=(linux/amd64 linux/arm64 windows/amd64)
  [ "$(uname -s)" = Darwin ] && targets+=(darwin/arm64 darwin/amd64)
fi

# 网页版构建一次，嵌入所有平台的二进制
if [ "${SKIP_WEB:-}" != 1 ]; then
  (cd ../clients/web && npm ci --no-audit --no-fund && HANE_VERSION="$VERSION" HANE_BUILD="$BUILD" npm run build)
  find internal/webui/dist -mindepth 1 ! -name .gitignore ! -name .gitkeep -exec rm -rf {} +
  cp -R ../clients/web/apps/web/dist/. internal/webui/dist/
fi
test -f internal/webui/dist/index.html || { echo "缺少网页版（internal/webui/dist）" >&2; exit 1; }

rm -rf "$OUT" && mkdir -p "$OUT"
for t in "${targets[@]}"; do
  os=${t%/*} arch=${t#*/}
  name="openhane_${VERSION}_${os}_${arch}"
  dir="$OUT/$name"
  mkdir -p "$dir"
  bin=openhane
  [ "$os" = windows ] && bin=openhane.exe
  cgo=0
  [ "$os" = darwin ] && cgo=1
  echo "==> $t"
  GOOS=$os GOARCH=$arch CGO_ENABLED=$cgo go build -trimpath -ldflags="-s -w -X main.version=$VERSION" -o "$dir/$bin" ./cmd/openhane
  cp ../README.md ../LICENSE ../TRADEMARKS.md ../.github/SECURITY.md "$dir/"
  cp -R ../deploy "$dir/deploy"
  if [ "$os" = windows ]; then
    (cd "$OUT" && zip -qr "$name.zip" "$name")
  else
    tar -C "$OUT" -czf "$OUT/$name.tar.gz" "$name"
  fi
  rm -rf "$dir"
done
(cd "$OUT" && shasum -a 256 openhane_* > SHA256SUMS)
ls -la "$OUT"
