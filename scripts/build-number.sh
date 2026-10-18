#!/bin/sh
# 输出全平台统一的构建号：main 上的提交数 × 10 + 渠道位（-dev 0、-beta 1、正式版 2）。
#   scripts/build-number.sh 0.2.0-beta.3
set -eu
version=${1:?用法：build-number.sh <版本号>}
case "$version" in
  *-dev.*) channel=0 ;;
  *-beta.*) channel=1 ;;
  *-*) echo "不支持的版本号：$version（只能是 X.Y.Z、X.Y.Z-beta.N 或 X.Y.Z-dev.B）" >&2; exit 1 ;;
  *) channel=2 ;;
esac
if [ "$(git rev-parse --is-shallow-repository)" = true ]; then
  echo "仓库是浅克隆，提交数不准确（CI 签出时需要 fetch-depth: 0）" >&2
  exit 1
fi
commits=$(git rev-list --count HEAD 2>/dev/null || echo 0)
echo $(( commits * 10 + channel ))
