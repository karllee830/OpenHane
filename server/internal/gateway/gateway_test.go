package gateway

import (
	"net/http/httptest"
	"net/netip"
	"testing"
)

func TestRealIP(t *testing.T) {
	ri := NewRealIP([]netip.Prefix{netip.MustParsePrefix("10.0.0.0/8")})
	cases := []struct {
		remote, xff, want string
	}{
		{"203.0.113.5:1234", "", "203.0.113.5"},
		{"203.0.113.5:1234", "1.2.3.4", "203.0.113.5"},                       // 直连方不可信，忽略 XFF
		{"10.0.0.2:1234", "198.51.100.7", "198.51.100.7"},                    // 可信代理
		{"10.0.0.2:1234", "6.6.6.6, 198.51.100.7, 10.0.0.9", "198.51.100.7"}, // 从右往左取第一个不可信
		{"10.0.0.2:1234", "", "10.0.0.2"},
		{"[::ffff:203.0.113.9]:1", "", "203.0.113.9"},
	}
	for _, c := range cases {
		r := httptest.NewRequest("GET", "/", nil)
		r.RemoteAddr = c.remote
		if c.xff != "" {
			r.Header.Set("X-Forwarded-For", c.xff)
		}
		if got := ri.Resolve(r).String(); got != c.want {
			t.Errorf("%s / %q: got %s want %s", c.remote, c.xff, got, c.want)
		}
	}
}
