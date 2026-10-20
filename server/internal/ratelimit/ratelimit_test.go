package ratelimit

import (
	"net/netip"
	"testing"
	"time"
)

func TestIPKey(t *testing.T) {
	for in, want := range map[string]string{
		"203.0.113.7":            "203.0.113.7",
		"::ffff:203.0.113.7":     "203.0.113.7",
		"2001:db8:1:2:a::1":      "2001:db8:1:2::/64",
		"2001:db8:1:2:ffff::abc": "2001:db8:1:2::/64",
		"2001:db8:1:3::1":        "2001:db8:1:3::/64",
	} {
		if got := IPKey(netip.MustParseAddr(in)); got != want {
			t.Errorf("%s → %s, want %s", in, got, want)
		}
	}
}

func TestWindowAndBlocker(t *testing.T) {
	now := time.Unix(0, 0)
	w := NewWindow(2, time.Minute)
	w.now = func() time.Time { return now }
	if !w.Allow("a") || !w.Allow("a") || w.Allow("a") || !w.Allow("b") {
		t.Fatal("window")
	}
	now = now.Add(61 * time.Second)
	if !w.Allow("a") {
		t.Fatal("window should slide")
	}

	b := NewBlocker(3, time.Minute, 15*time.Minute)
	b.now, b.failures.now = func() time.Time { return now }, func() time.Time { return now }
	b.Fail("ip")
	b.Fail("ip")
	if b.Blocked("ip") != 0 {
		t.Fatal("blocked too early")
	}
	b.Fail("ip")
	if b.Blocked("ip") != 15*time.Minute {
		t.Fatal(b.Blocked("ip"))
	}
	now = now.Add(16 * time.Minute)
	if b.Blocked("ip") != 0 {
		t.Fatal("block should expire")
	}
}

func TestBucket(t *testing.T) {
	now := time.Unix(0, 0)
	b := Bucket{Rate: 1, Burst: 5}
	n := 0
	for range 10 {
		if b.Allow(now) {
			n++
		}
	}
	if n != 5 {
		t.Fatal(n)
	}
	if !b.Allow(now.Add(time.Second)) || b.Allow(now.Add(time.Second)) {
		t.Fatal("refill")
	}
}
