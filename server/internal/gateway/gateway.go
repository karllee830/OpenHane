// Package gateway 是对外的 HTTP(S) 入口：路由、TLS 监听、/rtc 反向代理、健康检查和真实 IP 解析。
package gateway

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"os"
	"strings"
	"time"

	"github.com/karllee830/OpenHane/server/internal/config"
	"github.com/karllee830/OpenHane/server/internal/logo"
	"github.com/karllee830/OpenHane/server/internal/tlsmgr"
)

// Info 是 /api/v1/info 的响应。
type Info struct {
	Name             string `json:"name"`
	Version          string `json:"version"`
	Protocol         Range  `json:"protocol"`
	RequiresPassword bool   `json:"requires_password"`
	WebClient        bool   `json:"web_client"`
	// Online 是在线人数（客户端的服务器列表里显示）
	Online int `json:"online"`
	// Logo 是服务器图标的摘要（从 /api/v1/logo 获取，换了图标摘要就变）；没有图标时省略
	Logo string `json:"logo,omitempty"`
}

type Range struct {
	Min int `json:"min"`
	Max int `json:"max"`
}

// Discovery 是 /.well-known/openhane 的响应（不含敏感信息）。
type Discovery struct {
	Protocol Range  `json:"protocol"`
	Control  string `json:"control"` // 控制协议路径
	Media    string `json:"media"`   // 媒体信令路径前缀
	TLSMode  string `json:"tls_mode"`
}

// Handlers 由 app 注入。为 nil 的处理器对应的路由返回 503。
// 必须在 Serve 之前填好（Serve 之后不再修改，避免数据竞争）。
type Handlers struct {
	WS   http.Handler // /ws 控制协议
	RTC  http.Handler // /rtc 反向代理到 LiveKit
	Web  http.Handler // / Web 客户端
	Info func() Info
	// Logo 返回服务器图标（数据目录里的 logo.png 等）；没有时返回 nil
	Logo  func() *logo.Image
	Ready func(ctx context.Context) error
	// Metrics 返回 Prometheus 文本格式的指标（HANE_METRICS=true 时提供 /metrics）
	Metrics func(ctx context.Context) string
}

type Gateway struct {
	cfg  *config.Config
	tls  *tlsmgr.Manager
	log  *slog.Logger
	srv  *http.Server
	ln   net.Listener
	real *RealIP
}

func New(cfg *config.Config, tm *tlsmgr.Manager, h *Handlers, log *slog.Logger) *Gateway {
	g := &Gateway{cfg: cfg, tls: tm, log: log, real: NewRealIP(cfg.TrustedProxies)}
	mux := http.NewServeMux()
	unavailable := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "not available", http.StatusServiceUnavailable)
	})
	// 处理器在请求时才读取：app 可以先绑定端口，再在各组件就绪后填入
	lazy := func(get func() http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if h := get(); h != nil {
				h.ServeHTTP(w, r)
				return
			}
			unavailable(w, r)
		})
	}

	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		fmt.Fprintln(w, "ok")
	})
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, r *http.Request) {
		if h.Ready != nil {
			ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
			defer cancel()
			if err := h.Ready(ctx); err != nil {
				http.Error(w, "not ready: "+err.Error(), http.StatusServiceUnavailable)
				return
			}
		}
		fmt.Fprintln(w, "ready")
	})
	if cfg.Metrics {
		mux.HandleFunc("GET /metrics", func(w http.ResponseWriter, r *http.Request) {
			// 设置了 HANE_METRICS_TOKEN 时必须带 Authorization: Bearer <token>
			if cfg.MetricsToken != "" && subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+cfg.MetricsToken)) != 1 {
				w.Header().Set("WWW-Authenticate", "Bearer")
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}
			if h.Metrics == nil {
				unavailable(w, r)
				return
			}
			ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
			defer cancel()
			w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
			fmt.Fprint(w, h.Metrics(ctx))
		})
	}
	mux.HandleFunc("GET /api/v1/info", func(w http.ResponseWriter, _ *http.Request) {
		// 公开信息，不带凭据：允许任意来源读取（桌面版和网页版的服务器列表据此显示在线人数和延迟）
		w.Header().Set("Access-Control-Allow-Origin", "*")
		if h.Info == nil {
			unavailable(w, nil)
			return
		}
		writeJSON(w, h.Info())
	})
	mux.HandleFunc("GET /api/v1/logo", func(w http.ResponseWriter, r *http.Request) {
		// 与 /api/v1/info 一样是公开信息：允许任意来源读取（服务器列表里显示）
		w.Header().Set("Access-Control-Allow-Origin", "*")
		var img *logo.Image
		if h.Logo != nil {
			img = h.Logo()
		}
		if img == nil {
			http.NotFound(w, r)
			return
		}
		// 从磁盘上处理好的 .logo 流式返回；ServeContent 按 ETag 处理 304
		f, err := os.Open(img.Path)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		defer f.Close()
		w.Header().Set("ETag", `"`+img.ETag+`"`)
		w.Header().Set("Cache-Control", "public, max-age=300")
		w.Header().Set("Content-Type", "image/png")
		http.ServeContent(w, r, "", img.ModTime, f)
	})
	mux.HandleFunc("GET /.well-known/openhane", func(w http.ResponseWriter, _ *http.Request) {
		var p Range
		if h.Info != nil {
			p = h.Info().Protocol
		}
		writeJSON(w, Discovery{Protocol: p, Control: "/ws", Media: "/rtc", TLSMode: string(cfg.TLSMode)})
	})
	mux.Handle("/ws", lazy(func() http.Handler { return h.WS }))
	// 只把 /rtc 前缀（含 /rtc/v1、/rtc/v1/validate）代理出去；LiveKit 的 /twirp 管理 API 绝不对外
	rtc := lazy(func() http.Handler { return h.RTC })
	mux.Handle("/rtc", rtc)
	mux.Handle("/rtc/", rtc)
	if h.Web != nil {
		mux.Handle("/", h.Web)
	} else {
		mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			fmt.Fprintln(w, "OpenHane server. Use an OpenHane client to connect.")
		})
	}

	g.srv = &http.Server{
		Handler:           g.real.Middleware(securityHeaders(mux)),
		TLSConfig:         tm.TLSConfig(),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
		ErrorLog:          slog.NewLogLogger(log.Handler(), slog.LevelDebug), // TLS 握手失败等噪声只在 debug 输出
	}
	return g
}

