package signal

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/netip"
	"strings"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"

	"github.com/karllee830/OpenHane/server/internal/auth"
	"github.com/karllee830/OpenHane/server/internal/gateway"
	"github.com/karllee830/OpenHane/server/internal/hub"
	"github.com/karllee830/OpenHane/server/internal/identity"
	"github.com/karllee830/OpenHane/server/internal/pb"
	"github.com/karllee830/OpenHane/server/internal/ratelimit"
	"github.com/karllee830/OpenHane/server/internal/settings"
	"github.com/karllee830/OpenHane/server/internal/store"
)

const (
	helloTimeout = 10 * time.Second
	nonceTTL     = 30 * time.Second // nonce 30 秒内有效且只能用一次（每个连接只签发一个）
	maxClockSkew = 5 * time.Minute
)

// SPKISource 提供服务端自身证书的指纹；ok 为 false 表示 TLS 由反向代理终止，无法比对。
type SPKISource interface {
	SPKI() (sum [32]byte, ok bool)
}

type Server struct {
	Hub   *hub.Hub
	Store *store.Store
	TLS   SPKISource
	Log   *slog.Logger

	// 限流：单 IP（IPv6 按 /64）每分钟的新连接数（HANE_CONN_PER_MINUTE，nil 表示不限）；5 分钟内 10 次鉴权失败封锁 15 分钟。
	ConnLimit *ratelimit.Window
	AuthBlock *ratelimit.Blocker

	upgrader websocket.Upgrader

	// 计数（/metrics）
	HandshakesOK, HandshakesRejected, RateLimited atomic.Int64
}

func NewServer(h *hub.Hub, st *store.Store, tls SPKISource, log *slog.Logger) *Server {
	return &Server{
		Hub: h, Store: st, TLS: tls, Log: log.With("component", "signal"),
		ConnLimit: ratelimit.NewWindow(20, time.Minute),
		AuthBlock: ratelimit.NewBlocker(10, 5*time.Minute, 15*time.Minute),
		upgrader: websocket.Upgrader{
			Subprotocols:    []string{Subprotocol},
			ReadBufferSize:  4096,
			WriteBufferSize: 4096,
			// 鉴权基于签名而不是 Cookie，跨站 WebSocket 劫持无从利用；原生客户端也不带 Origin
			CheckOrigin: func(*http.Request) bool { return true },
		},
	}
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	ip := gateway.ClientIP(r)
	ws, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return // Upgrade 已经写好了 HTTP 错误
	}
	log := s.Log.With("ip", ip)
	c := newConn(ws, log)
	defer func() { <-c.Done() }()

	key := ratelimit.IPKey(ip)
	if d := s.AuthBlock.Blocked(key); d > 0 {
		c.Close(&pb.Error{Code: pb.ErrorCode_ERROR_CODE_RATE_LIMITED, RetryAfterMs: uint32(d.Milliseconds())}, false)
		return
	}
	if s.ConnLimit != nil && !s.ConnLimit.Allow(key) {
		s.RateLimited.Add(1)
		c.Close(&pb.Error{Code: pb.ErrorCode_ERROR_CODE_RATE_LIMITED, RetryAfterMs: 60_000}, true)
		return
	}

	sess, perr := s.handshake(r.Context(), c, ip)
	if perr != nil {
		switch perr.Code {
		case pb.ErrorCode_ERROR_CODE_AUTH_FAILED, pb.ErrorCode_ERROR_CODE_PASSWORD_INVALID, pb.ErrorCode_ERROR_CODE_TLS_MITM_SUSPECTED:
			s.AuthBlock.Fail(key)
		}
		s.HandshakesRejected.Add(1)
		log.Info("handshake rejected", "code", perr.Code, "reason", perr.Message)
		c.Close(perr, false)
		return
	}
	s.HandshakesOK.Add(1)
	s.serve(c, sess)
}

func readMsg[T any](c *Conn, timeout time.Duration, get func(*pb.Envelope) T) (T, error) {
	var zero T
	env, err := c.Read(timeout)
	if err != nil {
		return zero, err
	}
	v := get(env)
	if any(v) == any(zero) {
		return zero, fmt.Errorf("unexpected message %T", env.GetMsg())
	}
	return v, nil
}

func protoErr(code pb.ErrorCode, msg string) *pb.Error { return &pb.Error{Code: code, Message: msg} }

