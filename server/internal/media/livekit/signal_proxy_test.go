package livekit

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	lkp "github.com/livekit/protocol/livekit"
	"github.com/livekit/protocol/utils/protojson"
	"github.com/pion/webrtc/v4"
	"google.golang.org/protobuf/proto"
)

var discard = slog.New(slog.NewTextHandler(io.Discard, nil))

func newRewriter(addr string) *candidateRewriter {
	return &candidateRewriter{addr: netip.MustParseAddr(addr), log: discard}
}

func TestCloneCandidate(t *testing.T) {
	c := newRewriter("124.220.40.176")
	cases := []struct {
		in, want string
	}{
		{"candidate:1 1 udp 2130706431 192.0.2.10 9800 typ host ufrag abc generation 0",
			"1 udp 2130706431 124.220.40.176 9800 typ host ufrag abc generation 0"},
		{"candidate:2 1 tcp 1671430143 172.17.0.6 9801 typ host tcptype passive",
			"1 tcp 1671430143 124.220.40.176 9801 typ host tcptype passive"},
	}
	for _, tc := range cases {
		got, ok := c.clone(map[string]bool{}, "0", tc.in)
		if !ok {
			t.Fatalf("%q: not cloned", tc.in)
		}
		// 去掉 foundation 再比较
		if _, rest, _ := strings.Cut(strings.TrimPrefix(got, "candidate:"), " "); rest != tc.want {
			t.Fatalf("%q:\n got %q\nwant %q", tc.in, rest, tc.want)
		}
	}

	for _, in := range []string{
		"candidate:1 1 udp 2130706431 124.220.40.176 9800 typ host", // 已经是这个地址
		"candidate:1 1 udp 16777215 10.0.0.1 3478 typ relay raddr 1.2.3.4 rport 5",
		// srflx 的端口是 NAT 映射出来的，不是 SFU 监听的端口
		"candidate:3 1 udp 1694498815 120.225.113.182 49762 typ srflx raddr 0.0.0.0 rport 51116",
		"candidate:1 1 udp 2130706431 abc.local 9800 typ host", // mDNS
		"candidate:1 1 udp 2130706431 192.0.2.10 9800 typ",     // 格式不完整
		"",
	} {
		if got, ok := c.clone(map[string]bool{}, "0", in); ok {
			t.Fatalf("%q should not be cloned, got %q", in, got)
		}
	}

	// 同一作用域内同协议同端口只补一次；原候选已经是这个地址时也不再补
	seen := map[string]bool{}
	if _, ok := c.clone(seen, "0", "candidate:1 1 udp 1 192.0.2.10 9800 typ host"); !ok {
		t.Fatal("first should be cloned")
	}
	if _, ok := c.clone(seen, "0", "candidate:2 1 udp 1 172.17.0.6 9800 typ host"); ok {
		t.Fatal("same transport and port should be cloned once")
	}
	if _, ok := c.clone(seen, "1", "candidate:2 1 udp 1 172.17.0.6 9800 typ host"); !ok {
		t.Fatal("another m-line should get its own candidate")
	}
	if _, ok := c.clone(seen, "2", "candidate:1 1 udp 1 124.220.40.176 9800 typ host"); ok {
		t.Fatal("original already has the address")
	}
	if _, ok := c.clone(seen, "2", "candidate:2 1 udp 1 172.17.0.6 9800 typ host"); ok {
		t.Fatal("original with the address seen earlier in the scope")
	}
}

func trickleMsg(t *testing.T, cand string, target lkp.SignalTarget, final bool) *lkp.SignalResponse {
	t.Helper()
	mid, idx := "0", uint16(0)
	b, err := json.Marshal(webrtc.ICECandidateInit{Candidate: cand, SDPMid: &mid, SDPMLineIndex: &idx})
	if err != nil {
		t.Fatal(err)
	}
	return &lkp.SignalResponse{Message: &lkp.SignalResponse_Trickle{Trickle: &lkp.TrickleRequest{CandidateInit: string(b), Target: target, Final: final}}}
}

