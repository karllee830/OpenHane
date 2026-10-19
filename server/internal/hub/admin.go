package hub

import (
	"context"
	"errors"
	"sort"
	"strings"
	"time"

	"github.com/karllee830/OpenHane/server/internal/auth"
	"github.com/karllee830/OpenHane/server/internal/geoip"
	"github.com/karllee830/OpenHane/server/internal/pb"
	"github.com/karllee830/OpenHane/server/internal/perm"
	"github.com/karllee830/OpenHane/server/internal/settings"
	"github.com/karllee830/OpenHane/server/internal/store"
)

func bg() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), 5*time.Second)
}

// ---------- 设置 ----------

func (h *Hub) handleUpdateSettings(s *Session, c Conn, id uint32, u *pb.UpdateSettings) *pb.Response {
	if len(u.GetPatch()) == 0 {
		return errResp(pb.ErrorCode_ERROR_CODE_INVALID_ARGUMENT, "empty patch")
	}
	actor, ip := s.UID, s.RemoteIP.String()
	h.async(func() func() {
		next, keys, err := h.UpdateSettings(settings.Patch(u.GetPatch()), actor)
		if err != nil {
			reply(c, id, errResp(pb.ErrorCode_ERROR_CODE_INVALID_ARGUMENT, err.Error()))
			return nil
		}
		h.audit(actor, "settings.update", "", auditSettingsDetail(u.GetPatch()), ip)
		return func() {
			h.log.Info("settings updated", "by", actor, "keys", keys)
			reply(c, id, &pb.Response{Body: &pb.Response_UpdateSettings{UpdateSettings: &pb.UpdateSettingsResult{Values: next.Public()}}})
		}
	})
	return nil
}

