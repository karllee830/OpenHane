package hub

import (
	"context"
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/karllee830/OpenHane/server/internal/auth"
	"github.com/karllee830/OpenHane/server/internal/identity"
	"github.com/karllee830/OpenHane/server/internal/pb"
	"github.com/karllee830/OpenHane/server/internal/perm"
	"github.com/karllee830/OpenHane/server/internal/ratelimit"
	"github.com/karllee830/OpenHane/server/internal/store"
)

// RedeemFailures 限制单 IP 兑换权限令牌的失败次数（每小时 10 次）。
var RedeemFailures = ratelimit.NewWindow(10, time.Hour)

// HandleRequest 由连接协程调用；请求在 Hub 协程中处理，响应发回发起请求的连接。
func (h *Hub) HandleRequest(s *Session, c Conn, req *pb.Request) {
	h.do(func() {
		if s.conn != c || h.sessions[s.ID] != s {
			return // 连接已被替换或会话已移除
		}
		resp := h.dispatch(s, c, req)
		if resp != nil {
			resp.Id = req.GetId()
			c.Send(&pb.Envelope{Msg: &pb.Envelope_Response{Response: resp}})
		}
	})
}

// reply 用于异步处理完成后发送响应。
func reply(c Conn, id uint32, resp *pb.Response) {
	resp.Id = id
	c.Send(&pb.Envelope{Msg: &pb.Envelope_Response{Response: resp}})
}

func errResp(code pb.ErrorCode, msg string) *pb.Response {
	return &pb.Response{Error: pbErr(code, msg)}
}

var (
	errDenied  = func() *pb.Response { return errResp(pb.ErrorCode_ERROR_CODE_PERMISSION_DENIED, "permission denied") }
	errLimited = func() *pb.Response {
		r := errResp(pb.ErrorCode_ERROR_CODE_RATE_LIMITED, "too many requests")
		r.Error.RetryAfterMs = 1000
		return r
	}
	errInternal = func() *pb.Response { return errResp(pb.ErrorCode_ERROR_CODE_INTERNAL, "internal error") }
)

