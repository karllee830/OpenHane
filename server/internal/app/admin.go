package app

import (
	"context"
	"errors"
	"fmt"
	"net/netip"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/karllee830/OpenHane/server/internal/adminsock"
	"github.com/karllee830/OpenHane/server/internal/pb"
	"github.com/karllee830/OpenHane/server/internal/perm"
	"github.com/karllee830/OpenHane/server/internal/settings"
	"github.com/karllee830/OpenHane/server/internal/store"
)

// Diag 是 openhane diag 的输出。
type Diag struct {
	Version        string  `json:"version"`
	Uptime         string  `json:"uptime"`
	Port           int     `json:"port"`
	TCPFallback    int     `json:"tcp_fallback_port"`
	TLSMode        string  `json:"tls_mode"`
	Fingerprint    string  `json:"fingerprint,omitempty"`
	PublicIP       string  `json:"public_ip,omitempty"`
	PublicIPSource string  `json:"public_ip_source"`
	Sessions       any     `json:"sessions"`
	MediaRooms     int     `json:"media_rooms"`
	MediaPeers     int     `json:"media_participants"`
	SchemaVersion  int     `json:"schema_version"`
	HeapMB         float64 `json:"heap_mb"`
	SysMB          float64 `json:"sys_mb"`
	Goroutines     int     `json:"goroutines"`
}

// adminCommand 处理本地管理套接字上的命令（openhane CLI 调用），修改立即对在线用户生效。
func (a *App) adminCommand(ctx context.Context, cmd string, args []string) (any, error) {
	need := func(n int, usage string) error {
		if len(args) < n {
			return fmt.Errorf("usage: %s", usage)
		}
		return nil
	}
	switch cmd {
	case "settings.get":
		values := a.hub.Settings().Public()
		if len(args) == 1 {
			v, ok := values[args[0]]
			if !ok {
				return nil, fmt.Errorf("unknown setting %q", args[0])
			}
			return map[string]string{args[0]: v}, nil
		}
		return values, nil
	case "settings.set":
		if err := need(2, "settings set <key> <json>"); err != nil {
			return nil, err
		}
		next, _, err := a.hub.UpdateSettings(settings.Patch{args[0]: args[1]}, "cli")
		if err != nil {
			return nil, err
		}
		detail := args[1]
		if args[0] == settings.PasswordKey {
			detail = "(changed)"
		}
		a.auditCLI(ctx, "settings.update", "", map[string]string{args[0]: detail})
		v, _ := next.Get(args[0])
		return map[string]string{args[0]: v}, nil
	case "user.set_role":
		if err := need(2, "user set-role <uid> <role>"); err != nil {
			return nil, err
		}
		role, err := perm.ParseRole(args[1])
		if err != nil {
			return nil, err
		}
		if err := a.hub.SetRole(args[0], role); err != nil {
			return nil, err
		}
		a.auditCLI(ctx, "user.set_role", args[0], map[string]string{"role": role.String()})
		return map[string]string{"uid": args[0], "role": role.String()}, nil
	case "ban.add":
		if err := need(1, "ban add <uid|ip|cidr> [duration] [reason]"); err != nil {
			return nil, err
		}
		b := &store.Ban{CreatedBy: "cli"}
		target := args[0]
		var prefix netip.Prefix
		if p, err := netip.ParsePrefix(target); err == nil {
			prefix, b.IPCIDR = p, p.String()
		} else if ip, err := netip.ParseAddr(target); err == nil {
			prefix = netip.PrefixFrom(ip.Unmap(), ip.Unmap().BitLen())
			b.IPCIDR = prefix.String()
		} else {
			b.UID = strings.ToLower(target)
		}
		if len(args) > 1 && args[1] != "" && args[1] != "permanent" {
			d, err := time.ParseDuration(args[1])
			if err != nil {
				return nil, fmt.Errorf("invalid duration %q (e.g. 10m, 24h, permanent)", args[1])
			}
			b.ExpiresAt = time.Now().Add(d).UnixMilli()
		}
		if len(args) > 2 {
			b.Reason = strings.Join(args[2:], " ")
		}
		if err := a.store.InsertBan(ctx, b); err != nil {
			return nil, err
		}
		kicked := a.hub.Kick(ctx, func(uid string, ip netip.Addr) bool {
			return (b.UID != "" && uid == b.UID) || (prefix.IsValid() && ip.IsValid() && prefix.Contains(ip.Unmap()))
		}, &pb.Error{Code: pb.ErrorCode_ERROR_CODE_BANNED, BanReason: b.Reason, BanExpiresAtMs: b.ExpiresAt})
		a.auditCLI(ctx, "user.ban", target, map[string]any{"reason": b.Reason, "expires_at": b.ExpiresAt, "kicked": kicked})
		return map[string]any{"id": b.ID, "kicked": kicked}, nil
	case "ban.list":
		return a.store.ListBans(ctx)
	case "ban.remove":
		if err := need(1, "ban remove <id>"); err != nil {
			return nil, err
		}
		id, err := strconv.ParseInt(args[0], 10, 64)
		if err != nil {
			return nil, fmt.Errorf("invalid ban id %q", args[0])
		}
		if err := a.store.RemoveBan(ctx, id); err != nil {
			return nil, err
		}
		a.auditCLI(ctx, "user.unban", args[0], nil)
		return map[string]int64{"removed": id}, nil
	case "notice":
		if err := need(1, "notice <text>"); err != nil {
			return nil, err
		}
		text := strings.Join(args, " ")
		a.hub.Notice(ctx, text)
		a.auditCLI(ctx, "server.notice", "", map[string]string{"text": text})
		return map[string]string{"sent": text}, nil
	case "diag":
		return a.diag(ctx), nil
	}
	return nil, adminsock.ErrUnknownCommand
}

func (a *App) diag(ctx context.Context) Diag {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	d := Diag{
		Version: a.Version, Uptime: time.Since(a.started).Round(time.Second).String(),
		Port: a.Cfg.Port, TCPFallback: a.Cfg.TCPFallbackPort, TLSMode: string(a.Cfg.TLSMode),
		Fingerprint: a.tls.Fingerprint(), PublicIPSource: a.publicIPSource,
		Sessions: a.hub.Stats(ctx), HeapMB: float64(m.HeapInuse) / 1e6, SysMB: float64(m.Sys) / 1e6, Goroutines: runtime.NumGoroutine(),
	}
	if a.publicIP.IsValid() {
		d.PublicIP = a.publicIP.String()
	}
	if st, err := a.media.Stats(ctx); err == nil {
		d.MediaRooms, d.MediaPeers = st.Rooms, st.Participants
	}
	d.SchemaVersion, _ = a.store.SchemaVersion(ctx)
	return d
}

func (a *App) auditCLI(ctx context.Context, action, target string, detail any) {
	if err := a.store.InsertAudit(ctx, &store.AuditEntry{Action: action, Target: target, Detail: detail}); err != nil && !errors.Is(err, context.Canceled) {
		a.Log.Warn("audit write failed", "action", action, "err", err)
	}
}
