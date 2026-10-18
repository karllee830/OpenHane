// hanenetem 是弱网测试用的 TURN 中继：客户端强制只用这个中继（iceTransportPolicy: relay），
// 中继在转发时注入限速、延迟、抖动和丢包。全部在用户态完成，不需要 root、不改系统网络设置。
//
//	go run ./cmd/hanenetem -listen 127.0.0.1:3478 -control 127.0.0.1:3479 -profile poor
//
// 客户端 ICE 服务器：turn:127.0.0.1:3478?transport=udp，用户名 / 密码 hane / hane。
// 控制接口（只监听本机）：
//
//	GET /profile?name=poor        切换场景（所有已有和新建的中继立即生效）
//	GET /blackout?ms=3000         全部丢包一段时间（模拟网络中断）
//	GET /reset                    关闭所有中继分配（模拟换网：客户端需要 ICE 重启、重新分配）
//	GET /stats                    各方向的发送 / 丢弃计数
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"sort"
	"strconv"
	"sync"
	"syscall"
	"time"

	"github.com/pion/turn/v5"

	"github.com/karllee830/OpenHane/server/internal/netem"
)

// scenario 是一个场景：上行（客户端 → SFU）和下行（SFU → 客户端）两个方向的损伤。
// 弱网矩阵：单向延迟 = RTT / 2，每个方向的抖动 = 表中抖动 / 2，丢包率按每个方向计。
type scenario struct {
	Up, Down netem.Profile
}

var scenarios = map[string]scenario{
	"off":      {},
	"good":     both(10000, 50000, 10, 1, 0),
	"wifi":     both(5000, 20000, 25, 5, 1),
	"4g":       both(3000, 10000, 40, 15, 2),
	"poor":     both(1000, 2000, 75, 25, 5),
	"terrible": both(300, 500, 150, 50, 10),
	"burst": {
		Up:   netem.Profile{RateKbps: 10000, DelayMs: 25, BurstLossPct: 20, BurstLen: 3},
		Down: netem.Profile{RateKbps: 10000, DelayMs: 25, BurstLossPct: 20, BurstLen: 3},
	},
}

func both(upKbps, downKbps, delayMs, jitterMs int, loss float64) scenario {
	return scenario{
		Up:   netem.Profile{RateKbps: upKbps, DelayMs: delayMs, JitterMs: jitterMs, LossPct: loss},
		Down: netem.Profile{RateKbps: downKbps, DelayMs: delayMs, JitterMs: jitterMs, LossPct: loss},
	}
}

type relay struct {
	mu       sync.Mutex
	current  scenario
	name     string
	down     *netem.Conn   // 中继 → 客户端（TURN 监听端口的发送方向）
	ups      []*netem.Conn // 中继 → SFU（每个分配一个）
	blackout time.Time
	seed     uint64
}

func (r *relay) apply(s scenario) {
	r.down.Set(s.Down)
	for _, u := range r.ups {
		u.Set(s.Up)
	}
}

