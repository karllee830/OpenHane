package netem

import (
	"math"
	"net"
	"sync"
	"testing"
	"time"
)

// collector 记录损伤器交出的包和时刻
type collector struct {
	mu    sync.Mutex
	at    []time.Time
	seq   []int
	bytes int
}

func (c *collector) send(b []byte, _ net.Addr) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.at = append(c.at, time.Now())
	c.seq = append(c.seq, int(b[0])<<8|int(b[1]))
	c.bytes += len(b)
}

func pkt(i, size int) []byte {
	b := make([]byte, size)
	b[0], b[1] = byte(i>>8), byte(i)
	return b
}

func TestRandomLoss(t *testing.T) {
	c := &collector{}
	d := newDirection(1, c.send)
	d.setProfile(Profile{LossPct: 10})
	for i := range 20000 {
		d.enqueue(pkt(i, 10), nil)
	}
	time.Sleep(50 * time.Millisecond)
	loss := float64(d.stats.Dropped) / 20000 * 100
	if math.Abs(loss-10) > 1 {
		t.Fatalf("loss %.2f%%, want ≈ 10%%", loss)
	}
}

func TestBurstLoss(t *testing.T) {
	c := &collector{}
	d := newDirection(2, c.send)
	d.setProfile(Profile{BurstLossPct: 20, BurstLen: 4})
	const n = 50000
	lost := make([]bool, n)
	for i := range n {
		before := d.stats.Dropped
		d.enqueue(pkt(i, 10), nil)
		lost[i] = d.stats.Dropped > before
	}
	drops, bursts := 0, 0
	for i, l := range lost {
		if l {
			drops++
			if i == 0 || !lost[i-1] {
				bursts++
			}
		}
	}
	loss := float64(drops) / n * 100
	meanBurst := float64(drops) / float64(bursts)
	if math.Abs(loss-20) > 2 || math.Abs(meanBurst-4) > 0.6 {
		t.Fatalf("loss %.1f%% (want 20), mean burst %.2f (want 4)", loss, meanBurst)
	}
}

func TestRateDelayAndOrder(t *testing.T) {
	c := &collector{}
	d := newDirection(3, c.send)
	// 400 kbps、单向 50 ms、抖动 10 ms：200 个 500 字节的包（800 kbit）约需 2 秒发完，且不乱序
	d.setProfile(Profile{RateKbps: 400, DelayMs: 50, JitterMs: 10, QueueMs: 5000})
	start := time.Now()
	for i := range 200 {
		d.enqueue(pkt(i, 500), nil)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		c.mu.Lock()
		n := len(c.at)
		c.mu.Unlock()
		if n == 200 || time.Now().After(deadline) {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.at) != 200 {
		t.Fatalf("delivered %d/200", len(c.at))
	}
	if first := c.at[0].Sub(start); first < 20*time.Millisecond || first > 120*time.Millisecond {
		t.Fatalf("first packet after %s, want ≈ 50 ms", first)
	}
	if total := c.at[199].Sub(start); total < 1900*time.Millisecond || total > 2300*time.Millisecond {
		t.Fatalf("200 packets took %s, want ≈ 2.05 s at 400 kbps", total)
	}
	for i, s := range c.seq {
		if s != i {
			t.Fatalf("reordered at %d: %v", i, c.seq[:i+1])
		}
	}
}

func TestQueueLimitDropsTail(t *testing.T) {
	c := &collector{}
	d := newDirection(4, c.send)
	// 100 kbps、排队上限 100 ms：瞬间塞进 100 个 1000 字节的包，只有约前 2 个能进队列（每个占 80 ms）
	d.setProfile(Profile{RateKbps: 100, QueueMs: 100})
	for i := range 100 {
		d.enqueue(pkt(i, 1000), nil)
	}
	if d.stats.Sent > 3 || d.stats.QueueDropped < 97 {
		t.Fatalf("stats %+v", d.stats)
	}
}
