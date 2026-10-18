// Package app 组装各模块，管理启动和停机顺序。
package app

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"net/netip"
	"os"
	ossignal "os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/karllee830/OpenHane/server/internal/adminsock"
	"github.com/karllee830/OpenHane/server/internal/config"
	"github.com/karllee830/OpenHane/server/internal/gateway"
	"github.com/karllee830/OpenHane/server/internal/hub"
	"github.com/karllee830/OpenHane/server/internal/media"
	"github.com/karllee830/OpenHane/server/internal/ratelimit"
	"github.com/karllee830/OpenHane/server/internal/settings"
	"github.com/karllee830/OpenHane/server/internal/signal"
	"github.com/karllee830/OpenHane/server/internal/store"
	"github.com/karllee830/OpenHane/server/internal/tlsmgr"
	"github.com/karllee830/OpenHane/server/internal/webui"
)

// 控制协议版本范围。
const (
	ProtocolMin = 1
	ProtocolMax = 1
)

type App struct {
	Version string
	Cfg     *config.Config
	Log     *slog.Logger

	store    *store.Store
	serverID []byte
	settings *settings.Settings
	tls      *tlsmgr.Manager
	gw       *gateway.Gateway
	media    media.Engine
	hub      *hub.Hub

	started        time.Time
	ws             *signal.Server // /metrics 读取握手计数
	publicIP       netip.Addr
	publicIPSource string
	fatal          chan error // 后台组件的致命错误
}

func NewLogger(cfg *config.Config) *slog.Logger {
	opts := &slog.HandlerOptions{Level: cfg.LogLevel}
	if cfg.LogFormat == "json" {
		return slog.New(slog.NewJSONHandler(os.Stdout, opts))
	}
	return slog.New(slog.NewTextHandler(os.Stdout, opts))
}

// Run 启动服务并阻塞，直到 ctx 取消（收到 SIGTERM / SIGINT）后优雅停机。
func (a *App) Run(ctx context.Context) error {
	started := time.Now()
	a.started = started
	applyMemoryLimit(a.Log)

	var err error
	a.store, err = store.Open(ctx, a.Cfg.DataDir, a.Log)
	if err != nil {
		return fmt.Errorf("database: %w", err)
	}
	defer a.store.Close()

	if err := a.loadServerState(ctx); err != nil {
		return err
	}

	a.tls, err = tlsmgr.New(a.Cfg, a.Log)
	if err != nil {
		return fmt.Errorf("tls: %w", err)
	}

	a.fatal = make(chan error, 4)
	handlers := gateway.Handlers{Info: a.info, Ready: a.ready, Metrics: a.metrics}
	if web := webui.New(); web != nil {
		handlers.Web = web
	}
	a.gw = gateway.New(a.Cfg, a.tls, &handlers, a.Log)
	// 先绑定主端口：端口被占用时立即报错，不必等媒体引擎启动
	if err := a.gw.Listen(); err != nil {
		return err
	}

	a.media, err = a.startMedia(ctx)
	if err != nil {
		return err
	}
	defer a.media.Stop(context.Background())
	handlers.RTC = a.media.RTCHandler()
	if err := a.media.EnsureRoom(ctx, "main", media.RoomOptions{}); err != nil {
		return fmt.Errorf("create main room: %w", err)
	}

	a.hub = hub.New(hub.Options{
		Store: a.store, Media: a.media, Settings: a.settings, ServerID: a.serverID, Version: a.Version,
		ProtocolMin: ProtocolMin, ProtocolMax: ProtocolMax, Log: a.Log,
	})
	hubCtx, stopHub := context.WithCancel(context.Background())
	defer stopHub()
	go func() {
		if err := a.hub.Run(hubCtx); err != nil {
			a.fatal <- fmt.Errorf("hub: %w", err)
		}
	}()
	ws := signal.NewServer(a.hub, a.store, a.tls, a.Log)
	a.ws = ws
	if a.Cfg.ConnPerMinute == 0 {
		ws.ConnLimit = nil
	} else {
		ws.ConnLimit = ratelimit.NewWindow(a.Cfg.ConnPerMinute, time.Minute)
	}
	handlers.WS = ws

	go func() {
		if err := a.gw.Serve(); err != nil {
			a.fatal <- fmt.Errorf("gateway: %w", err)
		}
	}()

	a.Log.Info("OpenHane server started",
		"version", a.Version, "port", a.Cfg.Port, "tls", a.Cfg.TLSMode,
		"fingerprint", a.tls.Fingerprint(), "public_ip", a.publicIP, "public_ip_source", a.publicIPSource,
		"startup", time.Since(started).Round(time.Millisecond))
	if err := a.printBanner(ctx); err != nil {
		return err
	}
	// 本地管理套接字：CLI 对运行中的服务的修改立即生效
	if sock, err := adminsock.Listen(adminsock.Path(a.Cfg.DataDir), a.adminCommand, a.Log.With("component", "adminsock")); err != nil {
		a.Log.Warn("admin socket unavailable; CLI will operate on the database directly", "err", err)
	} else {
		defer sock.Close()
	}

	go a.maintenanceLoop(ctx)
	if a.Cfg.TLSMode == config.TLSFile {
		go a.certReloadLoop(ctx)
	}

	select {
	case <-ctx.Done():
		a.Log.Info("shutting down")
	case err := <-a.fatal:
		return err
	}
	// 优雅停机：先通知客户端「服务器即将重启」（客户端进入自动重连），再关闭各组件
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	a.hub.Shutdown(shutdownCtx)
	time.Sleep(300 * time.Millisecond) // 让 Goodbye 发出去
	return a.gw.Shutdown(shutdownCtx)
}

