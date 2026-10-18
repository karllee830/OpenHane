package auth

import (
	"bytes"
	"crypto/ed25519"
	"encoding/hex"
	"strings"
	"testing"
)

func TestSigInputVector(t *testing.T) {
	serverID := bytes.Repeat([]byte{0x11}, 16)
	nonce := bytes.Repeat([]byte{0x22}, 32)
	spki := bytes.Repeat([]byte{0x33}, 32)
	in := SigInput(serverID, nonce, spki, 0x0102030405060708)
	if len(in) != len("OpenHane-Auth-v1")+1+16+32+32+8 {
		t.Fatal(len(in))
	}
	if !strings.HasPrefix(string(in), "OpenHane-Auth-v1\x00") || !bytes.HasSuffix(in, []byte{1, 2, 3, 4, 5, 6, 7, 8}) {
		t.Fatal(hex.EncodeToString(in))
	}
	// 固定向量（逐字节构造，供各端实现对照）
	want := hex.EncodeToString([]byte("OpenHane-Auth-v1")) + "00" + strings.Repeat("11", 16) +
		strings.Repeat("22", 32) + strings.Repeat("33", 32) + "0102030405060708"
	if got := hex.EncodeToString(in); got != want {
		t.Fatalf("got %s", got)
	}
}

func TestVerifyAuth(t *testing.T) {
	priv := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{7}, 32))
	pub := priv.Public().(ed25519.PublicKey)
	sid, nonce := make([]byte, 16), bytes.Repeat([]byte{9}, 32)
	sig := ed25519.Sign(priv, SigInput(sid, nonce, ZeroSPKI, 1000))
	if !VerifyAuth(pub, sig, sid, nonce, ZeroSPKI, 1000) {
		t.Fatal("valid signature rejected")
	}
	if VerifyAuth(pub, sig, sid, nonce, ZeroSPKI, 1001) || VerifyAuth(pub, sig[:10], sid, nonce, ZeroSPKI, 1000) {
		t.Fatal("tampered input accepted")
	}
	var own [32]byte
	own[0] = 1
	if SPKIMismatch(ZeroSPKI, own) || !SPKIMismatch(make([]byte, 32)[:31], own) || SPKIMismatch(own[:], own) {
		t.Fatal("spki")
	}
	x := bytes.Repeat([]byte{5}, 32)
	if !VerifyE2EEKey(pub, x, ed25519.Sign(priv, E2EEKeyInput(x))) {
		t.Fatal("e2ee key")
	}
}

func TestToken(t *testing.T) {
	disp, hash := NewToken()
	if !strings.HasPrefix(disp, "HANE-") || len(disp) != len(tokenPrefix)+20+4 {
		t.Fatal(disp)
	}
	norm, err := NormalizeToken(strings.ToLower(disp))
	if err != nil || !bytes.Equal(HashToken(norm), hash) {
		t.Fatal(norm, err)
	}
	n1, _ := NormalizeToken("hane-7f3k 9qx2-mz8p-4ita-h6wd") // i → 1
	n2, _ := NormalizeToken("7F3K9QX2MZ8P41TAH6WD")
	if n1 != n2 || n1 == "" {
		t.Fatal(n1, n2)
	}
	for _, bad := range []string{"", "HANE-", "HANE-7F3K-9QX2", "HANE-7F3K-9QX2-MZ8P-4LTA-H6WU", "hello world"} {
		if _, err := NormalizeToken(bad); err == nil {
			t.Errorf("%q should be rejected", bad)
		}
	}
}