// dispatch 处理一个请求。返回 nil 表示稍后异步响应。
func (h *Hub) dispatch(s *Session, c Conn, req *pb.Request) *pb.Response {
	now := h.now()
	switch req.Body.(type) {
	case *pb.Request_JoinRoom, *pb.Request_GetChatHistory, *pb.Request_RedeemToken, *pb.Request_RequestScreenShare, *pb.Request_ReleaseScreenShare:
		if !s.actionLimit.Allow(now) {
			return errLimited()
		}
	}
	switch b := req.Body.(type) {
	case *pb.Request_JoinRoom:
		return h.handleJoinRoom(s, b.JoinRoom)
	case *pb.Request_UpdateSelf:
		if !s.updateLimit.Allow(now) {
			return errLimited()
		}
		return h.handleUpdateSelf(s, b.UpdateSelf)
	case *pb.Request_SendChat:
		if !s.chatLimit.Allow(now) {
			return errLimited()
		}
		return h.handleSendChat(s, b.SendChat)
	case *pb.Request_GetChatHistory:
		return h.handleChatHistory(s, c, req.GetId(), b.GetChatHistory)
	case *pb.Request_RedeemToken:
		return h.handleRedeem(s, c, req.GetId(), b.RedeemToken)
	case *pb.Request_RequestScreenShare:
		return h.handleRequestShare(s, b.RequestScreenShare)
	case *pb.Request_ReleaseScreenShare:
		return h.handleReleaseShare(s, b.ReleaseScreenShare)
	case *pb.Request_JoinShareMedia:
		return h.handleJoinShareMedia(s, b.JoinShareMedia)
	case *pb.Request_SendKeyPackage:
		if !s.keyLimit.Allow(now) {
			return errLimited()
		}
		return h.handleSendKeyPackage(s, b.SendKeyPackage)
	}

	// 房间与主持操作：权限在各处理函数中按角色（含房间主持）判断
	switch b := req.Body.(type) {
	case *pb.Request_CreateRoom, *pb.Request_UpdateRoom, *pb.Request_CloseRoom, *pb.Request_MoveParticipant,
		*pb.Request_RecallAll, *pb.Request_Moderate, *pb.Request_MuteAll:
		if !s.adminLimit.Allow(now) {
			return errLimited()
		}
		switch b := b.(type) {
		case *pb.Request_CreateRoom:
			return h.handleCreateRoom(s, b.CreateRoom)
		case *pb.Request_UpdateRoom:
			return h.handleUpdateRoom(s, b.UpdateRoom)
		case *pb.Request_CloseRoom:
			return h.handleCloseRoom(s, b.CloseRoom)
		case *pb.Request_MoveParticipant:
			return h.handleMove(s, b.MoveParticipant)
		case *pb.Request_RecallAll:
			return h.handleRecallAll(s)
		case *pb.Request_Moderate:
			return h.handleModerate(s, b.Moderate)
		case *pb.Request_MuteAll:
			return h.handleMuteAll(s, b.MuteAll)
		}
	}

	// 以下为管理员请求
	if s.Role < perm.Admin {
		return errDenied()
	}
	if !s.adminLimit.Allow(now) {
		return errLimited()
	}
	switch b := req.Body.(type) {
	case *pb.Request_GetSettings:
		return &pb.Response{Body: &pb.Response_GetSettings{GetSettings: &pb.GetSettingsResult{Values: h.Settings().Public()}}}
	case *pb.Request_UpdateSettings:
		return h.handleUpdateSettings(s, c, req.GetId(), b.UpdateSettings)
	case *pb.Request_CreateToken:
		return h.handleCreateToken(s, c, req.GetId(), b.CreateToken)
	case *pb.Request_ListTokens:
		return h.handleListTokens(c, req.GetId())
	case *pb.Request_RevokeToken:
		return h.handleRevokeToken(s, c, req.GetId(), b.RevokeToken)
	case *pb.Request_SetRole:
		return h.handleSetRole(s, c, req.GetId(), b.SetRole)
	case *pb.Request_ListIdentities:
		return h.handleListIdentities(s, c, req.GetId(), b.ListIdentities)
	case *pb.Request_ListBans:
		return h.handleListBans(c, req.GetId())
	case *pb.Request_AddBan:
		return h.handleAddBan(s, c, req.GetId(), b.AddBan)
	case *pb.Request_RemoveBan:
		return h.handleRemoveBan(s, c, req.GetId(), b.RemoveBan)
	case *pb.Request_GetAuditLog:
		return h.handleAuditLog(c, req.GetId(), b.GetAuditLog)
	case *pb.Request_CreateInvite:
		return h.handleCreateInvite(s, c, req.GetId(), b.CreateInvite)
	case *pb.Request_ListInvites:
		return h.handleListInvites(c, req.GetId())
	case *pb.Request_RevokeInvite:
		return h.handleRevokeInvite(s, c, req.GetId(), b.RevokeInvite)
	case *pb.Request_GetSessionInfo:
		return h.handleSessionInfo(b.GetSessionInfo)
	case *pb.Request_DownloadIpv6GeoDb:
		return h.handleDownloadIPv6GeoDB(s, c, req.GetId())
	}
	return errResp(pb.ErrorCode_ERROR_CODE_INVALID_ARGUMENT, "unknown request")
}

func (h *Hub) handleUpdateSelf(s *Session, u *pb.UpdateSelf) *pb.Response {
	changed := false
	setBool := func(dst *bool, v *bool) {
		if v != nil && *dst != *v {
			*dst, changed = *v, true
		}
	}
	setBool(&s.State.MicMuted, u.MicMuted)
	setBool(&s.State.Deafened, u.Deafened)
	setBool(&s.State.HandRaised, u.HandRaised)
	setBool(&s.State.Away, u.Away)
	if u.Nickname != nil {
		name, err := identity.NormalizeNickname(*u.Nickname)
		if err != nil {
			return errResp(pb.ErrorCode_ERROR_CODE_NICKNAME_INVALID, err.Error())
		}
		if name != s.Nickname {
			old := s.Nickname
			s.Nickname = h.uniqueNickname(name, s.ID)
			changed = true
			h.audit(s.UID, "user.rename", s.UID, map[string]string{"from": old, "to": s.Nickname}, "")
		}
	}
	if changed {
		h.participantUpdated(s)
	}
	return &pb.Response{Body: &pb.Response_UpdateSelf{UpdateSelf: &pb.UpdateSelfResult{Self: s.proto()}}}
}

