package livekit

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"hash/crc32"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"time"

	"github.com/gorilla/websocket"
	lkp "github.com/livekit/protocol/livekit"
	"github.com/livekit/protocol/utils/protojson"
	"github.com/pion/webrtc/v4"
	"google.golang.org/protobuf/proto"
)

// signalProxy 转发 /rtc 的 WebSocket 信令，并让媒体跟着客户端填写的服务器地址走。
//
// LiveKit 公布的候选地址来自启动时的 node_ip（HANE_PUBLIC_HOST / STUN）和本机网卡。经 frp、Docker 端口映射等
// 转发时，这些地址客户端都连不上，而客户端用来连信令的地址（请求的 Host）一定是它能到达的。所以这里给 LiveKit
// 下发的每个服务端 host 候选补一个地址为 Host、端口和协议不变的候选：局域网用户拿到局域网地址，外网用户拿到
// 公网地址，各走各的。这要求转发时 UDP / ICE-TCP 的端口号保持不变。
//
// 只走 TCP 的连接（屏幕共享连接 TCP 优先）双向过滤掉 UDP 候选：客户端只拿到服务端的 TCP 候选，
// 服务端也只拿到客户端的 TCP 候选（否则服务端发往客户端 UDP 地址的连通性检查会让客户端学到 UDP 候选），连接从一开始就走 TCP，
// 不需要先走 UDP 再 ICE 重启。效果与 LiveKit 自己的「偏好 TCP」相同。
//
// 非 WebSocket 请求（/rtc/validate 等），以及 Host 无法用于媒体（回环、解析失败）且不需要过滤时，原样反向代理。
type signalProxy struct {
	backend  *url.URL     // LiveKit 的 HTTP 地址（只监听 127.0.0.1）
	fallback http.Handler // 原样反向代理
	log      *slog.Logger
	resolve  func(ctx context.Context, host string) (netip.Addr, error)
	tcpOnly  func(r *http.Request) bool // 这条信令连接是否只走 TCP
	dialer   websocket.Dialer
	upgrader websocket.Upgrader
}

func newSignalProxy(backend *url.URL, fallback http.Handler, resolve func(context.Context, string) (netip.Addr, error), tcpOnly func(*http.Request) bool, log *slog.Logger) *signalProxy {
	if tcpOnly == nil {
		tcpOnly = func(*http.Request) bool { return false }
	}
	return &signalProxy{
		backend:  backend,
		fallback: fallback,
		log:      log,
		resolve:  resolve,
		tcpOnly:  tcpOnly,
		dialer:   websocket.Dialer{HandshakeTimeout: 10 * time.Second},
		// 与 LiveKit 自己的 Upgrader 一致：允许任意 Origin（鉴权靠令牌），开启压缩
		upgrader: websocket.Upgrader{EnableCompression: true, CheckOrigin: func(*http.Request) bool { return true }},
	}
}

func (p *signalProxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !websocket.IsWebSocketUpgrade(r) {
		p.fallback.ServeHTTP(w, r)
		return
	}
	addr := p.clientFacingAddr(r)
	tcpOnly := p.tcpOnly(r)
	if !addr.IsValid() && !tcpOnly {
		p.fallback.ServeHTTP(w, r)
		return
	}

	u := *p.backend
	u.Scheme, u.Path, u.RawQuery = "ws", r.URL.Path, r.URL.RawQuery
	up, resp, err := p.dialer.DialContext(r.Context(), u.String(), backendHeader(r))
	if err != nil {
		if resp != nil {
			// LiveKit 拒绝了连接（令牌无效、房间不存在等）：状态码和原因原样交给客户端
			if ct := resp.Header.Get("Content-Type"); ct != "" {
				w.Header().Set("Content-Type", ct)
			}
			w.WriteHeader(resp.StatusCode)
			io.Copy(w, resp.Body)
			return
		}
		p.log.Warn("media signaling: cannot reach media engine", "err", err)
		http.Error(w, "media engine unavailable", http.StatusBadGateway)
		return
	}
	defer up.Close()
	down, err := p.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return // Upgrade 已经回复了错误
	}
	defer down.Close()

	rw := &candidateRewriter{addr: addr, tcpOnly: tcpOnly, log: p.log}
	var fromClient func(int, []byte) [][]byte
	if tcpOnly {
		fromClient = filterClientUDP
	}
	errc := make(chan error, 2)
	go func() { errc <- relay(up, down, fromClient) }()
	go func() { errc <- relay(down, up, rw.rewrite) }()
	// 任一方向结束后关闭两侧连接，另一个方向随之退出
	<-errc
}

