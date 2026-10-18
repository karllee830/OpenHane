package hub

import (
	"context"
	"io"
	"log/slog"
	"net/netip"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"google.golang.org/protobuf/proto"

	"github.com/karllee830/OpenHane/server/internal/media"
	"github.com/karllee830/OpenHane/server/internal/pb"
	"github.com/karllee830/OpenHane/server/internal/perm"
	"github.com/karllee830/OpenHane/server/internal/settings"
	"github.com/karllee830/OpenHane/server/internal/store"
)

// 模糊测试：任意构造的请求——来自普通成员或管理员——都不能让 Hub 崩溃，
// 普通成员发来的管理员请求一律被拒绝。
//   go test ./internal/hub -run '^$' -fuzz FuzzRequest -fuzztime 10m

type fuzzConn struct{ sent atomic.Int64 }

func (c *fuzzConn) Send(*pb.Envelope)     { c.sent.Add(1) }
func (c *fuzzConn) SendRaw([]byte)        { c.sent.Add(1) }
func (c *fuzzConn) Close(*pb.Error, bool) {}

type fuzzEnv struct {
	h     *Hub
	clock atomic.Int64 // 毫秒
	conns map[string]*fuzzConn
	sess  map[string]*Session
}

var (
	fuzzOnce sync.Once
	fuzzE    *fuzzEnv
)

func fuzzSetup(t testing.TB) *fuzzEnv {
	fuzzOnce.Do(func() {
		log := slog.New(slog.NewTextHandler(io.Discard, nil))
		dir, err := os.MkdirTemp("", "hane-fuzz-")
		if err != nil {
			t.Fatal(err)
		}
		st, err := store.Open(context.Background(), dir, log)
		if err != nil {
			t.Fatal(err)
		}
		e := &fuzzEnv{conns: map[string]*fuzzConn{}, sess: map[string]*Session{}}
		e.clock.Store(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC).UnixMilli())
		e.h = New(Options{
			Store: st, Media: media.NewFake(), Settings: settings.Defaults(), ServerID: []byte("0123456789abcdef"),
			Version: "fuzz", ProtocolMin: 1, ProtocolMax: 1, Log: log,
			HashPassword: func(p string) (string, error) { return "fake:" + p, nil }, // Argon2 太慢
			Now:          func() time.Time { return time.UnixMilli(e.clock.Load()) },
			ResumeGrace:  time.Millisecond,
		})
		go e.h.Run(context.Background())
		fuzzE = e
	})
	return fuzzE
}

// session 返回指定身份的在线会话；被踢出、移走或断开后重新加入
func (e *fuzzEnv) session(name string, role perm.Role) (*Session, *fuzzConn) {
	var alive bool
	e.h.call(context.Background(), func() {
		s := e.sess[name]
		alive = s != nil && e.h.sessions[s.ID] == s && s.conn != nil
	})
	if alive {
		return e.sess[name], e.conns[name]
	}
	c := &fuzzConn{}
	s, perr := e.h.Join(context.Background(), JoinParams{
		UID: "u_" + name, PublicKey: make([]byte, 32), Nickname: name, Role: role,
		Client: &pb.ClientInfo{}, Caps: &pb.Capabilities{E2Ee: true}, RemoteIP: netip.MustParseAddr("192.0.2.1"), Conn: c,
	})
	if perr != nil {
		return nil, nil
	}
	e.sess[name], e.conns[name] = s, c
	return s, c
}

// adminOnly：只有管理员能发的请求类型（requests.go 中「以下为管理员请求」部分）
func adminOnly(r *pb.Request) bool {
	switch r.Body.(type) {
	case *pb.Request_GetSettings, *pb.Request_UpdateSettings, *pb.Request_CreateToken, *pb.Request_ListTokens,
		*pb.Request_RevokeToken, *pb.Request_SetRole, *pb.Request_ListIdentities, *pb.Request_ListBans,
		*pb.Request_AddBan, *pb.Request_RemoveBan, *pb.Request_GetAuditLog, *pb.Request_CreateInvite,
		*pb.Request_ListInvites, *pb.Request_RevokeInvite:
		return true
	}
	return false
}