// handshake 执行 ClientHello → ServerChallenge → ClientAuth 并完成校验。
// 校验通过后交给 Hub 创建会话，Hub 负责发送 Welcome。
func (s *Server) handshake(ctx context.Context, c *Conn, ip netip.Addr) (*hub.Session, *pb.Error) {
	hello, err := readMsg(c, helloTimeout, (*pb.Envelope).GetClientHello)
	if err != nil {
		return nil, protoErr(pb.ErrorCode_ERROR_CODE_INVALID_ARGUMENT, "expected ClientHello")
	}
	info := s.Hub.ServerInfo()
	v := hello.GetProtocolVersion()
	if v < info.ProtocolMin {
		e := protoErr(pb.ErrorCode_ERROR_CODE_PROTOCOL_VERSION_UNSUPPORTED, "client protocol too old")
		e.ProtocolMin, e.ProtocolMax = info.ProtocolMin, info.ProtocolMax
		return nil, e
	}
	chosen := min(v, info.ProtocolMax)

	nonce := make([]byte, 32)
	rand.Read(nonce)
	issued := time.Now()
	c.Send(&pb.Envelope{Msg: &pb.Envelope_ServerChallenge{ServerChallenge: &pb.ServerChallenge{
		ProtocolVersion: chosen, ServerId: s.Hub.ServerID(), Nonce: nonce, Info: info,
	}}})

	ca, err := readMsg(c, nonceTTL, (*pb.Envelope).GetClientAuth)
	if err != nil {
		return nil, protoErr(pb.ErrorCode_ERROR_CODE_INVALID_ARGUMENT, "expected ClientAuth")
	}
	st := s.Hub.Settings()

	// 1–2. nonce 未过期（每个连接只签发一个，天然一次性）；时间戳偏差
	if time.Since(issued) > nonceTTL {
		return nil, protoErr(pb.ErrorCode_ERROR_CODE_AUTH_FAILED, "challenge expired")
	}
	if d := time.Since(time.UnixMilli(ca.GetTimestampMs())); d > maxClockSkew || d < -maxClockSkew {
		return nil, protoErr(pb.ErrorCode_ERROR_CODE_AUTH_FAILED, "clock skew too large; check device time")
	}
	pub := ca.GetPublicKey()
	// 3. 证书指纹（服务端自己终止 TLS 时）
	if own, ok := s.TLS.SPKI(); ok && len(ca.GetSeenSpkiSha256()) == 32 && auth.SPKIMismatch(ca.GetSeenSpkiSha256(), own) {
		uid := ""
		if len(pub) == ed25519.PublicKeySize {
			uid = identity.UID(pub)
		}
		s.audit(uid, "security.tls_mismatch", ip)
		return nil, protoErr(pb.ErrorCode_ERROR_CODE_TLS_MITM_SUSPECTED, "certificate fingerprint mismatch")
	}
	// 4. 签名
	if !auth.VerifyAuth(pub, ca.GetSignature(), s.Hub.ServerID(), nonce, ca.GetSeenSpkiSha256(), ca.GetTimestampMs()) {
		return nil, protoErr(pb.ErrorCode_ERROR_CODE_AUTH_FAILED, "bad signature")
	}
	uid := identity.UID(pub)
	// 5. 封禁
	ban, err := s.Store.FindActiveBan(ctx, uid, ip)
	switch {
	case err == nil:
		e := protoErr(pb.ErrorCode_ERROR_CODE_BANNED, "banned")
		e.BanReason, e.BanExpiresAtMs = ban.Reason, ban.ExpiresAt
		return nil, e
	case !errors.Is(err, store.ErrNotFound):
		s.Log.Error("ban lookup failed", "err", err)
		return nil, protoErr(pb.ErrorCode_ERROR_CODE_INTERNAL, "")
	}
	// 6. 安全等级
	if lvl := st.MinSecurityLevel; lvl > 0 && identity.SecurityLevel(pub, ca.GetPowNonce()) < lvl {
		e := protoErr(pb.ErrorCode_ERROR_CODE_SECURITY_LEVEL_TOO_LOW, "identity security level too low")
		e.RequiredSecurityLevel = uint32(lvl)
		return nil, e
	}
	// 7. 邀请码（免密码、可附带角色）：无效、过期或用完的邀请码按没有处理。这里只检查，所有校验通过后才扣减次数
	var inv *store.Invite
	inviteCode := strings.TrimSpace(hello.GetInviteCode())
	if inviteCode != "" {
		inv, err = s.Store.PeekInvite(ctx, inviteCode)
		switch {
		case errors.Is(err, store.ErrInviteInvalid), errors.Is(err, store.ErrInviteExpired), errors.Is(err, store.ErrInviteUsedUp):
			inv = nil
		case err != nil:
			s.Log.Error("invite lookup failed", "err", err)
			return nil, protoErr(pb.ErrorCode_ERROR_CODE_INTERNAL, "")
		}
	}
	// 8. 服务器密码（有效的免密邀请码豁免）
	if st.ServerPassword != "" && !(inv != nil && inv.BypassPassword) {
		if ca.GetServerPassword() == "" {
			return nil, protoErr(pb.ErrorCode_ERROR_CODE_PASSWORD_REQUIRED, "password required")
		}
		if !settings.VerifyPassword(st.ServerPassword, ca.GetServerPassword()) {
			return nil, protoErr(pb.ErrorCode_ERROR_CODE_PASSWORD_INVALID, "wrong password")
		}
	}
	// 9. 昵称
	nickname, err := identity.NormalizeNickname(ca.GetNickname())
	if err != nil {
		return nil, protoErr(pb.ErrorCode_ERROR_CODE_NICKNAME_INVALID, err.Error())
	}
	if k := ca.GetE2EeKey(); k != nil && !auth.VerifyE2EEKey(pub, k.GetPublicKey(), k.GetSignature()) {
		return nil, protoErr(pb.ErrorCode_ERROR_CODE_AUTH_FAILED, "bad e2ee key signature")
	}
	// 邀请码扣减次数（输错密码、昵称不合法时不浪费）。并发下恰好被别人用完、而本次又是靠它免密时，回到要求密码
	if inv != nil {
		used, err := s.Store.UseInvite(ctx, inviteCode)
		switch {
		case err == nil:
			inv = used
		case errors.Is(err, store.ErrInviteInvalid), errors.Is(err, store.ErrInviteExpired), errors.Is(err, store.ErrInviteUsedUp):
			if inv.BypassPassword && st.ServerPassword != "" && !settings.VerifyPassword(st.ServerPassword, ca.GetServerPassword()) {
				return nil, protoErr(pb.ErrorCode_ERROR_CODE_PASSWORD_REQUIRED, "password required")
			}
			inv = nil
		default:
			s.Log.Error("invite use failed", "err", err)
			return nil, protoErr(pb.ErrorCode_ERROR_CODE_INTERNAL, "")
		}
	}
	// 10. 写入身份记录，取得角色；在线人数（第 8 步）和重名由 Hub 判断
	storedIP := ""
	if st.PrivacyStoreIP {
		storedIP = ip.String()
	}
	// 客户端自报的版本号只用于管理员查看：限制长度，避免往数据库里塞超长字符串
	client := fmt.Sprintf("%s/%s", hello.GetClient().GetPlatform(), truncate(hello.GetClient().GetAppVersion(), 32))
	role, err := s.Store.TouchIdentity(ctx, uid, pub, nickname, storedIP, client)
	if err != nil {
		s.Log.Error("identity write failed", "err", err)
		return nil, protoErr(pb.ErrorCode_ERROR_CODE_INTERNAL, "")
	}
	if inv != nil {
		// 邀请码附带的角色：只升不降
		if inv.Role > role {
			if err := s.Store.SetRole(ctx, uid, inv.Role); err != nil {
				s.Log.Error("invite role grant failed", "err", err)
			} else {
				role = inv.Role
			}
		}
		go s.Store.InsertAudit(context.Background(), &store.AuditEntry{ActorUID: uid, Action: "invite.use", Target: inv.Code,
			Detail: map[string]any{"role": inv.Role.String(), "bypass_password": inv.BypassPassword}, IP: ip.String()})
	}
	return s.Hub.Join(ctx, hub.JoinParams{
		UID: uid, PublicKey: pub, Nickname: nickname, Role: role,
		Client: hello.GetClient(), Caps: hello.GetCaps(), E2EEKey: ca.GetE2EeKey(),
		RemoteIP: ip, ResumeTicket: hello.GetResumeTicket(), Conn: c,
	})
}

