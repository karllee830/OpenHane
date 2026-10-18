// Package config 解析部署配置（环境变量）。
//
// 原则：所有环境变量都是可选的。只有部署相关、启动前必须确定的配置才放这里；
// 运营类设置（服务器名称、码率上限等）存在数据库里，由管理面板修改（见 internal/settings）。
package config

import (
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/netip"
	"strconv"
	"strings"
)

type TLSMode string

const (
	TLSSelfSigned TLSMode = "self-signed"
	TLSACME       TLSMode = "acme"
	TLSACMEIP     TLSMode = "acme-ip"
	TLSFile       TLSMode = "file"
	TLSOff        TLSMode = "off"
)

type Config struct {
	Port              int
	TCPFallbackPort   int // 0 表示关闭 ICE-TCP 回退
	PublicHost        string
	TLSMode           TLSMode
	Domain            string
	ACMEEmail         string
	TLSCert           string
	TLSKey            string
	TrustedProxies    []netip.Prefix
	STUNServers       []string
	DataDir           string
	LogLevel          slog.Level
	LogFormat         string // text | json
	Metrics           bool
	MetricsToken      string
	BackupKeep        int
	MediaMode         string // embedded | subprocess
	InitialServerName string
	// ConnPerMinute 单个 IP 每分钟允许的新连接数（0 表示不限）。整个办公室共用一个出口 IP 时需要调大
	ConnPerMinute int
}

// DefaultSTUNServers 用于公网 IP 探测；同时包含海外和中国大陆可访问的服务器。
var DefaultSTUNServers = []string{
	"stun.l.google.com:19302",
	"stun.cloudflare.com:3478",
	"stun.miwifi.com:3478",
	"stun.qq.com:3478",
}

