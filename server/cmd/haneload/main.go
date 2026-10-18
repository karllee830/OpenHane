// haneload 是控制面压测工具：模拟 N 个客户端完成握手，然后随机进出房间、聊天、改变自身状态，
// 统计连接耗时、各类请求的往返延迟（经过 Hub，P50 / P99）、事件扇出量和服务端内存。
//
//	go run ./cmd/haneload -url wss://127.0.0.1:9800/ws -token HANE-... -n 500 -duration 60s [-pid 1234]
//
// 服务器需要放宽单 IP 新连接限制：HANE_CONN_PER_MINUTE=0。
package main

import (
	"context"
	"crypto/rand"
	"flag"
	"fmt"
	"math"
	mrand "math/rand/v2"
	"os"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/karllee830/OpenHane/server/internal/client"
	"github.com/karllee830/OpenHane/server/internal/pb"
	"google.golang.org/protobuf/proto"
)

type stats struct {
	mu   sync.Mutex
	lat  map[string][]time.Duration
	errs map[string]int
}

func (s *stats) add(kind string, d time.Duration, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err != nil {
		s.errs[kind+": "+shortErr(err)]++
		return
	}
	s.lat[kind] = append(s.lat[kind], d)
}

func shortErr(err error) string {
	if c := client.Code(err); c != pb.ErrorCode_ERROR_CODE_UNSPECIFIED {
		return c.String()
	}
	msg := err.Error()
	// 去掉地址部分（read tcp 127.0.0.1:1234->…: i/o timeout → i/o timeout），同类错误合并统计
	if i := strings.LastIndex(msg, ": "); i >= 0 && strings.Contains(msg, "->") {
		msg = msg[i+2:]
	}
	if len(msg) > 60 {
		msg = msg[:60]
	}
	return msg
}

func pct(ds []time.Duration, p float64) time.Duration {
	if len(ds) == 0 {
		return 0
	}
	i := int(math.Ceil(p*float64(len(ds)))) - 1
	return ds[max(0, min(i, len(ds)-1))]
}

func (s *stats) report(title string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	fmt.Printf("\n== %s ==\n%-14s %8s %9s %9s %9s %9s\n", title, "kind", "count", "p50", "p95", "p99", "max")
	kinds := make([]string, 0, len(s.lat))
	for k := range s.lat {
		kinds = append(kinds, k)
	}
	sort.Strings(kinds)
	for _, k := range kinds {
		ds := s.lat[k]
		sort.Slice(ds, func(i, j int) bool { return ds[i] < ds[j] })
		fmt.Printf("%-14s %8d %9s %9s %9s %9s\n", k, len(ds), r(pct(ds, .5)), r(pct(ds, .95)), r(pct(ds, .99)), r(ds[len(ds)-1]))
	}
	for e, n := range s.errs {
		fmt.Printf("error  %-50s %d\n", e, n)
	}
}

func r(d time.Duration) string { return d.Round(10 * time.Microsecond).String() }

// psValue 读取进程的一项指标（ps，macOS / Linux 通用）
func psValue(pid int, field string) float64 {
	if pid == 0 {
		return 0
	}
	out, err := exec.Command("ps", "-o", field+"=", "-p", strconv.Itoa(pid)).Output()
	if err != nil {
		return 0
	}
	v, _ := strconv.ParseFloat(strings.TrimSpace(string(out)), 64)
	return v
}

// rssMB 进程的常驻内存
func rssMB(pid int) float64 { return psValue(pid, "rss") / 1024 }

// cpuSeconds 进程累计占用的 CPU 时间（ps 的 time 字段：[时-]分:秒.xx）
func cpuSeconds(pid int) float64 {
	if pid == 0 {
		return 0
	}
	out, err := exec.Command("ps", "-o", "time=", "-p", strconv.Itoa(pid)).Output()
	if err != nil {
		return 0
	}
	t := strings.TrimSpace(string(out))
	var total float64
	if i := strings.Index(t, "-"); i >= 0 { // 天-时:分:秒
		d, _ := strconv.ParseFloat(t[:i], 64)
		total += d * 86400
		t = t[i+1:]
	}
	parts := strings.Split(t, ":")
	for _, p := range parts {
		v, _ := strconv.ParseFloat(p, 64)
		total = total*60 + v
	}
	return total
}

