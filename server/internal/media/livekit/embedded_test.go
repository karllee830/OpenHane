package livekit

import (
	"io"
	"log/slog"
	"net/netip"
	"testing"

	lkconfig "github.com/livekit/livekit-server/pkg/config"
	lkp "github.com/livekit/protocol/livekit"
	"github.com/livekit/protocol/webhook"

	"github.com/karllee830/OpenHane/server/internal/media"
)

func TestGeneratedConfigParses(t *testing.T) {
	e := New(Options{UDPPort: 9800, TCPPort: 0, NodeIP: netip.MustParseAddr("203.0.113.10"),
		STUNServers: []string{"a:1", "b:2"}, Log: slog.New(slog.NewTextHandler(io.Discard, nil))})
	e.key, e.secret = "k", "0123456789abcdef0123456789abcdef"
	conf, err := lkconfig.NewConfig(e.yaml(12345, "http://127.0.0.1:1/hook"), true, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if conf.Room.AutoCreate || conf.RTC.UDPPort.Start != 9800 || conf.RTC.TCPPort != 0 ||
		conf.RTC.NodeIP.V4 != "203.0.113.10" || !conf.RTC.AdvertiseInternalIP || len(conf.RTC.STUNServers) != 2 {
		t.Fatalf("unexpected config: %+v", conf.RTC)
	}
}

func TestConvertEvent(t *testing.T) {
	ev := &lkp.WebhookEvent{Event: webhook.EventTrackPublished, Room: &lkp.Room{Name: "main"},
		Participant: &lkp.ParticipantInfo{Identity: "u:s"}, Track: &lkp.TrackInfo{Sid: "TR_1", Source: lkp.TrackSource_SCREEN_SHARE}}
	me, ok := convertEvent(ev)
	if !ok || me.Kind != media.TrackPublished || me.Source != media.SourceScreenShare || me.Identity != "u:s" {
		t.Fatalf("%+v", me)
	}
	if _, ok := convertEvent(&lkp.WebhookEvent{Event: "egress_started"}); ok {
		t.Fatal("unknown events should be ignored")
	}
}
