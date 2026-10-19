package signal_test

import (
	"context"
	"crypto/ed25519"
	"crypto/tls"
	"errors"
	"io"
	"log/slog"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/karllee830/OpenHane/server/internal/client"
	"github.com/karllee830/OpenHane/server/internal/config"
	"github.com/karllee830/OpenHane/server/internal/gateway"
	"github.com/karllee830/OpenHane/server/internal/geoip"
	"github.com/karllee830/OpenHane/server/internal/hub"
	"github.com/karllee830/OpenHane/server/internal/identity"
	"github.com/karllee830/OpenHane/server/internal/media"
	"github.com/karllee830/OpenHane/server/internal/pb"
	"github.com/karllee830/OpenHane/server/internal/perm"
	"github.com/karllee830/OpenHane/server/internal/settings"
	"github.com/karllee830/OpenHane/server/internal/signal"
	"github.com/karllee830/OpenHane/server/internal/store"
	"github.com/karllee830/OpenHane/server/internal/tlsmgr"
)

type env struct {
	t     *testing.T
	url   string
	hub   *hub.Hub
	store *store.Store
	media *media.Fake
	sig   *signal.Server
}

func setup(t *testing.T) *env {
	t.Helper()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	dir := t.TempDir()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	st, err := store.Open(ctx, dir, log)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	tm, err := tlsmgr.New(&config.Config{TLSMode: config.TLSSelfSigned, DataDir: dir}, log)
	if err != nil {
		t.Fatal(err)
	}
	fake := media.NewFake()
	h := hub.New(hub.Options{
		Store: st, Media: fake, Settings: settings.Defaults(), ServerID: []byte("0123456789abcdef"),
		Version: "test", ProtocolMin: 1, ProtocolMax: 1, Log: log,
		HashPassword: settings.HashPassword, ResumeGrace: 300 * time.Millisecond, ShareGrace: 300 * time.Millisecond,
		GeoIP: geoip.Open(dir, log),
	})
	go h.Run(ctx)
	sig := signal.NewServer(h, st, tm, log)
	srv := httptest.NewUnstartedServer(gateway.NewRealIP(nil).Middleware(sig))
	// 不用 StartTLS：它会塞入 httptest 自己的证书，按 IP 连接（没有 SNI）时优先使用，指纹就对不上了
	srv.Listener = tls.NewListener(srv.Listener, tm.TLSConfig())
	srv.Start()
	t.Cleanup(srv.Close)
	return &env{t: t, url: "wss://" + srv.Listener.Addr().String() + "/ws", hub: h, store: st, media: fake, sig: sig}
}

func seed(n byte) []byte { s := make([]byte, 32); s[0] = n; return s }

func ctx(t *testing.T) context.Context {
	c, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	t.Cleanup(cancel)
	return c
}

func (e *env) dial(n byte, nick string, mod ...func(*client.Options)) (*client.Client, error) {
	o := client.Options{URL: e.url, MasterSeed: seed(n), Nickname: nick}
	for _, m := range mod {
		m(&o)
	}
	return client.Dial(ctx(e.t), o)
}

func (e *env) mustDial(n byte, nick string, mod ...func(*client.Options)) *client.Client {
	e.t.Helper()
	c, err := e.dial(n, nick, mod...)
	if err != nil {
		e.t.Fatalf("dial %s: %v", nick, err)
	}
	e.t.Cleanup(func() { c.Close() })
	return c
}

func isJoined(ev *pb.Event) bool { return ev.GetParticipantJoined() != nil }

