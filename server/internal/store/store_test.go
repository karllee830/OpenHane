package store

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/netip"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/karllee830/OpenHane/server/internal/perm"
)

func open(t *testing.T) (*Store, string) {
	t.Helper()
	dir := t.TempDir()
	s, err := Open(context.Background(), dir, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s, dir
}

func TestMigrateAndReopen(t *testing.T) {
	ctx := context.Background()
	s, dir := open(t)
	v, err := s.SchemaVersion(ctx)
	if err != nil || v < 1 {
		t.Fatalf("version %d err %v", v, err)
	}
	id1, err := s.GetOrInitMeta(ctx, "server_id", func() string { return "a" })
	if err != nil || id1 != "a" {
		t.Fatal(id1, err)
	}
	s.Close()

	s2, err := Open(ctx, dir, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	defer s2.Close()
	id2, _ := s2.GetOrInitMeta(ctx, "server_id", func() string { return "b" })
	if id2 != "a" {
		t.Fatalf("server_id changed: %s", id2)
	}
	// 版本没变化时不应生成迁移前备份
	if _, err := os.Stat(filepath.Join(dir, "backups")); err == nil {
		t.Fatal("unexpected backup dir")
	}
}

func TestIdentitiesAndRoles(t *testing.T) {
	ctx := context.Background()
	s, _ := open(t)
	role, err := s.TouchIdentity(ctx, "u1", []byte("pub1"), "Alice", "10.0.0.1", "macos/1.0")
	if err != nil || role != perm.Member {
		t.Fatal(role, err)
	}
	if role, _ = s.TouchIdentity(ctx, "u1", []byte("pub1"), "Alice2", "", ""); role != perm.Member {
		t.Fatal(role)
	}
	id, err := s.GetIdentity(ctx, "u1")
	if err != nil || id.Nickname != "Alice2" || id.LastIP != "" {
		t.Fatalf("%+v %v", id, err)
	}
	if err := s.SetRole(ctx, "u1", perm.Admin); err != nil {
		t.Fatal(err)
	}
	if err := s.SetRole(ctx, "u1", perm.Member); !errors.Is(err, ErrLastAdmin) {
		t.Fatalf("expected ErrLastAdmin, got %v", err)
	}
	s.TouchIdentity(ctx, "u2", []byte("pub2"), "Bob", "", "")
	list, total, err := s.ListIdentities(ctx, perm.Admin, 10, 0)
	if err != nil || total != 1 || len(list) != 1 || list[0].UID != "u1" {
		t.Fatalf("%v %d %v", list, total, err)
	}
	if _, err := s.GetIdentity(ctx, "nobody"); !errors.Is(err, ErrNotFound) {
		t.Fatal(err)
	}
}

func TestRedeemToken(t *testing.T) {
	ctx := context.Background()
	s, _ := open(t)
	now := time.UnixMilli(1_000_000)
	s.SetClock(func() time.Time { return now })
	s.TouchIdentity(ctx, "u1", []byte("p1"), "A", "", "")
	s.TouchIdentity(ctx, "u2", []byte("p2"), "B", "", "")

	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(s.CreateToken(ctx, &PrivilegeToken{ID: "t1", Hash: []byte("h1"), Role: perm.Admin, MaxUses: 1, CreatedBy: SystemCreator}))
	must(s.CreateToken(ctx, &PrivilegeToken{ID: "t2", Hash: []byte("h2"), Role: perm.Moderator, MaxUses: 0, CreatedBy: "u1",
		ExpiresAt: now.Add(time.Hour).UnixMilli()}))

	if _, err := s.RedeemToken(ctx, []byte("nope"), "u1"); !errors.Is(err, ErrTokenInvalid) {
		t.Fatal(err)
	}
	r, err := s.RedeemToken(ctx, []byte("h1"), "u1")
	if err != nil || !r.Consumed || r.NewRole != perm.Admin {
		t.Fatalf("%+v %v", r, err)
	}
	if _, err := s.RedeemToken(ctx, []byte("h1"), "u2"); !errors.Is(err, ErrTokenUsedUp) {
		t.Fatal(err)
	}
	// 只升不降：管理员兑换主持人令牌不消耗
	r, err = s.RedeemToken(ctx, []byte("h2"), "u1")
	if err != nil || r.Consumed || r.NewRole != perm.Admin {
		t.Fatalf("%+v %v", r, err)
	}
	r, err = s.RedeemToken(ctx, []byte("h2"), "u2")
	if err != nil || !r.Consumed || r.NewRole != perm.Moderator {
		t.Fatalf("%+v %v", r, err)
	}
	now = now.Add(2 * time.Hour)
	if _, err := s.RedeemToken(ctx, []byte("h2"), "u2"); !errors.Is(err, ErrTokenExpired) {
		t.Fatal(err)
	}

	must(s.CreateToken(ctx, &PrivilegeToken{ID: "t3", Hash: []byte("h3"), Role: perm.Admin, MaxUses: 1, CreatedBy: SystemCreator}))
	must(s.RevokeUnusedSystemTokens(ctx))
	if _, err := s.RedeemToken(ctx, []byte("h3"), "u2"); !errors.Is(err, ErrTokenInvalid) {
		t.Fatal(err)
	}
	list, _ := s.ListTokens(ctx)
	if len(list) != 3 {
		t.Fatalf("tokens: %d", len(list))
	}
	if err := s.RevokeToken(ctx, "t3"); !errors.Is(err, ErrNotFound) {
		t.Fatal("double revoke should be not found", err)
	}
}

func TestSettingsChatAuditBans(t *testing.T) {
	ctx := context.Background()
	s, dir := open(t)
	if err := s.PutSettings(ctx, map[string]string{"server.name": `"X"`, "camera.max_fps": "24"}, "u1"); err != nil {
		t.Fatal(err)
	}
	s.PutSettings(ctx, map[string]string{"camera.max_fps": ""}, "u1")
	m, _ := s.LoadSettings(ctx)
	if len(m) != 1 || m["server.name"] != `"X"` {
		t.Fatal(m)
	}

	for i := 0; i < 5; i++ {
		if err := s.InsertChat(ctx, &ChatMessage{RoomID: "main", SenderName: "A", Body: "hi"}); err != nil {
			t.Fatal(err)
		}
	}
	page, more, err := s.ChatHistory(ctx, "main", 0, 3)
	if err != nil || len(page) != 3 || !more || page[0].ID >= page[2].ID {
		t.Fatalf("%v %v %v", page, more, err)
	}
	page2, more, _ := s.ChatHistory(ctx, "main", page[0].ID, 3)
	if len(page2) != 2 || more {
		t.Fatalf("page2 %d more %v", len(page2), more)
	}
	// 加密的消息：密文和发送者的会话 ID 原样存取
	enc := &ChatMessage{RoomID: "main", SenderName: "A", SenderSession: "s1", EncKeyIndex: 3, EncNonce: []byte{1, 2}, EncCiphertext: []byte{3, 4, 5}}
	if err := s.InsertChat(ctx, enc); err != nil {
		t.Fatal(err)
	}
	last, _, _ := s.ChatHistory(ctx, "main", 0, 2)
	if got := last[1]; got.SenderSession != "s1" || got.EncKeyIndex != 3 || !bytes.Equal(got.EncNonce, []byte{1, 2}) || !bytes.Equal(got.EncCiphertext, []byte{3, 4, 5}) {
		t.Fatalf("encrypted: %+v", got)
	}
	if last[0].EncNonce != nil || last[0].SenderSession != "" {
		t.Fatalf("plain: %+v", last[0])
	}

	if err := s.InsertAudit(ctx, &AuditEntry{Action: "token.create", Detail: map[string]any{"role": "admin"}}); err != nil {
		t.Fatal(err)
	}
	logs, _ := s.ListAudit(ctx, 0, 10)
	if len(logs) != 1 || string(logs[0].Detail.(json.RawMessage)) != `{"role":"admin"}` {
		t.Fatalf("audit: %+v", logs)
	}

	s.InsertBan(ctx, &Ban{IPCIDR: "203.0.113.0/24", CreatedBy: "u1"})
	if _, err := s.FindActiveBan(ctx, "x", netip.MustParseAddr("203.0.113.7")); err != nil {
		t.Fatal("ip ban not matched", err)
	}
	if _, err := s.FindActiveBan(ctx, "x", netip.MustParseAddr("198.51.100.1")); !errors.Is(err, ErrNotFound) {
		t.Fatal(err)
	}

	if err := s.DailyBackup(ctx, 2); err != nil {
		t.Fatal(err)
	}
	if err := s.DailyBackup(ctx, 2); err != nil { // 当天已有备份，跳过
		t.Fatal(err)
	}
	files, _ := filepath.Glob(filepath.Join(dir, "backups", "*.db"))
	if len(files) != 1 {
		t.Fatal(files)
	}
}
