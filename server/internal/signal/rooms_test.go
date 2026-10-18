package signal_test

import (
	"crypto/rand"
	"strings"
	"testing"
	"time"

	"github.com/karllee830/OpenHane/server/internal/client"
	"github.com/karllee830/OpenHane/server/internal/hub"
	"github.com/karllee830/OpenHane/server/internal/media"
	"github.com/karllee830/OpenHane/server/internal/pb"
	"github.com/karllee830/OpenHane/server/internal/perm"
	"github.com/karllee830/OpenHane/server/internal/store"
)

// promote 用权限令牌把 c 提升为 role。
func (e *env) promote(c *client.Client, role perm.Role) {
	e.t.Helper()
	plain, _, err := hub.CreatePrivilegeToken(ctx(e.t), e.store, role, 1, 0, "", store.SystemCreator)
	if err != nil {
		e.t.Fatal(err)
	}
	if _, err := c.Request(ctx(e.t), &pb.Request{Body: &pb.Request_RedeemToken{RedeemToken: &pb.RedeemToken{Token: plain}}}); err != nil {
		e.t.Fatal(err)
	}
}

// online 模拟 SFU 的 webhook：c 已连上 room 的媒体
func (e *env) online(c *client.Client, room string) {
	e.media.Emit(media.Event{Kind: media.ParticipantJoined, Room: room, Identity: mediaID(c)})
}

func mediaID(c *client.Client) string { return c.Welcome.GetUid() + ":" + c.Welcome.GetSessionId() }

func req(t *testing.T, c *client.Client, body any) (*pb.Response, error) {
	t.Helper()
	r := &pb.Request{}
	switch b := body.(type) {
	case *pb.CreateRoom:
		r.Body = &pb.Request_CreateRoom{CreateRoom: b}
	case *pb.UpdateRoom:
		r.Body = &pb.Request_UpdateRoom{UpdateRoom: b}
	case *pb.CloseRoom:
		r.Body = &pb.Request_CloseRoom{CloseRoom: b}
	case *pb.JoinRoom:
		r.Body = &pb.Request_JoinRoom{JoinRoom: b}
	case *pb.MoveParticipant:
		r.Body = &pb.Request_MoveParticipant{MoveParticipant: b}
	case *pb.RecallAll:
		r.Body = &pb.Request_RecallAll{RecallAll: b}
	case *pb.Moderate:
		r.Body = &pb.Request_Moderate{Moderate: b}
	case *pb.MuteAll:
		r.Body = &pb.Request_MuteAll{MuteAll: b}
	case *pb.SendKeyPackage:
		r.Body = &pb.Request_SendKeyPackage{SendKeyPackage: b}
	case *pb.CreateInvite:
		r.Body = &pb.Request_CreateInvite{CreateInvite: b}
	case *pb.ListInvites:
		r.Body = &pb.Request_ListInvites{ListInvites: b}
	case *pb.ListBans:
		r.Body = &pb.Request_ListBans{ListBans: b}
	case *pb.AddBan:
		r.Body = &pb.Request_AddBan{AddBan: b}
	case *pb.RemoveBan:
		r.Body = &pb.Request_RemoveBan{RemoveBan: b}
	case *pb.GetAuditLog:
		r.Body = &pb.Request_GetAuditLog{GetAuditLog: b}
	case *pb.UpdateSettings:
		r.Body = &pb.Request_UpdateSettings{UpdateSettings: b}
	case *pb.RequestScreenShare:
		r.Body = &pb.Request_RequestScreenShare{RequestScreenShare: b}
	default:
		t.Fatalf("unsupported request %T", body)
	}
	return c.Request(ctx(t), r)
}

func wantCode(t *testing.T, err error, code pb.ErrorCode) {
	t.Helper()
	if client.Code(err) != code {
		t.Fatalf("want %v, got %v", code, err)
	}
}

func hasSource(p media.Permission, src media.Source) bool {
	for _, s := range p.Sources {
		if s == src {
			return true
		}
	}
	return false
}

