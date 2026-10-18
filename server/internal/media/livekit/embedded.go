// Package livekit 是 media.Engine 的内嵌 LiveKit 实现：LiveKit SFU 作为库运行在本进程内，
// HTTP 只监听 127.0.0.1 的随机端口，由网关把 /rtc 转发过去（信令里的候选地址会按客户端连接的地址补充，
// 见 signal_proxy.go）；媒体走主端口号的 UDP（单端口复用）和 ICE-TCP 回退端口。
package livekit

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/http/httputil"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/go-logr/logr"
	lkconfig "github.com/livekit/livekit-server/pkg/config"
	"github.com/livekit/livekit-server/pkg/routing"
	"github.com/livekit/livekit-server/pkg/service"
	"github.com/livekit/livekit-server/pkg/telemetry/prometheus"
	"github.com/livekit/protocol/auth"
	lkp "github.com/livekit/protocol/livekit"
	lklogger "github.com/livekit/protocol/logger"
	"github.com/livekit/protocol/webhook"
	lksdk "github.com/livekit/server-sdk-go/v2"

	"github.com/karllee830/OpenHane/server/internal/media"
	"github.com/karllee830/OpenHane/server/internal/netdiag"
)

type Options struct {
	UDPPort int // 与对外主端口号相同
	TCPPort int // ICE-TCP 回退，0 表示关闭
	// NodeIP 是对外公布的媒体地址（HANE_PUBLIC_HOST 或 STUN 探测结果）；无效值表示只使用本机网卡地址。
	NodeIP      netip.Addr
	STUNServers []string
	Log         *slog.Logger
	// Debug 为 true 时输出 LiveKit 的 info / debug 日志；否则只输出 warn 以上。
	Debug bool
}

type Engine struct {
	opt    Options
	log    *slog.Logger
	key    string
	secret string
	lkURL  string

	server  *service.LivekitServer
	rooms   *lksdk.RoomServiceClient
	hookSrv *http.Server
	proxy   *httputil.ReverseProxy
	rtc     *signalProxy
	events  chan media.Event
	runErr  chan error
	// tcpOnly 记录只走 ICE-TCP 的连接（房间 + 身份），信令转发时据此过滤 UDP 候选
	tcpOnly sync.Map

	stopOnce sync.Once
}

func New(opt Options) *Engine {
	return &Engine{opt: opt, log: opt.Log.With("component", "media"), events: make(chan media.Event, 1024), runErr: make(chan error, 1)}
}

func randHex(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func (e *Engine) Start(ctx context.Context) error {
	httpPort, err := freeLoopbackPort()
	if err != nil {
		return err
	}
	hookLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	// API 密钥每次启动随机生成，只在进程内使用，不落盘
	e.key, e.secret = "om_"+randHex(8), randHex(32)

	conf, err := lkconfig.NewConfig(e.yaml(httpPort, "http://"+hookLn.Addr().String()+"/hook"), true, nil, nil)
	if err != nil {
		hookLn.Close()
		return fmt.Errorf("livekit config: %w", err)
	}
	e.bridgeLogs()
	node, err := routing.NewLocalNode(conf)
	if err != nil {
		hookLn.Close()
		return err
	}
	if err := prometheus.Init(string(node.NodeID()), node.NodeType()); err != nil {
		hookLn.Close()
		return err
	}
	e.server, err = service.InitializeServer(conf, node)
	if err != nil {
		hookLn.Close()
		return fmt.Errorf("livekit init: %w", err)
	}
	go func() { e.runErr <- e.server.Start() }()

	e.lkURL = fmt.Sprintf("http://127.0.0.1:%d", httpPort)
	if err := waitHTTP(ctx, e.lkURL, 15*time.Second, e.runErr); err != nil {
		hookLn.Close()
		return fmt.Errorf("livekit did not start: %w", err)
	}
	e.rooms = lksdk.NewRoomServiceClient(e.lkURL, e.key, e.secret)

	target, _ := url.Parse(e.lkURL)
	e.proxy = httputil.NewSingleHostReverseProxy(target)
	e.proxy.ErrorLog = slog.NewLogLogger(e.log.Handler(), slog.LevelDebug)
	e.rtc = newSignalProxy(target, e.proxy, netdiag.ResolveHost, e.isTCPOnly, e.log)

	keys := auth.NewSimpleKeyProvider(e.key, e.secret)
	e.hookSrv = &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ev, err := webhook.ReceiveWebhookEvent(r, keys)
		if err != nil {
			e.log.Warn("webhook rejected", "err", err)
			http.Error(w, "bad webhook", http.StatusUnauthorized)
			return
		}
		if me, ok := convertEvent(ev); ok {
			select {
			case e.events <- me:
			case <-r.Context().Done():
			}
		}
	}), ReadHeaderTimeout: 5 * time.Second}
	go e.hookSrv.Serve(hookLn)

	e.log.Info("media engine started", "udp", e.opt.UDPPort, "ice_tcp", e.opt.TCPPort, "node_ip", e.opt.NodeIP)
	return nil
}

// Err 在 LiveKit 意外退出时收到错误。
func (e *Engine) Err() <-chan error { return e.runErr }

