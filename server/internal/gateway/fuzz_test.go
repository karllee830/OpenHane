package gateway

import (
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
)

// X-Forwarded-For 由客户端控制：结果只能是直连地址，或者头里出现过的合法地址；直连方不可信时一律用直连地址
func FuzzRealIP(f *testing.F) {
	for _, s := range []string{"203.0.113.9", "198.51.100.1, 10.0.0.2", "garbage", ", ,", "::ffff:1.2.3.4", "1.2.3.4,::1"} {
		f.Add(s, true)
		f.Add(s, false)
	}
	trusted := NewRealIP([]netip.Prefix{netip.MustParsePrefix("10.0.0.0/8")})
	f.Fuzz(func(t *testing.T, xff string, fromProxy bool) {
		r := httptest.NewRequest("GET", "/", nil)
		r.RemoteAddr = "192.0.2.7:4000"
		if fromProxy {
			r.RemoteAddr = "10.0.0.1:4000"
		}
		r.Header.Set("X-Forwarded-For", xff)
		got := trusted.Resolve(r)
		direct := netip.MustParseAddrPort(r.RemoteAddr).Addr()
		if !fromProxy && got != direct {
			t.Fatalf("untrusted peer: got %v, want %v", got, direct)
		}
		if got == direct {
			return
		}
		for _, hop := range strings.Split(xff, ",") {
			if a, err := netip.ParseAddr(strings.TrimSpace(hop)); err == nil && a.Unmap() == got {
				return
			}
		}
		t.Fatalf("got %v which is neither the peer nor in %q", got, xff)
	})
}