// serve 处理已鉴权连接上的消息，直到连接断开。
func (s *Server) serve(c *Conn, sess *hub.Session) {
	left := false
	defer func() {
		if left {
			s.Hub.Left(sess, c)
		} else {
			s.Hub.Disconnected(sess, c)
		}
	}()
	defer c.Close(nil, false)
	for {
		env, err := c.Read(IdleTimeout)
		if err != nil {
			// 客户端以「正常关闭」（1000）断开表示主动离开：立即移除，不进入恢复宽限期（否则其他人会看到一个「重连中」的成员）。
			// 浏览器关闭页面发送的是 1001，网络中断没有关闭帧：这两种情况仍可在宽限期内恢复。
			left = websocket.IsCloseError(err, websocket.CloseNormalClosure)
			return
		}
		switch m := env.GetMsg().(type) {
		case *pb.Envelope_Ping:
			c.Send(&pb.Envelope{Msg: &pb.Envelope_Pong{Pong: &pb.Pong{
				ClientTimeMs: m.Ping.GetClientTimeMs(), ServerTimeMs: time.Now().UnixMilli(),
			}}})
		case *pb.Envelope_Request:
			s.Hub.HandleRequest(sess, c, m.Request)
		default:
			c.Close(protoErr(pb.ErrorCode_ERROR_CODE_INVALID_ARGUMENT, "unexpected message after handshake"), false)
			return
		}
	}
}

func (s *Server) audit(uid, action string, ip netip.Addr) {
	go s.Store.InsertAudit(context.Background(), &store.AuditEntry{ActorUID: uid, Action: action, IP: ip.String()})
}

// truncate 截断到最多 n 个字符（按 rune）
func truncate(v string, n int) string {
	if r := []rune(v); len(r) > n {
		return string(r[:n])
	}
	return v
}
