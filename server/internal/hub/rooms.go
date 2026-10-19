package hub

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"strings"
	"time"
	"unicode/utf8"

	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	"github.com/karllee830/OpenHane/server/internal/auth"
	"github.com/karllee830/OpenHane/server/internal/media"
	"github.com/karllee830/OpenHane/server/internal/pb"
	"github.com/karllee830/OpenHane/server/internal/perm"
)

// 房间：常驻的主会议 + 临时房间。临时房间只在内存中，空置超时自动关闭，服务器重启即消失。

// roomSwitchGrace 是切换房间后保留旧 SFU 房间连接的时长：客户端「先连后断」，超时后服务端主动移除。
const roomSwitchGrace = 3 * time.Second

// mainRoomMetaKey 是主会议设置（人数上限、策略覆盖）在 server_meta 中的键。
const mainRoomMetaKey = "room.main"

type mainRoomConfig struct {
	Capacity  int             `json:"capacity"`
	Overrides json.RawMessage `json:"overrides,omitempty"` // protojson
}

// roleIn 返回会话在房间中的有效角色：临时房间的创建者在自己的房间里拥有主持人权限（房间主持）。
func (h *Hub) roleIn(s *Session, room *Room) perm.Role {
	if s.Role < perm.Moderator && room != nil && room.temporary() && room.CreatedBy == s.UID {
		return perm.Moderator
	}
	return s.Role
}

func (h *Hub) members(roomID string) int {
	n := 0
	for _, s := range h.sessions {
		if s.RoomID == roomID {
			n++
		}
	}
	return n
}

func validRoomName(name string) (string, bool) {
	name = strings.TrimSpace(name)
	n := utf8.RuneCountInString(name)
	return name, n >= 1 && n <= 40
}

func roomPassHash(key []byte, password string) []byte {
	m := hmac.New(sha256.New, key)
	m.Write([]byte(password))
	return m.Sum(nil)
}

func (r *Room) setPassword(password string) {
	if password == "" {
		r.passHash, r.passKey = nil, nil
		return
	}
	r.passKey = make([]byte, 32)
	rand.Read(r.passKey)
	r.passHash = roomPassHash(r.passKey, password)
}

func (r *Room) checkPassword(password string) bool {
	return r.passHash == nil || hmac.Equal(r.passHash, roomPassHash(r.passKey, password))
}

// canEnter 按固定顺序判断能否进入房间（moved 为 true 表示被主持人移入，忽略密码、锁定和人数上限）。
func (h *Hub) canEnter(s *Session, room *Room, password string, moved bool) *pb.Error {
	privileged := h.roleIn(s, room) >= perm.Moderator
	if !moved && !privileged {
		if room.Locked {
			return pbErr(pb.ErrorCode_ERROR_CODE_ROOM_LOCKED, "room is locked")
		}
		if !room.checkPassword(password) {
			return pbErr(pb.ErrorCode_ERROR_CODE_ROOM_PASSWORD_INVALID, "wrong room password")
		}
		if room.Capacity > 0 && h.members(room.ID) >= room.Capacity {
			return pbErr(pb.ErrorCode_ERROR_CODE_ROOM_FULL, "room is full")
		}
	}
	if room.e2ee(h.Settings()) && !s.proto().GetSupportsE2Ee() {
		return pbErr(pb.ErrorCode_ERROR_CODE_E2EE_UNSUPPORTED, "this room requires end-to-end encryption")
	}
	return nil
}

// handleJoinRoom 进入或切换房间（也用于媒体令牌过期后重新获取令牌）。
func (h *Hub) handleJoinRoom(s *Session, r *pb.JoinRoom) *pb.Response {
	room := h.rooms[r.GetRoomId()]
	if room == nil {
		return errResp(pb.ErrorCode_ERROR_CODE_ROOM_NOT_FOUND, "room not found")
	}
	if room.ID != s.RoomID {
		if e := h.canEnter(s, room, r.GetPassword(), false); e != nil {
			return &pb.Response{Error: e}
		}
		h.switchRoom(s, room)
	}
	return &pb.Response{Body: &pb.Response_JoinRoom{JoinRoom: h.joinResult(s)}}
}

