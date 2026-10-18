package hub

import (
	"github.com/karllee830/OpenHane/server/internal/pb"
)

// 端到端加密：服务端只中转加密后的密钥包，无法解开；只校验双方在同一个开启 E2EE 的房间。

const (
	maxKeyIndex     = 16
	maxKeyEncLen    = 64  // HPKE 封装的 X25519 临时公钥为 32 字节
	maxKeyCipherLen = 256 // 32 字节媒体密钥 + AEAD 标签，留足余量
)

func (h *Hub) handleSendKeyPackage(s *Session, r *pb.SendKeyPackage) *pb.Response {
	room := h.rooms[s.RoomID]
	t := h.sessions[r.GetToSessionId()]
	switch {
	case room == nil || r.GetRoomId() != s.RoomID || !room.e2ee(h.Settings()):
		return errResp(pb.ErrorCode_ERROR_CODE_INVALID_ARGUMENT, "not in an end-to-end encrypted room")
	case t == nil || t.RoomID != s.RoomID || t == s:
		return errResp(pb.ErrorCode_ERROR_CODE_INVALID_ARGUMENT, "recipient is not in this room")
	case r.GetKeyIndex() >= maxKeyIndex || len(r.GetEnc()) == 0 || len(r.GetEnc()) > maxKeyEncLen ||
		len(r.GetCiphertext()) == 0 || len(r.GetCiphertext()) > maxKeyCipherLen:
		return errResp(pb.ErrorCode_ERROR_CODE_INVALID_ARGUMENT, "malformed key package")
	}
	t.sendEvent(&pb.Event{Body: &pb.Event_KeyPackage{KeyPackage: &pb.KeyPackage{
		FromSessionId: s.ID, RoomId: s.RoomID, KeyIndex: r.GetKeyIndex(), Enc: r.GetEnc(), Ciphertext: r.GetCiphertext(),
	}}})
	return &pb.Response{Body: &pb.Response_SendKeyPackage{SendKeyPackage: &pb.SendKeyPackageResult{}}}
}

// enforceE2EE 在房间的加密状态变化后执行：现有屏幕共享结束（加密房间的编码器限制不同，由共享者重新开始），
// 不支持 E2EE 的成员被送回主会议；主会议本身开启加密时断开他们。
func (h *Hub) enforceE2EE(room *Room) {
	on := room.e2ee(h.Settings())
	for _, s := range h.sessions {
		if s.RoomID != room.ID {
			continue
		}
		h.releaseShare(s, true)
		if !on || s.proto().GetSupportsE2Ee() {
			continue
		}
		if room.ID != MainRoomID && !h.rooms[MainRoomID].e2ee(h.Settings()) {
			h.moveSession(s, h.rooms[MainRoomID], pb.MoveReason_MOVE_REASON_E2EE_UNSUPPORTED, nil)
		} else {
			h.disconnect(s, pbErr(pb.ErrorCode_ERROR_CODE_E2EE_UNSUPPORTED, "this server requires end-to-end encryption"), "e2ee unsupported")
		}
	}
	h.roomUpdated(room)
}