func FuzzRequest(f *testing.F) {
	seeds := []*pb.Request{
		{Body: &pb.Request_JoinRoom{JoinRoom: &pb.JoinRoom{RoomId: "main"}}},
		{Body: &pb.Request_SendChat{SendChat: &pb.SendChat{RoomId: "main", Text: "你好"}}},
		{Body: &pb.Request_UpdateSelf{UpdateSelf: &pb.UpdateSelf{MicMuted: proto.Bool(true), Nickname: proto.String("新名字")}}},
		{Body: &pb.Request_CreateRoom{CreateRoom: &pb.CreateRoom{Name: "房间", Password: "pw", Capacity: 3, Overrides: &pb.RoomOverrides{E2Ee: true}}}},
		{Body: &pb.Request_RequestScreenShare{RequestScreenShare: &pb.RequestScreenShare{Intent: pb.ShareIntent_SHARE_INTENT_SMART, WithAudio: true}}},
		{Body: &pb.Request_Moderate{Moderate: &pb.Moderate{Action: pb.ModerationAction_MODERATION_ACTION_FORCE_MUTE, Reason: "x"}}},
		{Body: &pb.Request_MuteAll{MuteAll: &pb.MuteAll{}}},
		{Body: &pb.Request_UpdateSettings{UpdateSettings: &pb.UpdateSettings{Patch: map[string]string{"server.name": `"x"`, "security.e2ee_policy": `"required"`}}}},
		{Body: &pb.Request_SetRole{SetRole: &pb.SetRole{Uid: "u_member", Role: pb.Role_ROLE_ADMIN}}},
		{Body: &pb.Request_AddBan{AddBan: &pb.AddBan{Uid: "u_target", DurationSec: 60}}},
		{Body: &pb.Request_CreateInvite{CreateInvite: &pb.CreateInvite{MaxUses: 1, BypassPassword: true}}},
		{Body: &pb.Request_SendKeyPackage{SendKeyPackage: &pb.SendKeyPackage{RoomId: "main", Enc: []byte{1}, Ciphertext: []byte{2}}}},
		{Body: &pb.Request_GetChatHistory{GetChatHistory: &pb.GetChatHistory{RoomId: "main", Limit: 1000}}},
	}
	for _, r := range seeds {
		b, _ := proto.Marshal(r)
		f.Add(b, false)
		f.Add(b, true)
	}
	f.Fuzz(func(t *testing.T, data []byte, asAdmin bool) {
		var req pb.Request
		if proto.Unmarshal(data, &req) != nil || req.Body == nil {
			return
		}
		e := fuzzSetup(t)
		e.clock.Add(time.Minute.Milliseconds()) // 限流桶每轮都补满，否则大部分输入只会得到 RATE_LIMITED
		e.session("target", perm.Member)
		name, role := "member", perm.Member
		if asAdmin {
			name, role = "admin", perm.Admin
		}
		s, c := e.session(name, role)
		if s == nil {
			return // 例如人数上限、端到端加密策略被前面的输入改掉了
		}
		// 请求里的会话 ID 有一半概率指向真实存在的会话，覆盖更多主持操作的分支
		if m := req.GetModerate(); m != nil && len(data)%2 == 0 {
			if tgt := e.sess["target"]; tgt != nil {
				m.SessionId = tgt.ID
			}
		}
		var resp *pb.Response
		var wasAdmin bool // 前面的输入可能已经把「成员」提升为管理员：按请求当时的角色判断
		e.h.call(context.Background(), func() {
			if e.h.sessions[s.ID] == s && s.conn == c {
				wasAdmin = s.Role >= perm.Admin
				resp = e.h.dispatch(s, c, &req)
			}
		})
		if !wasAdmin && adminOnly(&req) && resp != nil && resp.GetError() == nil {
			t.Fatalf("member got a successful response to an admin request %T: %v", req.Body, resp)
		}
	})
}
