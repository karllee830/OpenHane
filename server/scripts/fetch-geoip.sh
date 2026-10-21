#!/bin/sh
# 下载服务端内嵌的 IPv4 归属地库（ip2region，约 11 MB）到 internal/geoip/data，按 SHA256 校验。
# 构建（make build、scripts/release.sh、Dockerfile）前执行；没有这个文件时服务端照常构建，只是不显示归属地。
# 升级时把 COMMIT 和 SHA256 一起改，IPv6 库的地址和校验值在 internal/geoip/geoip.go。
set -eu
cd "$(dirname "$0")/.."
COMMIT=f8b0792b0cd729f5b2593f690aeed225e49c1967
SHA256=27ecba8c9a6d5e3b280aedbe7ee15c65372b179fbd0dad3845d8c608f2fcace1
OUT=internal/geoip/data/ip2region_v4.xdb

sum() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }
if [ -f "$OUT" ] && [ "$(sum "$OUT")" = "$SHA256" ]; then
  exit 0
fi
URL="https://github.com/lionsoul2014/ip2region/raw/$COMMIT/data/ip2region_v4.xdb"
if command -v curl >/dev/null 2>&1; then
  curl -sSfL --retry 3 -o "$OUT.tmp" "$URL"
else
  wget -q -O "$OUT.tmp" "$URL"
fi
if [ "$(sum "$OUT.tmp")" != "$SHA256" ]; then
  rm -f "$OUT.tmp"
  echo "ip2region_v4.xdb 校验失败" >&2
  exit 1
fi
mv "$OUT.tmp" "$OUT"