func TestTemporaryRoomLifecycle(t *testing.T) {
	e := setup(t)
	mod := e.mustDial(1, "Mod")
	bob := e.mustDial(2, "Bob")
	carol := e.mustDial(3, "Carol")
	mod.WaitEvent(ctx(t), isJoined)

	// 默认只有主持人以上可以建房
	_, err := req(t, bob, &pb.CreateRoom{Name: "私聊"})
	wantCode(t, err, pb.ErrorCode_ERROR_CODE_PERMISSION_DENIED)
	e.promote(mod, perm.Moderator)

	resp, err := req(t, mod, &pb.CreateRoom{Name: "设计评审", Password: "pw", Capacity: 2, Join: true})
	if err != nil {
		t.Fatal(err)
	}
	room := resp.GetCreateRoom().GetRoom()
	if !strings.HasPrefix(room.GetId(), "r_") || !room.GetHasPassword() || resp.GetCreateRoom().GetJoined().GetRoomId() != room.GetId() {
		t.Fatalf("create: %v", resp)
	}
	if !strings.HasPrefix(resp.GetCreateRoom().GetJoined().GetMedia().GetToken(), "fake:"+room.GetId()+":") || !e.media.HasRoom(room.GetId()) {
		t.Fatal("media room not created / token not for new room")
	}
	if _, err := bob.WaitEvent(ctx(t), func(ev *pb.Event) bool { return ev.GetRoomCreated().GetRoom().GetId() == room.GetId() }); err != nil {
		t.Fatal(err)
	}

	// 进入规则：密码、人数上限、锁定
	_, err = req(t, bob, &pb.JoinRoom{RoomId: room.GetId(), Password: "nope"})
	wantCode(t, err, pb.ErrorCode_ERROR_CODE_ROOM_PASSWORD_INVALID)
	resp, err = req(t, bob, &pb.JoinRoom{RoomId: room.GetId(), Password: "pw"})
	if err != nil || resp.GetJoinRoom().GetRoomId() != room.GetId() {
		t.Fatal(resp, err)
	}
	_, err = req(t, carol, &pb.JoinRoom{RoomId: room.GetId(), Password: "pw"})
	wantCode(t, err, pb.ErrorCode_ERROR_CODE_ROOM_FULL)
	if _, err := req(t, mod, &pb.UpdateRoom{RoomId: room.GetId(), Capacity: new(uint32), Locked: ptr(true)}); err != nil {
		t.Fatal(err)
	}
	_, err = req(t, carol, &pb.JoinRoom{RoomId: room.GetId(), Password: "pw"})
	wantCode(t, err, pb.ErrorCode_ERROR_CODE_ROOM_LOCKED)
	// 普通成员不能修改别人的房间
	_, err = req(t, bob, &pb.UpdateRoom{RoomId: room.GetId(), Name: ptr("x")})
	wantCode(t, err, pb.ErrorCode_ERROR_CODE_PERMISSION_DENIED)

	// 主持人把 Carol 移进锁定的房间（忽略锁定）：Carol 收到 YouWereMoved 和新房间的媒体令牌
	if _, err := req(t, mod, &pb.MoveParticipant{SessionId: carol.Welcome.GetSessionId(), RoomId: room.GetId()}); err != nil {
		t.Fatal(err)
	}
	ev, err := carol.WaitEvent(ctx(t), func(ev *pb.Event) bool { return ev.GetYouWereMoved() != nil })
	if err != nil || ev.GetYouWereMoved().GetReason() != pb.MoveReason_MOVE_REASON_MOVED || ev.GetYouWereMoved().GetByName() != "Mod" ||
		!strings.HasPrefix(ev.GetYouWereMoved().GetJoined().GetMedia().GetToken(), "fake:"+room.GetId()+":") {
		t.Fatal(ev, err)
	}

	// 关闭房间：所有人回到主会议，房间从列表中消失
	if _, err := req(t, mod, &pb.CloseRoom{RoomId: room.GetId()}); err != nil {
		t.Fatal(err)
	}
	ev, err = bob.WaitEvent(ctx(t), func(ev *pb.Event) bool { return ev.GetYouWereMoved() != nil })
	if err != nil || ev.GetYouWereMoved().GetReason() != pb.MoveReason_MOVE_REASON_ROOM_CLOSED || ev.GetYouWereMoved().GetRoomId() != "main" ||
		ev.GetYouWereMoved().GetFromRoomName() != "设计评审" {
		t.Fatal(ev, err)
	}
	if _, err := bob.WaitEvent(ctx(t), func(ev *pb.Event) bool { return ev.GetRoomClosed().GetRoomId() == room.GetId() }); err != nil {
		t.Fatal(err)
	}
	if _, err := req(t, mod, &pb.CloseRoom{RoomId: "main"}); client.Code(err) != pb.ErrorCode_ERROR_CODE_INVALID_ARGUMENT {
		t.Fatal(err)
	}

	// 空置超时自动关闭（设置为 0 秒：没人进入就关闭）
	resp, err = req(t, mod, &pb.CreateRoom{Name: "临时", EmptyTimeoutSec: new(uint32)})
	if err != nil {
		t.Fatal(err)
	}
	id := resp.GetCreateRoom().GetRoom().GetId()
	if _, err := bob.WaitEvent(ctx(t), func(ev *pb.Event) bool { return ev.GetRoomClosed().GetRoomId() == id }); err != nil {
		t.Fatal("empty room should close", err)
	}
}

