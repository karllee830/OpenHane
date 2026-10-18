package config

import (
	"log/slog"
	"strings"
	"testing"
)

func env(m map[string]string) func(string) string { return func(k string) string { return m[k] } }

func TestDefaults(t *testing.T) {
	c, err := Load(env(nil))
	if err != nil {
		t.Fatal(err)
	}
	if c.Port != 9800 || c.TCPFallbackPort != 9801 || c.TLSMode != TLSSelfSigned || c.DataDir != "/data" ||
		c.LogLevel != slog.LevelInfo || c.BackupKeep != 7 || c.MediaMode != "embedded" || len(c.STUNServers) == 0 || c.ConnPerMinute != 60 {
		t.Fatalf("unexpected defaults: %+v", c)
	}
}

func TestOverrides(t *testing.T) {
	c, err := Load(env(map[string]string{
		"HANE_PORT":              "443",
		"HANE_TCP_FALLBACK_PORT": "0",
		"HANE_LOG_LEVEL":         "DEBUG",
		"HANE_TRUSTED_PROXIES":   "10.0.0.0/8, 192.168.1.1",
		"HANE_STUN_SERVERS":      "a:1;b:2",
		"HANE_TLS_MODE":          "file",
		"HANE_TLS_CERT":          "/c.pem",
		"HANE_TLS_KEY":           "/k.pem",
		"HANE_CONN_PER_MINUTE":   "0",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if c.Port != 443 || c.TCPFallbackPort != 0 || c.LogLevel != slog.LevelDebug || c.ConnPerMinute != 0 {
		t.Fatalf("unexpected: %+v", c)
	}
	if len(c.TrustedProxies) != 2 || c.TrustedProxies[1].Bits() != 32 {
		t.Fatalf("proxies: %v", c.TrustedProxies)
	}
	if strings.Join(c.STUNServers, ",") != "a:1,b:2" {
		t.Fatalf("stun: %v", c.STUNServers)
	}
}

func TestSTUNOff(t *testing.T) {
	c, err := Load(env(map[string]string{"HANE_STUN_SERVERS": "off"}))
	if err != nil || len(c.STUNServers) != 0 {
		t.Fatal(c.STUNServers, err)
	}
}

func TestInvalid(t *testing.T) {
	cases := map[string]map[string]string{
		"port":        {"HANE_PORT": "70000"},
		"same port":   {"HANE_PORT": "9000", "HANE_TCP_FALLBACK_PORT": "9000"},
		"loopback":    {"HANE_PUBLIC_HOST": "127.0.0.1"},
		"tls file":    {"HANE_TLS_MODE": "file"},
		"tls unknown": {"HANE_TLS_MODE": "magic"},
		"conn limit":  {"HANE_CONN_PER_MINUTE": "-1"},
		"log level":   {"HANE_LOG_LEVEL": "loud"},
		"proxy":       {"HANE_TRUSTED_PROXIES": "not-an-ip"},
		"bool":        {"HANE_METRICS": "yes please"},
	}
	for name, m := range cases {
		if _, err := Load(env(m)); err == nil {
			t.Errorf("%s: expected error", name)
		}
	}
}