// Listen 绑定主端口（失败时立即返回，便于启动自检给出明确提示）。
func (g *Gateway) Listen() error {
	ln, err := net.Listen("tcp", fmt.Sprintf(":%d", g.cfg.Port))
	if err != nil {
		return fmt.Errorf("listen tcp :%d: %w", g.cfg.Port, err)
	}
	g.ln = ln
	return nil
}

// Serve 阻塞运行，直到 Shutdown。
func (g *Gateway) Serve() error {
	var err error
	if g.tls.Enabled() {
		err = g.srv.ServeTLS(g.ln, "", "")
	} else {
		err = g.srv.Serve(g.ln)
	}
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

func (g *Gateway) Addr() net.Addr { return g.ln.Addr() }

func (g *Gateway) Shutdown(ctx context.Context) error { return g.srv.Shutdown(ctx) }

// RegisterOnShutdown 用于关闭被劫持的连接（WebSocket 不受 Shutdown 管理）。
func (g *Gateway) RegisterOnShutdown(f func()) { g.srv.RegisterOnShutdown(f) }

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(v)
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		if !strings.HasPrefix(r.URL.Path, "/rtc") {
			h.Set("X-Frame-Options", "DENY")
		}
		next.ServeHTTP(w, r)
	})
}

// ---------- 真实 IP ----------

type ctxKey struct{}

// RealIP 解析客户端真实 IP：只有直连方在可信代理网段内时，才采信 X-Forwarded-For（从右往左取第一个不可信地址）。
type RealIP struct {
	trusted []netip.Prefix
}

func NewRealIP(trusted []netip.Prefix) *RealIP { return &RealIP{trusted: trusted} }

func (ri *RealIP) isTrusted(a netip.Addr) bool {
	for _, p := range ri.trusted {
		if p.Contains(a) {
			return true
		}
	}
	return false
}

func (ri *RealIP) Resolve(r *http.Request) netip.Addr {
	ap, err := netip.ParseAddrPort(r.RemoteAddr)
	if err != nil {
		return netip.Addr{}
	}
	addr := ap.Addr().Unmap()
	if !ri.isTrusted(addr) {
		return addr
	}
	hops := strings.Split(r.Header.Get("X-Forwarded-For"), ",")
	for i := len(hops) - 1; i >= 0; i-- {
		a, err := netip.ParseAddr(strings.TrimSpace(hops[i]))
		if err != nil {
			break
		}
		a = a.Unmap()
		if !ri.isTrusted(a) {
			return a
		}
		addr = a
	}
	return addr
}

func (ri *RealIP) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ctxKey{}, ri.Resolve(r))))
	})
}

// ClientIP 返回中间件解析出的客户端 IP。
func ClientIP(r *http.Request) netip.Addr {
	a, _ := r.Context().Value(ctxKey{}).(netip.Addr)
	return a
}