func decodeTrickle(t *testing.T, mt int, b []byte) (*lkp.TrickleRequest, webrtc.ICECandidateInit) {
	t.Helper()
	msg := &lkp.SignalResponse{}
	var err error
	if mt == websocket.TextMessage {
		err = protojson.Unmarshal(b, msg)
	} else {
		err = proto.Unmarshal(b, msg)
	}
	if err != nil || msg.GetTrickle() == nil {
		t.Fatalf("not a trickle: %v %s", err, b)
	}
	var init webrtc.ICECandidateInit
	if err := json.Unmarshal([]byte(msg.GetTrickle().CandidateInit), &init); err != nil {
		t.Fatal(err)
	}
	return msg.GetTrickle(), init
}

func TestRewriteTrickle(t *testing.T) {
	for _, mt := range []int{websocket.BinaryMessage, websocket.TextMessage} {
		c := newRewriter("124.220.40.176")
		orig := trickleMsg(t, "candidate:1 1 udp 2130706431 192.0.2.10 9800 typ host", lkp.SignalTarget_SUBSCRIBER, true)
		data, _ := marshalSignal(mt, orig)
		out := c.rewrite(mt, data)
		if len(out) != 2 {
			t.Fatalf("type %d: want added candidate + original, got %d messages", mt, len(out))
		}
		// 补的候选在前且不带 final；原消息原样保留在后
		tr, init := decodeTrickle(t, mt, out[0])
		if tr.Final || tr.Target != lkp.SignalTarget_SUBSCRIBER || !strings.Contains(init.Candidate, " 124.220.40.176 9800 typ host") ||
			init.SDPMid == nil || *init.SDPMid != "0" || init.SDPMLineIndex == nil {
			t.Fatalf("type %d: added %+v %+v", mt, tr, init)
		}
		if string(out[1]) != string(data) {
			t.Fatalf("type %d: original changed", mt)
		}

		// 同端口的候选只补一次；offer 之后（可能是 ICE 重启）重新补
		again, _ := marshalSignal(mt, trickleMsg(t, "candidate:2 1 udp 2130706431 172.17.0.6 9800 typ host", lkp.SignalTarget_SUBSCRIBER, false))
		if n := len(c.rewrite(mt, again)); n != 1 {
			t.Fatalf("type %d: duplicate candidate added (%d messages)", mt, n)
		}
		offer, _ := marshalSignal(mt, &lkp.SignalResponse{Message: &lkp.SignalResponse_Offer{Offer: &lkp.SessionDescription{Type: "offer", Sdp: "v=0\r\n"}}})
		if out := c.rewrite(mt, offer); len(out) != 1 || string(out[0]) != string(offer) {
			t.Fatalf("type %d: offer without candidates should pass through", mt)
		}
		if n := len(c.rewrite(mt, again)); n != 2 {
			t.Fatalf("type %d: candidate not re-added after offer", mt)
		}
	}

	// 其他消息和无法解析的数据原样通过
	c := newRewriter("124.220.40.176")
	pong, _ := proto.Marshal(&lkp.SignalResponse{Message: &lkp.SignalResponse_PongResp{PongResp: &lkp.Pong{LastPingTimestamp: 1}}})
	for _, data := range [][]byte{pong, []byte("\xff\xff garbage")} {
		if out := c.rewrite(websocket.BinaryMessage, data); len(out) != 1 || string(out[0]) != string(data) {
			t.Fatalf("message changed: %q", data)
		}
	}
}

