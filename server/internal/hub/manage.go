package hub

import (
	"context"
	"encoding/json"
	"errors"
	"net/netip"
	"strings"
	"time"

	"github.com/karllee830/OpenHane/server/internal/auth"
	"github.com/karllee830/OpenHane/server/internal/pb"
	"github.com/karllee830/OpenHane/server/internal/perm"
	"github.com/karllee830/OpenHane/server/internal/store"
)

// 管理员请求：封禁、审计日志、邀请码。数据库操作都在独立协程中执行。

func banProto(b *store.Ban) *pb.BanInfo {
	return &pb.BanInfo{Id: b.ID, Uid: b.UID, IpCidr: b.IPCIDR, Reason: b.Reason, CreatedBy: b.CreatedBy,
		CreatedAtMs: b.CreatedAt, ExpiresAtMs: b.ExpiresAt, Nickname: b.Nickname}
}

func (h *Hub) handleListBans(c Conn, id uint32) *pb.Response {
	h.async(func() func() {
		ctx, cancel := bg()
		defer cancel()
		list, err := h.store.ListBans(ctx)
		if err != nil {
			reply(c, id, errInternal())
			return nil
		}
		res := &pb.ListBansResult{}
		for _, b := range list {
			res.Bans = append(res.Bans, banProto(b))
		}
		reply(c, id, &pb.Response{Body: &pb.Response_ListBans{ListBans: res}})
		return nil
	})
	return nil
}

func (h *Hub) handleAddBan(s *Session, c Conn, id uint32, r *pb.AddBan) *pb.Response {
	ban := &store.Ban{UID: strings.TrimSpace(r.GetUid()), Reason: strings.TrimSpace(r.GetReason()), CreatedBy: s.UID}
	if cidr := strings.TrimSpace(r.GetIpCidr()); cidr != "" {
		p, err := netip.ParsePrefix(cidr)
		if err != nil {
			a, err2 := netip.ParseAddr(cidr)
			if err2 != nil {
				return errResp(pb.ErrorCode_ERROR_CODE_INVALID_ARGUMENT, "invalid IP or CIDR")
			}
			p = netip.PrefixFrom(a, a.BitLen())
		}
		ban.IPCIDR = p.Masked().String()
	}
	if ban.UID == "" && ban.IPCIDR == "" {
		return errResp(pb.ErrorCode_ERROR_CODE_INVALID_ARGUMENT, "a ban needs a UID or an IP")
	}
	// 不能封禁管理员（包括自己）：服务器必须至少保留一名管理员
	for _, o := range h.sessions {
		if o.UID == ban.UID && o.Role >= perm.Admin {
			return errDenied()
		}
	}
	if d := r.GetDurationSec(); d > 0 {
		ban.ExpiresAt = h.now().Add(time.Duration(d) * time.Second).UnixMilli()
	}
	h.addBan(s, ban, func(b *store.Ban, kicked int, err error) {
		if err != nil {
			reply(c, id, errInternal())
			return
		}
		h.audit(s.UID, "ban.add", b.UID+b.IPCIDR, map[string]any{"uid": b.UID, "ip": b.IPCIDR, "reason": b.Reason, "duration_sec": r.GetDurationSec(), "kicked": kicked}, s.RemoteIP.String())
		reply(c, id, &pb.Response{Body: &pb.Response_AddBan{AddBan: &pb.AddBanResult{Ban: banProto(b), Kicked: uint32(kicked)}}})
	})
	return nil
}

func (h *Hub) handleRemoveBan(s *Session, c Conn, id uint32, r *pb.RemoveBan) *pb.Response {
	actor, ip := s.UID, s.RemoteIP.String()
	h.async(func() func() {
		ctx, cancel := bg()
		defer cancel()
		if err := h.store.RemoveBan(ctx, r.GetId()); err != nil {
			if errors.Is(err, store.ErrNotFound) {
				reply(c, id, errResp(pb.ErrorCode_ERROR_CODE_INVALID_ARGUMENT, "no such ban"))
			} else {
				reply(c, id, errInternal())
			}
			return nil
		}
		h.audit(actor, "ban.remove", "", map[string]int64{"id": r.GetId()}, ip)
		reply(c, id, &pb.Response{Body: &pb.Response_RemoveBan{RemoveBan: &pb.RemoveBanResult{}}})
		return nil
	})
	return nil
}

