package hub

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"net/netip"
	"strings"
	"time"

	"github.com/karllee830/OpenHane/server/internal/auth"
	"github.com/karllee830/OpenHane/server/internal/identity"
	"github.com/karllee830/OpenHane/server/internal/media"
	"github.com/karllee830/OpenHane/server/internal/pb"
	"github.com/karllee830/OpenHane/server/internal/perm"
)

// JoinParams 是握手校验通过后交给 Hub 的信息。
type JoinParams struct {
	UID          string
	PublicKey    []byte
	Nickname     string // 已规范化
	Role         perm.Role
	Client       *pb.ClientInfo
	Caps         *pb.Capabilities
	E2EEKey      *pb.SignedPublicKey
	RemoteIP     netip.Addr
	ResumeTicket []byte
	Conn         Conn
}

func pbErr(code pb.ErrorCode, msg string) *pb.Error { return &pb.Error{Code: code, Message: msg} }

// Join 创建会话（或恢复断线宽限期内的会话），并由 Hub 协程直接向连接发送 Welcome，
// 保证 Welcome 先于任何事件到达。返回的错误应以 Goodbye 发给客户端。
func (h *Hub) Join(ctx context.Context, p JoinParams) (*Session, *pb.Error) {
	var (
		sess *Session
		perr *pb.Error
	)
	if err := h.call(ctx, func() { sess, perr = h.join(p) }); err != nil {
		return nil, pbErr(pb.ErrorCode_ERROR_CODE_INTERNAL, err.Error())
	}
	return sess, perr
}

func (h *Hub) join(p JoinParams) (*Session, *pb.Error) {
	if len(p.ResumeTicket) > 0 {
		if s := h.byTicket[string(p.ResumeTicket)]; s != nil && s.UID == p.UID {
			h.resume(s, p)
			return s, nil
		}
		// 凭证过期或无效：作为新会话加入
	}

	st := h.Settings()
	if p.Role < perm.Admin && len(h.sessions) >= st.MaxClients {
		return nil, pbErr(pb.ErrorCode_ERROR_CODE_SERVER_FULL, "server is full")
	}
	if main := h.rooms[MainRoomID]; p.Role < perm.Moderator && main.Capacity > 0 && h.members(MainRoomID) >= main.Capacity {
		return nil, pbErr(pb.ErrorCode_ERROR_CODE_ROOM_FULL, "the main room is full")
	}
	if h.rooms[MainRoomID].e2ee(st) && !(p.Caps.GetE2Ee() && p.E2EEKey != nil) {
		return nil, pbErr(pb.ErrorCode_ERROR_CODE_E2EE_UNSUPPORTED, "this server requires end-to-end encryption")
	}

	id := auth.RandomID(10)
	s := &Session{
		ID:          id,
		UID:         p.UID,
		PublicKey:   p.PublicKey,
		Nickname:    h.uniqueNickname(p.Nickname, ""),
		Role:        p.Role,
		Client:      p.Client,
		Caps:        p.Caps,
		E2EEKey:     p.E2EEKey,
		RoomID:      MainRoomID,
		MediaID:     p.UID + ":" + id,
		RemoteIP:    p.RemoteIP,
		ConnectedAt: h.now(),
		conn:        p.Conn,
		ticket:      newTicket(),
	}
	newLimits(s)
	if st.JoinForceMute {
		s.State.MicMuted = true
	}
	h.sessions[s.ID] = s
	h.online.Store(int32(len(h.sessions)))
	h.byTicket[s.ticket] = s
	h.byMedia[s.MediaID] = s
	s.ShareMediaID = s.MediaID + "#s"
	h.byMedia[s.ShareMediaID] = s

	h.broadcast(h.except(s.ID), &pb.Event{Body: &pb.Event_ParticipantJoined{ParticipantJoined: &pb.ParticipantJoined{Participant: s.proto()}}})
	h.sendWelcome(s, false)      // Welcome 必须是新连接上的第一条消息
	h.refreshDecodable(s.RoomID) // 新成员的解码能力可能缩小房间的可解码集合
	h.log.Info("session joined", "session", s.ID, "uid", s.UID, "nickname", s.Nickname, "role", s.Role,
		"platform", s.Client.GetPlatform(), "ip", s.RemoteIP)
	return s, nil
}

