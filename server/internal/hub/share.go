package hub

import (
	"context"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/karllee830/OpenHane/server/internal/auth"
	"github.com/karllee830/OpenHane/server/internal/media"
	"github.com/karllee830/OpenHane/server/internal/pb"
	"github.com/karllee830/OpenHane/server/internal/perm"
)

// 屏幕共享许可：获得许可后，SFU 才允许该参与者发布 screen_share 轨道。
// 许可数受 screen.max_concurrent 限制；角色受 screen.min_role 限制。权限在 SFU 上强制执行，客户端绕不过。

type share struct {
	GrantID   string
	SessionID string
	Intent    pb.ShareIntent
	WithAudio bool
	StartedAt int64
}

func (sh *share) proto() *pb.ShareInfo {
	return &pb.ShareInfo{GrantId: sh.GrantID, SessionId: sh.SessionID, Intent: sh.Intent, WithAudio: sh.WithAudio, StartedAtMs: sh.StartedAt}
}

func (r *Room) shareOf(sessionID string) *share {
	for _, sh := range r.shares {
		if sh.SessionID == sessionID {
			return sh
		}
	}
	return nil
}

func (h *Hub) handleRequestShare(s *Session, req *pb.RequestScreenShare) *pb.Response {
	st := h.Settings()
	room := h.rooms[s.RoomID]
	if room == nil {
		return errResp(pb.ErrorCode_ERROR_CODE_ROOM_NOT_FOUND, "room not found")
	}
	if !h.shareAllowed(s) {
		return errDenied()
	}
	intent := req.GetIntent()
	if intent == pb.ShareIntent_SHARE_INTENT_UNSPECIFIED {
		intent = pb.ShareIntent_SHARE_INTENT_SMART
	}
	withAudio := req.GetWithAudio() && st.ScreenAllowAudio
	sh := room.shareOf(s.ID)
	if sh == nil {
		if len(room.shares) >= st.ScreenMaxConcurrent {
			return errResp(pb.ErrorCode_ERROR_CODE_SHARE_LIMIT_REACHED, "too many concurrent shares in this room")
		}
		sh = &share{GrantID: "g_" + auth.RandomID(10), SessionID: s.ID, StartedAt: h.now().UnixMilli()}
		room.shares = append(room.shares, sh)
		s.ShareGrant = sh.GrantID
	}
	// 重复申请（例如更换意图或共享声音开关）沿用同一个许可
	sh.Intent, sh.WithAudio = intent, withAudio
	h.syncPermission(s)
	h.shareChanged(room)
	h.participantUpdated(s)
	pol := h.policyFor(s)
	return &pb.Response{Body: &pb.Response_RequestScreenShare{RequestScreenShare: &pb.ScreenShareGrant{
		GrantId: sh.GrantID, Limits: pol.GetScreen(), RoomDecodable: pol.GetCodecs().GetRoomDecodable(),
		CodecMode: pol.GetCodecs().GetMode(), WithAudio: withAudio, E2Ee: pol.GetE2Ee().GetRoomEnabled(),
	}}}
}

func (h *Hub) handleReleaseShare(s *Session, req *pb.ReleaseScreenShare) *pb.Response {
	if s.ShareGrant == "" || (req.GetGrantId() != "" && req.GetGrantId() != s.ShareGrant) {
		return &pb.Response{Body: &pb.Response_ReleaseScreenShare{ReleaseScreenShare: &pb.ReleaseScreenShareResult{}}}
	}
	h.releaseShare(s, true)
	return &pb.Response{Body: &pb.Response_ReleaseScreenShare{ReleaseScreenShare: &pb.ReleaseScreenShareResult{}}}
}