func (h *Hub) handleAuditLog(c Conn, id uint32, r *pb.GetAuditLog) *pb.Response {
	limit := int(r.GetLimit())
	if limit <= 0 || limit > 200 {
		limit = 100
	}
	h.async(func() func() {
		ctx, cancel := bg()
		defer cancel()
		list, err := h.store.QueryAudit(ctx, store.AuditQuery{BeforeID: r.GetBeforeId(), Limit: limit + 1, ActionPrefix: r.GetActionPrefix(), ActorUID: r.GetActorUid()})
		if err != nil {
			reply(c, id, errInternal())
			return nil
		}
		res := &pb.GetAuditLogResult{HasMore: len(list) > limit}
		if res.HasMore {
			list = list[:limit]
		}
		for _, e := range list {
			detail := ""
			if raw, ok := e.Detail.(json.RawMessage); ok {
				detail = string(raw)
			}
			res.Entries = append(res.Entries, &pb.AuditEntry{Id: e.ID, AtMs: e.At, ActorUid: e.ActorUID, Action: e.Action,
				Target: e.Target, Detail: detail, Ip: e.IP, ActorName: e.ActorName})
		}
		reply(c, id, &pb.Response{Body: &pb.Response_GetAuditLog{GetAuditLog: res}})
		return nil
	})
	return nil
}

func inviteProto(inv *store.Invite) *pb.InviteInfo {
	return &pb.InviteInfo{Code: inv.Code, BypassPassword: inv.BypassPassword, Role: inv.Role.Proto(), MaxUses: uint32(inv.MaxUses),
		UsedCount: uint32(inv.UsedCount), ExpiresAtMs: inv.ExpiresAt, CreatedBy: inv.CreatedBy, CreatedAtMs: inv.CreatedAt}
}

func (h *Hub) handleCreateInvite(s *Session, c Conn, id uint32, r *pb.CreateInvite) *pb.Response {
	role := perm.Member
	if r.GetRole() != pb.Role_ROLE_UNSPECIFIED && r.GetRole() != pb.Role_ROLE_MEMBER {
		var ok bool
		if role, ok = perm.FromProto(r.GetRole()); !ok {
			return errResp(pb.ErrorCode_ERROR_CODE_INVALID_ARGUMENT, "invalid role")
		}
	}
	inv := &store.Invite{Code: auth.RandomID(12), BypassPassword: r.GetBypassPassword(), Role: role, MaxUses: int(r.GetMaxUses()), CreatedBy: s.UID}
	if d := r.GetExpiresInSec(); d > 0 {
		inv.ExpiresAt = h.now().Add(time.Duration(d) * time.Second).UnixMilli()
	}
	actor, ip := s.UID, s.RemoteIP.String()
	h.async(func() func() {
		ctx, cancel := bg()
		defer cancel()
		if err := h.store.CreateInvite(ctx, inv); err != nil {
			reply(c, id, errInternal())
			return nil
		}
		h.audit(actor, "invite.create", inv.Code, map[string]any{"bypass_password": inv.BypassPassword, "role": inv.Role.String(), "max_uses": inv.MaxUses}, ip)
		reply(c, id, &pb.Response{Body: &pb.Response_CreateInvite{CreateInvite: &pb.CreateInviteResult{Invite: inviteProto(inv)}}})
		return nil
	})
	return nil
}

func (h *Hub) handleListInvites(c Conn, id uint32) *pb.Response {
	h.async(func() func() {
		ctx, cancel := bg()
		defer cancel()
		list, err := h.store.ListInvites(ctx)
		if err != nil {
			reply(c, id, errInternal())
			return nil
		}
		res := &pb.ListInvitesResult{}
		for _, inv := range list {
			res.Invites = append(res.Invites, inviteProto(inv))
		}
		reply(c, id, &pb.Response{Body: &pb.Response_ListInvites{ListInvites: res}})
		return nil
	})
	return nil
}

func (h *Hub) handleRevokeInvite(s *Session, c Conn, id uint32, r *pb.RevokeInvite) *pb.Response {
	actor, ip := s.UID, s.RemoteIP.String()
	h.async(func() func() {
		ctx, cancel := bg()
		defer cancel()
		if err := h.store.DeleteInvite(ctx, r.GetCode()); err != nil {
			if errors.Is(err, store.ErrNotFound) {
				reply(c, id, errResp(pb.ErrorCode_ERROR_CODE_INVALID_ARGUMENT, "no such invite"))
			} else {
				reply(c, id, errInternal())
			}
			return nil
		}
		h.audit(actor, "invite.revoke", r.GetCode(), nil, ip)
		reply(c, id, &pb.Response{Body: &pb.Response_RevokeInvite{RevokeInvite: &pb.RevokeInviteResult{}}})
		return nil
	})
	return nil
}

// UseInvite 在握手时消耗邀请码（可在任意协程调用）。返回邀请码的内容；无效、过期或用完时返回错误。
func (h *Hub) UseInvite(ctx context.Context, code string) (*store.Invite, error) {
	return h.store.UseInvite(ctx, code)
}
