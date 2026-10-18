package hub

import (
	"context"
	"net/netip"

	"github.com/karllee830/OpenHane/server/internal/pb"
)

// Kick 断开所有满足 match 的会话（发送 Goodbye，不进入宽限期），返回断开的数量。
// 用于封禁立即生效。可在任意协程调用。
func (h *Hub) Kick(ctx context.Context, match func(uid string, ip netip.Addr) bool, reason *pb.Error) int {
	n := 0
	h.call(ctx, func() {
		for _, s := range h.sessions {
			if !match(s.UID, s.RemoteIP) {
				continue
			}
			if s.conn != nil {
				s.conn.Close(reason, false)
				s.conn = nil
			}
			h.removeSession(s, "kicked: "+reason.GetCode().String())
			n++
		}
	})
	return n
}

// Notice 向所有在线会话推送公告。
func (h *Hub) Notice(ctx context.Context, text string) {
	h.call(ctx, func() {
		h.broadcast(nil, &pb.Event{Body: &pb.Event_ServerNotice{ServerNotice: &pb.ServerNotice{Kind: pb.ServerNotice_KIND_ANNOUNCEMENT, Text: text}}})
	})
}

// Stats 是控制面的运行统计。
type Stats struct {
	Sessions     int `json:"sessions"`
	Reconnecting int `json:"reconnecting"`
	MediaOnline  int `json:"media_online"`
	Rooms        int `json:"rooms"`
	Admins       int `json:"admins_online"`
}

func (h *Hub) Stats(ctx context.Context) Stats {
	var st Stats
	h.call(ctx, func() {
		st.Rooms = len(h.rooms)
		for _, s := range h.sessions {
			st.Sessions++
			if s.conn == nil {
				st.Reconnecting++
			}
			if s.MediaOnline {
				st.MediaOnline++
			}
			if s.Role.String() == "admin" {
				st.Admins++
			}
		}
	})
	return st
}