func TestRewriteSDP(t *testing.T) {
	sdp := "v=0\r\n" +
		"m=audio 9 UDP/TLS/RTP/SAVPF 111\r\n" +
		"a=candidate:1 1 udp 2130706431 192.0.2.10 9800 typ host\r\n" +
		"a=candidate:2 1 udp 2130706431 172.17.0.6 9800 typ host\r\n" +
		"a=candidate:3 1 tcp 1671430143 192.0.2.10 9801 typ host tcptype passive\r\n" +
		"a=end-of-candidates\r\n" +
		"m=video 9 UDP/TLS/RTP/SAVPF 96\r\n" +
		"a=candidate:1 1 udp 2130706431 192.0.2.10 9800 typ host\r\n"
	d := &lkp.SessionDescription{Type: "answer", Sdp: sdp}
	if !newRewriter("124.220.40.176").sdp(d) {
		t.Fatal("sdp not changed")
	}
	want := "v=0\r\n" +
		"m=audio 9 UDP/TLS/RTP/SAVPF 111\r\n" +
		"a=candidate:1 1 udp 2130706431 192.0.2.10 9800 typ host\r\n" +
		"a=candidate:F 1 udp 2130706431 124.220.40.176 9800 typ host\r\n" +
		"a=candidate:2 1 udp 2130706431 172.17.0.6 9800 typ host\r\n" +
		"a=candidate:3 1 tcp 1671430143 192.0.2.10 9801 typ host tcptype passive\r\n" +
		"a=candidate:F 1 tcp 1671430143 124.220.40.176 9801 typ host tcptype passive\r\n" +
		"a=end-of-candidates\r\n" +
		"m=video 9 UDP/TLS/RTP/SAVPF 96\r\n" +
		"a=candidate:1 1 udp 2130706431 192.0.2.10 9800 typ host\r\n" +
		"a=candidate:F 1 udp 2130706431 124.220.40.176 9800 typ host\r\n"
	if got := maskFoundation(d.Sdp); got != want {
		t.Fatalf("got:\n%s\nwant:\n%s", got, want)
	}
}

// maskFoundation 把补出来的候选（地址 124.220.40.176）的 foundation 换成 F，便于比较。
func maskFoundation(sdp string) string {
	lines := strings.SplitAfter(sdp, "\n")
	for i, l := range lines {
		if strings.Contains(l, " 124.220.40.176 ") {
			_, rest, _ := strings.Cut(l, " ")
			lines[i] = "a=candidate:F " + rest
		}
	}
	return strings.Join(lines, "")
}

func TestClientFacingAddr(t *testing.T) {
	p := newSignalProxy(&url.URL{}, http.NotFoundHandler(), func(_ context.Context, h string) (netip.Addr, error) {
		if h == "meet.example.com" {
			return netip.MustParseAddr("203.0.113.5"), nil
		}
		return netip.ParseAddr(h)
	}, nil, discard)
	for host, want := range map[string]string{
		"124.220.40.176:9800":   "124.220.40.176",
		"124.220.40.176":        "124.220.40.176",
		"meet.example.com:9800": "203.0.113.5",
		"[2001:db8::1]:9800":    "2001:db8::1",
		"[2001:db8::1]":         "2001:db8::1",
		"127.0.0.1:9800":        "",
		"[::1]:9800":            "",
		"localhost:9800":        "", // 解析失败
		"":                      "",
	} {
		r := httptest.NewRequest("GET", "/rtc", nil)
		r.Host = host
		got := p.clientFacingAddr(r)
		if (want == "" && got.IsValid()) || (want != "" && got.String() != want) {
			t.Fatalf("%q: got %v, want %q", host, got, want)
		}
	}
}

