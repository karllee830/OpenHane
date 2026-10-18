package hub

import (
	"context"
	"net/netip"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/karllee830/OpenHane/server/internal/media"
	"github.com/karllee830/OpenHane/server/internal/pb"
	"github.com/karllee830/OpenHane/server/internal/perm"
	"github.com/karllee830/OpenHane/server/internal/store"
)

// 主持与管理操作：
// - 只能管理角色比自己低的人（临时房间的创建者在自己房间里算主持人，但只能管理房间内的成员，且不能踢出或封禁）；
// - 媒体相关的操作通过 SFU 权限强制执行，客户端绕不过；
// - 所有操作写入审计日志，并给当事人推送 ModerationNotice。

// moderatorMaxBan 是主持人能设置的最长封禁时长。
const moderatorMaxBan = 24 * time.Hour

func (h *Hub) notify(s *Session, action pb.ModerationAction, by, reason string) {
	s.sendEvent(&pb.Event{Body: &pb.Event_ModerationNotice{ModerationNotice: &pb.ModerationNotice{Action: action, ByName: by, Reason: reason}}})
}

// canModerate 判断 actor 能否对 target 执行 action。
func (h *Hub) canModerate(actor, target *Session, action pb.ModerationAction) bool {
	if actor == target {
		return false
	}
	switch action {
	case pb.ModerationAction_MODERATION_ACTION_KICK, pb.ModerationAction_MODERATION_ACTION_BAN:
		// 服务器级操作：只看服务器角色。管理员之间不能互相踢出或封禁
		return actor.Role >= perm.Moderator && target.Role < actor.Role
	}
	if actor.Role >= perm.Moderator {
		return target.Role < actor.Role
	}
	// 房间主持：只能管理自己房间里的普通成员
	room := h.rooms[actor.RoomID]
	return target.RoomID == actor.RoomID && h.roleIn(actor, room) >= perm.Moderator && target.Role < perm.Moderator
}

func (h *Hub) handleModerate(s *Session, r *pb.Moderate) *pb.Response {
	t := h.sessions[r.GetSessionId()]
	if t == nil {
		return errResp(pb.ErrorCode_ERROR_CODE_INVALID_ARGUMENT, "no such session")
	}
	action := r.GetAction()
	if !h.canModerate(s, t, action) {
		return errDenied()
	}
	reason := strings.TrimSpace(r.GetReason())
	if utf8.RuneCountInString(reason) > 200 {
		return errResp(pb.ErrorCode_ERROR_CODE_INVALID_ARGUMENT, "reason too long")
	}
	ok := &pb.Response{Body: &pb.Response_Moderate{Moderate: &pb.ModerateResult{}}}
	detail := map[string]any{"session": t.ID, "nickname": t.Nickname}
	if reason != "" {
		detail["reason"] = reason
	}
	ip := s.RemoteIP.String()

	switch action {
	case pb.ModerationAction_MODERATION_ACTION_FORCE_MUTE:
		h.forceMute(t, true, "")
		h.notify(t, action, s.Nickname, reason)
	case pb.ModerationAction_MODERATION_ACTION_UNMUTE:
		h.forceMute(t, false, "")
		h.notify(t, action, s.Nickname, reason)
	case pb.ModerationAction_MODERATION_ACTION_STOP_SHARE:
		if t.ShareGrant == "" {
			return ok
		}
		h.releaseShare(t, true)
		h.notify(t, action, s.Nickname, reason)
	case pb.ModerationAction_MODERATION_ACTION_CAMERA_OFF:
		h.cameraOff(t)
		h.notify(t, action, s.Nickname, reason)
	case pb.ModerationAction_MODERATION_ACTION_REMOVE_FROM_ROOM:
		if t.RoomID == MainRoomID {
			return errResp(pb.ErrorCode_ERROR_CODE_INVALID_ARGUMENT, "already in the main room")
		}
		h.moveSession(t, h.rooms[MainRoomID], pb.MoveReason_MOVE_REASON_REMOVED, s)
	case pb.ModerationAction_MODERATION_ACTION_KICK:
		h.disconnect(t, &pb.Error{Code: pb.ErrorCode_ERROR_CODE_KICKED, Message: "kicked", ByName: s.Nickname, Reason: reason}, "kicked")
	case pb.ModerationAction_MODERATION_ACTION_BAN:
		dur := time.Duration(r.GetDurationSec()) * time.Second
		if s.Role < perm.Admin && (dur == 0 || dur > moderatorMaxBan) {
			return errResp(pb.ErrorCode_ERROR_CODE_PERMISSION_DENIED, "moderators can ban for at most 24 hours")
		}
		ban := &store.Ban{UID: t.UID, Reason: reason, CreatedBy: s.UID}
		if r.GetBanIp() && t.RemoteIP.IsValid() {
			ban.IPCIDR = netip.PrefixFrom(t.RemoteIP, t.RemoteIP.BitLen()).String()
		}
		if dur > 0 {
			ban.ExpiresAt = h.now().Add(dur).UnixMilli()
		}
		detail["duration_sec"] = r.GetDurationSec()
		detail["ip"] = ban.IPCIDR != ""
		h.addBan(s, ban, nil)
	default:
		return errResp(pb.ErrorCode_ERROR_CODE_INVALID_ARGUMENT, "unknown action")
	}
	h.audit(s.UID, "moderate."+strings.ToLower(strings.TrimPrefix(action.String(), "MODERATION_ACTION_")), t.UID, detail, ip)
	return ok
}