// clientFacingAddr 返回客户端连接时用的服务器地址（Host 解析成 IP）；不适合作为媒体地址时返回无效值。
func (p *signalProxy) clientFacingAddr(r *http.Request) netip.Addr {
	host := r.Host
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	host = strings.Trim(host, "[]")
	if host == "" {
		return netip.Addr{}
	}
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	a, err := p.resolve(ctx, host)
	if err != nil {
		p.log.Debug("media signaling: cannot resolve client-facing host", "host", host, "err", err)
		return netip.Addr{}
	}
	// LiveKit 不在回环地址上收 UDP；链路本地地址需要 zone，客户端无法使用
	if a.IsLoopback() || a.IsUnspecified() || a.IsMulticast() || a.IsLinkLocalUnicast() {
		return netip.Addr{}
	}
	return a
}

// backendHeader 是转给 LiveKit 的握手请求头：去掉逐跳和 WebSocket 握手头（由 Dialer 生成），
// 与 httputil.ReverseProxy 一样追加 X-Forwarded-For。
func backendHeader(r *http.Request) http.Header {
	h := r.Header.Clone()
	for _, k := range []string{"Connection", "Upgrade", "Keep-Alive", "Proxy-Connection", "Te", "Trailer", "Transfer-Encoding",
		"Sec-Websocket-Key", "Sec-Websocket-Version", "Sec-Websocket-Extensions", "Sec-Websocket-Protocol"} {
		h.Del(k)
	}
	if ip, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		if prior := h.Values("X-Forwarded-For"); len(prior) > 0 {
			ip = strings.Join(prior, ", ") + ", " + ip
		}
		h.Set("X-Forwarded-For", ip)
	}
	return h
}

// relay 把 src 的消息转给 dst（rewrite 不为 nil 时先改写，一条可以变成多条），直到任一侧出错。
func relay(dst, src *websocket.Conn, rewrite func(msgType int, data []byte) [][]byte) error {
	for {
		mt, data, err := src.ReadMessage()
		if err != nil {
			// 把对端的关闭原因转过去；异常断开（1006）不能出现在关闭帧里
			var ce *websocket.CloseError
			if errors.As(err, &ce) && ce.Code != websocket.CloseAbnormalClosure {
				dst.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(ce.Code, ce.Text), time.Now().Add(time.Second))
			}
			return err
		}
		msgs := [][]byte{data}
		if rewrite != nil {
			msgs = rewrite(mt, data)
		}
		for _, m := range msgs {
			if err := dst.WriteMessage(mt, m); err != nil {
				return err
			}
		}
	}
}

// candidateRewriter 改写一条信令连接上 LiveKit 下发给客户端的消息（SignalResponse），
// 给每个服务端 host 候选补一个地址为 addr 的候选（addr 无效时不补）；tcpOnly 时去掉 UDP 候选。
type candidateRewriter struct {
	addr    netip.Addr
	tcpOnly bool
	log     *slog.Logger
	// trickle 已补过的候选（目标 PeerConnection、m 行、协议、端口），避免同一端口补出多条重复候选。
	// 每次 offer / answer 后清空：ICE 重启后 LiveKit 会重新下发候选，需要再补一次。
	seen map[string]bool
}

