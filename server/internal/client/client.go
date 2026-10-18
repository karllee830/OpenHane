// Package client 是控制协议的 Go 参考客户端，用于集成测试和命令行冒烟测试，
// 也是各端客户端实现握手的对照。
package client

import (
	"context"
	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"errors"
	"fmt"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
	"google.golang.org/protobuf/proto"

	"github.com/karllee830/OpenHane/server/internal/auth"
	"github.com/karllee830/OpenHane/server/internal/identity"
	"github.com/karllee830/OpenHane/server/internal/pb"
)

type Options struct {
	URL          string // wss://host:port/ws
	MasterSeed   []byte // 32 字节主种子；每个服务器的身份由它派生
	Nickname     string
	Password     string
	ResumeTicket []byte
	Platform     pb.Platform
	// PinnedSPKI 不为空时按 TOFU 校验证书指纹；为空时接受任何证书（首次连接）。
	PinnedSPKI []byte
	// BrowserMode 模拟拿不到证书指纹的客户端（seen_spki 填全零）。
	BrowserMode bool
	// SeenSPKIOverride 测试用：伪造客户端看到的指纹（模拟中间人）。
	SeenSPKIOverride []byte
	// Caps 上报的编解码能力
	Caps *pb.Capabilities
	// InviteCode 通过邀请链接进入
	InviteCode string
	// E2EE 为 true 时生成 X25519 密钥交换公钥（身份签名）并声明支持端到端加密
	E2EE bool
	// OnEvent 不为空时事件交给它处理（在读循环中调用，必须很快返回），不再进入 WaitEvent 的队列。压测用：不消费事件的客户端会堵住读循环
	OnEvent func(*pb.Event)
}

// ProtocolError 是服务端以 Goodbye 拒绝时的错误。
type ProtocolError struct{ E *pb.Error }

func (e *ProtocolError) Error() string { return fmt.Sprintf("%s: %s", e.E.GetCode(), e.E.GetMessage()) }

// Code 返回错误中的协议错误码（非协议错误返回 UNSPECIFIED）。
func Code(err error) pb.ErrorCode {
	var pe *ProtocolError
	if errors.As(err, &pe) {
		return pe.E.GetCode()
	}
	return pb.ErrorCode_ERROR_CODE_UNSPECIFIED
}

type Client struct {
	ws        *websocket.Conn
	Key       ed25519.PrivateKey
	SPKI      []byte
	Challenge *pb.ServerChallenge
	Welcome   *pb.Welcome
	// E2EEPrivate 是本次会话的 X25519 私钥（Options.E2EE 为 true 时）
	E2EEPrivate *ecdh.PrivateKey

	writeMu sync.Mutex
	nextID  atomic.Uint32
	mu      sync.Mutex
	pending map[uint32]chan *pb.Response
	events  chan *pb.Event
	goodbye chan *pb.Goodbye
	pongs   chan *pb.Pong
	onEvent func(*pb.Event)
	done    chan struct{}
	err     error
}

// Dial 连接并完成握手；被拒绝时返回 *ProtocolError。
func Dial(ctx context.Context, o Options) (*Client, error) {
	d := websocket.Dialer{
		Subprotocols:     []string{"hane.v1"},
		HandshakeTimeout: 10 * time.Second,
		// 自签名证书：用 TOFU 指纹代替 CA 校验
		TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
	}
	ws, _, err := d.DialContext(ctx, o.URL, http.Header{})
	if err != nil {
		return nil, err
	}
	c := &Client{ws: ws, pending: map[uint32]chan *pb.Response{}, events: make(chan *pb.Event, 1024),
		goodbye: make(chan *pb.Goodbye, 1), pongs: make(chan *pb.Pong, 8), done: make(chan struct{}), onEvent: o.OnEvent}

	c.SPKI = make([]byte, 32)
	if tc, ok := ws.UnderlyingConn().(*tls.Conn); ok {
		sum := sha256.Sum256(tc.ConnectionState().PeerCertificates[0].RawSubjectPublicKeyInfo)
		c.SPKI = sum[:]
		if len(o.PinnedSPKI) > 0 && string(o.PinnedSPKI) != string(c.SPKI) {
			ws.Close()
			return nil, errors.New("certificate fingerprint changed (possible MITM)")
		}
	}

	if err := c.handshake(o); err != nil {
		ws.Close()
		return nil, err
	}
	go c.readLoop()
	return c, nil
}