func (h *Hub) resume(s *Session, p JoinParams) {
	if s.conn != nil {
		// 旧连接可能是半开状态：以新连接为准
		s.conn.Close(pbErr(pb.ErrorCode_ERROR_CODE_SESSION_REPLACED, "session resumed on another connection"), false)
	}
	if s.grace != nil {
		s.grace.Stop()
		s.grace = nil
	}
	s.conn = p.Conn
	s.RemoteIP = p.RemoteIP
	s.Client, s.Caps = p.Client, p.Caps
	if p.E2EEKey != nil {
		s.E2EEKey = p.E2EEKey
	}
	// 每次恢复都换新凭证，旧凭证作废
	delete(h.byTicket, s.ticket)
	s.ticket = newTicket()
	h.byTicket[s.ticket] = s

	// 先发 Welcome（必须是新连接上的第一条消息），再通知其他人 reconnecting → false
	h.sendWelcome(s, true)
	h.broadcast(h.except(s.ID), &pb.Event{Body: &pb.Event_ParticipantUpdated{ParticipantUpdated: &pb.ParticipantUpdated{Participant: s.proto()}}})
	h.log.Info("session resumed", "session", s.ID, "uid", s.UID)
}

// sendWelcome 发送 Welcome：完整快照 + 当前房间的媒体令牌。
// 恢复会话时同样下发完整快照（客户端只需一套状态重建逻辑，错过的聊天用 GetChatHistory 补齐）。
func (h *Hub) sendWelcome(s *Session, resumed bool) {
	snap := h.snapshot()
	snap.EventSeq = s.seq
	w := &pb.Welcome{
		SessionId:    s.ID,
		Uid:          s.UID,
		Nickname:     s.Nickname,
		Role:         s.Role.Proto(),
		ResumeTicket: []byte(s.ticket),
		Resumed:      resumed,
		Snapshot:     snap,
		AutoJoin:     h.joinResult(s),
	}
	s.conn.Send(&pb.Envelope{Msg: &pb.Envelope_Welcome{Welcome: w}})
}

// joinResult 为会话当前房间签发媒体令牌。SFU 房间只是控制面房间的缓存，
// LiveKit 会在房间空置后自行关闭，所以每次签发前都确保房间存在（幂等）。
func (h *Hub) joinResult(s *Session) *pb.JoinRoomResult {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	res := &pb.JoinRoomResult{RoomId: s.RoomID, Policy: h.policyFor(s)}
	if err := h.media.EnsureRoom(ctx, s.RoomID, media.RoomOptions{}); err != nil {
		h.log.Error("ensure media room failed", "room", s.RoomID, "err", err)
		return res // 没有 media：客户端稍后用 JoinRoom 重试
	}
	tok, exp, err := h.media.IssueToken(media.TokenParams{
		Room:     s.RoomID,
		Identity: s.MediaID,
		Name:     s.Nickname,
		Metadata: mediaMetadata(s),
		Perm:     h.mediaPermission(s),
		TTL:      MediaTokenTTL,
	})
	if err != nil {
		h.log.Error("issue media token failed", "err", err)
		return res
	}
	res.Media = &pb.MediaGrant{Token: tok, ExpiresAtMs: exp.UnixMilli()}
	return res
}

// mediaPermission 计算主连接在 SFU 中可以发布的来源：麦克风、摄像头。屏幕共享在共享连接上（sharePermission）。
func (h *Hub) mediaPermission(s *Session) media.Permission {
	p := media.Permission{CanSubscribe: true}
	if !s.ForceMuted {
		p.Sources = append(p.Sources, media.SourceMicrophone)
	}
	if h.policyFor(s).GetCamera().GetAllowed() {
		p.Sources = append(p.Sources, media.SourceCamera)
	}
	return p // 屏幕共享在共享连接上（sharePermission）
}

// sharePermission 计算共享连接的权限：可以订阅；获得共享许可后可以发布屏幕（和共享声音）。
func (h *Hub) sharePermission(s *Session) media.Permission {
	return media.Permission{CanSubscribe: true, Sources: h.screenSources(s)}
}

func (h *Hub) screenSources(s *Session) []media.Source {
	if s.ShareGrant == "" {
		return nil
	}
	src := []media.Source{media.SourceScreenShare}
	if room := h.rooms[s.RoomID]; room != nil {
		if sh := room.shareOf(s.ID); sh != nil && sh.WithAudio {
			src = append(src, media.SourceScreenShareAudio)
		}
	}
	return src
}

// Disconnected 由连接协程在控制连接断开时调用：会话进入宽限期，期间可凭凭证恢复。
func (h *Hub) Disconnected(s *Session, c Conn) {
	h.do(func() {
		if s.conn != c || h.sessions[s.ID] != s {
			return // 已被新连接接管或已移除
		}
		s.conn = nil
		h.participantUpdated(s) // reconnecting → true
		s.grace = time.AfterFunc(h.opt.ResumeGrace, func() {
			h.do(func() {
				if s.conn == nil && h.sessions[s.ID] == s {
					h.removeSession(s, "resume grace expired")
				}
			})
		})
	})
}

// Left 由连接协程在客户端主动离开（正常关闭连接）时调用：立即移除会话。
func (h *Hub) Left(s *Session, c Conn) {
	h.do(func() {
		if s.conn != c || h.sessions[s.ID] != s {
			return
		}
		s.conn = nil
		h.removeSession(s, "left")
	})
}