func TestJoinChatAndPresence(t *testing.T) {
	e := setup(t)
	a := e.mustDial(1, "Alice")
	w := a.Welcome
	if w.GetNickname() != "Alice" || w.GetRole() != pb.Role_ROLE_MEMBER || len(w.GetSnapshot().GetParticipants()) != 1 {
		t.Fatalf("welcome: %v", w)
	}
	if w.GetAutoJoin().GetRoomId() != "main" || !strings.HasPrefix(w.GetAutoJoin().GetMedia().GetToken(), "fake:main:") {
		t.Fatalf("auto join: %v", w.GetAutoJoin())
	}
	if w.GetAutoJoin().GetPolicy().GetAudio().GetMaxBitrateBps() != 32000 {
		t.Fatalf("policy: %v", w.GetAutoJoin().GetPolicy())
	}
	// 媒体权限：麦克风 + 摄像头，不含屏幕共享（需要共享许可）
	p, _ := e.media.Perm("main", w.GetUid()+":"+w.GetSessionId())
	if len(p.Sources) != 2 || p.Sources[0] != media.SourceMicrophone {
		t.Fatalf("media perm: %+v", p)
	}

	// 同一服务器、同一主种子 → 同一 UID；同名自动加后缀
	b := e.mustDial(2, "alice")
	if b.Welcome.GetNickname() != "alice (2)" {
		t.Fatalf("nickname: %s", b.Welcome.GetNickname())
	}
	ev, err := a.WaitEvent(ctx(t), isJoined)
	if err != nil || ev.GetParticipantJoined().GetParticipant().GetNickname() != "alice (2)" {
		t.Fatal(ev, err)
	}
	if ev.GetSeq() != 1 {
		t.Fatalf("first event seq should be 1, got %d", ev.GetSeq())
	}

	// 聊天
	resp, err := b.Request(ctx(t), &pb.Request{Body: &pb.Request_SendChat{SendChat: &pb.SendChat{RoomId: "main", Text: " 你好 ", ClientMsgId: "m1"}}})
	if err != nil || resp.GetSendChat().GetMessage().GetText() != "你好" {
		t.Fatal(resp, err)
	}
	ev, err = a.WaitEvent(ctx(t), func(ev *pb.Event) bool { return ev.GetChatMessage() != nil })
	if err != nil || ev.GetChatMessage().GetSenderName() != "alice (2)" || ev.GetChatMessage().GetClientMsgId() != "m1" {
		t.Fatal(ev, err)
	}
	hist, err := a.Request(ctx(t), &pb.Request{Body: &pb.Request_GetChatHistory{GetChatHistory: &pb.GetChatHistory{RoomId: "main"}}})
	if err != nil || len(hist.GetGetChatHistory().GetMessages()) != 1 {
		t.Fatal(hist, err)
	}
	if _, err := a.Request(ctx(t), &pb.Request{Body: &pb.Request_SendChat{SendChat: &pb.SendChat{RoomId: "main", Text: "   "}}}); client.Code(err) != pb.ErrorCode_ERROR_CODE_INVALID_ARGUMENT {
		t.Fatal("empty chat should be rejected", err)
	}
	// 聊天限流：每 5 秒 5 条
	limited := false
	for i := range 8 {
		_, err := a.Request(ctx(t), &pb.Request{Body: &pb.Request_SendChat{SendChat: &pb.SendChat{RoomId: "main", Text: "x" + string(rune('0'+i))}}})
		if client.Code(err) == pb.ErrorCode_ERROR_CODE_RATE_LIMITED {
			limited = true
			break
		}
	}
	if !limited {
		t.Fatal("chat should be rate limited")
	}

	// 自身状态
	muted := true
	if _, err := a.Request(ctx(t), &pb.Request{Body: &pb.Request_UpdateSelf{UpdateSelf: &pb.UpdateSelf{MicMuted: &muted}}}); err != nil {
		t.Fatal(err)
	}
	ev, err = b.WaitEvent(ctx(t), func(ev *pb.Event) bool {
		p := ev.GetParticipantUpdated().GetParticipant()
		return p.GetNickname() == "Alice" && p.GetState().GetMicMuted()
	})
	if err != nil {
		t.Fatal(err)
	}

	// 媒体连接状态来自 SFU 的事件
	e.media.Emit(media.Event{Kind: media.ParticipantJoined, Room: "main", Identity: w.GetUid() + ":" + w.GetSessionId()})
	if _, err := b.WaitEvent(ctx(t), func(ev *pb.Event) bool {
		return ev.GetParticipantUpdated().GetParticipant().GetMediaConnected()
	}); err != nil {
		t.Fatal(err)
	}

	if p, err := a.Ping(ctx(t)); err != nil || p.GetServerTimeMs() == 0 {
		t.Fatal(p, err)
	}
	if _, err := a.Request(ctx(t), &pb.Request{Body: &pb.Request_JoinRoom{JoinRoom: &pb.JoinRoom{RoomId: "nope"}}}); client.Code(err) != pb.ErrorCode_ERROR_CODE_ROOM_NOT_FOUND {
		t.Fatal(err)
	}
}