func ptr[T any](v T) *T { return &v }

func TestRoomSwitchMediaAndShares(t *testing.T) {
	e := setup(t)
	mod := e.mustDial(1, "Mod")
	bob := e.mustDial(2, "Bob")
	e.promote(mod, perm.Moderator)
	e.online(bob, "main")
	if _, err := mod.WaitEvent(ctx(t), func(ev *pb.Event) bool { return ev.GetParticipantUpdated().GetParticipant().GetMediaConnected() }); err != nil {
		t.Fatal(err)
	}
	if _, err := req(t, bob, &pb.RequestScreenShare{}); err != nil {
		t.Fatal(err)
	}
	resp, _ := req(t, mod, &pb.CreateRoom{Name: "分组 1"})
	room := resp.GetCreateRoom().GetRoom().GetId()
	if _, err := req(t, bob, &pb.JoinRoom{RoomId: room}); err != nil {
		t.Fatal(err)
	}
	// 共享许可绑定在房间上：切换后自动结束；旧房间稍后的「离开」事件不影响新房间的状态
	if _, err := mod.WaitEvent(ctx(t), func(ev *pb.Event) bool {
		return ev.GetShareStateChanged().GetRoomId() == "main" && len(ev.GetShareStateChanged().GetShares()) == 0
	}); err != nil {
		t.Fatal(err)
	}
	e.online(bob, room)
	e.media.Emit(media.Event{Kind: media.ParticipantLeft, Room: "main", Identity: mediaID(bob)})
	if _, err := mod.WaitEvent(ctx(t), func(ev *pb.Event) bool {
		p := ev.GetParticipantUpdated().GetParticipant()
		return p.GetSessionId() == bob.Welcome.GetSessionId() && p.GetRoomId() == room && p.GetMediaConnected()
	}); err != nil {
		t.Fatal(err)
	}
	// 旧 SFU 房间中的连接在宽限后被移除
	deadline := time.Now().Add(5 * time.Second)
	for !strings.Contains(strings.Join(e.media.RemovedList(), ","), "main/"+mediaID(bob)) {
		if time.Now().After(deadline) {
			t.Fatalf("old media connection not removed: %v", e.media.RemovedList())
		}
		time.Sleep(50 * time.Millisecond)
	}
	// 全员召回
	resp, err := req(t, mod, &pb.RecallAll{})
	if err != nil || resp.GetRecallAll().GetMoved() != 1 {
		t.Fatal(resp, err)
	}
	ev, err := bob.WaitEvent(ctx(t), func(ev *pb.Event) bool { return ev.GetYouWereMoved() != nil })
	if err != nil || ev.GetYouWereMoved().GetReason() != pb.MoveReason_MOVE_REASON_RECALLED {
		t.Fatal(ev, err)
	}
}

