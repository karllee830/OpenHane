#!/usr/bin/env bash
# 用 Sparkle 的 EdDSA 私钥给更新包签名，输出 base64 签名（appcast 里的 sparkle:edSignature）。
#   SPARKLE_ED_PRIVATE_KEY=<base64 种子> ./scripts/sparkle-sign.sh <文件>
# 私钥是 32 字节 Ed25519 种子的 base64，与 Sparkle generate_keys 导出的格式相同。
set -euo pipefail
file=${1:?用法：sparkle-sign.sh <文件>}
: "${SPARKLE_ED_PRIVATE_KEY:?缺少 SPARKLE_ED_PRIVATE_KEY}"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
{
  printf '\x30\x2e\x02\x01\x00\x30\x05\x06\x03\x2b\x65\x70\x04\x22\x04\x20'
  printf '%s' "$SPARKLE_ED_PRIVATE_KEY" | base64 --decode
} > "$tmp/key.der"
[ "$(wc -c < "$tmp/key.der")" -eq 48 ] || { echo "SPARKLE_ED_PRIVATE_KEY 不是 32 字节的种子" >&2; exit 1; }
openssl pkey -inform DER -in "$tmp/key.der" -out "$tmp/key.pem"
openssl pkeyutl -sign -inkey "$tmp/key.pem" -rawin -in "$file" | base64 | tr -d '\n'
echo