func (c *candidateRewriter) rewrite(mt int, data []byte) [][]byte {
	msg := &lkp.SignalResponse{}
	var err error
	switch mt {
	case websocket.BinaryMessage:
		err = proto.Unmarshal(data, msg)
	case websocket.TextMessage: // 客户端用 JSON 时 LiveKit 也回 JSON
		err = protojson.Unmarshal(data, msg)
	default:
		return [][]byte{data}
	}
	if err != nil {
		return [][]byte{data}
	}

	var extra *lkp.SignalResponse
	changed := false
	switch m := msg.Message.(type) {
	case *lkp.SignalResponse_Trickle:
		if c.tcpOnly && udpTrickle(m.Trickle) {
			return nil
		}
		if t := c.trickle(m.Trickle); t != nil {
			extra = &lkp.SignalResponse{Message: &lkp.SignalResponse_Trickle{Trickle: t}}
		}
	case *lkp.SignalResponse_Offer:
		c.seen = nil
		changed = c.sdp(m.Offer)
	case *lkp.SignalResponse_Answer:
		c.seen = nil
		changed = c.sdp(m.Answer)
	default:
		return [][]byte{data}
	}

	out := make([][]byte, 0, 2)
	// 补的候选放在原消息之前：原消息可能带着 final（候选已发完）
	if extra != nil {
		if b, err := marshalSignal(mt, extra); err == nil {
			out = append(out, b)
		}
	}
	if changed {
		if b, err := marshalSignal(mt, msg); err == nil {
			return append(out, b)
		}
	}
	return append(out, data)
}

func marshalSignal(mt int, m proto.Message) ([]byte, error) {
	if mt == websocket.TextMessage {
		return protojson.Marshal(m)
	}
	return proto.Marshal(m)
}

// trickle 返回要补发的 trickle 消息；不需要补时返回 nil。
func (c *candidateRewriter) trickle(t *lkp.TrickleRequest) *lkp.TrickleRequest {
	var init webrtc.ICECandidateInit
	if json.Unmarshal([]byte(t.CandidateInit), &init) != nil || init.Candidate == "" {
		return nil
	}
	mid := ""
	if init.SDPMid != nil {
		mid = *init.SDPMid
	}
	if c.seen == nil {
		c.seen = map[string]bool{}
	}
	cand, ok := c.clone(c.seen, fmt.Sprintf("%d|%s", t.Target, mid), init.Candidate)
	if !ok {
		return nil
	}
	init.Candidate = cand
	b, err := json.Marshal(init)
	if err != nil {
		return nil
	}
	c.log.Debug("media signaling: added client-facing candidate", "candidate", cand)
	return &lkp.TrickleRequest{CandidateInit: string(b), Target: t.Target}
}

// sdp 在 SDP 里每条 a=candidate 之后补一条候选，返回是否有改动。
func (c *candidateRewriter) sdp(d *lkp.SessionDescription) bool {
	if d == nil || !strings.Contains(d.Sdp, "a=candidate:") {
		return false
	}
	stripped := false
	if c.tcpOnly {
		d.Sdp, stripped = stripUDP(d.Sdp)
	}
	if !c.addr.IsValid() {
		return stripped
	}
	seen := map[string]bool{}
	section := 0
	changed := false
	var b strings.Builder
	for _, line := range strings.SplitAfter(d.Sdp, "\n") {
		b.WriteString(line)
		if strings.HasPrefix(line, "m=") {
			section++
		}
		if cand, ok := strings.CutPrefix(strings.TrimRight(line, "\r\n"), "a="); ok && strings.HasPrefix(cand, "candidate:") {
			if extra, ok := c.clone(seen, fmt.Sprint(section), cand); ok {
				b.WriteString("a=" + extra + "\r\n")
				changed = true
			}
		}
	}
	if changed {
		d.Sdp = b.String()
	}
	return changed || stripped
}

