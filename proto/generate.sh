#!/bin/sh
# 生成各端协议代码。工具版本固定在这里，升级时一起改。
set -eu
cd "$(dirname "$0")"
BUF_VERSION=v1.73.0
PROTOBUF_GO_VERSION=v1.36.12 # 与 server/go.mod 中 google.golang.org/protobuf 的版本保持一致
SWIFT_PROTOBUF_VERSION=1.38.1 # 与 clients/apple/Packages/OpenHaneKit/Package.swift 保持一致

# TypeScript 插件（@bufbuild/protoc-gen-es）的版本固定在 clients/web/package.json
if [ ! -x ../clients/web/node_modules/.bin/protoc-gen-es ]; then
  (cd ../clients/web && npm install --no-audit --no-fund)
fi
GOBIN="$PWD/.bin" go install "google.golang.org/protobuf/cmd/protoc-gen-go@$PROTOBUF_GO_VERSION"
go run "github.com/bufbuild/buf/cmd/buf@$BUF_VERSION" lint
rm -rf ../clients/web/packages/protocol/src/gen
go run "github.com/bufbuild/buf/cmd/buf@$BUF_VERSION" generate

# Swift（苹果客户端）：从源码编译 protoc-gen-swift。编译目录放在本机临时目录（仓库可能在网络共享上）。
if command -v swift >/dev/null 2>&1; then
  if [ ! -x .bin/protoc-gen-swift ]; then
    SRC="${TMPDIR:-/tmp}/hane-swift-protobuf-$SWIFT_PROTOBUF_VERSION"
    [ -d "$SRC" ] || git clone -q --depth 1 --branch "$SWIFT_PROTOBUF_VERSION" https://github.com/apple/swift-protobuf.git "$SRC"
    swift build -c release --product protoc-gen-swift --package-path "$SRC" --scratch-path "$SRC/.build" >/dev/null
    mkdir -p .bin && cp "$SRC/.build/release/protoc-gen-swift" .bin/
  fi
  rm -rf ../clients/apple/Packages/OpenHaneKit/Sources/HaneProtocol/Generated
  go run "github.com/bufbuild/buf/cmd/buf@$BUF_VERSION" generate --template buf.gen.swift.yaml
else
  echo "swift not found: skipping Swift code generation"
fi
