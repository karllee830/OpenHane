package media

import (
	"context"
	"fmt"
	"net/http"
	"sync"
	"time"
)

// Fake 是测试用的内存实现：记录调用，令牌为可读的明文。
type Fake struct {
	mu      sync.Mutex
	Rooms   map[string]bool
	Perms   map[string]Permission // room/identity → 权限
	Removed []string              // room/identity
	Tokens  []TokenParams
	noTCP   bool
	events  chan Event
}

func NewFake() *Fake {
	return &Fake{Rooms: map[string]bool{}, Perms: map[string]Permission{}, events: make(chan Event, 64)}
}

func (f *Fake) Start(context.Context) error { return nil }
func (f *Fake) Stop(context.Context) error  { close(f.events); return nil }

func (f *Fake) EnsureRoom(_ context.Context, room string, _ RoomOptions) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.Rooms[room] = true
	return nil
}

func (f *Fake) DeleteRoom(_ context.Context, room string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.Rooms, room)
	return nil
}

func (f *Fake) IssueToken(p TokenParams) (string, time.Time, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.Tokens = append(f.Tokens, p)
	f.Perms[p.Room+"/"+p.Identity] = p.Perm
	return fmt.Sprintf("fake:%s:%s", p.Room, p.Identity), time.Now().Add(p.TTL), nil
}

func (f *Fake) UpdatePermission(_ context.Context, room, identity string, perm Permission) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.Perms[room+"/"+identity] = perm
	return nil
}

func (f *Fake) MuteTrack(context.Context, string, string, string, bool) error { return nil }

func (f *Fake) RemoveParticipant(_ context.Context, room, identity string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.Removed = append(f.Removed, room+"/"+identity)
	return nil
}

func (f *Fake) Events() <-chan Event { return f.events }

// TCPAvailable 默认开放 ICE-TCP（测试共享连接的 TCP 优先）；SetTCPAvailable(false) 后关闭。
func (f *Fake) TCPAvailable() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return !f.noTCP
}

// SetTCPAvailable 模拟服务器开放 / 关闭 ICE-TCP 端口（Hub 在自己的协程里读取，要加锁）。
func (f *Fake) SetTCPAvailable(ok bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.noTCP = !ok
}

// LastToken 返回最近一次签发令牌的参数。
func (f *Fake) LastToken() TokenParams {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.Tokens[len(f.Tokens)-1]
}

// Emit 模拟一个 SFU 事件。
func (f *Fake) Emit(e Event) { f.events <- e }

func (f *Fake) Stats(context.Context) (Stats, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return Stats{Rooms: len(f.Rooms)}, nil
}

func (f *Fake) RTCHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { http.Error(w, "fake", http.StatusNotImplemented) })
}

func (f *Fake) Ready(context.Context) error { return nil }

// Perm 返回记录的权限（测试断言用）。
func (f *Fake) Perm(room, identity string) (Permission, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	p, ok := f.Perms[room+"/"+identity]
	return p, ok
}

// RemovedList 返回被移除的参与者（room/identity，测试断言用）。
func (f *Fake) RemovedList() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.Removed...)
}

// HasRoom 报告 SFU 房间是否存在（测试断言用）。
func (f *Fake) HasRoom(room string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.Rooms[room]
}