// clone 把一条服务端 host 候选改成地址为 c.addr，其余（组件、协议、优先级、端口、tcptype、ufrag 等）不变。
// 只处理 host 候选：它的端口就是 SFU 监听的 UDP / ICE-TCP 端口；srflx 等候选的端口是 NAT 映射出来的，换了地址也连不上。
// 原候选已经是这个地址、格式无法识别，或同一作用域内这个协议和端口已经有了时，返回 false。
func (c *candidateRewriter) clone(seen map[string]bool, scope, cand string) (string, bool) {
	// candidate:<foundation> <component> <transport> <priority> <address> <port> typ <type> [<key> <value>]...
	f := strings.Fields(strings.TrimPrefix(cand, "candidate:"))
	if !c.addr.IsValid() || len(f) < 8 || f[6] != "typ" || f[7] != "host" || len(f[8:])%2 != 0 {
		return "", false
	}
	orig, err := netip.ParseAddr(f[4])
	if err != nil {
		return "", false
	}
	var rest []string
	tcpType := ""
	for i := 8; i < len(f); i += 2 {
		if f[i] == "tcptype" {
			tcpType = f[i+1]
		}
		rest = append(rest, f[i], f[i+1])
	}
	key := strings.Join([]string{scope, f[1], strings.ToLower(f[2]), f[5], tcpType}, "|")
	if seen[key] {
		return "", false
	}
	seen[key] = true
	if orig.Unmap() == c.addr {
		return "", false
	}
	foundation := crc32.ChecksumIEEE([]byte("hane|" + c.addr.String() + "|" + strings.ToLower(f[2]) + "|" + tcpType))
	out := fmt.Sprintf("candidate:%d %s %s %s %s %s typ host", foundation, f[1], f[2], f[3], c.addr, f[5])
	if len(rest) > 0 {
		out += " " + strings.Join(rest, " ")
	}
	return out, true
}

// filterClientUDP 去掉客户端发给 LiveKit 的消息（SignalRequest）里的 UDP 候选：trickle 整条丢掉，offer / answer 删掉对应的行。
func filterClientUDP(mt int, data []byte) [][]byte {
	msg := &lkp.SignalRequest{}
	var err error
	switch mt {
	case websocket.BinaryMessage:
		err = proto.Unmarshal(data, msg)
	case websocket.TextMessage:
		err = protojson.Unmarshal(data, msg)
	default:
		return [][]byte{data}
	}
	if err != nil {
		return [][]byte{data}
	}
	var d *lkp.SessionDescription
	switch m := msg.Message.(type) {
	case *lkp.SignalRequest_Trickle:
		if udpTrickle(m.Trickle) {
			return nil
		}
		return [][]byte{data}
	case *lkp.SignalRequest_Offer:
		d = m.Offer
	case *lkp.SignalRequest_Answer:
		d = m.Answer
	default:
		return [][]byte{data}
	}
	if d == nil {
		return [][]byte{data}
	}
	sdp, changed := stripUDP(d.Sdp)
	if !changed {
		return [][]byte{data}
	}
	d.Sdp = sdp
	b, err := marshalSignal(mt, msg)
	if err != nil {
		return [][]byte{data}
	}
	return [][]byte{b}
}

// udpCandidate 判断一条候选（candidate:<foundation> <component> <transport> ...）是不是 UDP。
func udpCandidate(cand string) bool {
	f := strings.Fields(strings.TrimPrefix(cand, "candidate:"))
	return len(f) > 2 && strings.EqualFold(f[2], "udp")
}

func udpTrickle(t *lkp.TrickleRequest) bool {
	var init webrtc.ICECandidateInit
	return json.Unmarshal([]byte(t.GetCandidateInit()), &init) == nil && udpCandidate(init.Candidate)
}

// stripUDP 删掉 SDP 里的 UDP 候选行（a=candidate:...），返回是否有改动。
func stripUDP(sdp string) (string, bool) {
	var b strings.Builder
	changed := false
	for _, line := range strings.SplitAfter(sdp, "\n") {
		if cand, ok := strings.CutPrefix(strings.TrimRight(line, "\r\n"), "a="); ok && strings.HasPrefix(cand, "candidate:") && udpCandidate(cand) {
			changed = true
			continue
		}
		b.WriteString(line)
	}
	return b.String(), changed
}