func TestModeration(t *testing.T) {
	e := setup(t)
	admin := e.mustDial(1, "Admin")
	mod := e.mustDial(2, "Mod")
	bob := e.mustDial(3, "Bob")
	e.promote(admin, perm.Admin)
	e.promote(mod, perm.Moderator)
	e.online(bob, "main")
	if _, err := mod.WaitEvent(ctx(t), func(ev *pb.Event) bool { return ev.GetParticipantUpdated().GetParticipant().GetMediaConnected() }); err != nil {
		t.Fatal(err)
	}
	bobID := bob.Welcome.GetSessionId()
	moderate := func(c *client.Client, target string, a pb.ModerationAction, extra ...func(*pb.Moderate)) error {
		m := &pb.Moderate{SessionId: target, Action: a, Reason: "测试"}
		for _, f := range extra {
			f(m)
		}
		_, err := req(t, c, m)
		return err
	}

	// 成员不能管理别人；主持人不能管理主持人和管理员
	wantCode(t, moderate(bob, mod.Welcome.GetSessionId(), pb.ModerationAction_MODERATION_ACTION_FORCE_MUTE), pb.ErrorCode_ERROR_CODE_PERMISSION_DENIED)
	wantCode(t, moderate(mod, admin.Welcome.GetSessionId(), pb.ModerationAction_MODERATION_ACTION_KICK), pb.ErrorCode_ERROR_CODE_PERMISSION_DENIED)

	// 强制静音：SFU 上收回麦克风权限，当事人收到提示；被篡改的客户端也无法再发布麦克风
	if err := moderate(mod, bobID, pb.ModerationAction_MODERATION_ACTION_FORCE_MUTE); err != nil {
		t.Fatal(err)
	}
	if ev, err := bob.WaitEvent(ctx(t), func(ev *pb.Event) bool { return ev.GetModerationNotice() != nil }); err != nil ||
		ev.GetModerationNotice().GetAction() != pb.ModerationAction_MODERATION_ACTION_FORCE_MUTE || ev.GetModerationNotice().GetByName() != "Mod" {
		t.Fatal(ev, err)
	}
	waitPerm(t, e, "main", mediaID(bob), func(p media.Permission) bool { return !hasSource(p, media.SourceMicrophone) })
	if _, err := mod.WaitEvent(ctx(t), func(ev *pb.Event) bool { return ev.GetParticipantUpdated().GetParticipant().GetForceMuted() }); err != nil {
		t.Fatal(err)
	}
	if err := moderate(mod, bobID, pb.ModerationAction_MODERATION_ACTION_UNMUTE); err != nil {
		t.Fatal(err)
	}
	waitPerm(t, e, "main", mediaID(bob), func(p media.Permission) bool { return hasSource(p, media.SourceMicrophone) })

	// 停止共享
	if _, err := req(t, bob, &pb.RequestScreenShare{}); err != nil {
		t.Fatal(err)
	}
	if err := moderate(mod, bobID, pb.ModerationAction_MODERATION_ACTION_STOP_SHARE); err != nil {
		t.Fatal(err)
	}
	waitPerm(t, e, "main", mediaID(bob), func(p media.Permission) bool { return !hasSource(p, media.SourceScreenShare) })

	// 主持人最长封禁 24 小时
	wantCode(t, moderate(mod, bobID, pb.ModerationAction_MODERATION_ACTION_BAN), pb.ErrorCode_ERROR_CODE_PERMISSION_DENIED)

	// 踢出：Goodbye 带原因和操作者；可以重连
	if err := moderate(mod, bobID, pb.ModerationAction_MODERATION_ACTION_KICK); err != nil {
		t.Fatal(err)
	}
	g, err := bob.WaitGoodbye(ctx(t))
	if err != nil || g.GetError().GetCode() != pb.ErrorCode_ERROR_CODE_KICKED || g.GetError().GetByName() != "Mod" || g.GetError().GetReason() != "测试" || g.GetReconnect() {
		t.Fatal(g, err)
	}
	bob = e.mustDial(3, "Bob")

	// 封禁 1 小时：断开并拒绝重连
	if err := moderate(mod, bob.Welcome.GetSessionId(), pb.ModerationAction_MODERATION_ACTION_BAN, func(m *pb.Moderate) { m.DurationSec = 3600 }); err != nil {
		t.Fatal(err)
	}
	if g, err := bob.WaitGoodbye(ctx(t)); err != nil || g.GetError().GetCode() != pb.ErrorCode_ERROR_CODE_BANNED {
		t.Fatal(g, err)
	}
	_, err = e.dial(3, "Bob")
	wantCode(t, err, pb.ErrorCode_ERROR_CODE_BANNED)

	// 管理员解封后可以进入
	resp, err := req(t, admin, &pb.ListBans{})
	if err != nil || len(resp.GetListBans().GetBans()) != 1 || resp.GetListBans().GetBans()[0].GetNickname() != "Bob" {
		t.Fatal(resp, err)
	}
	if _, err := req(t, admin, &pb.RemoveBan{Id: resp.GetListBans().GetBans()[0].GetId()}); err != nil {
		t.Fatal(err)
	}
	bob = e.mustDial(3, "Bob")

	// 审计日志：能按操作类型筛选，带操作者昵称
	var entries []*pb.AuditEntry
	deadline := time.Now().Add(3 * time.Second)
	for len(entries) < 4 && time.Now().Before(deadline) {
		resp, err := req(t, admin, &pb.GetAuditLog{ActionPrefix: "moderate."})
		if err != nil {
			t.Fatal(err)
		}
		entries = resp.GetGetAuditLog().GetEntries()
		time.Sleep(50 * time.Millisecond)
	}
	if len(entries) < 4 || entries[0].GetAction() != "moderate.ban" || entries[0].GetActorName() != "Mod" {
		t.Fatalf("audit: %v", entries)
	}
	_, err = req(t, mod, &pb.GetAuditLog{})
	wantCode(t, err, pb.ErrorCode_ERROR_CODE_PERMISSION_DENIED)
}

