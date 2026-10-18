#!/bin/sh
# 检查 server/go.mod 中的 replace 指令是否与所用 LiveKit 版本的 go.mod 一致（CI 中运行）。
# LiveKit 把 pion 组件替换成了自己的 fork，依赖方不会继承 replace，必须手动同步。
set -eu
cd "$(dirname "$0")/.."
LK_DIR=$(go list -m -f '{{.Dir}}' github.com/livekit/livekit-server)
want=$(grep -E '^replace|^\s+github.com/pion/.* => ' "$LK_DIR/go.mod" | grep 'pion' | sed -E 's/^replace //; s/^[[:space:]]+//' | sort)
have=$(grep -E '^replace ' go.mod | sed -E 's/^replace //' | sort)
if [ "$want" != "$have" ]; then
  echo "replace 指令与 LiveKit $(go list -m -f '{{.Version}}' github.com/livekit/livekit-server) 不一致"
  echo "--- LiveKit 要求:"; echo "$want"
  echo "--- server/go.mod:"; echo "$have"
  exit 1
fi
echo "replace 指令与 LiveKit 一致"