// releaseShare 收回会话的共享许可；syncSFU 为 true 时同时收回 SFU 发布权限（SFU 会取消发布不再允许的轨道）。
func (h *Hub) releaseShare(s *Session, syncSFU bool) {
	if s.ShareGrant == "" {
		return
	}
	s.ShareGrant = ""
	if room := h.rooms[s.RoomID]; room != nil {
		room.shares = slices.DeleteFunc(room.shares, func(sh *share) bool { return sh.SessionID == s.ID })
		h.shareChanged(room)
	}
	if syncSFU {
		h.syncPermission(s)
	}
	h.participantUpdated(s)
}

func (h *Hub) shareChanged(room *Room) {
	infos := make([]*pb.ShareInfo, 0, len(room.shares))
	for _, sh := range room.shares {
		infos = append(infos, sh.proto())
	}
	h.broadcast(h.inRoom(room.ID), &pb.Event{Body: &pb.Event_ShareStateChanged{ShareStateChanged: &pb.ShareStateChanged{RoomId: room.ID, Shares: infos}}})
}

// shareRoom 是房间的共享连接所在的 SFU 房间。
func shareRoom(roomID string) string { return roomID + "~share" }

// syncPermission 把会话当前的发布权限同步到 SFU（异步）：主连接和共享连接各一份。
func (h *Hub) syncPermission(s *Session) {
	type target struct {
		room, id string
		p        media.Permission
	}
	var ts []target
	if s.MediaOnline { // 还没连上 SFU：下次签发令牌时自然带上新权限
		ts = append(ts, target{s.RoomID, s.MediaID, h.mediaPermission(s)})
	}
	if s.shareOnline {
		ts = append(ts, target{shareRoom(s.RoomID), s.ShareMediaID, h.sharePermission(s)})
	}
	for _, t := range ts {
		go func() {
			ctx, cancel := bg()
			defer cancel()
			if err := h.media.UpdatePermission(ctx, t.room, t.id, t.p); err != nil {
				h.log.Warn("update media permission failed", "identity", t.id, "err", err)
			}
		}()
	}
}

// handleJoinShareMedia 为共享连接签发令牌：自己要共享、或者房间里有人在共享时，客户端连到 <房间 ID>~share。
// 获得共享许可之前只能订阅；获得许可后权限同步到 SFU，就可以发布屏幕。
// 传输方式：客户端没指定时按服务器设置 media.share_transport；TCP 优先时令牌标记为只走 TCP，
// 客户端连不上再请求 UDP。没有开放 ICE-TCP 端口时总是 UDP。
func (h *Hub) handleJoinShareMedia(s *Session, req *pb.JoinShareMedia) *pb.Response {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	room := shareRoom(s.RoomID)
	want := req.GetTransport()
	if want == pb.ShareTransport_SHARE_TRANSPORT_UNSPECIFIED {
		want = shareTransport(h.Settings().MediaShareTransport)
	}
	tcp := want == pb.ShareTransport_SHARE_TRANSPORT_TCP && h.media.TCPAvailable()
	if err := h.media.EnsureRoom(ctx, room, media.RoomOptions{}); err != nil {
		h.log.Error("ensure share media room failed", "room", room, "err", err)
		return errResp(pb.ErrorCode_ERROR_CODE_INTERNAL, "media unavailable")
	}
	tok, exp, err := h.media.IssueToken(media.TokenParams{
		Room:     room,
		Identity: s.ShareMediaID,
		Name:     s.Nickname,
		Metadata: mediaMetadata(s),
		Perm:     h.sharePermission(s),
		TTL:      MediaTokenTTL,
		TCPOnly:  tcp,
	})
	if err != nil {
		h.log.Error("issue share media token failed", "err", err)
		return errResp(pb.ErrorCode_ERROR_CODE_INTERNAL, "media unavailable")
	}
	return &pb.Response{Body: &pb.Response_JoinShareMedia{JoinShareMedia: &pb.MediaGrant{Token: tok, ExpiresAtMs: exp.UnixMilli(), Tcp: tcp}}}
}

