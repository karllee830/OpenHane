// Package hub 是控制面状态机：会话、房间、成员状态、聊天、权限和管理请求。
//
// 并发模型：所有状态只由 Hub 的一个协程串行修改，
// 各连接协程只负责收发。耗时操作（数据库写入、Argon2 哈希）放到独立协程执行，完成后把结果投递回 Hub。
package hub

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/karllee830/OpenHane/server/internal/geoip"
	"github.com/karllee830/OpenHane/server/internal/media"
	"github.com/karllee830/OpenHane/server/internal/pb"
	"github.com/karllee830/OpenHane/server/internal/perm"
	"github.com/karllee830/OpenHane/server/internal/settings"
	"github.com/karllee830/OpenHane/server/internal/store"
)

// MainRoomID 是常驻主会议的 ID。
const MainRoomID = "main"

const (
	// ResumeGrace 是控制连接断开后保留会话的时长。
	ResumeGrace = 60 * time.Second
	// ShareRepublishGrace 是屏幕共享轨道取消发布后保留共享许可的时长：共享中换编码器时客户端会取消发布再重新发布同一路画面。
	ShareRepublishGrace = 3 * time.Second
	// MediaTokenTTL 是媒体令牌有效期；连上媒体服务器后由 SFU 自动续期。
	MediaTokenTTL = 5 * time.Minute
	// chatMemoryKeep 是每个房间在内存中保留的最近聊天条数（不持久化时即为全部历史）。
	chatMemoryKeep = 200
)

// Conn 是一个已鉴权的控制连接（由 signal 包实现）。方法必须并发安全且不阻塞。
type Conn interface {
	// Send 把消息放入发送队列；队列满时连接自行以「慢消费者」断开。
	Send(env *pb.Envelope)
	// SendRaw 发送已经序列化好的 Envelope（广播时事件只序列化一次）。
	SendRaw(b []byte)
	// Close 发送 Goodbye 后关闭连接。
	Close(e *pb.Error, reconnect bool)
}

type Options struct {
	Store         *store.Store
	Media         media.Engine
	Settings      *settings.Settings
	ServerID      []byte
	Version       string
	ProtocolMin   uint32
	ProtocolMax   uint32
	Log           *slog.Logger
	HashPassword  func(string) (string, error) // 默认 settings.HashPassword
	Now           func() time.Time
	ResumeGrace   time.Duration // 测试时可缩短
	ShareGrace    time.Duration // 测试时可缩短（默认 ShareRepublishGrace）
	StoreClientIP func() bool
	GeoIP         *geoip.DB // nil 表示不查归属地
}

type Hub struct {
	opt   Options
	log   *slog.Logger
	store *store.Store
	media media.Engine
	now   func() time.Time

	cmds    chan func()
	stopped chan struct{}
	stopMu  sync.Once

	settings   atomic.Pointer[settings.Settings]
	settingsMu sync.Mutex // 串行化设置修改（计算 → 持久化 → 生效）
	// 在线会话数（含重连宽限期内的），供公开信息接口读取，不经过 Hub 协程
	online atomic.Int32

	// 以下只在 Hub 协程中访问
	sessions map[string]*Session // 会话 ID → 会话
	byTicket map[string]*Session // 恢复凭证 → 会话
	byMedia  map[string]*Session // 媒体 identity → 会话
	rooms    map[string]*Room
	chatSeq  int64
}

func New(opt Options) *Hub {
	if opt.HashPassword == nil {
		opt.HashPassword = settings.HashPassword
	}
	if opt.Now == nil {
		opt.Now = time.Now
	}
	if opt.ResumeGrace == 0 {
		opt.ResumeGrace = ResumeGrace
	}
	if opt.ShareGrace == 0 {
		opt.ShareGrace = ShareRepublishGrace
	}
	h := &Hub{
		opt:      opt,
		log:      opt.Log.With("component", "hub"),
		store:    opt.Store,
		media:    opt.Media,
		now:      opt.Now,
		cmds:     make(chan func(), 1024),
		stopped:  make(chan struct{}),
		sessions: map[string]*Session{},
		byTicket: map[string]*Session{},
		byMedia:  map[string]*Session{},
		rooms:    map[string]*Room{},
	}
	h.settings.Store(opt.Settings)
	h.rooms[MainRoomID] = &Room{ID: MainRoomID, Kind: pb.RoomKind_ROOM_KIND_MAIN, CreatedAt: h.now(), Overrides: &pb.RoomOverrides{}, decodable: baselineDecodable}
	return h
}

// Online 返回在线会话数（任意协程可调用）。
func (h *Hub) Online() int { return int(h.online.Load()) }

// Settings 返回当前设置快照（任意协程可调用）。
func (h *Hub) Settings() *settings.Settings { return h.settings.Load() }

func (h *Hub) ServerID() []byte { return h.opt.ServerID }