func (e *Engine) yaml(httpPort int, hookURL string) string {
	var rtc strings.Builder
	fmt.Fprintf(&rtc, "  udp_port: %d\n  tcp_port: %d\n  use_external_ip: false\n", e.opt.UDPPort, e.opt.TCPPort)
	if e.opt.NodeIP.IsValid() {
		// 显式指定对外地址，同时保留本机网卡地址作为候选（局域网内的客户端可以直连）
		fmt.Fprintf(&rtc, "  node_ip: %s\n  advertise_internal_ip: true\n", e.opt.NodeIP)
	}
	if len(e.opt.STUNServers) > 0 {
		quoted := make([]string, len(e.opt.STUNServers))
		for i, srv := range e.opt.STUNServers {
			quoted[i] = strconv.Quote(srv)
		}
		fmt.Fprintf(&rtc, "  stun_servers: [%s]\n", strings.Join(quoted, ", "))
	}
	return fmt.Sprintf(`port: %d
bind_addresses: ["127.0.0.1"]
rtc:
%s  congestion_control:
    enabled: true
    allow_pause: true
room:
  auto_create: false
  enabled_codecs:
    - mime: audio/opus
    - mime: audio/red
    - mime: video/vp8
    - mime: video/h264
    - mime: video/vp9
    - mime: video/av1
    - mime: video/h265
keys:
  %s: %s
webhook:
  api_key: %s
  urls: ["%s"]
logging:
  level: %s
`, httpPort, rtc.String(), e.key, e.secret, e.key, hookURL, map[bool]string{true: "debug", false: "warn"}[e.opt.Debug])
}

// bridgeLogs 把 LiveKit 的日志转到我们的 slog（带 component=media），而不是让它自建 zap 日志。
func (e *Engine) bridgeLogs() {
	min := slog.LevelWarn
	if e.opt.Debug {
		min = slog.LevelDebug
	}
	h := &minLevel{Handler: e.log.Handler(), min: min}
	lklogger.SetLogger(lklogger.LogRLogger(logr.FromSlogHandler(h)), "livekit")
}

type minLevel struct {
	slog.Handler
	min slog.Level
}

func (m *minLevel) Enabled(ctx context.Context, l slog.Level) bool {
	return l >= m.min && m.Handler.Enabled(ctx, l)
}
func (m *minLevel) WithAttrs(a []slog.Attr) slog.Handler {
	return &minLevel{m.Handler.WithAttrs(a), m.min}
}
func (m *minLevel) WithGroup(n string) slog.Handler { return &minLevel{m.Handler.WithGroup(n), m.min} }

func (e *Engine) Stop(ctx context.Context) error {
	e.stopOnce.Do(func() {
		if e.hookSrv != nil {
			e.hookSrv.Shutdown(ctx)
		}
		if e.server != nil {
			e.server.Stop(true)
		}
		close(e.events)
	})
	return nil
}

func (e *Engine) EnsureRoom(ctx context.Context, room string, opts media.RoomOptions) error {
	req := &lkp.CreateRoomRequest{Name: room}
	if opts.EmptyTimeout > 0 {
		req.EmptyTimeout = uint32(opts.EmptyTimeout / time.Second)
		req.DepartureTimeout = req.EmptyTimeout
	}
	_, err := e.rooms.CreateRoom(ctx, req)
	return err
}

func (e *Engine) DeleteRoom(ctx context.Context, room string) error {
	e.tcpOnly.Range(func(k, _ any) bool {
		if strings.HasPrefix(k.(string), room+"\x00") {
			e.tcpOnly.Delete(k)
		}
		return true
	})
	_, err := e.rooms.DeleteRoom(ctx, &lkp.DeleteRoomRequest{Room: room})
	return err
}

func (e *Engine) IssueToken(p media.TokenParams) (string, time.Time, error) {
	canPublish := len(p.Perm.Sources) > 0
	canSubscribe := p.Perm.CanSubscribe
	canPublishData := false
	sources := make([]string, len(p.Perm.Sources))
	for i, s := range p.Perm.Sources {
		sources[i] = string(s)
	}
	grant := &auth.VideoGrant{
		RoomJoin:          true,
		Room:              p.Room,
		CanPublish:        &canPublish,
		CanSubscribe:      &canSubscribe,
		CanPublishData:    &canPublishData, // 聊天走控制协议
		CanPublishSources: sources,
	}
	if key := p.Room + "\x00" + p.Identity; p.TCPOnly && e.TCPAvailable() {
		e.tcpOnly.Store(key, true)
	} else {
		e.tcpOnly.Delete(key)
	}
	expires := time.Now().Add(p.TTL)
	tok, err := auth.NewAccessToken(e.key, e.secret).
		SetIdentity(p.Identity).
		SetName(p.Name).
		SetMetadata(p.Metadata).
		SetVideoGrant(grant).
		SetValidFor(p.TTL).
		ToJWT()
	return tok, expires, err
}

func (e *Engine) TCPAvailable() bool { return e.opt.TCPPort != 0 }