// shareAllowed 判断会话现在能否共享屏幕：服务器开启了共享、角色达到 screen.min_role、房间没有限制为仅主持人。
func (h *Hub) shareAllowed(s *Session) bool {
	st := h.Settings()
	minRole, _ := perm.ParseRole(st.ScreenMinRole)
	return st.ScreenEnabled && s.Role >= minRole && h.policyFor(s).GetScreen().GetAllowed()
}

// revokeDisallowedShares 在设置或房间覆盖变化后收回不再允许的共享（关闭了屏幕共享、提高了最低角色、
// 房间改为仅主持人可共享、关闭了共享声音），并提示当事人。
func (h *Hub) revokeDisallowedShares() {
	st := h.Settings()
	for _, s := range h.sessions {
		if s.ShareGrant == "" {
			continue
		}
		if !h.shareAllowed(s) {
			h.releaseShare(s, true)
			h.notify(s, pb.ModerationAction_MODERATION_ACTION_STOP_SHARE, "", "")
			continue
		}
		if room := h.rooms[s.RoomID]; room != nil && !st.ScreenAllowAudio {
			if sh := room.shareOf(s.ID); sh != nil && sh.WithAudio {
				sh.WithAudio = false
				h.syncPermission(s)
				h.shareChanged(room)
			}
		}
	}
}

// 没有上报解码能力的客户端按「所有 WebRTC 端都能解码」的集合处理。
var baselineDecodable = []string{"video/h264", "video/vp8"}

// roomDecodable 计算房间内所有成员都能解码的视频编码器集合，排序后返回。
func (h *Hub) roomDecodable(roomID string) []string {
	var set map[string]bool
	for _, s := range h.sessions {
		if s.RoomID != roomID {
			continue
		}
		mine := map[string]bool{}
		for _, c := range s.Caps.GetCodecs() {
			mime := strings.ToLower(c.GetMime())
			if c.GetDecode() && strings.HasPrefix(mime, "video/") {
				mine[mime] = true
			}
		}
		if len(mine) == 0 {
			for _, m := range baselineDecodable {
				mine[m] = true
			}
		}
		if set == nil {
			set = mine
			continue
		}
		for m := range set {
			if !mine[m] {
				delete(set, m)
			}
		}
	}
	if set == nil {
		return append([]string(nil), baselineDecodable...)
	}
	out := make([]string, 0, len(set))
	for m := range set {
		out = append(out, m)
	}
	sort.Strings(out)
	return out
}

// refreshDecodable 在房间成员变化后重新计算可解码集合，变化时推送新的媒体策略（发送端据此选择编码器）。
func (h *Hub) refreshDecodable(roomID string) {
	room := h.rooms[roomID]
	if room == nil {
		return
	}
	d := h.roomDecodable(roomID)
	if slices.Equal(d, room.decodable) {
		return
	}
	room.decodable = d
	h.pushPolicy(roomID)
}

// onTrackEvent 根据 SFU 的轨道事件更新摄像头状态；共享者自己停止发布屏幕时（例如浏览器的「停止共享」）收回许可。
// 屏幕轨道取消发布后等 ShareGrace 再收回：共享中换编码器时客户端会取消发布、再用新编码器重新发布，期间许可不能丢。
func (h *Hub) onTrackEvent(s *Session, ev media.Event) {
	switch {
	case ev.Source == media.SourceCamera:
		on := ev.Kind == media.TrackPublished
		if s.CameraOn != on {
			s.CameraOn = on
			h.participantUpdated(s)
		}
	case ev.Source == media.SourceScreenShare && ev.Kind == media.TrackPublished:
		s.screenTracks++
	case ev.Source == media.SourceScreenShare && ev.Kind == media.TrackUnpublished:
		s.screenTracks = max(0, s.screenTracks-1)
		if s.screenTracks > 0 || s.ShareGrant == "" {
			return
		}
		grant := s.ShareGrant
		time.AfterFunc(h.opt.ShareGrace, func() {
			h.do(func() {
				if h.sessions[s.ID] == s && s.ShareGrant == grant && s.screenTracks == 0 {
					h.releaseShare(s, true)
				}
			})
		})
	}
}