// Load 从 getenv 读取配置（测试时可传入假的 getenv）。
func Load(getenv func(string) string) (*Config, error) {
	var errs []error
	str := func(key, def string) string {
		if v := strings.TrimSpace(getenv(key)); v != "" {
			return v
		}
		return def
	}
	num := func(key string, def, min, max int) int {
		v := strings.TrimSpace(getenv(key))
		if v == "" {
			return def
		}
		n, err := strconv.Atoi(v)
		if err != nil || n < min || n > max {
			errs = append(errs, fmt.Errorf("%s=%q：应为 %d–%d 之间的整数", key, v, min, max))
			return def
		}
		return n
	}
	boolean := func(key string, def bool) bool {
		v := strings.TrimSpace(getenv(key))
		if v == "" {
			return def
		}
		b, err := strconv.ParseBool(v)
		if err != nil {
			errs = append(errs, fmt.Errorf("%s=%q：应为 true 或 false", key, v))
			return def
		}
		return b
	}

	c := &Config{
		Port:              num("HANE_PORT", 9800, 1, 65535),
		TCPFallbackPort:   num("HANE_TCP_FALLBACK_PORT", 9801, 0, 65535),
		PublicHost:        str("HANE_PUBLIC_HOST", ""),
		TLSMode:           TLSMode(str("HANE_TLS_MODE", string(TLSSelfSigned))),
		Domain:            str("HANE_DOMAIN", ""),
		ACMEEmail:         str("HANE_ACME_EMAIL", ""),
		TLSCert:           str("HANE_TLS_CERT", ""),
		TLSKey:            str("HANE_TLS_KEY", ""),
		DataDir:           str("HANE_DATA_DIR", "/data"),
		LogFormat:         str("HANE_LOG_FORMAT", "text"),
		Metrics:           boolean("HANE_METRICS", false),
		MetricsToken:      str("HANE_METRICS_TOKEN", ""),
		BackupKeep:        num("HANE_BACKUP_KEEP", 7, 0, 365),
		MediaMode:         str("HANE_MEDIA_MODE", "embedded"),
		InitialServerName: str("HANE_INITIAL_SERVER_NAME", ""),
		ConnPerMinute:     num("HANE_CONN_PER_MINUTE", 60, 0, 100000),
		STUNServers:       DefaultSTUNServers,
	}

	if v := str("HANE_STUN_SERVERS", ""); v != "" {
		c.STUNServers = splitList(v)
		if len(c.STUNServers) == 1 && (strings.EqualFold(v, "off") || strings.EqualFold(v, "none")) {
			c.STUNServers = nil // 不探测公网 IP（内网部署、测试）
		}
	}
	for _, p := range splitList(getenv("HANE_TRUSTED_PROXIES")) {
		prefix, err := netip.ParsePrefix(p)
		if err != nil {
			addr, err2 := netip.ParseAddr(p)
			if err2 != nil {
				errs = append(errs, fmt.Errorf("HANE_TRUSTED_PROXIES：%q 不是有效的 IP 或网段", p))
				continue
			}
			prefix = netip.PrefixFrom(addr, addr.BitLen())
		}
		c.TrustedProxies = append(c.TrustedProxies, prefix)
	}

	switch lv := strings.ToLower(str("HANE_LOG_LEVEL", "info")); lv {
	case "debug":
		c.LogLevel = slog.LevelDebug
	case "info":
		c.LogLevel = slog.LevelInfo
	case "warn":
		c.LogLevel = slog.LevelWarn
	case "error":
		c.LogLevel = slog.LevelError
	default:
		errs = append(errs, fmt.Errorf("HANE_LOG_LEVEL=%q：应为 debug / info / warn / error", lv))
	}
	if c.LogFormat != "text" && c.LogFormat != "json" {
		errs = append(errs, fmt.Errorf("HANE_LOG_FORMAT=%q：应为 text 或 json", c.LogFormat))
	}

	switch c.TLSMode {
	case TLSSelfSigned, TLSOff:
	case TLSFile:
		if c.TLSCert == "" || c.TLSKey == "" {
			errs = append(errs, errors.New("HANE_TLS_MODE=file 时必须同时设置 HANE_TLS_CERT 和 HANE_TLS_KEY"))
		}
	case TLSACME:
		if c.Domain == "" {
			errs = append(errs, errors.New("HANE_TLS_MODE=acme 时必须设置 HANE_DOMAIN"))
		}
		errs = append(errs, errors.New("HANE_TLS_MODE=acme 尚未实现（M1 后续提交）"))
	case TLSACMEIP:
		errs = append(errs, errors.New("HANE_TLS_MODE=acme-ip 计划在 1.1 提供"))
	default:
		errs = append(errs, fmt.Errorf("HANE_TLS_MODE=%q：应为 self-signed / acme / acme-ip / file / off", c.TLSMode))
	}

	switch c.MediaMode {
	case "embedded":
	case "subprocess":
		errs = append(errs, errors.New("HANE_MEDIA_MODE=subprocess 是后备方案，尚未实现"))
	default:
		errs = append(errs, fmt.Errorf("HANE_MEDIA_MODE=%q：应为 embedded 或 subprocess", c.MediaMode))
	}

	if c.TCPFallbackPort == c.Port {
		errs = append(errs, errors.New("HANE_TCP_FALLBACK_PORT 不能与 HANE_PORT 相同"))
	}
	if c.PublicHost != "" {
		if ip := net.ParseIP(c.PublicHost); ip != nil && ip.IsLoopback() {
			// LiveKit 只在网卡地址上监听 UDP，回环地址作为对外地址会导致媒体不通
			errs = append(errs, fmt.Errorf("HANE_PUBLIC_HOST=%s 是回环地址，客户端无法用它建立媒体连接；本机测试时不要设置", c.PublicHost))
		}
	}
	return c, errors.Join(errs...)
}

func splitList(s string) []string {
	var out []string
	for _, f := range strings.FieldsFunc(s, func(r rune) bool { return r == ',' || r == ' ' || r == ';' }) {
		if f = strings.TrimSpace(f); f != "" {
			out = append(out, f)
		}
	}
	return out
}