func main() {
	url := flag.String("url", "wss://127.0.0.1:9800/ws", "控制协议地址")
	token := flag.String("token", "", "管理员令牌（用于创建房间）；不填时只使用主会议")
	n := flag.Int("n", 200, "客户端数量")
	connectRate := flag.Int("rate", 50, "每秒新建连接数")
	rooms := flag.Int("rooms", 10, "临时房间数量")
	duration := flag.Duration("duration", 60*time.Second, "建立连接后的混合负载时长")
	interval := flag.Duration("interval", 10*time.Second, "每个客户端两次操作之间的平均间隔")
	pid := flag.Int("pid", 0, "服务端进程号（采样内存）")
	mediaMode := flag.Bool("media", false, "媒体压测：每个客户端连上 SFU，前 -speakers 个持续发送音频（服务端需 HANE_TLS_MODE=off，-url 用 ws://）；大家都留在主会议")
	speakers := flag.Int("speakers", 3, "媒体压测：同时发言的人数")
	sample := flag.Duration("sample", time.Minute, "媒体压测：多久输出一次送达率、内存和 CPU")
	flag.Parse()

	st := &stats{lat: map[string][]time.Duration{}, errs: map[string]int{}}
	var events atomic.Int64
	onEvent := func(*pb.Event) { events.Add(1) }
	dial := func(i int) (*client.Client, error) {
		seed := make([]byte, 32)
		_, _ = rand.Read(seed)
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		return client.Dial(ctx, client.Options{URL: *url, MasterSeed: seed, Nickname: fmt.Sprintf("load-%d", i), OnEvent: onEvent})
	}
	req := func(c *client.Client, kind string, r *pb.Request) error {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		t := time.Now()
		_, err := c.Request(ctx, r)
		st.add(kind, time.Since(t), err)
		return err
	}

	fmt.Printf("server RSS before: %.1f MB\n", rssMB(*pid))

	// 管理员：创建房间（空置不关闭）
	roomIDs := []string{"main"}
	if *token != "" {
		admin, err := dial(-1)
		if err != nil {
			fmt.Fprintln(os.Stderr, "admin connect:", err)
			os.Exit(1)
		}
		if err := req(admin, "redeem", &pb.Request{Body: &pb.Request_RedeemToken{RedeemToken: &pb.RedeemToken{Token: *token}}}); err != nil {
			fmt.Fprintln(os.Stderr, "redeem:", err)
			os.Exit(1)
		}
		// 在线上限调到足够大（默认 100）
		if err := req(admin, "settings", &pb.Request{Body: &pb.Request_UpdateSettings{UpdateSettings: &pb.UpdateSettings{Patch: map[string]string{"server.max_clients": strconv.Itoa(*n + 10)}}}}); err != nil {
			fmt.Fprintln(os.Stderr, "settings:", err)
			os.Exit(1)
		}
		for i := range *rooms {
			// 管理请求有限流：被限流时等一会儿再试
			resp, err := admin.Request(context.Background(), &pb.Request{Body: &pb.Request_CreateRoom{CreateRoom: &pb.CreateRoom{Name: fmt.Sprintf("压测-%d", i), EmptyTimeoutSec: proto.Uint32(3600)}}})
			for client.Code(err) == pb.ErrorCode_ERROR_CODE_RATE_LIMITED {
				time.Sleep(time.Second)
				resp, err = admin.Request(context.Background(), &pb.Request{Body: &pb.Request_CreateRoom{CreateRoom: &pb.CreateRoom{Name: fmt.Sprintf("压测-%d", i), EmptyTimeoutSec: proto.Uint32(3600)}}})
			}
			if err != nil {
				fmt.Fprintln(os.Stderr, "create room:", err)
				os.Exit(1)
			}
			roomIDs = append(roomIDs, resp.GetCreateRoom().GetRoom().GetId())
		}
		defer admin.Close()
	}

	// 阶段一：按速率建立连接
	clients := make([]*client.Client, *n)
	var wg sync.WaitGroup
	tick := time.NewTicker(time.Second / time.Duration(max(1, *connectRate)))
	start := time.Now()
	for i := range *n {
		<-tick.C
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			t := time.Now()
			c, err := dial(i)
			st.add("connect", time.Since(t), err)
			clients[i] = c
		}(i)
	}
	tick.Stop()
	wg.Wait()
	online := 0
	for _, c := range clients {
		if c != nil {
			online++
		}
	}
	fmt.Printf("connected %d/%d in %s; server RSS: %.1f MB\n", online, *n, time.Since(start).Round(time.Millisecond), rssMB(*pid))
	st.report("connect")

	var ml *mediaLoad
	if *mediaMode {
		t := time.Now()
		var err error
		ml, err = startMedia(*url, clients, *speakers)
		if ml == nil {
			fmt.Fprintln(os.Stderr, "media:", err)
			os.Exit(1)
		}
		if err != nil {
			fmt.Println("media connect error (continuing):", err)
		}
		fmt.Printf("media: %d connected in %s, %d speakers; server RSS: %.1f MB\n", len(ml.rooms), time.Since(t).Round(time.Millisecond), *speakers, rssMB(*pid))
		time.Sleep(5 * time.Second) // 等订阅建立
	}

	// 阶段二：混合负载
	st2 := &stats{lat: map[string][]time.Duration{}, errs: map[string]int{}}
	st.lat, st.errs = st2.lat, st2.errs
	events.Store(0)
	cpu0 := cpuSeconds(*pid)
	ctx, cancel := context.WithTimeout(context.Background(), *duration)
	defer cancel()
	var peak atomic.Int64
	var mediaRecv0 int64
	mediaStart := time.Now()
	if ml != nil {
		mediaRecv0 = ml.received.Load()
		// 定期输出：送达率（实际收到 / 应收到）、掉线次数、服务端内存和 CPU
		go func() {
			lastT, lastRecv, lastCPU := time.Now(), ml.received.Load(), cpuSeconds(*pid)
			for {
				select {
				case <-ctx.Done():
					return
				case <-time.After(*sample):
				}
				now, recv, cpu := time.Now(), ml.received.Load(), cpuSeconds(*pid)
				sec := now.Sub(lastT).Seconds()
				fmt.Printf("[%s] media delivery %.2f%%  recv %.0f pkt/s  drops %d  reconnects %d  server RSS %.1f MB  CPU %.0f%%\n",
					time.Since(mediaStart).Round(time.Second), float64(recv-lastRecv)/sec/ml.expectedPerSecond()*100, float64(recv-lastRecv)/sec,
					ml.drops.Load(), ml.reconn.Load(), rssMB(*pid), (cpu-lastCPU)/sec*100)
				lastT, lastRecv, lastCPU = now, recv, cpu
			}
		}()
	}
	go func() {
		for ctx.Err() == nil {
			if m := int64(rssMB(*pid) * 10); m > peak.Load() {
				peak.Store(m)
			}
			time.Sleep(time.Second)
		}
	}()
	for i, c := range clients {
		if c == nil {
			continue
		}
		wg.Add(1)
		go func(i int, c *client.Client) {
			defer wg.Done()
			rng := mrand.New(mrand.NewPCG(uint64(i), 7))
			// 先错开，避免所有人同时开始
			sleep := func(d time.Duration) bool {
				select {
				case <-time.After(d):
					return true
				case <-ctx.Done():
					return false
				}
			}
			if !sleep(time.Duration(rng.Int64N(int64(*interval)))) {
				return
			}
			// 心跳：与真实客户端一样每 15 秒一次（服务端 45 秒收不到数据即断开）；不经过 Hub，作为延迟基准
			go func() {
				for sleep(15 * time.Second) {
					pctx, pcancel := context.WithTimeout(ctx, 10*time.Second)
					t := time.Now()
					_, err := c.Ping(pctx)
					pcancel()
					if ctx.Err() != nil {
						return
					}
					st.add("ping", time.Since(t), err)
				}
			}()
			muted := false
			room := "main"
			for {
				switch x := rng.IntN(10); {
				case x < 4 && !*mediaMode: // 进出房间（媒体压测时大家留在主会议）
					next := roomIDs[rng.IntN(len(roomIDs))]
					if req(c, "join_room", &pb.Request{Body: &pb.Request_JoinRoom{JoinRoom: &pb.JoinRoom{RoomId: next}}}) == nil {
						room = next
					}
				case x < 7: // 改变自身状态（静音 / 取消静音）
					muted = !muted
					_ = req(c, "update_self", &pb.Request{Body: &pb.Request_UpdateSelf{UpdateSelf: &pb.UpdateSelf{MicMuted: &muted}}})
				default: // 聊天
					_ = req(c, "chat", &pb.Request{Body: &pb.Request_SendChat{SendChat: &pb.SendChat{RoomId: room, Text: fmt.Sprintf("hello %d", rng.IntN(1000))}}})
				}
				// 指数分布的间隔（平均 interval）
				if !sleep(time.Duration(rng.ExpFloat64() * float64(*interval))) {
					return
				}
			}
		}(i, c)
	}
	wg.Wait()
	ev := events.Load()
	fmt.Printf("\nmixed load %s: %d events delivered (%.0f/s), server CPU %.0f%% of one core, peak server RSS: %.1f MB\n",
		*duration, ev, float64(ev)/duration.Seconds(), (cpuSeconds(*pid)-cpu0)/duration.Seconds()*100, float64(peak.Load())/10)
	st.report("mixed load")
	if ml != nil {
		sec := time.Since(mediaStart).Seconds()
		recv := ml.received.Load() - mediaRecv0
		fmt.Printf("media total: delivery %.2f%% (%d packets received, %.0f expected), drops %d, reconnects %d\n",
			float64(recv)/(ml.expectedPerSecond()*sec)*100, recv, ml.expectedPerSecond()*sec, ml.drops.Load(), ml.reconn.Load())
		ml.close()
	}
	for _, c := range clients {
		if c != nil {
			_ = c.Close()
		}
	}
	time.Sleep(2 * time.Second)
	fmt.Printf("server RSS after disconnect: %.1f MB\n", rssMB(*pid))
}