// forceMute 设置或解除强制静音：收回 / 恢复 SFU 上的麦克风发布权限（SFU 会取消发布不再允许的轨道）。
// room 为空表示服务器级（随会话保留），否则是房间级（全员静音，离开该房间后解除）。
func (h *Hub) forceMute(t *Session, on bool, room string) {
	if t.ForceMuted == on && (!on || t.forceMutedRoom == room) {
		return
	}
	t.ForceMuted, t.forceMutedRoom = on, room
	if !on {
		t.forceMutedRoom = ""
	}
	h.syncPermission(t)
	h.participantUpdated(t)
}

// cameraOff 让 SFU 取消发布当事人的摄像头：先收回摄像头权限，再恢复（不禁止再次开启）。两步必须按顺序执行。
func (h *Hub) cameraOff(t *Session) {
	if !t.MediaOnline {
		return
	}
	room, mid := t.RoomID, t.MediaID
	without := h.mediaPermission(t)
	with := without
	without.Sources = nil
	for _, src := range with.Sources {
		if src != media.SourceCamera {
			without.Sources = append(without.Sources, src)
		}
	}
	go func() {
		ctx, cancel := bg()
		defer cancel()
		if err := h.media.UpdatePermission(ctx, room, mid, without); err != nil {
			h.log.Warn("camera off failed", "identity", mid, "err", err)
			return
		}
		time.Sleep(300 * time.Millisecond) // 等 SFU 处理完取消发布
		h.media.UpdatePermission(ctx, room, mid, with)
	}()
}

// disconnect 发送 Goodbye 后移除会话（不进入宽限期）。
func (h *Hub) disconnect(t *Session, e *pb.Error, why string) {
	if t.conn != nil {
		t.conn.Close(e, false)
		t.conn = nil
	}
	h.removeSession(t, why)
}

// addBan 写入封禁（异步），完成后断开所有匹配的在线会话。done 在 Hub 协程中以结果回调（可为 nil）。
func (h *Hub) addBan(by *Session, ban *store.Ban, done func(*store.Ban, int, error)) {
	h.async(func() func() {
		err := h.store.InsertBan(context.Background(), ban)
		return func() {
			if err != nil {
				h.log.Error("insert ban failed", "err", err)
				if done != nil {
					done(nil, 0, err)
				}
				return
			}
			var prefix netip.Prefix
			if ban.IPCIDR != "" {
				prefix, _ = netip.ParsePrefix(ban.IPCIDR)
			}
			byName := ""
			if by != nil {
				byName = by.Nickname
			}
			n := 0
			for _, s := range h.sessions {
				if (ban.UID != "" && s.UID == ban.UID) || (prefix.IsValid() && prefix.Contains(s.RemoteIP)) {
					h.disconnect(s, &pb.Error{Code: pb.ErrorCode_ERROR_CODE_BANNED, Message: "banned", BanReason: ban.Reason,
						BanExpiresAtMs: ban.ExpiresAt, ByName: byName, Reason: ban.Reason}, "banned")
					n++
				}
			}
			if done != nil {
				done(ban, n, nil)
			}
		}
	})
}

func (h *Hub) handleMuteAll(s *Session, r *pb.MuteAll) *pb.Response {
	room := h.rooms[r.GetRoomId()]
	if room == nil {
		return errResp(pb.ErrorCode_ERROR_CODE_ROOM_NOT_FOUND, "room not found")
	}
	if h.roleIn(s, room) < perm.Moderator {
		return errDenied()
	}
	n := uint32(0)
	for _, t := range h.sessions {
		if t.RoomID != room.ID || t == s || !h.canModerate(s, t, pb.ModerationAction_MODERATION_ACTION_FORCE_MUTE) || t.ForceMuted {
			continue
		}
		h.forceMute(t, true, room.ID)
		h.notify(t, pb.ModerationAction_MODERATION_ACTION_FORCE_MUTE, s.Nickname, "")
		n++
	}
	h.audit(s.UID, "moderate.mute_all", room.ID, map[string]uint32{"muted": n}, s.RemoteIP.String())
	return &pb.Response{Body: &pb.Response_MuteAll{MuteAll: &pb.MuteAllResult{Muted: n}}}
}