// ---------- 聊天 ----------

func (h *Hub) handleSendChat(s *Session, m *pb.SendChat) *pb.Response {
	room, ok := h.rooms[m.GetRoomId()]
	if !ok {
		return errResp(pb.ErrorCode_ERROR_CODE_ROOM_NOT_FOUND, "room not found")
	}
	if m.GetRoomId() != s.RoomID {
		return errDenied()
	}
	text := strings.TrimSpace(m.GetText())
	st := h.Settings()
	if !utf8.ValidString(text) || utf8.RuneCountInString(text) > st.ChatMaxLength || (text == "" && m.GetImageId() == "") {
		return errResp(pb.ErrorCode_ERROR_CODE_INVALID_ARGUMENT, "message is empty or too long")
	}
	if len(m.GetClientMsgId()) > 64 {
		return errResp(pb.ErrorCode_ERROR_CODE_INVALID_ARGUMENT, "client_msg_id too long")
	}
	var image *pb.ChatImage
	if id := m.GetImageId(); id != "" {
		// 只能发自己刚上传到这个房间、还没发出去的图片
		p := h.pendingImages[id]
		if p == nil || p.session != s.ID || p.room != room.ID {
			return errResp(pb.ErrorCode_ERROR_CODE_INVALID_ARGUMENT, "unknown image")
		}
		p.timer.Stop()
		delete(h.pendingImages, id)
		image = &pb.ChatImage{Id: id, Width: uint32(p.img.Width), Height: uint32(p.img.Height), Size: uint32(p.img.Size)}
	}
	h.chatSeq++
	msg := &pb.ChatMessage{
		Id:              h.chatSeq,
		RoomId:          room.ID,
		SenderSessionId: s.ID,
		SenderUid:       s.UID,
		SenderName:      s.Nickname,
		Text:            text,
		ReplyTo:         m.GetReplyTo(),
		CreatedAtMs:     h.now().UnixMilli(),
		ClientMsgId:     m.GetClientMsgId(),
		Image:           image,
	}
	// 只持久化主会议（临时房间的聊天只在内存）；同步写入，保证历史查询能立即看到
	persisted := room.Kind == pb.RoomKind_ROOM_KIND_MAIN && st.ChatRetentionDays > 0
	if persisted {
		row := &store.ChatMessage{
			ID: msg.Id, RoomID: msg.RoomId, SenderUID: msg.SenderUid, SenderName: msg.SenderName,
			Body: msg.Text, ReplyTo: msg.ReplyTo, CreatedAt: msg.CreatedAtMs,
		}
		if image != nil {
			row.ImageID, row.ImageWidth, row.ImageHeight, row.ImageSize = image.Id, int64(image.Width), int64(image.Height), int64(image.Size)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		err := h.store.InsertChat(ctx, row)
		cancel()
		if err != nil {
			h.log.Error("chat persist failed", "err", err)
			if image != nil {
				h.deleteImage(room.ID, image.Id)
			}
			return errInternal()
		}
	} else if image != nil {
		h.memImages[image.Id] = room.ID
	}
	for _, old := range room.remember(msg) {
		if id := old.GetImage().GetId(); id != "" && h.memImages[id] != "" {
			delete(h.memImages, id)
			h.deleteImage(room.ID, id)
		}
	}
	h.broadcast(h.inRoom(room.ID), &pb.Event{Body: &pb.Event_ChatMessage{ChatMessage: msg}})
	return &pb.Response{Body: &pb.Response_SendChat{SendChat: &pb.SendChatResult{Message: msg}}}
}

func (h *Hub) handleChatHistory(s *Session, c Conn, id uint32, q *pb.GetChatHistory) *pb.Response {
	room, ok := h.rooms[q.GetRoomId()]
	if !ok {
		return errResp(pb.ErrorCode_ERROR_CODE_ROOM_NOT_FOUND, "room not found")
	}
	if q.GetRoomId() != s.RoomID {
		return errDenied()
	}
	limit := int(q.GetLimit())
	if limit <= 0 || limit > 100 {
		limit = 100
	}
	before := q.GetBeforeId()
	if room.Kind != pb.RoomKind_ROOM_KIND_MAIN || h.Settings().ChatRetentionDays == 0 {
		return &pb.Response{Body: &pb.Response_GetChatHistory{GetChatHistory: memoryHistory(room.chat, before, limit)}}
	}
	h.async(func() func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		rows, more, err := h.store.ChatHistory(ctx, room.ID, before, limit)
		if err != nil {
			h.log.Error("chat history failed", "err", err)
			reply(c, id, errInternal())
			return nil
		}
		res := &pb.GetChatHistoryResult{HasMore: more}
		for _, r := range rows {
			m := &pb.ChatMessage{
				Id: r.ID, RoomId: r.RoomID, SenderUid: r.SenderUID, SenderName: r.SenderName,
				Text: r.Body, ReplyTo: r.ReplyTo, CreatedAtMs: r.CreatedAt,
			}
			if r.ImageID != "" {
				m.Image = &pb.ChatImage{Id: r.ImageID, Width: uint32(r.ImageWidth), Height: uint32(r.ImageHeight), Size: uint32(r.ImageSize)}
			}
			res.Messages = append(res.Messages, m)
		}
		reply(c, id, &pb.Response{Body: &pb.Response_GetChatHistory{GetChatHistory: res}})
		return nil
	})
	return nil
}

