// openhane 是羽见服务端的单一可执行文件：默认运行服务，也提供管理子命令。
package main

import (
	"context"
	"crypto/tls"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/karllee830/OpenHane/server/internal/app"
	"github.com/karllee830/OpenHane/server/internal/config"
	"github.com/karllee830/OpenHane/server/internal/privdrop"
	"github.com/karllee830/OpenHane/server/internal/store"
)

// version 由构建参数注入：-ldflags "-X main.version=1.2.3"
var version = "dev"

const usage = `OpenHane server

用法：
  openhane [serve]                 运行服务（默认）
  openhane token create --role admin|moderator [--uses 1] [--expires 24h] [--note "..."]
  openhane token list
  openhane token revoke <id>
  openhane user list [--role admin|moderator|member]
  openhane user set-role <uid> <role>
  openhane settings get [key]
  openhane settings set <key> <json>
  openhane ban add <uid|ip|cidr> [10m|24h|permanent] [reason]
  openhane ban list
  openhane ban remove <id>
  openhane notice <text>           向所有在线用户发送公告
  openhane diag                    连通性与资源诊断
  openhane backup [--out <path>]   在线备份数据库
  openhane healthcheck             检查本机服务是否存活（供 Docker HEALTHCHECK 使用）
  openhane version                 显示版本

配置全部通过环境变量（HANE_*）提供，见部署指南（https://github.com/karllee830/OpenHane/wiki/Deployment-Guide）第 8 节。
服务运行中时，管理命令经本地管理套接字（<数据目录>/run/admin.sock）执行，对在线用户立即生效；
服务未运行时直接操作数据库，下次启动生效。
`

func main() {
	cmd, args := "serve", os.Args[1:]
	if len(args) > 0 {
		cmd, args = args[0], args[1:]
	}
	if cmd != "version" && cmd != "help" {
		// Docker 镜像以 root 启动：修正数据目录属主后降为 PUID / PGID（默认 65532）。
		// docker exec 执行的管理命令同样降权，不会在数据目录里留下属于 root 的文件
		dataDir := os.Getenv("HANE_DATA_DIR")
		if dataDir == "" {
			dataDir = "/data"
		}
		if err := privdrop.Drop(dataDir, os.Getenv); err != nil {
			fmt.Fprintln(os.Stderr, "error:", err)
			os.Exit(1)
		}
	}
	var err error
	switch cmd {
	case "serve":
		err = serve()
	case "token":
		err = tokenCmd(args)
	case "user":
		err = userCmd(args)
	case "settings":
		err = settingsCmd(args)
	case "ban":
		err = banCmd(args)
	case "diag":
		err = diagCmd()
	case "notice":
		err = noticeCmd(args)
	case "backup":
		err = backup(args)
	case "healthcheck":
		err = healthcheck()
	case "version", "--version", "-v":
		fmt.Println(version)
	case "help", "--help", "-h":
		fmt.Print(usage)
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n\n%s", cmd, usage)
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func loadConfig() (*config.Config, error) {
	cfg, err := config.Load(os.Getenv)
	if err != nil {
		return nil, fmt.Errorf("invalid configuration:\n%w", err)
	}
	return cfg, nil
}

func serve() error {
	startPprof()
	cfg, err := loadConfig()
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	a := &app.App{Version: version, Cfg: cfg, Log: app.NewLogger(cfg)}
	return a.Run(ctx)
}

func openStore(ctx context.Context) (*store.Store, *config.Config, error) {
	cfg, err := loadConfig()
	if err != nil {
		return nil, nil, err
	}
	s, err := store.Open(ctx, cfg.DataDir, slog.New(slog.NewTextHandler(io.Discard, nil)))
	return s, cfg, err
}

func backup(args []string) error {
	fs := flag.NewFlagSet("backup", flag.ExitOnError)
	out := fs.String("out", "", "备份文件路径（默认 <数据目录>/backups/manual-<时间>.db）")
	fs.Parse(args)
	ctx := context.Background()
	s, cfg, err := openStore(ctx)
	if err != nil {
		return err
	}
	defer s.Close()
	if *out == "" {
		*out = filepath.Join(cfg.DataDir, "backups", "manual-"+time.Now().Format("20060102-150405")+".db")
	}
	if err := s.Backup(ctx, *out); err != nil {
		return err
	}
	fmt.Println("backup written to", *out)
	return nil
}

func healthcheck() error {
	cfg, err := loadConfig()
	if err != nil {
		return err
	}
	scheme := "https"
	if cfg.TLSMode == config.TLSOff {
		scheme = "http"
	}
	client := &http.Client{
		Timeout: 3 * time.Second,
		// 只连本机，证书可能是自签名或签给域名的，不做校验
		Transport: &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}},
	}
	resp, err := client.Get(fmt.Sprintf("%s://127.0.0.1:%d/healthz", scheme, cfg.Port))
	if err != nil {
		return err
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("healthz returned %s", resp.Status)
	}
	return nil
}
