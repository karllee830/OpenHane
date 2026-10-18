#!/bin/sh
# 构建 AI 降噪库（DeepFilterNet3），产物不入库：
#   build.sh web                 网页版 / 桌面版：clients/web/packages/audio-dsp/dfn/（WASM + 模型）
#   build.sh apple [macos] [ios] 苹果端：OpenHaneKit 的 Binaries/HaneDeepFilter.xcframework + HaneMedia 的模型资源
# 需要 rustup（按 rust-toolchain.toml 自动安装锁定版本的 Rust）、curl、tar、patch；苹果端另需 Xcode。
# 输入（源码、Cargo.lock、本脚本、补丁）没有变化时直接跳过。
set -eu
cd "$(dirname "$0")"
HERE=$(pwd)
ROOT=$(cd ../.. && pwd)

# 模型：DeepFilterNet 官方仓库里的 DeepFilterNet3（与 libdf/UPSTREAM.md 同一提交），下载后校验哈希
MODEL_URL=https://raw.githubusercontent.com/Rikorose/DeepFilterNet/d375b2d8309e0935d165700c91da9de862a99c31/models/DeepFilterNet3_onnx.tar.gz
MODEL_SHA256=c94d91f70911001c946e0fabb4aa9adc37045f45a03b56008cb0c8244cb63616
# tract-linalg 源码（打上 patches/tract-linalg-no-amx.patch），哈希与 crates.io 索引一致
LINALG_VERSION=0.21.7
LINALG_SHA256=ad0506e62347d2f3a6bb6a6ad647b4200a11e58be4ca5ba9622e9689bb8ec6c1

WEB_OUT=$ROOT/clients/web/packages/audio-dsp/dfn
# 编译目录可以用 CARGO_TARGET_DIR 放到本地磁盘（仓库在网络共享上时编译很慢）
TARGET=${CARGO_TARGET_DIR:-$HERE/target}
KIT=$ROOT/clients/apple/Packages/OpenHaneKit

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# fetch <url> <文件> <sha256>：已存在且哈希一致时跳过
fetch() {
  if [ -f "$2" ] && [ "$(sha256 "$2")" = "$3" ]; then return; fi
  curl -fsSL --retry 3 -o "$2.part" "$1"
  got=$(sha256 "$2.part")
  if [ "$got" != "$3" ]; then
    echo "校验失败：$1（$got，应为 $3）" >&2
    rm -f "$2.part"
    exit 1
  fi
  mv "$2.part" "$2"
}

prepare() {
  command -v cargo >/dev/null 2>&1 || { echo "需要 Rust：https://rustup.rs" >&2; exit 1; }
  # 安装 rust-toolchain.toml 锁定的版本（新版 rustup 不一定自动安装）
  if command -v rustup >/dev/null 2>&1; then
    rustup toolchain install "$(sed -n 's/^channel = "\(.*\)"/\1/p' rust-toolchain.toml)" --profile minimal --target wasm32-unknown-unknown >/dev/null
  fi
  mkdir -p build
  fetch "$MODEL_URL" build/DeepFilterNet3_onnx.tar.gz "$MODEL_SHA256"
  if [ ! -f build/tract-linalg/.hane-patched ]; then
    fetch "https://static.crates.io/crates/tract-linalg/tract-linalg-$LINALG_VERSION.crate" build/tract-linalg.crate "$LINALG_SHA256"
    rm -rf build/tract-linalg
    mkdir -p build/tract-linalg
    tar xzf build/tract-linalg.crate -C build/tract-linalg --strip-components 1
    patch -s -p1 -d build/tract-linalg < patches/tract-linalg-no-amx.patch
    touch build/tract-linalg/.hane-patched
  fi
}

# 输入的指纹：源码、锁文件、工具链、补丁、本脚本
fingerprint() {
  find Cargo.toml Cargo.lock rust-toolchain.toml build.sh src libdf include patches -type f | LC_ALL=C sort | while read -r f; do
    printf '%s %s\n' "$f" "$(sha256 "$f")"
  done | {
    if command -v sha256sum >/dev/null 2>&1; then sha256sum; else shasum -a 256; fi
  } | cut -d' ' -f1
}

# 编译时把本机路径换成固定前缀（panic 信息里带源码路径），不同机器编出的 WASM 相同
remap() {
  printf -- '--remap-path-prefix=%s=/hane --remap-path-prefix=%s=/cargo' "$HERE" "${CARGO_HOME:-$HOME/.cargo}"
}

