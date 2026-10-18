#!/bin/sh
# 拉取 LiveKit Swift SDK 并打上羽见补丁（自定义证书信任、运行时调整视频编码），放到 .vendor/（不入库）。
# 然后构建 AI 降噪库（DeepFilterNet3，需要 Rust）：没装 Rust 时跳过，应用照常构建但不带 AI 降噪。
#   HANE_REQUIRE_DFN=1      必须带 AI 降噪（CI 和发布构建）：没装 Rust 时失败
#   HANE_DFN_PLATFORMS=ios  只构建一个平台的库（默认 macos ios）
set -eu
cd "$(dirname "$0")/.."
LIVEKIT_VERSION=2.17.0
DIR=.vendor/client-sdk-swift
if [ -d "$DIR" ] && [ "$(cat "$DIR/.hane-version" 2>/dev/null)" = "$LIVEKIT_VERSION+$(shasum -a 256 patches/livekit-swift-openhane.patch | cut -c1-16)" ]; then
  echo "$DIR is up to date"
else
  rm -rf "$DIR"
  git clone -q --depth 1 --branch "$LIVEKIT_VERSION" https://github.com/livekit/client-sdk-swift.git "$DIR"
  git -C "$DIR" apply "$PWD/patches/livekit-swift-openhane.patch"
  echo "$LIVEKIT_VERSION+$(shasum -a 256 patches/livekit-swift-openhane.patch | cut -c1-16)" > "$DIR/.hane-version"
  echo "patched LiveKit SDK ready at $DIR"
fi

if command -v cargo >/dev/null 2>&1; then
  # shellcheck disable=SC2086
  ../deepfilter/build.sh apple ${HANE_DFN_PLATFORMS:-macos ios}
elif [ "${HANE_REQUIRE_DFN:-}" = 1 ]; then
  echo "构建 AI 降噪需要 Rust：https://rustup.rs" >&2
  exit 1
else
  echo "没有安装 Rust：跳过 AI 降噪（应用照常构建，只是不带 AI 降噪）"
fi