func TestRoomHostAndMuteAll(t *testing.T) {
	e := setup(t)
	admin := e.mustDial(1, "Admin")
	host := e.mustDial(2, "Host")
	bob := e.mustDial(3, "Bob")
	e.promote(admin, perm.Admin)
	// 允许成员建房：建房者在自己的房间里是房间主持
	if _, err := req(t, admin, &pb.UpdateSettings{Patch: map[string]string{"rooms.create_min_role": `"member"`}}); err != nil {
		t.Fatal(err)
	}
	resp, err := req(t, host, &pb.CreateRoom{Name: "小组", Join: true, Overrides: &pb.RoomOverrides{ScreenModeratorOnly: true}})
	if err != nil {
		t.Fatal(err)
	}
	room := resp.GetCreateRoom().GetRoom().GetId()
	// 房间主持有共享权限（仅主持人可共享），普通成员没有
	if !resp.GetCreateRoom().GetJoined().GetPolicy().GetScreen().GetAllowed() {
		t.Fatal("room host should be allowed to share")
	}
	resp, err = req(t, bob, &pb.JoinRoom{RoomId: room})
	if err != nil || resp.GetJoinRoom().GetPolicy().GetScreen().GetAllowed() {
		t.Fatal("member should not be allowed to share in a moderator-only room", resp, err)
	}
	_, err = req(t, bob, &pb.RequestScreenShare{})
	wantCode(t, err, pb.ErrorCode_ERROR_CODE_PERMISSION_DENIED)

	// 房间主持可以静音本房间的成员，但不能踢出（服务器级操作）
	resp, err = req(t, host, &pb.MuteAll{RoomId: room})
	if err != nil || resp.GetMuteAll().GetMuted() != 1 {
		t.Fatal(resp, err)
	}
	_, err = req(t, host, &pb.Moderate{SessionId: bob.Welcome.GetSessionId(), Action: pb.ModerationAction_MODERATION_ACTION_KICK})
	wantCode(t, err, pb.ErrorCode_ERROR_CODE_PERMISSION_DENIED)
	// 房间级静音：回到主会议后解除
	if _, err := req(t, bob, &pb.JoinRoom{RoomId: "main"}); err != nil {
		t.Fatal(err)
	}
	if _, err := admin.WaitEvent(ctx(t), func(ev *pb.Event) bool {
		p := ev.GetParticipantUpdated().GetParticipant()
		return p.GetSessionId() == bob.Welcome.GetSessionId() && p.GetRoomId() == "main" && !p.GetForceMuted()
	}); err != nil {
		t.Fatal(err)
	}

	e.online(bob, "main")
	if _, err := admin.WaitEvent(ctx(t), func(ev *pb.Event) bool {
		p := ev.GetParticipantUpdated().GetParticipant()
		return p.GetSessionId() == bob.Welcome.GetSessionId() && p.GetMediaConnected()
	}); err != nil {
		t.Fatal(err)
	}

	// 主会议的覆盖由主持人以上修改，并持久化
	_, err = req(t, host, &pb.UpdateRoom{RoomId: "main", Overrides: &pb.RoomOverrides{CameraModeratorOnly: true}})
	wantCode(t, err, pb.ErrorCode_ERROR_CODE_PERMISSION_DENIED)
	if _, err := req(t, admin, &pb.UpdateRoom{RoomId: "main", Overrides: &pb.RoomOverrides{CameraModeratorOnly: true, AudioMaxKbps: 24}}); err != nil {
		t.Fatal(err)
	}
	ev, err := bob.WaitEvent(ctx(t), func(ev *pb.Event) bool {
		return ev.GetPolicyUpdated() != nil && !ev.GetPolicyUpdated().GetPolicy().GetCamera().GetAllowed()
	})
	if err != nil || ev.GetPolicyUpdated().GetPolicy().GetAudio().GetMaxBitrateBps() != 24000 {
		t.Fatal(ev, err)
	}
	waitPerm(t, e, "main", mediaID(bob), func(p media.Permission) bool { return !hasSource(p, media.SourceCamera) })
	deadline := time.Now().Add(3 * time.Second)
	for {
		v, _ := e.store.GetMeta(ctx(t), "room.main")
		if strings.Contains(v, "cameraModeratorOnly") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("main room overrides not persisted: %q", v)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestInvites(t *testing.T) {
	e := setup(t)
	admin := e.mustDial(1, "Admin")
	e.promote(admin, perm.Admin)
	if _, err := req(t, admin, &pb.UpdateSettings{Patch: map[string]string{"server.password": `"secret"`}}); err != nil {
		t.Fatal(err)
	}
	resp, err := req(t, admin, &pb.CreateInvite{MaxUses: 1, BypassPassword: true, Role: pb.Role_ROLE_MODERATOR})
	if err != nil {
		t.Fatal(err)
	}
	code := resp.GetCreateInvite().GetInvite().GetCode()
	_, err = e.dial(2, "Bob")
	wantCode(t, err, pb.ErrorCode_ERROR_CODE_PASSWORD_REQUIRED)
	// 握手因其他原因被拒（这里是昵称不合法）时，邀请码不扣减次数
	_, err = e.dial(2, "  ", func(o *client.Options) { o.InviteCode = code })
	wantCode(t, err, pb.ErrorCode_ERROR_CODE_NICKNAME_INVALID)
	// 免密邀请码：不需要密码，并获得附带的角色
	bob, err := e.dial(2, "Bob", func(o *client.Options) { o.InviteCode = code })
	if err != nil || bob.Welcome.GetRole() != pb.Role_ROLE_MODERATOR {
		t.Fatal(bob, err)
	}
	bob.Close()
	// 用完之后按没有邀请码处理
	_, err = e.dial(3, "Carol", func(o *client.Options) { o.InviteCode = code })
	wantCode(t, err, pb.ErrorCode_ERROR_CODE_PASSWORD_REQUIRED)
	resp, err = req(t, admin, &pb.ListInvites{})
	if err != nil || resp.GetListInvites().GetInvites()[0].GetUsedCount() != 1 {
		t.Fatal(resp, err)
	}
}

func TestE2EERoomsAndKeyRelay(t *testing.T) {
	e := setup(t)
	admin := e.mustDial(1, "Admin", func(o *client.Options) { o.E2EE = true })
	alice := e.mustDial(2, "Alice", func(o *client.Options) { o.E2EE = true })
	legacy := e.mustDial(3, "Legacy")
	e.promote(admin, perm.Admin)
	if pk := alice.Welcome.GetSnapshot(); pk == nil {
		t.Fatal("no snapshot")
	}
	// 成员列表中带身份公钥和签名过的 E2EE 公钥
	for _, p := range admin.Welcome.GetSnapshot().GetParticipants() {
		if p.GetSessionId() == admin.Welcome.GetSessionId() && (len(p.GetPublicKey()) != 32 || len(p.GetE2EeKey().GetPublicKey()) != 32 || !p.GetSupportsE2Ee()) {
			t.Fatalf("participant keys: %v", p)
		}
	}
	// 服务器策略「可选」：房间可以开启 E2EE；不支持的客户端进不去
	if _, err := req(t, admin, &pb.UpdateSettings{Patch: map[string]string{"security.e2ee_policy": `"optional"`}}); err != nil {
		t.Fatal(err)
	}
	resp, err := req(t, admin, &pb.CreateRoom{Name: "加密", Join: true, Overrides: &pb.RoomOverrides{E2Ee: true}})
	if err != nil || !resp.GetCreateRoom().GetRoom().GetE2Ee() || !resp.GetCreateRoom().GetJoined().GetPolicy().GetE2Ee().GetRoomEnabled() {
		t.Fatal(resp, err)
	}
	room := resp.GetCreateRoom().GetRoom().GetId()
	_, err = req(t, legacy, &pb.JoinRoom{RoomId: room})
	wantCode(t, err, pb.ErrorCode_ERROR_CODE_E2EE_UNSUPPORTED)
	if _, err := req(t, alice, &pb.JoinRoom{RoomId: room}); err != nil {
		t.Fatal(err)
	}

	// 密钥包：只中转给同一个加密房间里的成员，服务端不解读内容
	enc, ct := make([]byte, 32), make([]byte, 48)
	rand.Read(enc)
	rand.Read(ct)
	if _, err := req(t, alice, &pb.SendKeyPackage{ToSessionId: admin.Welcome.GetSessionId(), RoomId: room, KeyIndex: 1, Enc: enc, Ciphertext: ct}); err != nil {
		t.Fatal(err)
	}
	ev, err := admin.WaitEvent(ctx(t), func(ev *pb.Event) bool { return ev.GetKeyPackage() != nil })
	if err != nil || ev.GetKeyPackage().GetFromSessionId() != alice.Welcome.GetSessionId() || ev.GetKeyPackage().GetKeyIndex() != 1 || string(ev.GetKeyPackage().GetCiphertext()) != string(ct) {
		t.Fatal(ev, err)
	}
	_, err = req(t, alice, &pb.SendKeyPackage{ToSessionId: legacy.Welcome.GetSessionId(), RoomId: room, Enc: enc, Ciphertext: ct})
	wantCode(t, err, pb.ErrorCode_ERROR_CODE_INVALID_ARGUMENT)
	_, err = req(t, legacy, &pb.SendKeyPackage{ToSessionId: alice.Welcome.GetSessionId(), RoomId: "main", Enc: enc, Ciphertext: ct})
	wantCode(t, err, pb.ErrorCode_ERROR_CODE_INVALID_ARGUMENT)

	// 改为「强制」：主会议也加密，不支持的客户端被断开；新的不支持的连接被拒绝
	if _, err := req(t, admin, &pb.UpdateSettings{Patch: map[string]string{"security.e2ee_policy": `"required"`}}); err != nil {
		t.Fatal(err)
	}
	if g, err := legacy.WaitGoodbye(ctx(t)); err != nil || g.GetError().GetCode() != pb.ErrorCode_ERROR_CODE_E2EE_UNSUPPORTED {
		t.Fatal(g, err)
	}
	_, err = e.dial(4, "Old")
	wantCode(t, err, pb.ErrorCode_ERROR_CODE_E2EE_UNSUPPORTED)
}

func waitPerm(t *testing.T, e *env, room, identity string, ok func(media.Permission) bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for {
		if p, found := e.media.Perm(room, identity); found && ok(p) {
			return
		}
		if time.Now().After(deadline) {
			p, _ := e.media.Perm(room, identity)
			t.Fatalf("media permission not as expected: %+v", p)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// 被踢出的人（或从未存在的身份）用还没过期的旧媒体令牌重新连上 SFU：立即被移除，不能继续旁听
func TestStaleMediaConnectionEvicted(t *testing.T) {
	e := setup(t)
	admin := e.mustDial(1, "Admin")
	bob := e.mustDial(2, "Bob")
	e.promote(admin, perm.Admin)
	e.online(bob, "main")
	oldID := mediaID(bob)
	if _, err := req(t, admin, &pb.Moderate{SessionId: bob.Welcome.GetSessionId(), Action: pb.ModerationAction_MODERATION_ACTION_KICK}); err != nil {
		t.Fatal(err)
	}
	if _, err := bob.WaitGoodbye(ctx(t)); err != nil {
		t.Fatal(err)
	}
	removed := func(want string) bool {
		deadline := time.Now().Add(3 * time.Second)
		for time.Now().Before(deadline) {
			for _, r := range e.media.RemovedList() {
				if r == want {
					return true
				}
			}
			time.Sleep(20 * time.Millisecond)
		}
		return false
	}
	// 踢出时已经从 SFU 移除；用旧令牌再次连上（SFU 报告加入）时再次移除
	before := len(e.media.RemovedList())
	e.media.Emit(media.Event{Kind: media.ParticipantJoined, Room: "main", Identity: oldID})
	deadline := time.Now().Add(3 * time.Second)
	for len(e.media.RemovedList()) == before && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if !removed("main/"+oldID) || len(e.media.RemovedList()) == before {
		t.Fatalf("kicked identity not evicted: %v", e.media.RemovedList())
	}
	// 从未存在的身份同样移除
	e.media.Emit(media.Event{Kind: media.ParticipantJoined, Room: "main", Identity: "u_forged:s_forged"})
	if !removed("main/u_forged:s_forged") {
		t.Fatalf("unknown identity not evicted: %v", e.media.RemovedList())
	}
}

// 进出房间等会触发全服广播的操作有频率限制：恶意客户端高频请求只会收到 RATE_LIMITED
func TestActionRateLimit(t *testing.T) {
	e := setup(t)
	bob := e.mustDial(1, "Bob")
	limited := 0
	for range 20 {
		if _, err := req(t, bob, &pb.JoinRoom{RoomId: "main"}); client.Code(err) == pb.ErrorCode_ERROR_CODE_RATE_LIMITED {
			limited++
		}
	}
	if limited < 10 {
		t.Fatalf("only %d of 20 rapid JoinRoom requests were rate limited", limited)
	}
}
