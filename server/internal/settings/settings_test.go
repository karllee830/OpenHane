package settings

import (
	"strings"
	"testing"
)

func fakeHash(p string) (string, error) { return "hash:" + p, nil }

func TestDefaultsValid(t *testing.T) {
	if err := Defaults().Validate(); err != nil {
		t.Fatal(err)
	}
	if len(Keys()) != len(Defaults().Public()) {
		t.Fatal("keys mismatch")
	}
}

func TestApplyAndStored(t *testing.T) {
	s := Defaults()
	next, stored, err := s.Apply(Patch{
		"server.name":     `"My Server"`,
		"camera.max_fps":  "24",
		"server.password": `"secret"`,
		"join.force_mute": "true",
		"audio.preset":    `"hd"`,
		"screen.min_role": `"moderator"`,
	}, fakeHash)
	if err != nil {
		t.Fatal(err)
	}
	if next.ServerName != "My Server" || next.CameraMaxFps != 24 || next.ServerPassword != "hash:secret" || !next.JoinForceMute {
		t.Fatalf("%+v", next)
	}
	if s.ServerName != "OpenHane" {
		t.Fatal("original snapshot must not change")
	}
	if stored["server.password"] != `"hash:secret"` {
		t.Fatal(stored)
	}
	if got, _ := next.Get("server.password"); got != MaskedPassword {
		t.Fatal(got)
	}
	if next.EffectiveAudioKbps() != 64 {
		t.Fatal(next.EffectiveAudioKbps())
	}

	// 从数据库恢复应得到相同结果
	restored, err := FromStored(stored)
	if err != nil || *restored != *next {
		t.Fatalf("%+v %v", restored, err)
	}

	// null 恢复默认，并要求删除该键
	reset, stored2, err := next.Apply(Patch{"camera.max_fps": "null", "server.password": `""`}, fakeHash)
	if err != nil || reset.CameraMaxFps != 30 || reset.ServerPassword != "" || stored2["camera.max_fps"] != "" || stored2["server.password"] != "" {
		t.Fatalf("%+v %v %v", reset, stored2, err)
	}
}

func TestApplyRejects(t *testing.T) {
	cases := []Patch{
		{"nope": "1"},
		{"camera.max_fps": `"fast"`},
		{"camera.max_fps": "1000"},
		{"audio.preset": `"loud"`},
		{"server.name": `""`},
		{"server.password": "123"},
		{"video.codec_policy": `"quality"`},
		{"media.share_transport": `"auto"`},
	}
	for _, p := range cases {
		if _, _, err := Defaults().Apply(p, fakeHash); err == nil {
			t.Errorf("%v: expected error", p)
		}
	}
}

func TestFromStoredTolerant(t *testing.T) {
	s, err := FromStored(map[string]string{"removed.key": "1", "camera.max_fps": "25"})
	if err != nil || s.CameraMaxFps != 25 {
		t.Fatal(s, err)
	}
	s, err = FromStored(map[string]string{"camera.max_fps": `"x"`})
	if err == nil || s.CameraMaxFps != 30 {
		t.Fatal("bad stored value should fall back to default with an error")
	}
	// 旧版本的「画质优先」已取消：按自动处理，其他设置保留
	s, err = FromStored(map[string]string{"video.codec_policy": `"quality"`, "camera.max_fps": "25"})
	if err != nil || s.VideoCodecPolicy != "auto" || s.CameraMaxFps != 25 {
		t.Fatal(s, err)
	}
}

func TestPassword(t *testing.T) {
	h, err := HashPassword("correct horse")
	if err != nil || !strings.HasPrefix(h, "$argon2id$v=19$m=19456,t=2,p=1$") {
		t.Fatal(h, err)
	}
	if !VerifyPassword(h, "correct horse") || VerifyPassword(h, "wrong") || VerifyPassword("garbage", "x") {
		t.Fatal("verify")
	}
}

func TestServerNameDefaultAndOverride(t *testing.T) {
	t.Cleanup(func() { defaultServerName = "OpenHane" })
	if err := SetDefaultServerName("  研发组 "); err != nil {
		t.Fatal(err)
	}
	if Defaults().ServerName != "研发组" {
		t.Fatalf("env default: %q", Defaults().ServerName)
	}
	if SetDefaultServerName("a\u202eb") == nil || SetDefaultServerName(strings.Repeat("字", MaxServerNameRunes+1)) == nil {
		t.Fatal("invalid HANE_SERVER_NAME should be rejected")
	}
	// 管理员设置的名称优先，并按规则规范化
	s, stored, err := Defaults().Apply(Patch{"server.name": `"  测试服 "`}, nil)
	if err != nil || s.ServerName != "测试服" || stored["server.name"] != `"测试服"` {
		t.Fatalf("admin name: %q %v %v", s.ServerName, stored, err)
	}
	if _, _, err := Defaults().Apply(Patch{"server.name": `"a\u200bb"`}, nil); err == nil {
		t.Fatal("invisible characters should be rejected")
	}
	// 恢复默认：回到 HANE_SERVER_NAME
	s, stored, err = s.Apply(Patch{"server.name": "null"}, nil)
	if err != nil || s.ServerName != "研发组" || stored["server.name"] != "" {
		t.Fatalf("reset: %q %v %v", s.ServerName, stored, err)
	}
	// 数据库里没有保存名称时也用 HANE_SERVER_NAME
	if s, _ := FromStored(map[string]string{}); s.ServerName != "研发组" {
		t.Fatalf("from stored: %q", s.ServerName)
	}
}