func memoryHistory(all []*pb.ChatMessage, before int64, limit int) *pb.GetChatHistoryResult {
	end := len(all)
	if before > 0 {
		for end > 0 && all[end-1].Id >= before {
			end--
		}
	}
	start := max(0, end-limit)
	return &pb.GetChatHistoryResult{Messages: append([]*pb.ChatMessage(nil), all[start:end]...), HasMore: start > 0}
}

// ---------- 权限令牌 ----------

func (h *Hub) handleRedeem(s *Session, c Conn, id uint32, r *pb.RedeemToken) *pb.Response {
	ip := s.RemoteIP.String()
	if RedeemFailures.Exceeded(ip) {
		return errLimited()
	}
	norm, err := auth.NormalizeToken(r.GetToken())
	if err != nil {
		RedeemFailures.Add(ip)
		return errResp(pb.ErrorCode_ERROR_CODE_TOKEN_INVALID, "invalid token")
	}
	uid := s.UID
	h.async(func() func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		res, err := h.store.RedeemToken(ctx, auth.HashToken(norm), uid)
		if err != nil {
			code := pb.ErrorCode_ERROR_CODE_INTERNAL
			switch {
			case errors.Is(err, store.ErrTokenInvalid):
				code = pb.ErrorCode_ERROR_CODE_TOKEN_INVALID
			case errors.Is(err, store.ErrTokenExpired):
				code = pb.ErrorCode_ERROR_CODE_TOKEN_EXPIRED
			case errors.Is(err, store.ErrTokenUsedUp):
				code = pb.ErrorCode_ERROR_CODE_TOKEN_USED_UP
			default:
				h.log.Error("redeem token failed", "err", err)
			}
			if code != pb.ErrorCode_ERROR_CODE_INTERNAL {
				RedeemFailures.Add(ip)
			}
			reply(c, id, errResp(code, "token rejected"))
			return nil
		}
		return func() {
			if res.Consumed {
				h.audit(uid, "token.redeem", res.Token.ID, map[string]string{"role": res.NewRole.String()}, ip)
				h.applyRole(uid, res.NewRole)
			}
			reply(c, id, &pb.Response{Body: &pb.Response_RedeemToken{RedeemToken: &pb.RedeemTokenResult{Role: res.NewRole.Proto()}}})
		}
	})
	return nil
}

// applyRole 把新角色应用到该 UID 的所有在线会话，并通知所有人。
func (h *Hub) applyRole(uid string, role perm.Role) {
	changed := false
	for _, s := range h.sessions {
		if s.UID == uid && s.Role != role {
			s.Role = role
			changed = true
			h.participantUpdated(s)
		}
	}
	if changed {
		h.broadcast(nil, &pb.Event{Body: &pb.Event_RoleChanged{RoleChanged: &pb.RoleChanged{Uid: uid, Role: role.Proto()}}})
	}
}
