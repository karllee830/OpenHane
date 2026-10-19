package hub

import (
	"context"
	"time"

	"github.com/karllee830/OpenHane/server/internal/chatimage"
	"github.com/karllee830/OpenHane/server/internal/settings"
)

const (
	// pendingImageTTL 是上传后多久内必须随消息发出，超时删掉
	pendingImageTTL = 10 * time.Minute
	// maxPendingImages 是每个会话最多同时有几张上传了还没发的图片
	maxPendingImages = 3
)

type pendingImage struct {
	session string
	room    string
	img     chatimage.Info
	timer   *time.Timer
}

// chatImageMaxBytes 是 ServerInfo 里告诉客户端的图片大小上限；0 表示不允许发送图片
func (h *Hub) chatImageMaxBytes(s *settings.Settings) uint32 {
	if h.opt.Images == nil {
		return 0
	}
	return uint32(s.ChatImageMaxMB) << 20
}

// deleteImage 删除图片文件（放到 Hub 协程外做，不阻塞）
func (h *Hub) deleteImage(room, id string) {
	if h.opt.Images != nil {
		go h.opt.Images.Delete(room, id)
	}
}

func (h *Hub) dropPendingImages(match func(*pendingImage) bool) {
	for id, p := range h.pendingImages {
		if match(p) {
			p.timer.Stop()
			delete(h.pendingImages, id)
			h.deleteImage(p.room, id)
		}
	}
}

// dropRoomImages 在临时房间关闭时删掉它的所有图片
func (h *Hub) dropRoomImages(room string) {
	h.dropPendingImages(func(p *pendingImage) bool { return p.room == room })
	for id, r := range h.memImages {
		if r == room {
			delete(h.memImages, id)
		}
	}
	if h.opt.Images != nil {
		go h.opt.Images.DeleteRoom(room)
	}
}

// ---------- chatimage.Access：HTTP 接口按会话凭据检查权限 ----------

var _ chatimage.Access = (*Hub)(nil)

// sessionByToken 在 Hub 协程中查找凭据对应的会话，找到时执行 f
func (h *Hub) sessionByToken(ctx context.Context, token string, f func(s *Session)) error {
	return h.call(ctx, func() {
		if s := h.byAPI[token]; token != "" && s != nil {
			f(s)
		}
	})
}

func (h *Hub) BeginUpload(ctx context.Context, token, room string) (session string, maxBytes, quota int64, err error) {
	err = chatimage.ErrUnauthorized
	callErr := h.sessionByToken(ctx, token, func(s *Session) {
		st := h.Settings()
		pending := 0
		for _, p := range h.pendingImages {
			if p.session == s.ID {
				pending++
			}
		}
		switch {
		case h.chatImageMaxBytes(st) == 0:
			err = chatimage.ErrDisabled
		case s.RoomID != room:
			err = chatimage.ErrForbidden
		case pending >= maxPendingImages || !s.imageLimit.Allow(h.now()):
			err = chatimage.ErrRateLimited
		default:
			session, maxBytes, quota, err = s.ID, int64(st.ChatImageMaxMB)<<20, int64(st.ChatImageStorageMB)<<20, nil
		}
	})
	if callErr != nil {
		return "", 0, 0, callErr
	}
	return session, maxBytes, quota, err
}

func (h *Hub) FinishUpload(ctx context.Context, session, room string, img chatimage.Info) bool {
	ok := false
	err := h.call(ctx, func() {
		s := h.sessions[session]
		if s == nil || s.RoomID != room {
			return
		}
		p := &pendingImage{session: session, room: room, img: img}
		p.timer = time.AfterFunc(pendingImageTTL, func() {
			h.do(func() {
				if h.pendingImages[img.ID] == p {
					delete(h.pendingImages, img.ID)
					h.deleteImage(room, img.ID)
				}
			})
		})
		h.pendingImages[img.ID] = p
		ok = true
	})
	return err == nil && ok
}

func (h *Hub) CanRead(ctx context.Context, token, room string) bool {
	ok := false
	err := h.sessionByToken(ctx, token, func(s *Session) { ok = s.RoomID == room })
	return err == nil && ok
}
