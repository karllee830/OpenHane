// Package netem 在用户态模拟弱网：包装 net.PacketConn，在发送方向注入限速、延迟、抖动和丢包。
// 用于测试用 TURN 中继（cmd/hanenetem），不需要 root 权限、也不改系统网络设置，macOS / Linux 通用。
package netem

import (
	"math"
	"math/rand/v2"
	"net"
	"sync"
	"time"
)

// Profile 是一个方向上的网络损伤。零值表示不做任何损伤。
type Profile struct {
	RateKbps int     // 带宽（0 = 不限）；超出带宽的包排队，排队超过 QueueMs 时丢弃（尾部丢弃）
	DelayMs  int     // 固定单向延迟
	JitterMs int     // 抖动（正态分布的标准差，截断在 ±3σ；不改变包的顺序）
	LossPct  float64 // 随机丢包率（%）
	// 突发丢包（Gilbert-Elliott 模型）：BurstLossPct 为平均丢包率，BurstLen 为平均连续丢包个数；设置后取代 LossPct
	BurstLossPct float64
	BurstLen     float64
	QueueMs      int // 排队上限（0 = 默认 300 ms）
}

// Stats 是一个方向的计数
type Stats struct {
	Sent, Dropped, QueueDropped int64
}

type packet struct {
	b    []byte
	addr net.Addr
	at   time.Time
}

// direction 是一个方向的损伤器：按计算出的发送时刻依次把包交给 send
type direction struct {
	mu       sync.Mutex
	p        Profile
	rng      *rand.Rand
	bad      bool      // Gilbert-Elliott 当前是否处于「坏」状态
	linkFree time.Time // 带宽模型：链路空闲的时刻
	lastAt   time.Time // 上一个包的发送时刻（保证不乱序）
	queue    chan packet
	stats    Stats
	send     func([]byte, net.Addr)
}

func newDirection(seed uint64, send func([]byte, net.Addr)) *direction {
	q := make(chan packet, 65536)
	d := &direction{rng: rand.New(rand.NewPCG(seed, seed^0x9e3779b97f4a7c15)), queue: q, send: send}
	go d.run(q)
	return d
}

func (d *direction) run(q <-chan packet) {
	for pk := range q {
		if w := time.Until(pk.at); w > 0 {
			time.Sleep(w)
		}
		d.send(pk.b, pk.addr)
	}
}

func (d *direction) setProfile(p Profile) {
	d.mu.Lock()
	d.p = p
	d.bad = false
	d.mu.Unlock()
}

// lost 按丢包模型决定这个包是否丢弃（调用方持有锁）
func (d *direction) lost() bool {
	p := d.p
	if p.BurstLossPct > 0 {
		// 两状态马尔可夫链：坏状态全丢、好状态不丢。平均丢包率 = p/(p+r)，平均突发长度 = 1/r
		burst := math.Max(p.BurstLen, 1)
		r := 1 / burst
		loss := p.BurstLossPct / 100
		pGB := loss * r / (1 - loss)
		if d.bad {
			if d.rng.Float64() < r {
				d.bad = false
			}
		} else if d.rng.Float64() < pGB {
			d.bad = true
		}
		return d.bad
	}
	return p.LossPct > 0 && d.rng.Float64()*100 < p.LossPct
}

func (d *direction) enqueue(b []byte, addr net.Addr) {
	d.mu.Lock()
	p := d.p
	if p == (Profile{}) {
		d.stats.Sent++
		d.mu.Unlock()
		d.send(b, addr)
		return
	}
	if d.lost() {
		d.stats.Dropped++
		d.mu.Unlock()
		return
	}
	now := time.Now()
	depart := now
	if p.RateKbps > 0 {
		// 链路串行发送：包在链路空闲后开始发送，占用 size*8/rate 的时间
		if d.linkFree.After(now) {
			depart = d.linkFree
		}
		queueMax := time.Duration(max(p.QueueMs, 0)) * time.Millisecond
		if queueMax == 0 {
			queueMax = 300 * time.Millisecond
		}
		if depart.Sub(now) > queueMax {
			d.stats.QueueDropped++
			d.mu.Unlock()
			return
		}
		depart = depart.Add(time.Duration(float64(len(b)*8) / float64(p.RateKbps) * float64(time.Millisecond)))
		d.linkFree = depart
	}
	at := depart.Add(time.Duration(p.DelayMs) * time.Millisecond)
	if p.JitterMs > 0 {
		j := math.Max(-3, math.Min(3, d.rng.NormFloat64())) * float64(p.JitterMs)
		at = at.Add(time.Duration(j * float64(time.Millisecond)))
	}
	if at.Before(d.lastAt) {
		at = d.lastAt // 不乱序
	}
	d.lastAt = at
	defer d.mu.Unlock()
	if d.queue == nil { // 已关闭
		return
	}
	buf := make([]byte, len(b))
	copy(buf, b)
	select {
	case d.queue <- packet{b: buf, addr: addr, at: at}:
		d.stats.Sent++
	default: // 队列溢出（极端情况）
		d.stats.QueueDropped++
	}
}

// Conn 包装 net.PacketConn：WriteTo 经过损伤器（发送方向）。
type Conn struct {
	net.PacketConn
	dir *direction
}

// Wrap 返回发送方向受 profile 控制的连接；profile 可以随时用 Set 修改。
func Wrap(pc net.PacketConn, seed uint64) *Conn {
	c := &Conn{PacketConn: pc}
	c.dir = newDirection(seed, func(b []byte, addr net.Addr) { _, _ = pc.WriteTo(b, addr) })
	return c
}

// WriteTo 把包交给损伤器，立即返回（与真实网络一样，发送方不知道包是否丢失）
func (c *Conn) WriteTo(b []byte, addr net.Addr) (int, error) {
	c.dir.enqueue(b, addr)
	return len(b), nil
}

// Set 修改损伤参数
func (c *Conn) Set(p Profile) { c.dir.setProfile(p) }

// Stats 返回计数
func (c *Conn) Stats() Stats {
	c.dir.mu.Lock()
	defer c.dir.mu.Unlock()
	return c.dir.stats
}

// Close 关闭底层连接并停止损伤器
func (c *Conn) Close() error {
	err := c.PacketConn.Close()
	c.dir.mu.Lock()
	defer c.dir.mu.Unlock()
	if c.dir.queue != nil {
		close(c.dir.queue)
		c.dir.queue = nil
	}
	return err
}
