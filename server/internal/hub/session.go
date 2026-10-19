package hub

import (
	"net/netip"
	"strings"
	"time"

	"google.golang.org/protobuf/proto"

	"github.com/karllee830/OpenHane/server/internal/pb"
	"github.com/karllee830/OpenHane/server/internal/perm"
	"github.com/karllee830/OpenHane/server/internal/ratelimit"
	"github.com/karllee830/OpenHane/server/internal/settings"
)

// Session 是一个在线会话。字段只在 Hub 协程中访问。
type Session struct {
	ID         string
	UID        string
	PublicKey  []byte
	Nickname   string
	Role       perm.Role
	Client     *pb.ClientInfo
	Caps       *pb.Capabilities
	E2EEKey    *pb.SignedPublicKey
	RoomID     string
	State      pb.SelfState
	ForceMuted bool
	// 强制静音所属的房间：空表示服务器级（随会话保留），否则是房间级（全员静音），离开该房间后解除
	forceMutedRoom string
	MediaID        string
	ShareMediaID   string // 共享连接的 identity（<MediaID>#s，在 <房间 ID>~share 里）
	MediaOnline    bool
	CameraOn       bool
	ShareGrant     string // 当前持有的屏幕共享许可（空表示没有）
	screenTracks   int    // SFU 上正在发布的屏幕共享视频轨道数（换编码器时会短暂为 0 或 2）
	shareOnline    bool   // 共享连接已连上 SFU
	RemoteIP       netip.Addr
	ConnectedAt    time.Time

	conn   Conn        // nil 表示处于断线宽限期
	ticket string      // 恢复凭证
	apiKey string      // HTTP 接口（聊天图片）的凭据，会话存续期间不变
	grace  *time.Timer // 宽限期计时器
	seq    uint64      // 已发送的最后一个事件序号

	chatLimit   ratelimit.Bucket
	updateLimit ratelimit.Bucket
	adminLimit  ratelimit.Bucket
	keyLimit    ratelimit.Bucket
	imageLimit  ratelimit.Bucket
	// 进出房间、申请 / 释放共享、读聊天历史、兑换令牌：每次都可能触发全服广播、SFU 操作或数据库查询
	actionLimit ratelimit.Bucket
}

func newLimits(s *Session) {
	s.chatLimit = ratelimit.Bucket{Rate: 1, Burst: 5}     // 每 5 秒 5 条
	s.updateLimit = ratelimit.Bucket{Rate: 10, Burst: 10} // 每秒 10 次
	s.adminLimit = ratelimit.Bucket{Rate: 5, Burst: 10}   // 每秒 5 次，允许管理面板打开时的突发
	s.keyLimit = ratelimit.Bucket{Rate: 50, Burst: 200}   // E2EE 密钥包：进入大房间时要给每个成员各发一个
	s.actionLimit = ratelimit.Bucket{Rate: 2, Burst: 6}   // 人手操作远到不了；防止恶意客户端高频进出房间刷广播
	s.imageLimit = ratelimit.Bucket{Rate: 0.2, Burst: 5}  // 上传图片：连发 5 张，之后每 5 秒 1 张
}

func (s *Session) proto() *pb.Participant {
	st := proto.Clone(&s.State).(*pb.SelfState)
	hw, sw := s.videoDecode()
	return &pb.Participant{
		SessionId:          s.ID,
		Uid:                s.UID,
		Nickname:           s.Nickname,
		Role:               s.Role.Proto(),
		RoomId:             s.RoomID,
		State:              st,
		Platform:           s.Client.GetPlatform(),
		ForceMuted:         s.ForceMuted,
		Reconnecting:       s.conn == nil,
		MediaConnected:     s.MediaOnline,
		MediaIdentity:      s.MediaID,
		CameraOn:           s.CameraOn,
		ScreenSharing:      s.ShareGrant != "",
		PublicKey:          s.PublicKey,
		E2EeKey:            s.E2EEKey,
		SupportsE2Ee:       s.Caps.GetE2Ee() && s.E2EEKey != nil,
		DecodeHardware:     hw,
		MediaShareIdentity: s.ShareMediaID,
		DecodeSoftware:     sw,
	}
}

