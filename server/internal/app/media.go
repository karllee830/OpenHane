package app

import (
	"context"
	"fmt"
	"log/slog"
	"net/netip"
	"time"

	"github.com/karllee830/OpenHane/server/internal/media"
	"github.com/karllee830/OpenHane/server/internal/media/livekit"
	"github.com/karllee830/OpenHane/server/internal/netdiag"
)

// publicAddr 确定对外公布的媒体地址：HANE_PUBLIC_HOST > STUN 探测 > 只用本机网卡地址。
// 返回的 source 用于启动摘要。
func (a *App) publicAddr(ctx context.Context) (addr netip.Addr, source string) {
	if h := a.Cfg.PublicHost; h != "" {
		ip, err := netdiag.ResolveHost(ctx, h)
		if err != nil {
			a.Log.Warn("cannot resolve HANE_PUBLIC_HOST; falling back to local addresses", "host", h, "err", err)
			return netip.Addr{}, "local"
		}
		return ip, "HANE_PUBLIC_HOST"
	}
	ip, err := netdiag.ProbePublicIP(ctx, a.Cfg.STUNServers, 3*time.Second)
	if err != nil {
		a.Log.Warn("public IP detection via STUN failed; clients will reach media via the address they connect to. "+
			"Set HANE_PUBLIC_HOST if media must use a different address (e.g. signaling behind a CDN)", "err", err)
		return netip.Addr{}, "local"
	}
	return ip, "STUN"
}

func (a *App) startMedia(ctx context.Context) (media.Engine, error) {
	ip, source := a.publicAddr(ctx)
	a.publicIP, a.publicIPSource = ip, source
	eng := livekit.New(livekit.Options{
		UDPPort:     a.Cfg.Port,
		TCPPort:     a.Cfg.TCPFallbackPort,
		NodeIP:      ip,
		STUNServers: a.Cfg.STUNServers,
		Log:         a.Log,
		Debug:       a.Cfg.LogLevel <= slog.LevelDebug,
	})
	if err := eng.Start(ctx); err != nil {
		return nil, fmt.Errorf("media engine: %w", err)
	}
	go func() {
		if err := <-eng.Err(); err != nil {
			a.Log.Error("media engine exited", "err", err)
			a.fatal <- fmt.Errorf("media engine exited: %w", err)
		}
	}()
	return eng, nil
}