// TestSignalProxy 用假的 LiveKit 后端验证整条转发：握手参数传到后端、双向消息转发、候选补充、拒绝原样返回。
func TestSignalProxy(t *testing.T) {
	type handshake struct {
		path, query, auth, xff string
	}
	got := make(chan handshake, 1)
	fromClient := make(chan []byte, 1)
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("access_token") == "bad" {
			http.Error(w, "invalid token", http.StatusUnauthorized)
			return
		}
		got <- handshake{r.URL.Path, r.URL.RawQuery, r.Header.Get("Authorization"), r.Header.Get("X-Forwarded-For")}
		c, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer c.Close()
		b, _ := proto.Marshal(trickleMsg(t, "candidate:1 1 udp 2130706431 192.0.2.10 9800 typ host", lkp.SignalTarget_PUBLISHER, false))
		c.WriteMessage(websocket.BinaryMessage, b)
		if _, msg, err := c.ReadMessage(); err == nil {
			fromClient <- msg
		}
		c.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, "bye"))
		c.ReadMessage()
	}))
	defer backend.Close()
	bu, _ := url.Parse(backend.URL)
	proxy := httptest.NewServer(newSignalProxy(bu, http.NotFoundHandler(), func(_ context.Context, h string) (netip.Addr, error) {
		return netip.ParseAddr(h)
	}, nil, discard))
	defer proxy.Close()

	wsURL := "ws" + strings.TrimPrefix(proxy.URL, "http") + "/rtc/v1?access_token=good&auto_subscribe=1"
	hdr := http.Header{"Host": {"124.220.40.176:9800"}, "Authorization": {"Bearer x"}}
	c, _, err := websocket.DefaultDialer.Dial(wsURL, hdr)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	c.SetReadDeadline(time.Now().Add(5 * time.Second))

	h := <-got
	if h.path != "/rtc/v1" || h.query != "access_token=good&auto_subscribe=1" || h.auth != "Bearer x" || h.xff != "127.0.0.1" {
		t.Fatalf("handshake not forwarded: %+v", h)
	}
	_, b, err := c.ReadMessage()
	if err != nil {
		t.Fatal(err)
	}
	if _, init := decodeTrickle(t, websocket.BinaryMessage, b); !strings.Contains(init.Candidate, " 124.220.40.176 9800 ") {
		t.Fatalf("first message should be the client-facing candidate: %s", init.Candidate)
	}
	_, b, err = c.ReadMessage()
	if err != nil {
		t.Fatal(err)
	}
	if _, init := decodeTrickle(t, websocket.BinaryMessage, b); !strings.Contains(init.Candidate, " 192.0.2.10 9800 ") {
		t.Fatalf("original candidate missing: %s", init.Candidate)
	}
	ping, _ := proto.Marshal(&lkp.SignalRequest{Message: &lkp.SignalRequest_PingReq{PingReq: &lkp.Ping{Timestamp: 42}}})
	if err := c.WriteMessage(websocket.BinaryMessage, ping); err != nil {
		t.Fatal(err)
	}
	if msg := <-fromClient; string(msg) != string(ping) {
		t.Fatal("client message changed on the way to the backend")
	}
	// 后端的关闭原因转给客户端
	_, _, err = c.ReadMessage()
	if ce, ok := err.(*websocket.CloseError); !ok || ce.Code != websocket.CloseNormalClosure || ce.Text != "bye" {
		t.Fatalf("close not forwarded: %v", err)
	}

	// LiveKit 拒绝握手时，状态码和原因交给客户端（客户端据此提示令牌无效等）
	_, resp, err := websocket.DefaultDialer.Dial(strings.Replace(wsURL, "good", "bad", 1), hdr)
	if err == nil || resp == nil || resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("rejection not forwarded: %v %v", resp, err)
	}
	if body, _ := io.ReadAll(resp.Body); !strings.Contains(string(body), "invalid token") {
		t.Fatalf("rejection body: %q", body)
	}
}

func TestStripUDP(t *testing.T) {
	sdp := "v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n" +
		"a=candidate:1 1 udp 2130706431 192.0.2.10 9800 typ host\r\n" +
		"a=candidate:2 1 tcp 1671430143 192.0.2.10 9801 typ host tcptype passive\r\n" +
		"a=candidate:3 1 UDP 1694498815 120.225.113.182 49762 typ srflx raddr 0.0.0.0 rport 51116\r\n" +
		"a=end-of-candidates\r\n"
	got, changed := stripUDP(sdp)
	want := "v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n" +
		"a=candidate:2 1 tcp 1671430143 192.0.2.10 9801 typ host tcptype passive\r\n" +
		"a=end-of-candidates\r\n"
	if !changed || got != want {
		t.Fatalf("got %q", got)
	}
	if _, changed := stripUDP(want); changed {
		t.Fatal("no UDP candidates: should be unchanged")
	}
}