// switchRoom 把会话移到另一个房间：结束共享（许可绑定在房间上）、解除房间级强制静音、
// 安排移除旧 SFU 房间中的连接，并更新两边房间的空置计时和可解码集合。
func (h *Hub) switchRoom(s *Session, to *Room) {
	from := s.RoomID
	h.releaseShare(s, false)
	if s.ForceMuted && s.forceMutedRoom != "" && s.forceMutedRoom != to.ID {
		s.ForceMuted, s.forceMutedRoom = false, ""
	}
	s.RoomID = to.ID
	if s.MediaOnline {
		// 新房间的媒体连接建立后会再次标记为在线；旧房间的连接在宽限后移除（客户端通常已经自己断开）
		s.MediaOnline, s.CameraOn, s.screenTracks = false, false, 0
		mid := s.MediaID
		time.AfterFunc(roomSwitchGrace, func() {
			h.do(func() {
				if cur := h.sessions[s.ID]; cur == s && s.RoomID == from {
					return // 已经回到原来的房间
				}
				go func() {
					ctx, cancel := bg()
					defer cancel()
					h.media.RemoveParticipant(ctx, from, mid)
				}()
			})
		})
	}
	if s.shareOnline {
		// 共享连接属于旧房间（共享许可也已收回）：立即移除，客户端也会自己断开
		s.shareOnline = false
		room, id := shareRoom(from), s.ShareMediaID
		go func() {
			ctx, cancel := bg()
			defer cancel()
			h.media.RemoveParticipant(ctx, room, id)
		}()
	}
	h.participantUpdated(s)
	h.refreshDecodable(from)
	h.refreshDecodable(to.ID)
	h.roomOccupancyChanged(from)
	h.roomOccupancyChanged(to.ID)
}

// moveSession 由服务端发起的移动（被主持人移动、移出房间、房间关闭、全员召回）：推送 YouWereMoved，
// 当事人凭附带的媒体令牌直接切换。
func (h *Hub) moveSession(s *Session, to *Room, reason pb.MoveReason, by *Session) {
	fromName := ""
	if from := h.rooms[s.RoomID]; from != nil {
		fromName = from.proto(h.Settings()).GetName()
	}
	h.switchRoom(s, to)
	byName := ""
	if by != nil {
		byName = by.Nickname
	}
	s.sendEvent(&pb.Event{Body: &pb.Event_YouWereMoved{YouWereMoved: &pb.YouWereMoved{
		RoomId: to.ID, Reason: reason, ByName: byName, Joined: h.joinResult(s), FromRoomName: fromName,
	}}})
}

// roomOccupancyChanged 维护临时房间的空置计时：没人时开始计时，有人进入时取消。
func (h *Hub) roomOccupancyChanged(roomID string) {
	room := h.rooms[roomID]
	if room == nil || !room.temporary() {
		return
	}
	if h.members(roomID) > 0 {
		if room.emptyTimer != nil {
			room.emptyTimer.Stop()
			room.emptyTimer = nil
		}
		return
	}
	if room.emptyTimer != nil {
		return
	}
	room.emptyTimer = time.AfterFunc(room.EmptyTimeout, func() {
		h.do(func() {
			if h.rooms[roomID] == room && h.members(roomID) == 0 {
				h.closeRoom(room, nil, "empty")
			}
		})
	})
}

// closeRoom 把成员送回主会议后销毁临时房间（SFU 房间、内存中的聊天和设置一并丢弃）。
func (h *Hub) closeRoom(room *Room, by *Session, why string) {
	main := h.rooms[MainRoomID]
	for _, s := range h.sessions {
		if s.RoomID == room.ID {
			h.moveSession(s, main, pb.MoveReason_MOVE_REASON_ROOM_CLOSED, by)
		}
	}
	if room.emptyTimer != nil {
		room.emptyTimer.Stop()
	}
	delete(h.rooms, room.ID)
	h.dropRoomImages(room.ID)
	h.broadcast(nil, &pb.Event{Body: &pb.Event_RoomClosed{RoomClosed: &pb.RoomClosed{RoomId: room.ID}}})
	go func() {
		ctx, cancel := bg()
		defer cancel()
		h.media.DeleteRoom(ctx, room.ID)
		h.media.DeleteRoom(ctx, shareRoom(room.ID)) // 没建过时 SFU 会返回错误，忽略
	}()
	actor := ""
	if by != nil {
		actor = by.UID
	}
	h.audit(actor, "room.close", room.ID, map[string]string{"name": room.Name, "reason": why}, "")
	h.log.Info("room closed", "room", room.ID, "reason", why)
}

func (h *Hub) roomUpdated(room *Room) {
	h.broadcast(nil, &pb.Event{Body: &pb.Event_RoomUpdated{RoomUpdated: &pb.RoomUpdated{Room: room.proto(h.Settings())}}})
}