func (r *relay) setScenario(name string) error {
	s, ok := scenarios[name]
	if !ok {
		return fmt.Errorf("unknown scenario %q", name)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.current, r.name = s, name
	r.apply(s)
	return nil
}

// relayGenerator 在每次分配时用 netem 包装中继套接字（上行方向）
type relayGenerator struct {
	turn.RelayAddressGeneratorStatic
	r *relay
}

func (g *relayGenerator) AllocatePacketConn(conf turn.AllocateListenerConfig) (net.PacketConn, net.Addr, error) {
	pc, addr, err := g.RelayAddressGeneratorStatic.AllocatePacketConn(conf)
	if err != nil {
		return nil, nil, err
	}
	g.r.mu.Lock()
	defer g.r.mu.Unlock()
	g.r.seed++
	c := netem.Wrap(pc, g.r.seed)
	c.Set(g.r.current.Up)
	g.r.ups = append(g.r.ups, c)
	return c, addr, nil
}

func main() {
	listen := flag.String("listen", "127.0.0.1:3478", "TURN 监听地址（UDP）")
	control := flag.String("control", "127.0.0.1:3479", "控制接口地址（HTTP，只允许回环地址）")
	profile := flag.String("profile", "off", "初始场景")
	flag.Parse()

	host, _, err := net.SplitHostPort(*listen)
	if err != nil {
		log.Fatal(err)
	}
	if ip := net.ParseIP(host); ip == nil || !ip.IsLoopback() {
		log.Fatal("hanenetem 只用于本机测试：-listen 必须是回环地址")
	}
	pc, err := net.ListenPacket("udp4", *listen)
	if err != nil {
		log.Fatal(err)
	}
	r := &relay{down: netem.Wrap(pc, 1)}
	if err := r.setScenario(*profile); err != nil {
		log.Fatal(err)
	}
	const realm = "openhane-netem"
	key := turn.GenerateAuthKey("hane", realm, "hane")
	srv, err := turn.NewServer(turn.ServerConfig{
		Realm: realm,
		AuthHandler: func(ra *turn.RequestAttributes) (string, []byte, bool) {
			return ra.Username, key, ra.Username == "hane"
		},
		PacketConnConfigs: []turn.PacketConnConfig{{
			PacketConn: r.down,
			RelayAddressGenerator: &relayGenerator{
				RelayAddressGeneratorStatic: turn.RelayAddressGeneratorStatic{RelayAddress: net.ParseIP(host), Address: host},
				r:                           r,
			},
		}},
	})
	if err != nil {
		log.Fatal(err)
	}
	defer srv.Close()

	ok := func(w http.ResponseWriter, v any) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(v)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/profile", func(w http.ResponseWriter, req *http.Request) {
		if err := r.setScenario(req.URL.Query().Get("name")); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		log.Printf("scenario: %s", req.URL.Query().Get("name"))
		ok(w, map[string]string{"scenario": req.URL.Query().Get("name")})
	})
	mux.HandleFunc("/blackout", func(w http.ResponseWriter, req *http.Request) {
		ms, _ := strconv.Atoi(req.URL.Query().Get("ms"))
		all := netem.Profile{LossPct: 100}
		r.mu.Lock()
		r.apply(scenario{Up: all, Down: all})
		until := time.Now().Add(time.Duration(ms) * time.Millisecond)
		r.blackout = until
		r.mu.Unlock()
		time.AfterFunc(time.Duration(ms)*time.Millisecond, func() {
			r.mu.Lock()
			defer r.mu.Unlock()
			if r.blackout.Equal(until) {
				r.apply(r.current)
			}
		})
		log.Printf("blackout %d ms", ms)
		ok(w, map[string]int{"blackout_ms": ms})
	})
	mux.HandleFunc("/reset", func(w http.ResponseWriter, _ *http.Request) {
		r.mu.Lock()
		n := len(r.ups)
		for _, u := range r.ups {
			_ = u.Close()
		}
		r.ups = nil
		r.mu.Unlock()
		log.Printf("reset: closed %d relay allocations", n)
		ok(w, map[string]int{"closed": n})
	})
	mux.HandleFunc("/stats", func(w http.ResponseWriter, _ *http.Request) {
		r.mu.Lock()
		defer r.mu.Unlock()
		up := netem.Stats{}
		for _, u := range r.ups {
			s := u.Stats()
			up.Sent += s.Sent
			up.Dropped += s.Dropped
			up.QueueDropped += s.QueueDropped
		}
		ok(w, map[string]any{"scenario": r.name, "up": up, "down": r.down.Stats(), "allocations": len(r.ups)})
	})
	mux.HandleFunc("/scenarios", func(w http.ResponseWriter, _ *http.Request) {
		names := make([]string, 0, len(scenarios))
		for n := range scenarios {
			names = append(names, n)
		}
		sort.Strings(names)
		ok(w, names)
	})
	chost, _, err := net.SplitHostPort(*control)
	if ip := net.ParseIP(chost); err != nil || ip == nil || !ip.IsLoopback() {
		log.Fatal("-control 必须是回环地址")
	}
	go func() { log.Fatal(http.ListenAndServe(*control, mux)) }()
	log.Printf("hanenetem: TURN %s (hane/hane), control http://%s, scenario %s", *listen, *control, *profile)

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig
}