build_web() {
  stamp="$(fingerprint) $1"
  if [ -f "$1/.hane-stamp" ] && [ "$(cat "$1/.hane-stamp")" = "$stamp" ] && [ -f "$1/hane-deepfilter.wasm" ]; then
    echo "AI 降噪（WASM）已是最新：$1"
    return
  fi
  prepare
  CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS="-C target-feature=+simd128 $(remap)" \
    cargo build --release --locked --target wasm32-unknown-unknown
  mkdir -p "$1"
  cp "$TARGET/wasm32-unknown-unknown/release/hane_deepfilter.wasm" "$1/hane-deepfilter.wasm"
  # 扩展名用 .bin：有的静态文件服务器会给 .gz 加 Content-Encoding，浏览器自动解压后模型就坏了
  cp build/DeepFilterNet3_onnx.tar.gz "$1/deepfilternet3.bin"
  echo "$stamp" > "$1/.hane-stamp"
  ls -l "$1"
}

build_apple() {
  platforms=${*:-macos ios}
  stamp="$(fingerprint) $platforms"
  out=$KIT/Binaries/HaneDeepFilter.xcframework
  if [ -f "$KIT/Binaries/.hane-stamp" ] && [ "$(cat "$KIT/Binaries/.hane-stamp")" = "$stamp" ] && [ -d "$out" ]; then
    echo "AI 降噪（苹果）已是最新：$out"
    return
  fi
  prepare
  # 与应用的最低系统版本一致
  export MACOSX_DEPLOYMENT_TARGET=14.0 IPHONEOS_DEPLOYMENT_TARGET=17.0
  targets=""
  for p in $platforms; do
    case $p in
      macos) targets="$targets aarch64-apple-darwin x86_64-apple-darwin" ;;
      ios) targets="$targets aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios" ;;
      *) echo "未知平台：$p" >&2; exit 1 ;;
    esac
  done
  # shellcheck disable=SC2086
  rustup target add $targets >/dev/null
  args=""
  for t in $targets; do
    args="$args --target $t"
    var=CARGO_TARGET_$(echo "$t" | tr 'a-z-' 'A-Z_')_RUSTFLAGS
    export "$var=$(remap)"
  done
  # 优化体积（opt-level=s）：tract 的矩阵乘内核是汇编，不受影响；静态库链接后小 35%，每帧耗时只多约 14%（0.35 / 0.31 ms）。
  # WASM 不这样做：WASM 的内核是 Rust 写的，会慢 80%
  # shellcheck disable=SC2086
  CARGO_PROFILE_RELEASE_OPT_LEVEL=s cargo build --release --locked $args
  rm -rf build/apple "$out"
  mkdir -p build/apple/include
  cp include/hane_deepfilter.h build/apple/include/
  printf 'module HaneDeepFilter {\n  header "hane_deepfilter.h"\n  export *\n}\n' > build/apple/include/module.modulemap
  libs=""
  for p in $platforms; do
    mkdir -p "build/apple/$p"
    case $p in
      macos) lipo -create "$TARGET/aarch64-apple-darwin/release/libhane_deepfilter.a" "$TARGET/x86_64-apple-darwin/release/libhane_deepfilter.a" -output build/apple/macos/libhane_deepfilter.a ;;
      ios)
        mkdir -p build/apple/ios-sim
        cp "$TARGET/aarch64-apple-ios/release/libhane_deepfilter.a" build/apple/ios/
        # 模拟器：Apple 芯片和 Intel 的 Mac 都要能跑（xcodebuild 的 generic/platform=iOS Simulator 两种架构都会编）
        lipo -create "$TARGET/aarch64-apple-ios-sim/release/libhane_deepfilter.a" "$TARGET/x86_64-apple-ios/release/libhane_deepfilter.a" -output build/apple/ios-sim/libhane_deepfilter.a
        libs="$libs -library build/apple/ios-sim/libhane_deepfilter.a -headers build/apple/include"
        ;;
    esac
    libs="$libs -library build/apple/$p/libhane_deepfilter.a -headers build/apple/include"
  done
  mkdir -p "$KIT/Binaries" "$KIT/Sources/HaneMedia/Resources"
  # shellcheck disable=SC2086
  xcodebuild -create-xcframework $libs -output "$out" >/dev/null
  cp build/DeepFilterNet3_onnx.tar.gz "$KIT/Sources/HaneMedia/Resources/deepfilternet3.bin"
  echo "$stamp" > "$KIT/Binaries/.hane-stamp"
  echo "AI 降噪（苹果）：$out"
}

case ${1:-} in
  web) build_web "${2:-$WEB_OUT}" ;;
  apple) shift; build_apple "$@" ;;
  *) echo "用法：$0 web [输出目录] | apple [macos] [ios]" >&2; exit 2 ;;
esac