func (h *Hub) handleCreateRoom(s *Session, r *pb.CreateRoom) *pb.Response {
	st := h.Settings()
	minRole, _ := perm.ParseRole(st.RoomsCreateMinRole)
	if s.Role < minRole {
		return errDenied()
	}
	temps := 0
	for _, room := range h.rooms {
		if room.temporary() {
			temps++
		}
	}
	if temps >= st.RoomsMaxTemporary {
		return errResp(pb.ErrorCode_ERROR_CODE_PERMISSION_DENIED, "temporary room limit reached")
	}
	name, ok := validRoomName(r.GetName())
	if !ok {
		return errResp(pb.ErrorCode_ERROR_CODE_INVALID_ARGUMENT, "room name must be 1–40 characters")
	}
	timeout := time.Duration(st.RoomsEmptyTimeout) * time.Second
	if r.EmptyTimeoutSec != nil {
		timeout = time.Duration(min(r.GetEmptyTimeoutSec(), 86400)) * time.Second
	}
	room := &Room{
		ID: "r_" + auth.RandomID(10), Kind: pb.RoomKind_ROOM_KIND_TEMPORARY, Name: name,
		CreatedBy: s.UID, CreatedAt: h.now(), Locked: r.GetLocked(), Capacity: int(r.GetCapacity()),
		Overrides: overridesOrEmpty(r.GetOverrides()), EmptyTimeout: timeout, decodable: baselineDecodable,
	}
	room.setPassword(r.GetPassword())
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := h.media.EnsureRoom(ctx, room.ID, media.RoomOptions{}); err != nil {
		h.log.Error("create media room failed", "room", room.ID, "err", err)
		return errInternal()
	}
	h.rooms[room.ID] = room
	h.broadcast(nil, &pb.Event{Body: &pb.Event_RoomCreated{RoomCreated: &pb.RoomCreated{Room: room.proto(st)}}})
	h.audit(s.UID, "room.create", room.ID, map[string]any{"name": name, "password": r.GetPassword() != "", "locked": room.Locked}, s.RemoteIP.String())
	res := &pb.CreateRoomResult{Room: room.proto(st)}
	if r.GetJoin() {
		if e := h.canEnter(s, room, r.GetPassword(), false); e == nil {
			h.switchRoom(s, room)
			res.Joined = h.joinResult(s)
		}
	}
	h.roomOccupancyChanged(room.ID) // 没进入时开始空置计时
	return &pb.Response{Body: &pb.Response_CreateRoom{CreateRoom: res}}
}

func overridesOrEmpty(o *pb.RoomOverrides) *pb.RoomOverrides {
	if o == nil {
		return &pb.RoomOverrides{}
	}
	return proto.Clone(o).(*pb.RoomOverrides)
}

func (h *Hub) handleUpdateRoom(s *Session, r *pb.UpdateRoom) *pb.Response {
	room := h.rooms[r.GetRoomId()]
	if room == nil {
		return errResp(pb.ErrorCode_ERROR_CODE_ROOM_NOT_FOUND, "room not found")
	}
	if h.roleIn(s, room) < perm.Moderator {
		return errDenied()
	}
	st := h.Settings()
	isMain := !room.temporary()
	if isMain && (r.Name != nil || r.Password != nil || r.Locked != nil || r.EmptyTimeoutSec != nil) {
		// 主会议的名称在服务器设置中修改；主会议不能设密码或锁定（新连接总是先进入主会议）
		return errResp(pb.ErrorCode_ERROR_CODE_INVALID_ARGUMENT, "main room only supports capacity and overrides")
	}
	if r.Name != nil {
		name, ok := validRoomName(r.GetName())
		if !ok {
			return errResp(pb.ErrorCode_ERROR_CODE_INVALID_ARGUMENT, "room name must be 1–40 characters")
		}
		room.Name = name
	}
	if r.Password != nil {
		room.setPassword(r.GetPassword())
	}
	if r.Locked != nil {
		room.Locked = r.GetLocked()
	}
	if r.Capacity != nil {
		room.Capacity = int(r.GetCapacity())
	}
	if r.EmptyTimeoutSec != nil {
		room.EmptyTimeout = time.Duration(min(r.GetEmptyTimeoutSec(), 86400)) * time.Second
	}
	wasE2EE := room.e2ee(st)
	if r.Overrides != nil {
		room.Overrides = overridesOrEmpty(r.GetOverrides())
	}
	h.roomUpdated(room)
	if r.Overrides != nil {
		h.applyRoomPolicy(room, wasE2EE)
	}
	if isMain {
		h.persistMainRoom()
	}
	h.audit(s.UID, "room.update", room.ID, r, s.RemoteIP.String())
	return &pb.Response{Body: &pb.Response_UpdateRoom{UpdateRoom: &pb.UpdateRoomResult{Room: room.proto(st)}}}
}

