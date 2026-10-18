// Package media 定义媒体引擎接口。控制面只通过这个接口操作 SFU，
// 实现是进程内嵌的 LiveKit（media/livekit）。
package media

import (
	"context"
	"net/http"
	"time"
)

// Source 是轨道来源，与 LiveKit 的 canPublishSources 取值一致。
type Source string

const (
	SourceMicrophone       Source = "microphone"
	SourceCamera           Source = "camera"
	SourceScreenShare      Source = "screen_share"
	SourceScreenShareAudio Source = "screen_share_audio"
)

// Permission 是参与者在 SFU 中的权限。
type Permission struct {
	CanSubscribe bool
	Sources      []Source // 允许发布的来源；为空表示不能发布
}

type RoomOptions struct {
	// EmptyTimeout：SFU 房间空置多久后自行关闭（控制面在每次签发令牌前都会确保房间存在）。
	EmptyTimeout time.Duration
}

type TokenParams struct {
	Room     string
	Identity string // <uid>:<会话短 ID>
	Name     string // 昵称
	Metadata string // JSON：{uid, role, platform}
	Perm     Permission
	TTL      time.Duration
	// TCPOnly：这个令牌的连接只走 ICE-TCP（信令转发时双向过滤掉 UDP 候选）；没有开放 ICE-TCP 端口时忽略
	TCPOnly bool
}

type EventKind int

const (
	ParticipantJoined EventKind = iota + 1
	ParticipantLeft
	TrackPublished
	TrackUnpublished
	RoomFinished
)

func (k EventKind) String() string {
	return [...]string{"", "participant_joined", "participant_left", "track_published", "track_unpublished", "room_finished"}[k]
}

// Event 是 SFU 回调给控制面的事件。
type Event struct {
	Kind     EventKind
	Room     string
	Identity string
	TrackSID string
	Source   Source
}

type Stats struct {
	Rooms        int
	Participants int
}

type Engine interface {
	Start(ctx context.Context) error
	Stop(ctx context.Context) error
	// EnsureRoom 创建房间；房间已存在时什么也不做（幂等）。
	EnsureRoom(ctx context.Context, room string, opts RoomOptions) error
	DeleteRoom(ctx context.Context, room string) error
	// IssueToken 签发短期媒体令牌（LiveKit JWT）。
	IssueToken(p TokenParams) (token string, expires time.Time, err error)
	UpdatePermission(ctx context.Context, room, identity string, perm Permission) error
	MuteTrack(ctx context.Context, room, identity, trackSID string, muted bool) error
	RemoveParticipant(ctx context.Context, room, identity string) error
	// Events 返回 SFU 事件；Stop 后关闭。
	Events() <-chan Event
	Stats(ctx context.Context) (Stats, error)
	// TCPAvailable 表示开放了 ICE-TCP 端口（媒体能走 TCP）。
	TCPAvailable() bool
	// RTCHandler 是对外的 /rtc 媒体信令入口（反向代理到 SFU）。
	RTCHandler() http.Handler
	// Ready 在 SFU 正常运行时返回 nil（/readyz）。
	Ready(ctx context.Context) error
}
