// Package ratelimit 提供按键（IP、会话）的限流工具。
package ratelimit

import (
	"sync"
	"time"
)

// Window 是滑动窗口计数器：每个键在 per 时间内最多 limit 次。并发安全。
type Window struct {
	mu    sync.Mutex
	limit int
	per   time.Duration
	hits  map[string][]time.Time
	now   func() time.Time
	ops   int
}

func NewWindow(limit int, per time.Duration) *Window {
	return &Window{limit: limit, per: per, hits: map[string][]time.Time{}, now: time.Now}
}

func (w *Window) prune(key string, now time.Time) []time.Time {
	h := w.hits[key]
	i := 0
	for i < len(h) && now.Sub(h[i]) >= w.per {
		i++
	}
	h = h[i:]
	if len(h) == 0 {
		delete(w.hits, key)
	} else {
		w.hits[key] = h
	}
	return h
}

// gc 定期清理所有过期的键，避免大量一次性 IP 占用内存。
func (w *Window) gc(now time.Time) {
	w.ops++
	if w.ops%1024 != 0 {
		return
	}
	for k := range w.hits {
		w.prune(k, now)
	}
}

// Allow 计一次并返回是否未超限（超限的那次也会被记录，持续请求会一直被拒绝）。
func (w *Window) Allow(key string) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	now := w.now()
	w.gc(now)
	h := w.prune(key, now)
	w.hits[key] = append(h, now)
	return len(h) < w.limit
}

// Exceeded 返回该键是否已达到上限（不计数）。
func (w *Window) Exceeded(key string) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	return len(w.prune(key, w.now())) >= w.limit
}

// Add 只计数（用于记录失败次数）。
func (w *Window) Add(key string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	now := w.now()
	w.gc(now)
	w.hits[key] = append(w.prune(key, now), now)
}

// Blocker 在 window 内失败达到上限后封锁该键 blockFor 时间（只在内存中）。
type Blocker struct {
	failures *Window
	blockFor time.Duration
	mu       sync.Mutex
	until    map[string]time.Time
	now      func() time.Time
}

func NewBlocker(maxFailures int, window, blockFor time.Duration) *Blocker {
	return &Blocker{failures: NewWindow(maxFailures, window), blockFor: blockFor, until: map[string]time.Time{}, now: time.Now}
}

// Blocked 返回剩余封锁时间；0 表示未被封锁。
func (b *Blocker) Blocked(key string) time.Duration {
	b.mu.Lock()
	defer b.mu.Unlock()
	u, ok := b.until[key]
	if !ok {
		return 0
	}
	if d := u.Sub(b.now()); d > 0 {
		return d
	}
	delete(b.until, key)
	return 0
}

// Fail 记录一次失败，达到上限时开始封锁。
func (b *Blocker) Fail(key string) {
	b.failures.Add(key)
	if b.failures.Exceeded(key) {
		b.mu.Lock()
		b.until[key] = b.now().Add(b.blockFor)
		b.mu.Unlock()
	}
}

// Bucket 是单协程使用的令牌桶（非并发安全，供 Hub 内部按会话限流）。
type Bucket struct {
	Rate   float64 // 每秒补充的令牌数
	Burst  float64
	tokens float64
	last   time.Time
}

func (b *Bucket) Allow(now time.Time) bool {
	if b.last.IsZero() {
		b.tokens, b.last = b.Burst, now
	}
	b.tokens = min(b.Burst, b.tokens+now.Sub(b.last).Seconds()*b.Rate)
	b.last = now
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}
