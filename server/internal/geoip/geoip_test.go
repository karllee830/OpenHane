package geoip

import (
	"errors"
	"io"
	"log/slog"
	"net/netip"
	"os"
	"path/filepath"
	"testing"
)

func TestParse(t *testing.T) {
	cases := map[string]Location{
		"中国|广东省|广州市|电信|CN":                         {Country: "中国", Province: "广东省", City: "广州市", ISP: "电信"},
		"中国|北京市|北京市|联通|CN":                         {Country: "中国", Province: "北京市", ISP: "联通"},
		"United States|California|0|Google LLC|US": {Country: "United States", Province: "California", ISP: "Google LLC"},
		"0|0|0|内网IP|内网IP":                          {ISP: "内网IP"},
		"":                                         {},
	}
	for in, want := range cases {
		if got := parse(in); got != want {
			t.Errorf("parse(%q) = %+v, want %+v", in, got, want)
		}
	}
}

func TestLookup(t *testing.T) {
	dir := t.TempDir()
	d := Open(dir, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if _, err := d.Lookup(netip.MustParseAddr("240e:4c:4008::1")); !errors.Is(err, ErrNoDB) {
		t.Fatalf("IPv6 without database: %v", err)
	}
	if d.v4 == nil {
		t.Skip("built without IPv4 database (scripts/fetch-geoip.sh)")
	}
	loc, err := d.Lookup(netip.MustParseAddr("::ffff:202.96.128.86"))
	if err != nil || loc.Country != "中国" || loc.Province != "广东省" || loc.ISP != "电信" {
		t.Fatalf("lookup: %+v %v", loc, err)
	}
}

func TestBrokenV6File(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, V6File), []byte("broken"), 0o644); err != nil {
		t.Fatal(err)
	}
	d := Open(dir, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if d.HasV6() {
		t.Fatal("broken IPv6 database should not load")
	}
}