func (a *App) loadServerState(ctx context.Context) error {
	idHex, err := a.store.GetOrInitMeta(ctx, "server_id", func() string {
		b := make([]byte, 16)
		rand.Read(b)
		return hex.EncodeToString(b)
	})
	if err != nil {
		return err
	}
	if a.serverID, err = hex.DecodeString(idHex); err != nil || len(a.serverID) != 16 {
		return fmt.Errorf("corrupt server_id in database: %q", idHex)
	}

	stored, err := a.store.LoadSettings(ctx)
	if err != nil {
		return err
	}
	// HANE_INITIAL_SERVER_NAME 只在首次启动时写入，之后以管理面板中的设置为准
	if a.Cfg.InitialServerName != "" {
		if _, err := a.store.GetMeta(ctx, "initial_name_applied"); errors.Is(err, store.ErrNotFound) {
			_, kv, err := settings.Defaults().Apply(settings.Patch{"server.name": strconv.Quote(a.Cfg.InitialServerName)}, settings.HashPassword)
			if err != nil {
				return fmt.Errorf("HANE_INITIAL_SERVER_NAME: %w", err)
			}
			if err := a.store.PutSettings(ctx, kv, store.SystemCreator); err != nil {
				return err
			}
			if _, err := a.store.GetOrInitMeta(ctx, "initial_name_applied", func() string { return "1" }); err != nil {
				return err
			}
			stored["server.name"] = kv["server.name"]
		}
	}
	a.settings, err = settings.FromStored(stored)
	if err != nil {
		a.Log.Warn("some stored settings are invalid and were reset to defaults", "err", err)
	}
	return nil
}

func (a *App) ready(ctx context.Context) error {
	if err := a.store.Ping(ctx); err != nil {
		return fmt.Errorf("database: %w", err)
	}
	return a.media.Ready(ctx)
}

func (a *App) currentSettings() *settings.Settings {
	if a.hub != nil {
		return a.hub.Settings()
	}
	return a.settings
}

func (a *App) info() gateway.Info {
	s := a.currentSettings()
	return gateway.Info{
		Name:             s.ServerName,
		Version:          a.Version,
		Protocol:         gateway.Range{Min: ProtocolMin, Max: ProtocolMax},
		RequiresPassword: s.ServerPassword != "",
		WebClient:        webui.Available(),
	}
}

// certReloadLoop：file 模式下每分钟检查证书文件是否更新（例如 certbot 续期后），收到 SIGHUP 时立即检查，无需重启。
func (a *App) certReloadLoop(ctx context.Context) {
	hup := make(chan os.Signal, 1)
	ossignal.Notify(hup, syscall.SIGHUP)
	defer ossignal.Stop(hup)
	t := time.NewTicker(time.Minute)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		case <-hup:
		}
		if err := a.tls.Reload(); err != nil {
			a.Log.Warn("certificate reload failed; keeping the current certificate", "err", err)
		}
	}
}

// maintenanceLoop 每小时：数据库维护、每日备份、按保留期清理聊天和审计日志。
func (a *App) maintenanceLoop(ctx context.Context) {
	run := func() {
		if err := a.store.Maintain(ctx); err != nil {
			a.Log.Warn("database maintenance failed", "err", err)
		}
		if err := a.store.DailyBackup(ctx, a.Cfg.BackupKeep); err != nil {
			a.Log.Warn("daily backup failed", "err", err)
		}
		s := a.currentSettings()
		now := time.Now()
		if s.ChatRetentionDays > 0 {
			if n, err := a.store.PurgeChat(ctx, now.AddDate(0, 0, -s.ChatRetentionDays).UnixMilli()); err == nil && n > 0 {
				a.Log.Info("purged old chat messages", "count", n)
			}
		}
		if n, err := a.store.PurgeAudit(ctx, now.AddDate(0, 0, -s.AuditRetentionDays).UnixMilli()); err == nil && n > 0 {
			a.Log.Info("purged old audit entries", "count", n)
		}
	}
	t := time.NewTicker(time.Hour)
	defer t.Stop()
	run()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			run()
		}
	}
}