// videoDecode 把客户端上报的视频解码能力分成硬件 / 软件两组（mime 小写）；没有上报硬件信息的旧版本客户端两组都为空。
func (s *Session) videoDecode() (hw, sw []string) {
	if !s.Caps.GetHardwareReported() {
		return nil, nil
	}
	for _, c := range s.Caps.GetCodecs() {
		mime := strings.ToLower(c.GetMime())
		if !c.GetDecode() || !strings.HasPrefix(mime, "video/") {
			continue
		}
		if c.GetHardware() {
			hw = append(hw, mime)
		} else {
			sw = append(sw, mime)
		}
	}
	return hw, sw
}

// sendEvent 给事件编上本会话的序号后发送。ev 的 body 可以在多个接收者之间共享（发送时立即序列化）。
func (s *Session) sendEvent(ev *pb.Event) {
	if s.conn == nil {
		return
	}
	s.seq++
	s.conn.Send(&pb.Envelope{Msg: &pb.Envelope_Event{Event: &pb.Event{Seq: s.seq, Body: ev.Body}}})
}

// Room 是一个房间：常驻的主会议，或临时房间。
type Room struct {
	ID        string
	Kind      pb.RoomKind
	Name      string
	CreatedBy string
	CreatedAt time.Time
	Locked    bool
	Capacity  int
	Overrides *pb.RoomOverrides // 不为 nil
	// 临时房间的密码：HMAC-SHA256(passKey, 密码)。只在内存中，房间关闭即丢弃
	passHash []byte
	passKey  []byte
	// 临时房间空置多久后关闭；emptyTimer 在最后一人离开时启动
	EmptyTimeout time.Duration
	emptyTimer   *time.Timer

	chat      []*pb.ChatMessage // 最近的聊天（内存）
	shares    []*share          // 正在进行的屏幕共享
	decodable []string          // 上次推送的可解码编码器集合
}

func (r *Room) temporary() bool { return r.Kind == pb.RoomKind_ROOM_KIND_TEMPORARY }

// e2ee 返回房间实际是否开启端到端加密：服务器策略「强制」时总是开启，「可选」时由房间覆盖决定。
func (r *Room) e2ee(s *settings.Settings) bool {
	switch s.SecurityE2EEPolicy {
	case "required":
		return true
	case "optional":
		return r.Overrides.GetE2Ee()
	}
	return false
}

func (r *Room) proto(s *settings.Settings) *pb.Room {
	name := r.Name
	if r.Kind == pb.RoomKind_ROOM_KIND_MAIN {
		name = s.RoomsMainName
	}
	return &pb.Room{
		Id:              r.ID,
		Kind:            r.Kind,
		Name:            name,
		HasPassword:     r.passHash != nil,
		Locked:          r.Locked,
		Capacity:        uint32(r.Capacity),
		CreatedBy:       r.CreatedBy,
		CreatedAtMs:     r.CreatedAt.UnixMilli(),
		Shares:          shares(r.shares),
		Overrides:       r.Overrides,
		E2Ee:            r.e2ee(s),
		EmptyTimeoutSec: uint32(r.EmptyTimeout / time.Second),
	}
}

func shares(list []*share) []*pb.ShareInfo {
	out := make([]*pb.ShareInfo, 0, len(list))
	for _, sh := range list {
		out = append(out, sh.proto())
	}
	return out
}

// remember 把消息放进内存里的最近聊天，返回被挤出去的消息
func (r *Room) remember(m *pb.ChatMessage) []*pb.ChatMessage {
	r.chat = append(r.chat, m)
	if len(r.chat) <= chatMemoryKeep {
		return nil
	}
	cut := len(r.chat) - chatMemoryKeep
	dropped := append([]*pb.ChatMessage(nil), r.chat[:cut]...)
	r.chat = append(r.chat[:0:0], r.chat[cut:]...)
	return dropped
}