// UpdateSettings 校验、持久化并应用一组设置修改，然后把变化推送给客户端。
// 可在任意协程调用（管理面板请求、本地管理套接字）。返回新快照和变化的键。
func (h *Hub) UpdateSettings(p settings.Patch, by string) (*settings.Settings, []string, error) {
	h.settingsMu.Lock()
	defer h.settingsMu.Unlock()
	cur := h.Settings()
	next, stored, err := cur.Apply(p, h.opt.HashPassword)
	if err != nil {
		return nil, nil, err
	}
	ctx, cancel := bg()
	defer cancel()
	if err := h.store.PutSettings(ctx, stored, by); err != nil {
		return nil, nil, err
	}
	h.settings.Store(next)
	keys := make([]string, 0, len(p))
	for k := range p {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	h.do(func() { h.onSettingsChanged(cur, next, keys) })
	return next, keys, nil
}

// onSettingsChanged 按变化的键推送事件：服务器信息、媒体策略、SFU 权限。
func (h *Hub) onSettingsChanged(old, next *settings.Settings, keys []string) {
	var info, policy, perms, rooms bool
	for _, k := range keys {
		switch {
		case k == "server.name" || k == "server.welcome_message" || k == settings.PasswordKey || k == "identity.min_security_level" || k == "rooms.create_min_role":
			info = true
		case k == "rooms.main_name":
			rooms = true
		case strings.HasPrefix(k, "audio.") || strings.HasPrefix(k, "camera.") || strings.HasPrefix(k, "screen.") ||
			strings.HasPrefix(k, "video.") || strings.HasPrefix(k, "media.") || strings.HasPrefix(k, "security.") || k == "join.force_mute":
			policy = true
			if k == "camera.enabled" && old.CameraEnabled != next.CameraEnabled {
				perms = true
			}
		}
	}
	if info {
		h.broadcast(nil, &pb.Event{Body: &pb.Event_ServerInfoUpdated{ServerInfoUpdated: &pb.ServerInfoUpdated{Info: h.ServerInfo()}}})
	}
	if rooms {
		main := h.rooms[MainRoomID]
		h.broadcast(nil, &pb.Event{Body: &pb.Event_RoomUpdated{RoomUpdated: &pb.RoomUpdated{Room: main.proto(next)}}})
	}
	if policy {
		for id := range h.rooms {
			h.pushPolicy(id)
		}
	}
	if perms {
		h.syncMediaPermissions()
	}
	h.revokeDisallowedShares()
	if old.SecurityE2EEPolicy != next.SecurityE2EEPolicy {
		// 端到端加密策略变化：各房间的加密状态可能随之变化（例如改为「强制」）
		for _, room := range h.rooms {
			if room.e2ee(old) != room.e2ee(next) {
				h.enforceE2EE(room)
			}
		}
	}
}

// syncMediaPermissions 把当前权限同步到 SFU（例如管理员关闭了摄像头）：服务端强制执行，客户端绕不过。
func (h *Hub) syncMediaPermissions() {
	for _, s := range h.sessions {
		h.syncPermission(s)
	}
}

// auditSettingsDetail 记录修改前后的值；密码类只记录「已修改」。
func auditSettingsDetail(p map[string]string) map[string]string {
	d := make(map[string]string, len(p))
	for k, v := range p {
		if k == settings.PasswordKey {
			v = "(changed)"
		}
		d[k] = v
	}
	return d
}

// ---------- 权限令牌 ----------

func tokenProto(t *store.PrivilegeToken) *pb.TokenInfo {
	return &pb.TokenInfo{
		Id: t.ID, Role: t.Role.Proto(), MaxUses: uint32(t.MaxUses), UsedCount: uint32(t.UsedCount),
		ExpiresAtMs: t.ExpiresAt, CreatedBy: t.CreatedBy, CreatedAtMs: t.CreatedAt, RevokedAtMs: t.RevokedAt, Note: t.Note,
	}
}

// CreatePrivilegeToken 生成并保存一个权限令牌，返回明文（只出现这一次）。
func CreatePrivilegeToken(ctx context.Context, st *store.Store, role perm.Role, maxUses int, ttl time.Duration, note, by string) (string, *store.PrivilegeToken, error) {
	if role != perm.Moderator && role != perm.Admin {
		return "", nil, errors.New("token role must be moderator or admin")
	}
	display, hash := auth.NewToken()
	t := &store.PrivilegeToken{ID: auth.NewTokenID(), Hash: hash, Role: role, MaxUses: maxUses, CreatedBy: by, Note: note}
	if ttl > 0 {
		t.ExpiresAt = time.Now().Add(ttl).UnixMilli()
	}
	if err := st.CreateToken(ctx, t); err != nil {
		return "", nil, err
	}
	return display, t, nil
}

func (h *Hub) handleCreateToken(s *Session, c Conn, id uint32, r *pb.CreateToken) *pb.Response {
	role, ok := perm.FromProto(r.GetRole())
	if !ok || role == perm.Member {
		return errResp(pb.ErrorCode_ERROR_CODE_INVALID_ARGUMENT, "role must be moderator or admin")
	}
	if len(r.GetNote()) > 200 {
		return errResp(pb.ErrorCode_ERROR_CODE_INVALID_ARGUMENT, "note too long")
	}
	actor, ip := s.UID, s.RemoteIP.String()
	h.async(func() func() {
		ctx, cancel := bg()
		defer cancel()
		plain, t, err := CreatePrivilegeToken(ctx, h.store, role, int(r.GetMaxUses()), time.Duration(r.GetExpiresInSec())*time.Second, r.GetNote(), actor)
		if err != nil {
			h.log.Error("create token failed", "err", err)
			reply(c, id, errInternal())
			return nil
		}
		h.audit(actor, "token.create", t.ID, map[string]any{"role": role.String(), "max_uses": t.MaxUses, "expires_at": t.ExpiresAt}, ip)
		reply(c, id, &pb.Response{Body: &pb.Response_CreateToken{CreateToken: &pb.CreateTokenResult{Token: plain, Info: tokenProto(t)}}})
		return nil
	})
	return nil
}

func (h *Hub) handleListTokens(c Conn, id uint32) *pb.Response {
	h.async(func() func() {
		ctx, cancel := bg()
		defer cancel()
		list, err := h.store.ListTokens(ctx)
		if err != nil {
			reply(c, id, errInternal())
			return nil
		}
		res := &pb.ListTokensResult{}
		for _, t := range list {
			res.Tokens = append(res.Tokens, tokenProto(t))
		}
		reply(c, id, &pb.Response{Body: &pb.Response_ListTokens{ListTokens: res}})
		return nil
	})
	return nil
}

func (h *Hub) handleRevokeToken(s *Session, c Conn, id uint32, r *pb.RevokeToken) *pb.Response {
	actor, ip := s.UID, s.RemoteIP.String()
	h.async(func() func() {
		ctx, cancel := bg()
		defer cancel()
		if err := h.store.RevokeToken(ctx, r.GetId()); err != nil {
			if errors.Is(err, store.ErrNotFound) {
				reply(c, id, errResp(pb.ErrorCode_ERROR_CODE_INVALID_ARGUMENT, "token not found or already revoked"))
			} else {
				reply(c, id, errInternal())
			}
			return nil
		}
		h.audit(actor, "token.revoke", r.GetId(), nil, ip)
		reply(c, id, &pb.Response{Body: &pb.Response_RevokeToken{RevokeToken: &pb.RevokeTokenResult{}}})
		return nil
	})
	return nil
}

// ---------- 用户与角色 ----------

func (h *Hub) handleSetRole(s *Session, c Conn, id uint32, r *pb.SetRole) *pb.Response {
	role, ok := perm.FromProto(r.GetRole())
	if !ok {
		return errResp(pb.ErrorCode_ERROR_CODE_INVALID_ARGUMENT, "invalid role")
	}
	actor, ip := s.UID, s.RemoteIP.String()
	h.async(func() func() {
		if err := h.SetRole(r.GetUid(), role); err != nil {
			switch {
			case errors.Is(err, store.ErrNotFound):
				reply(c, id, errResp(pb.ErrorCode_ERROR_CODE_INVALID_ARGUMENT, "unknown uid"))
			case errors.Is(err, store.ErrLastAdmin):
				reply(c, id, errResp(pb.ErrorCode_ERROR_CODE_INVALID_ARGUMENT, "server must keep at least one admin"))
			default:
				reply(c, id, errInternal())
			}
			return nil
		}
		h.audit(actor, "user.set_role", r.GetUid(), map[string]string{"role": role.String()}, ip)
		reply(c, id, &pb.Response{Body: &pb.Response_SetRole{SetRole: &pb.SetRoleResult{}}})
		return nil
	})
	return nil
}

// SetRole 修改角色并通知在线会话。可在任意协程调用（管理请求、本地管理套接字）。
func (h *Hub) SetRole(uid string, role perm.Role) error {
	ctx, cancel := bg()
	defer cancel()
	if err := h.store.SetRole(ctx, uid, role); err != nil {
		return err
	}
	h.do(func() { h.applyRole(uid, role) })
	return nil
}

func (h *Hub) handleListIdentities(s *Session, c Conn, id uint32, r *pb.ListIdentities) *pb.Response {
	role, _ := perm.FromProto(r.GetRole()) // 未指定 = 全部
	limit := int(r.GetLimit())
	if limit <= 0 {
		limit = 100
	}
	limit = min(limit, 500)
	h.async(func() func() {
		ctx, cancel := bg()
		defer cancel()
		list, total, err := h.store.ListIdentities(ctx, role, limit, int(r.GetOffset()))
		if err != nil {
			reply(c, id, errInternal())
			return nil
		}
		res := &pb.ListIdentitiesResult{Total: uint32(total)}
		for _, i := range list {
			res.Identities = append(res.Identities, &pb.Identity{
				Uid: i.UID, Role: i.Role.Proto(), LastNickname: i.Nickname, FirstSeenAtMs: i.FirstSeenAt,
				LastSeenAtMs: i.LastSeenAt, LastIp: i.LastIP, Note: i.Note,
			})
		}
		reply(c, id, &pb.Response{Body: &pb.Response_ListIdentities{ListIdentities: res}})
		return nil
	})
	return nil
}

// ---------- 会话连接信息 ----------

// rttConn 是能报告往返延迟的连接（signal.Conn）
type rttConn interface{ RTT() time.Duration }

func (h *Hub) handleSessionInfo(r *pb.GetSessionInfo) *pb.Response {
	t, ok := h.sessions[r.GetSessionId()]
	if !ok {
		return errResp(pb.ErrorCode_ERROR_CODE_INVALID_ARGUMENT, "unknown session")
	}
	res := &pb.GetSessionInfoResult{AppVersion: t.Client.GetAppVersion()}
	// 客户端自报的版本号，限制长度
	if r := []rune(res.AppVersion); len(r) > 32 {
		res.AppVersion = string(r[:32])
	}
	if rc, ok := t.conn.(rttConn); ok {
		if d := rc.RTT(); d > 0 {
			res.RttMs = uint32(max(d.Milliseconds(), 1))
		}
	}
	if ip := t.RemoteIP.Unmap(); ip.IsValid() {
		res.Ip = ip.String()
		if g := h.opt.GeoIP; g != nil {
			loc, err := g.Lookup(ip)
			switch {
			case err == nil:
				res.Country, res.Province, res.City, res.Isp, res.CountryCode = loc.Country, loc.Province, loc.City, loc.ISP, loc.CountryCode
			case errors.Is(err, geoip.ErrNoDB) && ip.Is6():
				res.Ipv6DbMissing = true
			}
		}
	}
	return &pb.Response{Body: &pb.Response_GetSessionInfo{GetSessionInfo: res}}
}

func (h *Hub) handleDownloadIPv6GeoDB(s *Session, c Conn, id uint32) *pb.Response {
	g := h.opt.GeoIP
	if g == nil {
		return errResp(pb.ErrorCode_ERROR_CODE_INVALID_ARGUMENT, "geoip disabled")
	}
	actor, ip := s.UID, s.RemoteIP.String()
	go func() {
		if err := g.DownloadV6(context.Background()); err != nil {
			h.log.Warn("geoip IPv6 download failed", "err", err)
			reply(c, id, errResp(pb.ErrorCode_ERROR_CODE_INTERNAL, err.Error()))
			return
		}
		h.audit(actor, "geoip.download", geoip.V6File, nil, ip)
		reply(c, id, &pb.Response{Body: &pb.Response_DownloadIpv6GeoDb{DownloadIpv6GeoDb: &pb.DownloadIPv6GeoDBResult{}}})
	}()
	return nil
}
