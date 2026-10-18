package app

import (
	"context"
	"fmt"
	"os"
	"strings"

	"github.com/karllee830/OpenHane/server/internal/config"
	"github.com/karllee830/OpenHane/server/internal/hub"
	"github.com/karllee830/OpenHane/server/internal/perm"
	"github.com/karllee830/OpenHane/server/internal/store"
)

// printBanner 打印启动摘要。数据库中还没有管理员时，作废之前未兑换的系统令牌，
// 生成新的单次管理员令牌并打印（每次启动都重新生成，不怕错过日志）。
func (a *App) printBanner(ctx context.Context) error {
	admins, err := a.store.CountAdmins(ctx)
	if err != nil {
		return err
	}
	token := ""
	if admins == 0 {
		if err := a.store.RevokeUnusedSystemTokens(ctx); err != nil {
			return err
		}
		token, _, err = hub.CreatePrivilegeToken(ctx, a.store, perm.Admin, 1, 0, "first admin", store.SystemCreator)
		if err != nil {
			return err
		}
	}

	addr := fmt.Sprintf("<本机 IP>:%d", a.Cfg.Port)
	switch {
	case a.Cfg.PublicHost != "":
		addr = fmt.Sprintf("%s:%d", a.Cfg.PublicHost, a.Cfg.Port)
	case a.publicIP.IsValid():
		addr = fmt.Sprintf("%s:%d", a.publicIP, a.Cfg.Port)
	}
	tlsDesc := map[config.TLSMode]string{
		config.TLSSelfSigned: "自签名（首次连接时客户端会自动记住指纹）",
		config.TLSFile:       "证书文件",
		config.TLSOff:        "关闭（由反向代理终止 TLS）",
	}[a.Cfg.TLSMode]
	tcp := "关闭"
	if a.Cfg.TCPFallbackPort != 0 {
		tcp = fmt.Sprintf("%d ✓", a.Cfg.TCPFallbackPort)
	}
	ipNote := map[string]string{"HANE_PUBLIC_HOST": "HANE_PUBLIC_HOST", "STUN": "STUN 探测", "local": "未探测到（客户端按自己填写的地址连接媒体）"}[a.publicIPSource]

	lines := []string{
		fmt.Sprintf("羽见（OpenHane）服务端 %s 已启动", a.Version),
		"",
		"客户端连接地址:  " + addr,
		"TLS 模式:       " + tlsDesc,
	}
	if fp := a.tls.Fingerprint(); fp != "" {
		lines = append(lines, "证书指纹:       "+fp)
	}
	if token != "" {
		lines = append(lines, "",
			"★ 管理员权限令牌（单次有效，请妥善保存）:",
			"    "+token,
			"  在客户端中：菜单 → 使用权限令牌",
			"  丢失后可执行：docker exec openhane /openhane token create --role admin",
		)
	}
	lines = append(lines, "",
		fmt.Sprintf("媒体端口:  UDP %d ✓  TCP 回退 %s  公网 IP: %s", a.Cfg.Port, tcp, ipNote))

	fmt.Fprint(os.Stdout, box(lines))
	return nil
}

// box 用制表符画框；按显示宽度对齐（中日韩字符占两格）。
func box(lines []string) string {
	width := 0
	for _, l := range lines {
		width = max(width, displayWidth(l))
	}
	var b strings.Builder
	b.WriteString("╔" + strings.Repeat("═", width+4) + "╗\n")
	for _, l := range lines {
		b.WriteString("║  " + l + strings.Repeat(" ", width-displayWidth(l)) + "  ║\n")
	}
	b.WriteString("╚" + strings.Repeat("═", width+4) + "╝\n")
	return b.String()
}

// displayWidth 按东亚宽度估算终端显示宽度：中日韩文字和全角符号占两格，其余（含 → ★ ✓）占一格。
func displayWidth(s string) int {
	w := 0
	for _, r := range s {
		if isWide(r) {
			w += 2
		} else {
			w++
		}
	}
	return w
}

func isWide(r rune) bool {
	return (r >= 0x1100 && r <= 0x115F) || (r >= 0x2E80 && r <= 0xA4CF) || (r >= 0xAC00 && r <= 0xD7A3) ||
		(r >= 0xF900 && r <= 0xFAFF) || (r >= 0xFE30 && r <= 0xFE4F) || (r >= 0xFF00 && r <= 0xFF60) || (r >= 0xFFE0 && r <= 0xFFE6)
}
