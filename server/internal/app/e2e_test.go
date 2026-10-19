package app

import (
	"bytes"
	"context"
	"image"
	pngenc "image/png"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	lksdk "github.com/livekit/server-sdk-go/v2"

	"github.com/karllee830/OpenHane/server/internal/adminsock"
	"github.com/karllee830/OpenHane/server/internal/client"
	"github.com/karllee830/OpenHane/server/internal/config"
	"github.com/karllee830/OpenHane/server/internal/pb"
)

// TestEndToEndMedia 启动完整服务（内嵌 LiveKit），客户端经控制协议拿到媒体令牌后，
// 用 LiveKit Go SDK 通过 /rtc 反向代理和 UDP 真正连上 SFU，验证 webhook 事件回流到 Hub。
func TestEndToEndMedia(t *testing.T) {
	if testing.Short() {
		t.Skip("starts the embedded SFU")
	}
	port := freePort(t)
	cfg, err := config.Load(func(k string) string {
		return map[string]string{
			"HANE_DATA_DIR":          t.TempDir(),
			"HANE_PORT":              itoa(port),
			"HANE_TCP_FALLBACK_PORT": "0",
			"HANE_TLS_MODE":          "off",
			"HANE_METRICS":           "true",
			"HANE_METRICS_TOKEN":     "s3cret",
		}[k]
	})
	if err != nil {
		t.Fatal(err)
	}
	cfg.STUNServers = nil // 离线测试：不探测公网 IP，只用本机地址
	ctx, cancel := context.WithCancel(context.Background())
	a := &App{Version: "e2e", Cfg: cfg, Log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	done := make(chan error, 1)
	go func() { done <- a.Run(ctx) }()
	base := "http://127.0.0.1:" + itoa(port)
	waitReady(t, base+"/readyz", done)

	dial := func(n byte, nick string) *client.Client {
		seed := make([]byte, 32)
		seed[0] = n
		c, err := client.Dial(context.Background(), client.Options{URL: "ws://127.0.0.1:" + itoa(port) + "/ws", MasterSeed: seed, Nickname: nick})
		if err != nil {
			t.Fatal(err)
		}
		return c
	}
	alice, bob := dial(1, "Alice"), dial(2, "Bob")
	defer alice.Close()
	defer bob.Close()

	// /metrics：需要 Bearer Token；在线人数和握手计数正确
	if resp, err := http.Get(base + "/metrics"); err != nil || resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("metrics without token: %v %v", resp, err)
	}
	mreq, _ := http.NewRequest("GET", base+"/metrics", nil)
	mreq.Header.Set("Authorization", "Bearer s3cret")
	mresp, err := http.DefaultClient.Do(mreq)
	if err != nil || mresp.StatusCode != http.StatusOK {
		t.Fatalf("metrics: %v %v", mresp, err)
	}
	body, _ := io.ReadAll(mresp.Body)
	mresp.Body.Close()
	for _, want := range []string{`hane_sessions{state="online"} 2`, "hane_handshakes_ok_total 2", `hane_build_info{version="e2e"} 1`, "hane_rooms 1", "go_goroutines "} {
		if !strings.Contains(string(body), want) {
			t.Fatalf("metrics missing %q:\n%s", want, body)
		}
	}

	// /api/v1/info：公开的在线人数，允许跨域读取
	iresp, err := http.Get(base + "/api/v1/info")
	if err != nil {
		t.Fatal(err)
	}
	ibody, _ := io.ReadAll(iresp.Body)
	iresp.Body.Close()
	if iresp.Header.Get("Access-Control-Allow-Origin") != "*" || !strings.Contains(string(ibody), `"online":2`) {
		t.Fatalf("info: %v %s", iresp.Header, ibody)
	}

	// 服务器图标：放进数据目录即生效，info 带上摘要，/api/v1/logo 返回图片并支持 304
	if resp, err := http.Get(base + "/api/v1/logo"); err != nil || resp.StatusCode != http.StatusNotFound {
		t.Fatalf("logo before file: %v %v", resp, err)
	}
	var png bytes.Buffer
	_ = pngenc.Encode(&png, image.NewRGBA(image.Rect(0, 0, 256, 256)))
	if err := os.WriteFile(filepath.Join(cfg.DataDir, "logo.png"), png.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	lresp, err := http.Get(base + "/api/v1/logo")
	if err != nil || lresp.StatusCode != http.StatusOK || lresp.Header.Get("Content-Type") != "image/png" || lresp.Header.Get("Access-Control-Allow-Origin") != "*" {
		t.Fatalf("logo: %v %v", lresp, err)
	}
	lresp.Body.Close()
	ireq2, _ := http.Get(base + "/api/v1/info")
	ibody2, _ := io.ReadAll(ireq2.Body)
	ireq2.Body.Close()
	if !strings.Contains(string(ibody2), `"logo":"`+strings.Trim(lresp.Header.Get("ETag"), `"`)+`"`) {
		t.Fatalf("info without logo: %s (etag %s)", ibody2, lresp.Header.Get("ETag"))
	}
	creq, _ := http.NewRequest("GET", base+"/api/v1/logo", nil)
	creq.Header.Set("If-None-Match", lresp.Header.Get("ETag"))
	if cresp, err := http.DefaultClient.Do(creq); err != nil || cresp.StatusCode != http.StatusNotModified {
		t.Fatalf("logo revalidation: %v %v", cresp, err)
	}

	grant := alice.Welcome.GetAutoJoin().GetMedia()
	if grant.GetToken() == "" {
		t.Fatal("no media token")
	}
	// 用本机的局域网地址连 /rtc：经过信令转发里的候选改写（回环地址会直接反向代理，覆盖不到）
	rtcHost := "127.0.0.1"
	if ip := lanIPv4(); ip != "" {
		rtcHost = ip
	}
	room, err := lksdk.ConnectToRoomWithToken("ws://"+rtcHost+":"+itoa(port), grant.GetToken(), lksdk.NewRoomCallback(), lksdk.WithAutoSubscribe(false))
	if err != nil {
		t.Fatalf("connect to SFU through /rtc: %v", err)
	}
	// 每次等待各自 30 秒：CI 上开着竞态检测，SFU 的事件可能晚到好几秒
	wctx, wcancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer wcancel()
	aliceID := alice.Welcome.GetSessionId()
	if _, err := bob.WaitEvent(wctx, func(ev *pb.Event) bool {
		p := ev.GetParticipantUpdated().GetParticipant()
		return p.GetSessionId() == aliceID && p.GetMediaConnected()
	}); err != nil {
		t.Fatalf("media_connected not reported: %v", err)
	}
	room.Disconnect()
	wctx2, wcancel2 := context.WithTimeout(context.Background(), 30*time.Second)
	defer wcancel2()
	if _, err := bob.WaitEvent(wctx2, func(ev *pb.Event) bool {
		p := ev.GetParticipantUpdated().GetParticipant()
		return p.GetSessionId() == aliceID && !p.GetMediaConnected()
	}); err != nil {
		t.Fatalf("media disconnect not reported: %v", err)
	}

	// 本地管理套接字：设置修改立即推送给在线用户；封禁立即踢出
	sock := adminsock.Path(cfg.DataDir)
	if _, err := adminsock.Call(sock, "settings.set", "server.name", `"CLI"`); err != nil {
		t.Fatal(err)
	}
	if _, err := bob.WaitEvent(wctx, func(ev *pb.Event) bool { return ev.GetServerInfoUpdated().GetInfo().GetName() == "CLI" }); err != nil {
		t.Fatal(err)
	}
	if _, err := adminsock.Call(sock, "ban.add", alice.Welcome.GetUid(), "1h", "test"); err != nil {
		t.Fatal(err)
	}
	if g, err := alice.WaitGoodbye(wctx); err != nil || g.GetError().GetCode() != pb.ErrorCode_ERROR_CODE_BANNED || g.GetReconnect() {
		t.Fatal(g, err)
	}

	// 停机：客户端收到「即将重启」并被要求重连
	cancel()
	g, err := bob.WaitGoodbye(wctx)
	if err != nil || !g.GetReconnect() {
		t.Fatal(g, err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

// lanIPv4 返回本机一个非回环的 IPv4 地址；没有时返回空。
func lanIPv4() string {
	addrs, _ := net.InterfaceAddrs()
	for _, a := range addrs {
		if n, ok := a.(*net.IPNet); ok && n.IP.To4() != nil && !n.IP.IsLoopback() && !n.IP.IsLinkLocalUnicast() {
			return n.IP.String()
		}
	}
	return ""
}

func freePort(t *testing.T) int {
	t.Helper()
	for range 20 {
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		p := ln.Addr().(*net.TCPAddr).Port
		ln.Close()
		// 同一端口号的 UDP 也要空闲（媒体单端口复用）
		if pc, err := net.ListenPacket("udp", ":"+itoa(p)); err == nil {
			pc.Close()
			return p
		}
	}
	t.Fatal("no free port")
	return 0
}

func waitReady(t *testing.T, url string, done <-chan error) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		select {
		case err := <-done:
			t.Fatalf("server exited: %v", err)
		default:
		}
		if resp, err := http.Get(url); err == nil {
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("server not ready")
}

func itoa(n int) string { return strconv.Itoa(n) }