// applyRoomPolicy 在房间覆盖变化后生效：推送新策略、同步 SFU 权限（摄像头）、收回不再允许的共享；
// 端到端加密状态变化时，现有共享全部结束（编码器限制不同），不支持 E2EE 的成员被送回主会议。
func (h *Hub) applyRoomPolicy(room *Room, wasE2EE bool) {
	h.pushPolicy(room.ID)
	for _, s := range h.sessions {
		if s.RoomID == room.ID {
			h.syncPermission(s)
		}
	}
	h.revokeDisallowedShares()
	if room.e2ee(h.Settings()) != wasE2EE {
		h.enforceE2EE(room)
	}
}

func (h *Hub) handleCloseRoom(s *Session, r *pb.CloseRoom) *pb.Response {
	room := h.rooms[r.GetRoomId()]
	if room == nil {
		return errResp(pb.ErrorCode_ERROR_CODE_ROOM_NOT_FOUND, "room not found")
	}
	if !room.temporary() {
		return errResp(pb.ErrorCode_ERROR_CODE_INVALID_ARGUMENT, "the main room cannot be closed")
	}
	if h.roleIn(s, room) < perm.Moderator {
		return errDenied()
	}
	h.closeRoom(room, s, "closed")
	return &pb.Response{Body: &pb.Response_CloseRoom{CloseRoom: &pb.CloseRoomResult{}}}
}

func (h *Hub) handleMove(s *Session, r *pb.MoveParticipant) *pb.Response {
	target := h.sessions[r.GetSessionId()]
	room := h.rooms[r.GetRoomId()]
	if target == nil {
		return errResp(pb.ErrorCode_ERROR_CODE_INVALID_ARGUMENT, "no such session")
	}
	if room == nil {
		return errResp(pb.ErrorCode_ERROR_CODE_ROOM_NOT_FOUND, "room not found")
	}
	// 移动他人需要主持人以上（服务器级），且只能移动角色比自己低的人；移动自己等同于进入
	if target != s && (s.Role < perm.Moderator || target.Role >= s.Role) {
		return errDenied()
	}
	if target.RoomID == room.ID {
		return &pb.Response{Body: &pb.Response_MoveParticipant{MoveParticipant: &pb.MoveParticipantResult{}}}
	}
	if e := h.canEnter(target, room, "", true); e != nil {
		return &pb.Response{Error: e}
	}
	h.moveSession(target, room, pb.MoveReason_MOVE_REASON_MOVED, s)
	h.audit(s.UID, "room.move", target.UID, map[string]string{"room": room.ID}, s.RemoteIP.String())
	return &pb.Response{Body: &pb.Response_MoveParticipant{MoveParticipant: &pb.MoveParticipantResult{}}}
}

func (h *Hub) handleRecallAll(s *Session) *pb.Response {
	if s.Role < perm.Moderator {
		return errDenied()
	}
	main := h.rooms[MainRoomID]
	n := uint32(0)
	for _, t := range h.sessions {
		if t.RoomID != MainRoomID {
			h.moveSession(t, main, pb.MoveReason_MOVE_REASON_RECALLED, s)
			n++
		}
	}
	h.audit(s.UID, "room.recall", "", map[string]uint32{"moved": n}, s.RemoteIP.String())
	return &pb.Response{Body: &pb.Response_RecallAll{RecallAll: &pb.RecallAllResult{Moved: n}}}
}

// loadMainRoom 读取持久化的主会议设置（人数上限、策略覆盖）。在 Hub 协程启动前调用。
func (h *Hub) loadMainRoom(ctx context.Context) {
	raw, err := h.store.GetMeta(ctx, mainRoomMetaKey)
	if err != nil {
		return
	}
	var cfg mainRoomConfig
	if json.Unmarshal([]byte(raw), &cfg) != nil {
		return
	}
	main := h.rooms[MainRoomID]
	main.Capacity = cfg.Capacity
	if len(cfg.Overrides) > 0 {
		o := &pb.RoomOverrides{}
		if protojsonUnmarshal(cfg.Overrides, o) == nil {
			main.Overrides = o
		}
	}
}

func (h *Hub) persistMainRoom() {
	main := h.rooms[MainRoomID]
	o, _ := protojsonMarshal(main.Overrides)
	b, _ := json.Marshal(mainRoomConfig{Capacity: main.Capacity, Overrides: o})
	go func() {
		ctx, cancel := bg()
		defer cancel()
		if err := h.store.SetMeta(ctx, mainRoomMetaKey, string(b)); err != nil {
			h.log.Warn("persist main room failed", "err", err)
		}
	}()
}

func protojsonMarshal(m proto.Message) ([]byte, error) { return protojson.Marshal(m) }

func protojsonUnmarshal(b []byte, m proto.Message) error { return protojson.Unmarshal(b, m) }