// removeSession 销毁会话，通知其他人，并把它从 SFU 中移除。
func (h *Hub) removeSession(s *Session, reason string) {
	if s.grace != nil {
		s.grace.Stop()
	}
	h.releaseShare(s, false)
	delete(h.sessions, s.ID)
	h.online.Store(int32(len(h.sessions)))
	delete(h.byTicket, s.ticket)
	delete(h.byMedia, s.MediaID)
	delete(h.byMedia, s.ShareMediaID)
	h.broadcast(nil, &pb.Event{Body: &pb.Event_ParticipantLeft{ParticipantLeft: &pb.ParticipantLeft{SessionId: s.ID}}})
	h.refreshDecodable(s.RoomID)
	h.roomOccupancyChanged(s.RoomID)
	h.log.Info("session left", "session", s.ID, "uid", s.UID, "reason", reason)
	if s.MediaOnline {
		room, id := s.RoomID, s.MediaID
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			h.media.RemoveParticipant(ctx, room, id)
		}()
	}
	if s.shareOnline {
		room, id := shareRoom(s.RoomID), s.ShareMediaID
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			h.media.RemoveParticipant(ctx, room, id)
		}()
	}
}

func (h *Hub) uniqueNickname(name, selfID string) string {
	return identity.Uniquify(name, func(c string) bool {
		for _, o := range h.sessions {
			if o.ID != selfID && strings.EqualFold(o.Nickname, c) {
				return true
			}
		}
		return false
	})
}

func newTicket() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(fmt.Sprintf("crypto/rand: %v", err))
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

// ---------- 媒体事件 ----------

func (h *Hub) onMediaEvent(ev media.Event) {
	s := h.byMedia[ev.Identity]
	// 共享连接在单独的 SFU 房间（<房间 ID>~share）里
	share := s != nil && ev.Identity == s.ShareMediaID
	expectRoom := ""
	if s != nil {
		expectRoom = s.RoomID
		if share {
			expectRoom = shareRoom(s.RoomID)
		}
	}
	// 只有当前在这个房间的合法会话才能连在 SFU 上。LiveKit 只在加入时校验令牌、连上后不再检查，所以被踢出 / 封禁 /
	// 已离开的人用还没过期的旧媒体令牌重新连接，或者被移出私密房间后用旧令牌连回去，都要立即移除，否则可以一直旁听。
	if ev.Kind == media.ParticipantJoined && (s == nil || (ev.Room != "" && ev.Room != expectRoom)) {
		h.log.Warn("removing media participant without a matching session", "room", ev.Room, "identity", ev.Identity)
		room, id := ev.Room, ev.Identity
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			h.media.RemoveParticipant(ctx, room, id)
		}()
		return
	}
	if s != nil && ev.Room != "" && ev.Room != expectRoom {
		// 切换房间后，旧房间的连接稍后才断开：它的事件不影响当前状态
		return
	}
	if share {
		switch ev.Kind {
		case media.ParticipantJoined:
			s.shareOnline = true
		case media.ParticipantLeft:
			s.shareOnline = false
		case media.TrackPublished:
			if !h.sourceAllowed(s, ev.Identity, ev.Source) {
				h.log.Warn("unpublishing track from disallowed source", "session", s.ID, "source", ev.Source)
				go h.media.MuteTrack(context.Background(), ev.Room, ev.Identity, ev.TrackSID, true)
				return
			}
			h.onTrackEvent(s, ev)
		case media.TrackUnpublished:
			h.onTrackEvent(s, ev)
		}
		return
	}
	switch ev.Kind {
	case media.ParticipantJoined:
		if s != nil && !s.MediaOnline {
			s.MediaOnline = true
			h.participantUpdated(s)
		}
	case media.ParticipantLeft:
		if s != nil && s.MediaOnline {
			s.MediaOnline = false
			s.CameraOn = false
			s.screenTracks = 0
			h.participantUpdated(s)
		}
	case media.TrackPublished:
		// 防御：SFU 权限已经限制了来源，这里再核对一次（例如权限更新尚未生效时发布的轨道）
		if s != nil && !h.sourceAllowed(s, ev.Identity, ev.Source) {
			h.log.Warn("unpublishing track from disallowed source", "session", s.ID, "source", ev.Source)
			go h.media.MuteTrack(context.Background(), ev.Room, ev.Identity, ev.TrackSID, true)
			return
		}
		if s != nil {
			h.onTrackEvent(s, ev)
		}
	case media.TrackUnpublished:
		if s != nil {
			h.onTrackEvent(s, ev)
		}
	}
}

func (h *Hub) sourceAllowed(s *Session, identity string, src media.Source) bool {
	p := h.mediaPermission(s)
	if identity == s.ShareMediaID {
		p = h.sharePermission(s)
	}
	for _, a := range p.Sources {
		if a == src {
			return true
		}
	}
	return false
}