// isTCPOnly 判断一个 /rtc 信令请求是不是只走 TCP 的连接：校验令牌，按其中的房间和身份查 IssueToken 时的标记。
// LiveKit 自动续期的令牌房间和身份不变，重连时同样能查到。
func (e *Engine) isTCPOnly(r *http.Request) bool {
	raw := r.URL.Query().Get("access_token")
	if raw == "" {
		raw, _ = strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	}
	if raw == "" {
		return false
	}
	v, err := auth.ParseAPIToken(raw)
	if err != nil || v.APIKey() != e.key {
		return false
	}
	_, grants, err := v.Verify(e.secret)
	if err != nil || grants.Video == nil {
		return false
	}
	_, ok := e.tcpOnly.Load(grants.Video.Room + "\x00" + grants.Identity)
	return ok
}

func (e *Engine) UpdatePermission(ctx context.Context, room, identity string, perm media.Permission) error {
	sources := make([]lkp.TrackSource, 0, len(perm.Sources))
	for _, s := range perm.Sources {
		sources = append(sources, toTrackSource(s))
	}
	_, err := e.rooms.UpdateParticipant(ctx, &lkp.UpdateParticipantRequest{
		Room:     room,
		Identity: identity,
		Permission: &lkp.ParticipantPermission{
			CanSubscribe:      perm.CanSubscribe,
			CanPublish:        len(perm.Sources) > 0,
			CanPublishData:    false,
			CanPublishSources: sources,
		},
	})
	return err
}

func (e *Engine) MuteTrack(ctx context.Context, room, identity, trackSID string, muted bool) error {
	_, err := e.rooms.MutePublishedTrack(ctx, &lkp.MuteRoomTrackRequest{Room: room, Identity: identity, TrackSid: trackSID, Muted: muted})
	return err
}

func (e *Engine) RemoveParticipant(ctx context.Context, room, identity string) error {
	_, err := e.rooms.RemoveParticipant(ctx, &lkp.RoomParticipantIdentity{Room: room, Identity: identity})
	return err
}

func (e *Engine) Events() <-chan media.Event { return e.events }

func (e *Engine) Stats(ctx context.Context) (media.Stats, error) {
	res, err := e.rooms.ListRooms(ctx, &lkp.ListRoomsRequest{})
	if err != nil {
		return media.Stats{}, err
	}
	s := media.Stats{Rooms: len(res.Rooms)}
	for _, r := range res.Rooms {
		s.Participants += int(r.NumParticipants)
	}
	return s, nil
}

func (e *Engine) RTCHandler() http.Handler { return e.rtc }

func (e *Engine) Ready(ctx context.Context) error {
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, e.lkURL, nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("media engine: %w", err)
	}
	resp.Body.Close()
	return nil
}

func convertEvent(ev *lkp.WebhookEvent) (media.Event, bool) {
	me := media.Event{Room: ev.GetRoom().GetName(), Identity: ev.GetParticipant().GetIdentity()}
	switch ev.GetEvent() {
	case webhook.EventParticipantJoined:
		me.Kind = media.ParticipantJoined
	case webhook.EventParticipantLeft, webhook.EventParticipantConnectionAborted:
		me.Kind = media.ParticipantLeft
	case webhook.EventTrackPublished:
		me.Kind = media.TrackPublished
	case webhook.EventTrackUnpublished:
		me.Kind = media.TrackUnpublished
	case webhook.EventRoomFinished:
		me.Kind = media.RoomFinished
	default:
		return me, false
	}
	if t := ev.GetTrack(); t != nil {
		me.TrackSID = t.GetSid()
		me.Source = fromTrackSource(t.GetSource())
	}
	return me, true
}

func toTrackSource(s media.Source) lkp.TrackSource {
	switch s {
	case media.SourceMicrophone:
		return lkp.TrackSource_MICROPHONE
	case media.SourceCamera:
		return lkp.TrackSource_CAMERA
	case media.SourceScreenShare:
		return lkp.TrackSource_SCREEN_SHARE
	case media.SourceScreenShareAudio:
		return lkp.TrackSource_SCREEN_SHARE_AUDIO
	}
	return lkp.TrackSource_UNKNOWN
}

func fromTrackSource(s lkp.TrackSource) media.Source {
	switch s {
	case lkp.TrackSource_MICROPHONE:
		return media.SourceMicrophone
	case lkp.TrackSource_CAMERA:
		return media.SourceCamera
	case lkp.TrackSource_SCREEN_SHARE:
		return media.SourceScreenShare
	case lkp.TrackSource_SCREEN_SHARE_AUDIO:
		return media.SourceScreenShareAudio
	}
	return ""
}

func freeLoopbackPort() (int, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer ln.Close()
	return ln.Addr().(*net.TCPAddr).Port, nil
}

func waitHTTP(ctx context.Context, u string, timeout time.Duration, runErr <-chan error) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		select {
		case err := <-runErr:
			return fmt.Errorf("exited: %w", err)
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		if resp, err := http.Get(u); err == nil {
			resp.Body.Close()
			return nil
		}
		time.Sleep(50 * time.Millisecond)
	}
	return errors.New("timeout")
}