func TestSessionInfo(t *testing.T) {
	e := setup(t)
	a := e.mustDial(1, "Owner")
	b := e.mustDial(2, "Guest")
	info := func(c *client.Client, id string) (*pb.GetSessionInfoResult, error) {
		r, err := c.Request(ctx(t), &pb.Request{Body: &pb.Request_GetSessionInfo{GetSessionInfo: &pb.GetSessionInfo{SessionId: id}}})
		return r.GetGetSessionInfo(), err
	}
	// 只有管理员能看
	if _, err := info(b, a.Welcome.GetSessionId()); client.Code(err) != pb.ErrorCode_ERROR_CODE_PERMISSION_DENIED {
		t.Fatal(err)
	}
	if err := e.store.SetRole(ctx(t), a.Welcome.GetUid(), perm.Admin); err != nil {
		t.Fatal(err)
	}
	if err := e.hub.SetRole(a.Welcome.GetUid(), perm.Admin); err != nil {
		t.Fatal(err)
	}
	if _, err := a.WaitEvent(ctx(t), func(ev *pb.Event) bool { return ev.GetRoleChanged().GetRole() == pb.Role_ROLE_ADMIN }); err != nil {
		t.Fatal(err)
	}
	if _, err := info(a, "nope"); client.Code(err) != pb.ErrorCode_ERROR_CODE_INVALID_ARGUMENT {
		t.Fatal(err)
	}
	// 连接建立时服务端立即发出第一个 ping，客户端回 pong 后就有往返延迟
	deadline := time.Now().Add(3 * time.Second)
	for {
		r, err := info(a, b.Welcome.GetSessionId())
		if err != nil {
			t.Fatal(err)
		}
		if r.GetIp() != "127.0.0.1" || r.GetIpv6DbMissing() || r.GetAppVersion() != "test" {
			t.Fatalf("info: %v", r)
		}
		if r.GetRttMs() > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("no rtt measured: %v", r)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func TestPrivilegeTokenAndAdmin(t *testing.T) {
	e := setup(t)
	a := e.mustDial(1, "Owner")
	b := e.mustDial(2, "Guest")

	// 普通成员不能读设置
	if _, err := b.Request(ctx(t), &pb.Request{Body: &pb.Request_GetSettings{GetSettings: &pb.GetSettings{}}}); client.Code(err) != pb.ErrorCode_ERROR_CODE_PERMISSION_DENIED {
		t.Fatal(err)
	}

	plain, _, err := hub.CreatePrivilegeToken(ctx(t), e.store, perm.Admin, 1, 0, "", store.SystemCreator)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := b.Request(ctx(t), &pb.Request{Body: &pb.Request_RedeemToken{RedeemToken: &pb.RedeemToken{Token: "HANE-0000-0000-0000-0000-0000"}}}); client.Code(err) != pb.ErrorCode_ERROR_CODE_TOKEN_INVALID {
		t.Fatal(err)
	}
	// 输入时忽略大小写和连字符
	resp, err := a.Request(ctx(t), &pb.Request{Body: &pb.Request_RedeemToken{RedeemToken: &pb.RedeemToken{Token: strings.ToLower(strings.ReplaceAll(plain, "-", " "))}}})
	if err != nil || resp.GetRedeemToken().GetRole() != pb.Role_ROLE_ADMIN {
		t.Fatal(resp, err)
	}
	if _, err := b.WaitEvent(ctx(t), func(ev *pb.Event) bool { return ev.GetRoleChanged().GetRole() == pb.Role_ROLE_ADMIN }); err != nil {
		t.Fatal(err)
	}
	if _, err := b.Request(ctx(t), &pb.Request{Body: &pb.Request_RedeemToken{RedeemToken: &pb.RedeemToken{Token: plain}}}); client.Code(err) != pb.ErrorCode_ERROR_CODE_TOKEN_USED_UP {
		t.Fatal(err)
	}

	// 管理员改设置 → 所有人收到服务器信息和媒体策略的更新
	resp, err = a.Request(ctx(t), &pb.Request{Body: &pb.Request_UpdateSettings{UpdateSettings: &pb.UpdateSettings{Patch: map[string]string{
		"server.name": `"新名字"`, "audio.preset": `"hd"`, "camera.enabled": "false",
	}}}})
	if err != nil || resp.GetUpdateSettings().GetValues()["server.name"] != `"新名字"` {
		t.Fatal(resp, err)
	}
	if _, err := b.WaitEvent(ctx(t), func(ev *pb.Event) bool { return ev.GetServerInfoUpdated().GetInfo().GetName() == "新名字" }); err != nil {
		t.Fatal(err)
	}
	ev, err := b.WaitEvent(ctx(t), func(ev *pb.Event) bool { return ev.GetPolicyUpdated() != nil })
	if err != nil || ev.GetPolicyUpdated().GetPolicy().GetAudio().GetMaxBitrateBps() != 64000 || ev.GetPolicyUpdated().GetPolicy().GetCamera().GetAllowed() {
		t.Fatal(ev, err)
	}
	if _, err := a.Request(ctx(t), &pb.Request{Body: &pb.Request_UpdateSettings{UpdateSettings: &pb.UpdateSettings{Patch: map[string]string{"camera.max_fps": "999"}}}}); client.Code(err) != pb.ErrorCode_ERROR_CODE_INVALID_ARGUMENT {
		t.Fatal(err)
	}

	// 令牌管理
	resp, err = a.Request(ctx(t), &pb.Request{Body: &pb.Request_CreateToken{CreateToken: &pb.CreateToken{Role: pb.Role_ROLE_MODERATOR, MaxUses: 3, Note: "for bob"}}})
	if err != nil || !strings.HasPrefix(resp.GetCreateToken().GetToken(), "HANE-") {
		t.Fatal(resp, err)
	}
	tokID := resp.GetCreateToken().GetInfo().GetId()
	list, err := a.Request(ctx(t), &pb.Request{Body: &pb.Request_ListTokens{ListTokens: &pb.ListTokens{}}})
	if err != nil || len(list.GetListTokens().GetTokens()) != 2 {
		t.Fatal(list, err)
	}
	if _, err := a.Request(ctx(t), &pb.Request{Body: &pb.Request_RevokeToken{RevokeToken: &pb.RevokeToken{Id: tokID}}}); err != nil {
		t.Fatal(err)
	}
	if _, err := b.Request(ctx(t), &pb.Request{Body: &pb.Request_RedeemToken{RedeemToken: &pb.RedeemToken{Token: resp.GetCreateToken().GetToken()}}}); client.Code(err) != pb.ErrorCode_ERROR_CODE_TOKEN_INVALID {
		t.Fatal("revoked token should be invalid", err)
	}

	// 角色：最后一名管理员不能降级
	if _, err := a.Request(ctx(t), &pb.Request{Body: &pb.Request_SetRole{SetRole: &pb.SetRole{Uid: a.Welcome.GetUid(), Role: pb.Role_ROLE_MEMBER}}}); client.Code(err) != pb.ErrorCode_ERROR_CODE_INVALID_ARGUMENT {
		t.Fatal(err)
	}
	if _, err := a.Request(ctx(t), &pb.Request{Body: &pb.Request_SetRole{SetRole: &pb.SetRole{Uid: b.Welcome.GetUid(), Role: pb.Role_ROLE_MODERATOR}}}); err != nil {
		t.Fatal(err)
	}
	if _, err := b.WaitEvent(ctx(t), func(ev *pb.Event) bool { return ev.GetRoleChanged().GetRole() == pb.Role_ROLE_MODERATOR }); err != nil {
		t.Fatal(err)
	}
	ids, err := a.Request(ctx(t), &pb.Request{Body: &pb.Request_ListIdentities{ListIdentities: &pb.ListIdentities{}}})
	if err != nil || ids.GetListIdentities().GetTotal() != 2 {
		t.Fatal(ids, err)
	}

	// 审计日志记录了以上操作
	logs, _ := e.store.ListAudit(ctx(t), 0, 50)
	actions := map[string]bool{}
	for _, l := range logs {
		actions[l.Action] = true
	}
	for _, want := range []string{"token.redeem", "settings.update", "token.create", "token.revoke", "user.set_role"} {
		if !actions[want] {
			// 审计是异步写入，稍等再查一次
			time.Sleep(100 * time.Millisecond)
			logs, _ = e.store.ListAudit(ctx(t), 0, 50)
			for _, l := range logs {
				actions[l.Action] = true
			}
			if !actions[want] {
				t.Errorf("missing audit %s", want)
			}
		}
	}
}

func TestHandshakeRejections(t *testing.T) {
	e := setup(t)
	if _, _, err := e.hub.UpdateSettings(settings.Patch{"server.password": `"s3cret"`}, "test"); err != nil {
		t.Fatal(err)
	}
	if _, err := e.dial(1, "A"); client.Code(err) != pb.ErrorCode_ERROR_CODE_PASSWORD_REQUIRED {
		t.Fatal(err)
	}
	if _, err := e.dial(1, "A", func(o *client.Options) { o.Password = "nope" }); client.Code(err) != pb.ErrorCode_ERROR_CODE_PASSWORD_INVALID {
		t.Fatal(err)
	}
	e.mustDial(1, "A", func(o *client.Options) { o.Password = "s3cret" })
	e.hub.UpdateSettings(settings.Patch{"server.password": "null"}, "test")

	// 中间人：客户端看到的指纹与服务端不一致
	if _, err := e.dial(2, "B", func(o *client.Options) { o.SeenSPKIOverride = make([]byte, 32); o.SeenSPKIOverride[0] = 1 }); client.Code(err) != pb.ErrorCode_ERROR_CODE_TLS_MITM_SUSPECTED {
		t.Fatal(err)
	}
	// 浏览器拿不到指纹（全零），允许
	e.mustDial(3, "Browser", func(o *client.Options) { o.BrowserMode = true })

	if _, err := e.dial(4, "a​b"); client.Code(err) != pb.ErrorCode_ERROR_CODE_NICKNAME_INVALID {
		t.Fatal(err)
	}

	// 封禁
	banned := identity.UID(identity.DeriveKey(seed(5), e.hub.ServerID()).Public().(ed25519.PublicKey))
	e.store.InsertBan(ctx(t), &store.Ban{UID: banned, Reason: "spam", CreatedBy: "test"})
	_, err := e.dial(5, "Spammer")
	var pe *client.ProtocolError
	if client.Code(err) != pb.ErrorCode_ERROR_CODE_BANNED || !errorsAs(err, &pe) || pe.E.GetBanReason() != "spam" {
		t.Fatal(err)
	}

	// 人数上限（管理员不受限）
	e.hub.UpdateSettings(settings.Patch{"server.max_clients": "2"}, "test")
	if _, err := e.dial(6, "Late"); client.Code(err) != pb.ErrorCode_ERROR_CODE_SERVER_FULL {
		t.Fatal(err)
	}
}

func TestResumeAndGrace(t *testing.T) {
	e := setup(t)
	a := e.mustDial(1, "A")
	b := e.mustDial(2, "B")
	a.WaitEvent(ctx(t), isJoined)

	// B 的控制连接断开 → 其他人看到「重连中」
	ticket := b.Welcome.GetResumeTicket()
	b.Close()
	if _, err := a.WaitEvent(ctx(t), func(ev *pb.Event) bool { return ev.GetParticipantUpdated().GetParticipant().GetReconnecting() }); err != nil {
		t.Fatal(err)
	}
	// 宽限期内凭凭证恢复：同一个会话
	b2 := e.mustDial(2, "B", func(o *client.Options) { o.ResumeTicket = ticket })
	if !b2.Welcome.GetResumed() || b2.Welcome.GetSessionId() != b.Welcome.GetSessionId() || string(b2.Welcome.GetResumeTicket()) == string(ticket) {
		t.Fatalf("resume: %v", b2.Welcome)
	}
	if _, err := a.WaitEvent(ctx(t), func(ev *pb.Event) bool {
		p := ev.GetParticipantUpdated().GetParticipant()
		return p.GetSessionId() == b.Welcome.GetSessionId() && !p.GetReconnecting()
	}); err != nil {
		t.Fatal(err)
	}
	// 旧凭证已作废，别人的凭证也不能用
	b2.Close()
	c := e.mustDial(3, "C", func(o *client.Options) { o.ResumeTicket = b2.Welcome.GetResumeTicket() })
	if c.Welcome.GetResumed() {
		t.Fatal("ticket of another identity must not resume")
	}
	// 超过宽限期 → 会话销毁
	if _, err := a.WaitEvent(ctx(t), func(ev *pb.Event) bool { return ev.GetParticipantLeft().GetSessionId() == b.Welcome.GetSessionId() }); err != nil {
		t.Fatal(err)
	}
}

func TestLeaveRemovesImmediately(t *testing.T) {
	e := setup(t)
	a := e.mustDial(1, "A")
	b := e.mustDial(2, "B")
	a.WaitEvent(ctx(t), isJoined)
	b.Leave()
	// 主动离开：直接收到 ParticipantLeft，中间没有「重连中」
	ev, err := a.WaitEvent(ctx(t), func(ev *pb.Event) bool {
		return ev.GetParticipantLeft() != nil || ev.GetParticipantUpdated().GetParticipant().GetReconnecting()
	})
	if err != nil || ev.GetParticipantLeft().GetSessionId() != b.Welcome.GetSessionId() {
		t.Fatal(ev, err)
	}
}

func TestShutdownNotifiesClients(t *testing.T) {
	e := setup(t)
	a := e.mustDial(1, "A")
	e.hub.Shutdown(ctx(t))
	if _, err := a.WaitEvent(ctx(t), func(ev *pb.Event) bool {
		return ev.GetServerNotice().GetKind() == pb.ServerNotice_KIND_RESTARTING
	}); err != nil {
		t.Fatal(err)
	}
	g, err := a.WaitGoodbye(ctx(t))
	if err != nil || !g.GetReconnect() || g.GetError().GetCode() != pb.ErrorCode_ERROR_CODE_SERVER_SHUTTING_DOWN {
		t.Fatal(g, err)
	}
}

func errorsAs(err error, target **client.ProtocolError) bool { return errors.As(err, target) }

func TestScreenShareGrants(t *testing.T) {
	e := setup(t)
	a := e.mustDial(1, "Alice")
	b := e.mustDial(2, "Bob")
	a.WaitEvent(ctx(t), isJoined)
	aID := a.Welcome.GetUid() + ":" + a.Welcome.GetSessionId()
	bID := b.Welcome.GetUid() + ":" + b.Welcome.GetSessionId()
	// 媒体已连接（SFU 的 webhook）：之后的权限变化会同步到 SFU
	e.media.Emit(media.Event{Kind: media.ParticipantJoined, Room: "main", Identity: aID})
	e.media.Emit(media.Event{Kind: media.ParticipantJoined, Room: "main", Identity: bID})
	// 屏幕共享走单独的共享连接：成员信息里带共享连接的 identity，令牌签给 main~share
	for _, p := range b.Welcome.GetSnapshot().GetParticipants() {
		if p.GetSessionId() == a.Welcome.GetSessionId() && p.GetMediaShareIdentity() != aID+"#s" {
			t.Fatalf("share identity: %q", p.GetMediaShareIdentity())
		}
	}
	for _, c := range []*client.Client{a, b} {
		r, err := c.Request(ctx(t), &pb.Request{Body: &pb.Request_JoinShareMedia{JoinShareMedia: &pb.JoinShareMedia{}}})
		if err != nil || r.GetJoinShareMedia().GetToken() == "" {
			t.Fatal("share media token", r, err)
		}
	}
	// 传输方式：默认 TCP 优先，令牌标记为只走 TCP；客户端可以请求 UDP（TCP 连不上时）；
	// 服务器设为 UDP 优先时按设置，客户端请求 TCP（UDP 不稳定切过去以后）时仍给 TCP；没开放 ICE-TCP 端口时总是 UDP
	shareTCP := func(want pb.ShareTransport) bool {
		t.Helper()
		r, err := a.Request(ctx(t), &pb.Request{Body: &pb.Request_JoinShareMedia{JoinShareMedia: &pb.JoinShareMedia{Transport: want}}})
		if err != nil {
			t.Fatal(err)
		}
		tok := e.media.LastToken()
		if tok.TCPOnly != r.GetJoinShareMedia().GetTcp() {
			t.Fatalf("token TCPOnly %v, grant tcp %v", tok.TCPOnly, r.GetJoinShareMedia().GetTcp())
		}
		return r.GetJoinShareMedia().GetTcp()
	}
	if !shareTCP(pb.ShareTransport_SHARE_TRANSPORT_UNSPECIFIED) || shareTCP(pb.ShareTransport_SHARE_TRANSPORT_UDP) {
		t.Fatal("default: TCP first, UDP on request")
	}
	if a.Welcome.GetAutoJoin().GetPolicy().GetTransport().GetShareTransport() != pb.ShareTransport_SHARE_TRANSPORT_TCP ||
		!a.Welcome.GetAutoJoin().GetPolicy().GetTransport().GetTcpAvailable() {
		t.Fatalf("policy transport: %v", a.Welcome.GetAutoJoin().GetPolicy().GetTransport())
	}
	e.hub.UpdateSettings(settings.Patch{"media.share_transport": `"udp"`}, "test")
	if shareTCP(pb.ShareTransport_SHARE_TRANSPORT_UNSPECIFIED) || !shareTCP(pb.ShareTransport_SHARE_TRANSPORT_TCP) {
		t.Fatal("udp first: UDP by default, TCP on request")
	}
	e.hub.UpdateSettings(settings.Patch{"media.share_transport": `"tcp"`}, "test")
	e.media.SetTCPAvailable(false)
	if shareTCP(pb.ShareTransport_SHARE_TRANSPORT_UNSPECIFIED) || shareTCP(pb.ShareTransport_SHARE_TRANSPORT_TCP) {
		t.Fatal("no ICE-TCP port: always UDP")
	}
	e.media.SetTCPAvailable(true)

	aShare, bShare := aID+"#s", bID+"#s"
	e.media.Emit(media.Event{Kind: media.ParticipantJoined, Room: "main~share", Identity: aShare})
	e.media.Emit(media.Event{Kind: media.ParticipantJoined, Room: "main~share", Identity: bShare})

	req := func(c *client.Client, intent pb.ShareIntent, audio bool) (*pb.ScreenShareGrant, error) {
		r, err := c.Request(ctx(t), &pb.Request{Body: &pb.Request_RequestScreenShare{RequestScreenShare: &pb.RequestScreenShare{Intent: intent, WithAudio: audio}}})
		return r.GetRequestScreenShare(), err
	}
	g, err := req(a, pb.ShareIntent_SHARE_INTENT_CLARITY, true)
	if err != nil || g.GetGrantId() == "" || !g.GetWithAudio() || g.GetLimits().GetMaxHeight() != 1440 {
		t.Fatal(g, err)
	}
	if strings.Join(g.GetRoomDecodable(), ",") != "video/h264,video/vp8" {
		t.Fatalf("decodable: %v", g.GetRoomDecodable())
	}
	ev, err := b.WaitEvent(ctx(t), func(ev *pb.Event) bool { return len(ev.GetShareStateChanged().GetShares()) == 1 })
	if err != nil || ev.GetShareStateChanged().GetShares()[0].GetIntent() != pb.ShareIntent_SHARE_INTENT_CLARITY {
		t.Fatal(ev, err)
	}
	if _, err := b.WaitEvent(ctx(t), func(ev *pb.Event) bool { return ev.GetParticipantUpdated().GetParticipant().GetScreenSharing() }); err != nil {
		t.Fatal(err)
	}
	waitPerm := func(id string, want bool) {
		t.Helper()
		deadline := time.Now().Add(2 * time.Second)
		for time.Now().Before(deadline) {
			p, _ := e.media.Perm("main~share", id)
			has := false
			for _, s := range p.Sources {
				has = has || s == media.SourceScreenShare
			}
			if has == want {
				return
			}
			time.Sleep(10 * time.Millisecond)
		}
		t.Fatalf("screen_share permission for %s should be %v", id, want)
	}
	waitPerm(aShare, true)
	// 主连接永远不能发布屏幕
	if p, _ := e.media.Perm("main", aID); len(p.Sources) == 0 || slices.Contains(p.Sources, media.SourceScreenShare) {
		t.Fatalf("main connection permission: %+v", p)
	}

	// 同时共享路数上限
	e.hub.UpdateSettings(settings.Patch{"screen.max_concurrent": "1"}, "test")
	if _, err := req(b, pb.ShareIntent_SHARE_INTENT_SMART, false); client.Code(err) != pb.ErrorCode_ERROR_CODE_SHARE_LIMIT_REACHED {
		t.Fatal(err)
	}
	// 重复申请沿用同一个许可
	g2, err := req(a, pb.ShareIntent_SHARE_INTENT_SMOOTHNESS, false)
	if err != nil || g2.GetGrantId() != g.GetGrantId() {
		t.Fatal(g2, err)
	}

	// 共享中换编码器：取消发布后很快重新发布同一路画面 → 许可保留
	screen := func(k media.EventKind) {
		e.media.Emit(media.Event{Kind: k, Room: "main~share", Identity: aShare, Source: media.SourceScreenShare})
	}
	screen(media.TrackPublished)
	screen(media.TrackUnpublished)
	screen(media.TrackPublished)
	time.Sleep(600 * time.Millisecond)
	waitPerm(aShare, true)
	if g3, err := req(a, pb.ShareIntent_SHARE_INTENT_SMOOTHNESS, false); err != nil || g3.GetGrantId() != g.GetGrantId() {
		t.Fatal("grant should survive a republish", g3, err)
	}

	// 共享者在浏览器里点了「停止共享」：SFU 报告屏幕轨道取消发布 → 宽限期后收回许可
	screen(media.TrackUnpublished)
	if _, err := b.WaitEvent(ctx(t), func(ev *pb.Event) bool {
		return ev.GetShareStateChanged() != nil && len(ev.GetShareStateChanged().GetShares()) == 0
	}); err != nil {
		t.Fatal(err)
	}
	waitPerm(aShare, false)

	// Bob 现在可以共享；随后管理员把最低角色提到主持人 → Bob 的许可被收回
	if _, err := req(b, pb.ShareIntent_SHARE_INTENT_SMART, false); err != nil {
		t.Fatal(err)
	}
	waitPerm(bShare, true)
	e.hub.UpdateSettings(settings.Patch{"screen.min_role": `"moderator"`}, "test")
	waitPerm(bShare, false)
	if _, err := req(b, pb.ShareIntent_SHARE_INTENT_SMART, false); client.Code(err) != pb.ErrorCode_ERROR_CODE_PERMISSION_DENIED {
		t.Fatal(err)
	}

	// 摄像头状态来自 SFU 的轨道事件
	e.media.Emit(media.Event{Kind: media.TrackPublished, Room: "main", Identity: aID, Source: media.SourceCamera})
	if _, err := b.WaitEvent(ctx(t), func(ev *pb.Event) bool { return ev.GetParticipantUpdated().GetParticipant().GetCameraOn() }); err != nil {
		t.Fatal(err)
	}
}

func TestRoomDecodableFollowsMembers(t *testing.T) {
	e := setup(t)
	a := e.mustDial(1, "Desktop", func(o *client.Options) {
		o.Caps = &pb.Capabilities{Codecs: []*pb.CodecCapability{
			{Mime: "video/AV1", Decode: true}, {Mime: "video/VP9", Decode: true}, {Mime: "video/H264", Decode: true}, {Mime: "video/VP8", Decode: true},
		}}
	})
	if got := strings.Join(a.Welcome.GetAutoJoin().GetPolicy().GetCodecs().GetRoomDecodable(), ","); got != "video/av1,video/h264,video/vp8,video/vp9" {
		t.Fatalf("decodable: %s", got)
	}
	// 只能解码 H.264 的成员加入 → 房间可解码集合缩小，推送新策略
	e.mustDial(2, "Old phone", func(o *client.Options) {
		o.Caps = &pb.Capabilities{Codecs: []*pb.CodecCapability{{Mime: "video/H264", Decode: true}}}
	})
	if _, err := a.WaitEvent(ctx(t), func(ev *pb.Event) bool {
		return strings.Join(ev.GetPolicyUpdated().GetPolicy().GetCodecs().GetRoomDecodable(), ",") == "video/h264"
	}); err != nil {
		t.Fatal(err)
	}
}

func TestParticipantVideoDecodeCapabilities(t *testing.T) {
	e := setup(t)
	// Mac：H.265 / H.264 硬件解码，AV1 软件解码；旧版本客户端不上报硬件信息
	a := e.mustDial(1, "Mac", func(o *client.Options) {
		o.Caps = &pb.Capabilities{HardwareReported: true, Codecs: []*pb.CodecCapability{
			{Mime: "video/AV1", Decode: true}, {Mime: "video/H265", Decode: true, Hardware: true}, {Mime: "video/H264", Decode: true, Hardware: true},
		}}
	})
	e.mustDial(2, "Old", func(o *client.Options) {
		o.Caps = &pb.Capabilities{Codecs: []*pb.CodecCapability{{Mime: "video/H264", Decode: true}}}
	})
	c := e.mustDial(3, "Viewer")
	for _, p := range c.Welcome.GetSnapshot().GetParticipants() {
		hw, sw := strings.Join(p.GetDecodeHardware(), ","), strings.Join(p.GetDecodeSoftware(), ",")
		switch p.GetSessionId() {
		case a.Welcome.GetSessionId():
			if hw != "video/h265,video/h264" || sw != "video/av1" {
				t.Fatalf("mac: hw=%s sw=%s", hw, sw)
			}
		default:
			if hw != "" || sw != "" {
				t.Fatalf("%s: hw=%s sw=%s", p.GetNickname(), hw, sw)
			}
		}
	}
}
