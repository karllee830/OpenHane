package identity

import (
	"crypto/ed25519"
	"encoding/binary"
	"strings"
	"testing"
)

func TestUID(t *testing.T) {
	pub := ed25519.NewKeyFromSeed(make([]byte, 32)).Public().(ed25519.PublicKey)
	uid := UID(pub)
	if len(uid) != 20 || strings.ToLower(uid) != uid {
		t.Fatal(uid)
	}
	// 固定向量：全零种子派生的公钥（3b6a27bc…），已用 OpenSSL 独立核对，供各端实现对照
	if uid != "copdsqhgjnkjc4rardm2" {
		t.Fatalf("UID vector changed: %s", uid)
	}
	if ShortUID(uid) != "copd-sqhg" {
		t.Fatal(ShortUID(uid))
	}
}

func TestNickname(t *testing.T) {
	ok := map[string]string{"  小明 ": "小明", "Alice Smith": "Alice Smith", strings.Repeat("字", 32): strings.Repeat("字", 32)}
	for in, want := range ok {
		if got, err := NormalizeNickname(in); err != nil || got != want {
			t.Errorf("%q: %q %v", in, got, err)
		}
	}
	for _, bad := range []string{"", "   ", strings.Repeat("a", 33), "a​b", "a\nb", "a\x00", "\xff", "a‮b"} {
		if _, err := NormalizeNickname(bad); err == nil {
			t.Errorf("%q should be invalid", bad)
		}
	}
}

func TestDisplayName(t *testing.T) {
	// NFC：分解形式的「é」（e + 组合重音）和合成形式结果相同
	if got, ok := NormalizeDisplayName("Cafe\u0301", 32); !ok || got != "Caf\u00e9" {
		t.Errorf("NFC: %q %v", got, ok)
	}
	// 越南语等正常文字会叠两三个组合字符，可以
	if _, ok := NormalizeDisplayName("Việt Nam", 32); !ok {
		t.Error("Vietnamese should be valid")
	}
	// 把字往上下堆出界的 Zalgo 文字、零宽字符、方向控制符、换行：不行
	for _, bad := range []string{"Z\u0300\u0301\u0302\u0303\u0304algo", "a\u200bb", "evil\u202egpj.exe", "a\u2028b", "a\tb"} {
		if _, ok := NormalizeDisplayName(bad, 32); ok {
			t.Errorf("%q should be invalid", bad)
		}
	}
}

func TestUniquify(t *testing.T) {
	taken := map[string]bool{"小明": true, "小明 (2)": true}
	got := Uniquify("小明", func(s string) bool { return taken[s] })
	if got != "小明 (3)" {
		t.Fatal(got)
	}
	long := strings.Repeat("x", 32)
	got = Uniquify(long, func(s string) bool { return s == long })
	if len([]rune(got)) != 32 || !strings.HasSuffix(got, " (2)") {
		t.Fatal(got)
	}
}

func TestSecurityLevel(t *testing.T) {
	pub := ed25519.NewKeyFromSeed(make([]byte, 32)).Public().(ed25519.PublicKey)
	nonce := make([]byte, 8)
	for c := uint64(0); ; c++ {
		binary.BigEndian.PutUint64(nonce, c)
		if SecurityLevel(pub, nonce) >= 8 {
			break
		}
	}
	if SecurityLevel(pub, nonce) < 8 {
		t.Fatal("level")
	}
}

func TestDeriveKey(t *testing.T) {
	seed := make([]byte, 32)
	a := DeriveKey(seed, []byte("server-a-16bytes"))
	b := DeriveKey(seed, []byte("server-b-16bytes"))
	if UID(a.Public().(ed25519.PublicKey)) == UID(b.Public().(ed25519.PublicKey)) {
		t.Fatal("different servers must see different identities")
	}
	again := DeriveKey(seed, []byte("server-a-16bytes"))
	if !a.Equal(again) {
		t.Fatal("derivation must be deterministic")
	}
	// 固定向量（已用 Python HKDF + OpenSSL 独立核对）：主种子 00×32，server_id = "server-a-16bytes"
	if uid := UID(a.Public().(ed25519.PublicKey)); uid != "2gqiydvtufme24hxgoyk" {
		t.Fatalf("derivation vector changed: %s", uid)
	}
}
