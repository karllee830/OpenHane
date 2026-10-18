// Package migrations 内嵌 SQLite 迁移脚本。
//
// 规则：文件名为 NNNN_描述.sql，按编号顺序执行，版本号记在 PRAGMA user_version。
// 只前进、不回滚；已发布的脚本不允许修改，只能追加新脚本。
package migrations

import "embed"

//go:embed *.sql
var FS embed.FS
