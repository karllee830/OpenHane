package netdiag

import (
	"context"
	"net"
	"net/netip"
	"testing"
	"time"

	"github.com/pion/stun/v3"
)

// fakeSTUN 启动一个本地 STUN 服务器，总是回复给定的映射地址。
func fakeSTUN(t *testing.T, mapped string) string {
	t.Helper()
	pc, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pc.Close() })
	go func() {
		buf := make([]byte, 1500)
		for {
			n, from, err := pc.ReadFrom(buf)
			if err != nil {
				return
			}
			req := &stun.Message{Raw: append([]byte(nil), buf[:n]...)}
			if req.Decode() != nil {
				continue
			}
			res := stun.MustBuild(stun.NewTransactionIDSetter(req.TransactionID), stun.BindingSuccess,
				&stun.XORMappedAddress{IP: net.ParseIP(mapped), Port: 4242})
			pc.WriteTo(res.Raw, from)
		}
	}()
	return pc.LocalAddr().String()
}

func TestProbePublicIP(t *testing.T) {
	a := fakeSTUN(t, "203.0.113.10")
	b := fakeSTUN(t, "203.0.113.10")
	c := fakeSTUN(t, "198.51.100.1")
	got, err := ProbePublicIP(context.Background(), []string{a, b, c, "127.0.0.1:1"}, 2*time.Second)
	if err != nil || got != netip.MustParseAddr("203.0.113.10") {
		t.Fatal(got, err)
	}
	if _, err := ProbePublicIP(context.Background(), []string{"127.0.0.1:1"}, 600*time.Millisecond); err == nil {
		t.Fatal("expected failure")
	}
}

func TestResolveHost(t *testing.T) {
	a, err := ResolveHost(context.Background(), "192.0.2.1")
	if err != nil || a.String() != "192.0.2.1" {
		t.Fatal(a, err)
	}
	if !IsLocalAddr(netip.MustParseAddr("127.0.0.1")) {
		t.Fatal("loopback should be local")
	}
}