// TestSignalProxyTCPOnly：只走 TCP 的连接（共享连接 TCP 优先）双向去掉 UDP 候选；回环地址（不补候选）时同样经过转发层。
func TestSignalProxyTCPOnly(t *testing.T) {
	const udp = "candidate:1 1 udp 2130706431 192.0.2.10 9800 typ host"
	const tcp = "candidate:2 1 tcp 1671430143 192.0.2.10 9801 typ host tcptype passive"
	sdp := "v=0\r\na=" + udp + "\r\na=" + tcp + "\r\n"
	fromClient := make(chan []byte, 3)
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer c.Close()
		for _, m := range []*lkp.SignalResponse{
			trickleMsg(t, udp, lkp.SignalTarget_PUBLISHER, false),
			trickleMsg(t, tcp, lkp.SignalTarget_PUBLISHER, false),
			{Message: &lkp.SignalResponse_Answer{Answer: &lkp.SessionDescription{Type: "answer", Sdp: sdp}}},
		} {
			b, _ := proto.Marshal(m)
			c.WriteMessage(websocket.BinaryMessage, b)
		}
		for range 3 {
			_, msg, err := c.ReadMessage()
			if err != nil {
				return
			}
			fromClient <- msg
		}
		c.ReadMessage()
	}))
	defer backend.Close()
	bu, _ := url.Parse(backend.URL)
	proxy := httptest.NewServer(newSignalProxy(bu, http.NotFoundHandler(), func(_ context.Context, h string) (netip.Addr, error) {
		return netip.ParseAddr(h)
	}, func(r *http.Request) bool { return r.URL.Query().Get("access_token") == "tcp" }, discard))
	defer proxy.Close()

	c, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(proxy.URL, "http")+"/rtc/v1?access_token=tcp", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	c.SetReadDeadline(time.Now().Add(5 * time.Second))

	// 服务端 → 客户端：UDP 的 trickle 被丢掉，SDP 里只剩 TCP 候选
	_, b, err := c.ReadMessage()
	if err != nil {
		t.Fatal(err)
	}
	if _, init := decodeTrickle(t, websocket.BinaryMessage, b); init.Candidate != tcp {
		t.Fatalf("expected only the TCP candidate, got %s", init.Candidate)
	}
	_, b, err = c.ReadMessage()
	if err != nil {
		t.Fatal(err)
	}
	ans := &lkp.SignalResponse{}
	if err := proto.Unmarshal(b, ans); err != nil || ans.GetAnswer().GetSdp() != "v=0\r\na="+tcp+"\r\n" {
		t.Fatalf("answer not filtered: %v %q", err, ans.GetAnswer().GetSdp())
	}

	// 客户端 → 服务端：同样去掉 UDP 候选（JSON 信令也一样）
	req := func(m *lkp.SignalRequest) []byte {
		b, _ := proto.Marshal(m)
		return b
	}
	tr := func(cand string) *lkp.SignalRequest {
		init, _ := json.Marshal(webrtc.ICECandidateInit{Candidate: cand})
		return &lkp.SignalRequest{Message: &lkp.SignalRequest_Trickle{Trickle: &lkp.TrickleRequest{CandidateInit: string(init)}}}
	}
	c.WriteMessage(websocket.BinaryMessage, req(tr(udp)))
	c.WriteMessage(websocket.BinaryMessage, req(tr(tcp)))
	offer, _ := protojson.Marshal(&lkp.SignalRequest{Message: &lkp.SignalRequest_Offer{Offer: &lkp.SessionDescription{Type: "offer", Sdp: sdp}}})
	c.WriteMessage(websocket.TextMessage, offer)
	if msg := <-fromClient; string(msg) != string(req(tr(tcp))) {
		t.Fatal("UDP trickle should be dropped, TCP trickle forwarded unchanged")
	}
	got := &lkp.SignalRequest{}
	if err := protojson.Unmarshal(<-fromClient, got); err != nil || got.GetOffer().GetSdp() != "v=0\r\na="+tcp+"\r\n" {
		t.Fatalf("offer not filtered: %v %q", err, got.GetOffer().GetSdp())
	}
}