// ServerInfo 返回握手和事件中使用的服务器信息（任意协程可调用）。
func (h *Hub) ServerInfo() *pb.ServerInfo {
	s := h.Settings()
	return &pb.ServerInfo{
		Name:              s.ServerName,
		Version:           h.opt.Version,
		RequiresPassword:  s.ServerPassword != "",
		MinSecurityLevel:  uint32(s.MinSecurityLevel),
		WelcomeMessage:    s.WelcomeMessage,
		ProtocolMin:       h.opt.ProtocolMin,
		ProtocolMax:       h.opt.ProtocolMax,
		RoomCreateMinRole: roleProto(s.RoomsCreateMinRole),
	}
}

// Run 运行 Hub 协程，直到 ctx 取消。
func (h *Hub) Run(ctx context.Context) error {
	if id, err := h.store.MaxChatID(ctx); err == nil {
		h.chatSeq = id
	} else {
		return err
	}
	h.loadMainRoom(ctx)
	defer h.stopMu.Do(func() { close(h.stopped) })
	events := h.media.Events()
	for {
		select {
		case <-ctx.Done():
			return nil
		case f := <-h.cmds:
			f()
		case ev, ok := <-events:
			if !ok {
				events = nil
				continue
			}
			h.onMediaEvent(ev)
		}
	}
}

// do 把 f 投递到 Hub 协程执行。Hub 已停止时丢弃。
func (h *Hub) do(f func()) {
	select {
	case h.cmds <- f:
	case <-h.stopped:
	}
}

// call 在 Hub 协程中执行 f 并等待其完成。
func (h *Hub) call(ctx context.Context, f func()) error {
	done := make(chan struct{})
	h.do(func() { f(); close(done) })
	select {
	case <-done:
		return nil
	case <-h.stopped:
		return errors.New("hub stopped")
	case <-ctx.Done():
		return ctx.Err()
	}
}

// async 在独立协程中执行耗时操作；done 会被投递回 Hub 协程执行。
func (h *Hub) async(work func() func()) {
	go func() {
		done := work()
		if done != nil {
			h.do(done)
		}
	}()
}

// Shutdown 通知所有客户端服务器即将重启，并断开连接（客户端会自动重连）。
func (h *Hub) Shutdown(ctx context.Context) {
	h.call(ctx, func() {
		for _, s := range h.sessions {
			if s.conn == nil {
				continue
			}
			s.sendEvent(&pb.Event{Body: &pb.Event_ServerNotice{ServerNotice: &pb.ServerNotice{Kind: pb.ServerNotice_KIND_RESTARTING}}})
			s.conn.Close(&pb.Error{Code: pb.ErrorCode_ERROR_CODE_SERVER_SHUTTING_DOWN}, true)
		}
	})
}

// ---------- 广播 ----------

// broadcast 向所有在线会话（filter 为 nil 时）推送事件；body 对每个接收者共享。
func (h *Hub) broadcast(filter func(*Session) bool, ev *pb.Event) {
	// 事件内容只序列化一次（成员信息带公钥，逐个序列化在上千人时会占满 Hub），每个接收者只拼上自己的序号
	var enc *eventEncoder
	for _, s := range h.sessions {
		if s.conn == nil || (filter != nil && !filter(s)) {
			continue
		}
		if enc == nil {
			if enc = newEventEncoder(ev); enc == nil {
				return
			}
		}
		s.seq++
		s.conn.SendRaw(enc.envelope(s.seq))
	}
}

func (h *Hub) inRoom(room string) func(*Session) bool {
	return func(s *Session) bool { return s.RoomID == room }
}

func (h *Hub) except(id string) func(*Session) bool {
	return func(s *Session) bool { return s.ID != id }
}

func (h *Hub) participantUpdated(s *Session) {
	h.broadcast(nil, &pb.Event{Body: &pb.Event_ParticipantUpdated{ParticipantUpdated: &pb.ParticipantUpdated{Participant: s.proto()}}})
}

// snapshot 构造完整状态快照（seq 由调用方填写）。
func (h *Hub) snapshot() *pb.Snapshot {
	snap := &pb.Snapshot{Info: h.ServerInfo()}
	for _, r := range h.rooms {
		snap.Rooms = append(snap.Rooms, r.proto(h.Settings()))
	}
	for _, s := range h.sessions {
		snap.Participants = append(snap.Participants, s.proto())
	}
	return snap
}

// ---------- 审计 ----------

func (h *Hub) audit(actor, action, target string, detail any, ip string) {
	e := &store.AuditEntry{ActorUID: actor, Action: action, Target: target, Detail: detail, IP: ip}
	go func() {
		if err := h.store.InsertAudit(context.Background(), e); err != nil {
			h.log.Warn("audit write failed", "action", action, "err", err)
		}
	}()
}

func mediaMetadata(s *Session) string {
	b, _ := json.Marshal(map[string]string{
		"uid":      s.UID,
		"role":     s.Role.String(),
		"platform": strings.ToLower(strings.TrimPrefix(s.Client.GetPlatform().String(), "PLATFORM_")),
	})
	return string(b)
}

func roleProto(name string) pb.Role {
	r, err := perm.ParseRole(name)
	if err != nil {
		return pb.Role_ROLE_MODERATOR
	}
	return r.Proto()
}