func (c *Client) send(env *pb.Envelope) error {
	b, err := proto.Marshal(env)
	if err != nil {
		return err
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	return c.ws.WriteMessage(websocket.BinaryMessage, b)
}

func (c *Client) read() (*pb.Envelope, error) {
	_, b, err := c.ws.ReadMessage()
	if err != nil {
		return nil, err
	}
	env := &pb.Envelope{}
	return env, proto.Unmarshal(b, env)
}

func (c *Client) handshake(o Options) error {
	platform := o.Platform
	if platform == pb.Platform_PLATFORM_UNSPECIFIED {
		platform = pb.Platform_PLATFORM_LINUX
	}
	caps := o.Caps
	if o.E2EE {
		if caps == nil {
			caps = &pb.Capabilities{}
		} else {
			caps = proto.Clone(caps).(*pb.Capabilities)
		}
		caps.E2Ee = true
	}
	if err := c.send(&pb.Envelope{Msg: &pb.Envelope_ClientHello{ClientHello: &pb.ClientHello{
		ProtocolVersion: 1,
		Client:          &pb.ClientInfo{AppVersion: "test", Platform: platform},
		ResumeTicket:    o.ResumeTicket,
		Caps:            caps,
		InviteCode:      o.InviteCode,
	}}}); err != nil {
		return err
	}
	c.ws.SetReadDeadline(time.Now().Add(10 * time.Second))
	defer c.ws.SetReadDeadline(time.Time{})
	env, err := c.read()
	if err != nil {
		return err
	}
	if g := env.GetGoodbye(); g != nil {
		return &ProtocolError{g.GetError()}
	}
	ch := env.GetServerChallenge()
	if ch == nil {
		return fmt.Errorf("expected ServerChallenge, got %T", env.GetMsg())
	}
	c.Challenge = ch
	c.Key = identity.DeriveKey(o.MasterSeed, ch.GetServerId())

	seen := c.SPKI
	if o.BrowserMode {
		seen = auth.ZeroSPKI
	}
	if o.SeenSPKIOverride != nil {
		seen = o.SeenSPKIOverride
	}
	ts := time.Now().UnixMilli()
	sig := ed25519.Sign(c.Key, auth.SigInput(ch.GetServerId(), ch.GetNonce(), seen, ts))
	if err := c.send(&pb.Envelope{Msg: &pb.Envelope_ClientAuth{ClientAuth: &pb.ClientAuth{
		PublicKey:      c.Key.Public().(ed25519.PublicKey),
		Signature:      sig,
		SeenSpkiSha256: seen,
		TimestampMs:    ts,
		Nickname:       o.Nickname,
		ServerPassword: o.Password,
		E2EeKey:        c.e2eeKey(o),
	}}}); err != nil {
		return err
	}
	env, err = c.read()
	if err != nil {
		return err
	}
	if g := env.GetGoodbye(); g != nil {
		return &ProtocolError{g.GetError()}
	}
	if c.Welcome = env.GetWelcome(); c.Welcome == nil {
		return fmt.Errorf("expected Welcome, got %T", env.GetMsg())
	}
	return nil
}

func (c *Client) readLoop() {
	defer close(c.done)
	for {
		env, err := c.read()
		if err != nil {
			c.err = err
			c.mu.Lock()
			for _, ch := range c.pending {
				close(ch)
			}
			c.pending = map[uint32]chan *pb.Response{}
			c.mu.Unlock()
			return
		}
		switch m := env.GetMsg().(type) {
		case *pb.Envelope_Response:
			c.mu.Lock()
			ch := c.pending[m.Response.GetId()]
			delete(c.pending, m.Response.GetId())
			c.mu.Unlock()
			if ch != nil {
				ch <- m.Response
			}
		case *pb.Envelope_Event:
			if c.onEvent != nil {
				c.onEvent(m.Event)
			} else {
				c.events <- m.Event
			}
		case *pb.Envelope_Goodbye:
			c.goodbye <- m.Goodbye
		case *pb.Envelope_Pong:
			c.pongs <- m.Pong
		}
	}
}

// Request 发送请求并等待响应；响应带错误时返回 *ProtocolError。
func (c *Client) Request(ctx context.Context, req *pb.Request) (*pb.Response, error) {
	id := c.nextID.Add(1)
	req.Id = id
	ch := make(chan *pb.Response, 1)
	c.mu.Lock()
	c.pending[id] = ch
	c.mu.Unlock()
	if err := c.send(&pb.Envelope{Msg: &pb.Envelope_Request{Request: req}}); err != nil {
		return nil, err
	}
	select {
	case resp, ok := <-ch:
		if !ok {
			return nil, fmt.Errorf("connection closed: %v", c.err)
		}
		if resp.GetError() != nil {
			return resp, &ProtocolError{resp.GetError()}
		}
		return resp, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// Ping 发送心跳并等待 Pong。
func (c *Client) Ping(ctx context.Context) (*pb.Pong, error) {
	if err := c.send(&pb.Envelope{Msg: &pb.Envelope_Ping{Ping: &pb.Ping{ClientTimeMs: time.Now().UnixMilli()}}}); err != nil {
		return nil, err
	}
	select {
	case p := <-c.pongs:
		return p, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// WaitEvent 等待第一个满足 match 的事件（之前不匹配的事件被丢弃）。
func (c *Client) WaitEvent(ctx context.Context, match func(*pb.Event) bool) (*pb.Event, error) {
	for {
		select {
		case ev := <-c.events:
			if match(ev) {
				return ev, nil
			}
		case <-c.done:
			return nil, fmt.Errorf("connection closed: %v", c.err)
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
}

// WaitGoodbye 等待服务端断开说明。
func (c *Client) WaitGoodbye(ctx context.Context) (*pb.Goodbye, error) {
	select {
	case g := <-c.goodbye:
		return g, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// Done 在连接断开后关闭。
func (c *Client) Done() <-chan struct{} { return c.done }

func (c *Client) Close() error { return c.ws.Close() }

// Leave 主动离开：发送「正常关闭」帧后断开，服务端立即移除会话（Close 模拟的是网络中断）。
func (c *Client) Leave() error {
	c.ws.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""), time.Now().Add(time.Second))
	return c.ws.Close()
}

// e2eeKey 生成本次会话的 X25519 密钥交换公钥，并用身份私钥签名。
func (c *Client) e2eeKey(o Options) *pb.SignedPublicKey {
	if !o.E2EE {
		return nil
	}
	k, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		return nil
	}
	c.E2EEPrivate = k
	pub := k.PublicKey().Bytes()
	return &pb.SignedPublicKey{PublicKey: pub, Signature: ed25519.Sign(c.Key, auth.E2EEKeyInput(pub))}
}
