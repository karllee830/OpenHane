// Package e2eevec 生成并校验端到端加密的跨端测试向量（testdata/e2ee/vectors.json）。
// 用 Go 标准库的 crypto/hpke 作为独立的第三方实现：TS（@hpke/core）和 Swift（CryptoKit）都必须能解开
// 这里生成的密钥包，并算出相同的 AAD 和安全码。
//
// 重新生成：HANE_UPDATE_E2EE=1 go test ./internal/e2eevec
package e2eevec

import (
	"bytes"
	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/hpke"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/karllee830/OpenHane/server/internal/identity"
)

// KeyPackageInfo 是 HPKE 的 info 参数。
const KeyPackageInfo = "OpenHane-E2EE-KeyPackage-v1"

// KeyPackageAAD 把密钥包绑定到房间、发送者、接收者和密钥索引，防止服务端挪用或重放到别处：
// room_id ‖ 0x00 ‖ from_session_id ‖ 0x00 ‖ to_session_id ‖ 0x00 ‖ key_index（4 字节大端）
func KeyPackageAAD(room, from, to string, index uint32) []byte {
	b := []byte(room + "\x00" + from + "\x00" + to + "\x00")
	return binary.BigEndian.AppendUint32(b, index)
}

type Member struct {
	UID       string `json:"uid"`
	PublicKey string `json:"publicKey"` // 身份公钥（Ed25519），hex
}

// SafetyCode = SHA-256("OpenHane-SafetyCode-v1" ‖ 0x00 ‖ 按 UID 排序、去重后每个成员的 UID ‖ 0x00 ‖ 身份公钥)，
// 取前 30 字节，每 5 字节（大端）对 100000 取余，得到 6 组 5 位数字。
func SafetyCode(members []Member) string {
	seen := map[string]Member{}
	for _, m := range members {
		seen[m.UID] = m
	}
	uids := make([]string, 0, len(seen))
	for u := range seen {
		uids = append(uids, u)
	}
	sort.Strings(uids)
	h := sha256.New()
	h.Write([]byte("OpenHane-SafetyCode-v1\x00"))
	for _, u := range uids {
		pk, _ := hex.DecodeString(seen[u].PublicKey)
		h.Write([]byte(u))
		h.Write([]byte{0})
		h.Write(pk)
	}
	d := h.Sum(nil)
	groups := make([]string, 6)
	for i := range groups {
		var v uint64
		for _, c := range d[i*5 : i*5+5] {
			v = v<<8 | uint64(c)
		}
		groups[i] = fmt.Sprintf("%05d", v%100000)
	}
	return strings.Join(groups, " ")
}

type HPKECase struct {
	RecipientPrivateKey string `json:"recipientPrivateKey"`
	RecipientPublicKey  string `json:"recipientPublicKey"`
	RoomID              string `json:"roomId"`
	FromSessionID       string `json:"fromSessionId"`
	ToSessionID         string `json:"toSessionId"`
	KeyIndex            uint32 `json:"keyIndex"`
	AAD                 string `json:"aad"`
	Enc                 string `json:"enc"`
	Ciphertext          string `json:"ciphertext"`
	Plaintext           string `json:"plaintext"`
}

type SafetyCase struct {
	Members []Member `json:"members"`
	Code    string   `json:"code"`
}

type Vectors struct {
	Suite      string       `json:"suite"`
	Info       string       `json:"info"`
	HPKE       []HPKECase   `json:"hpke"`
	SafetyCode []SafetyCase `json:"safetyCode"`
}

var file = filepath.Join("..", "..", "..", "testdata", "e2ee", "vectors.json")

func seeded(label string) []byte {
	s := sha256.Sum256([]byte(label))
	return s[:]
}

func member(label string) Member {
	pub := ed25519.NewKeyFromSeed(seeded(label)).Public().(ed25519.PublicKey)
	return Member{UID: identity.UID(pub), PublicKey: hex.EncodeToString(pub)}
}

func generate(t *testing.T) Vectors {
	v := Vectors{Suite: "DHKEM(X25519, HKDF-SHA256) / HKDF-SHA256 / AES-128-GCM, base mode", Info: KeyPackageInfo}
	for i, c := range []struct {
		room, from, to string
		index          uint32
	}{{"r_abc123", "s_alice", "s_bob", 0}, {"main", "4qy8nkgc2b", "7tw3sh8gek", 5}} {
		sk, err := ecdh.X25519().NewPrivateKey(seeded(fmt.Sprintf("hane-e2ee-recipient-%d", i)))
		if err != nil {
			t.Fatal(err)
		}
		pt := seeded(fmt.Sprintf("hane-e2ee-media-key-%d", i))
		aad := KeyPackageAAD(c.room, c.from, c.to, c.index)
		pk, _ := hpke.DHKEM(ecdh.X25519()).NewPublicKey(sk.PublicKey().Bytes())
		enc, s, err := hpke.NewSender(pk, hpke.HKDFSHA256(), hpke.AES128GCM(), []byte(KeyPackageInfo))
		if err != nil {
			t.Fatal(err)
		}
		ct, err := s.Seal(aad, pt)
		if err != nil {
			t.Fatal(err)
		}
		v.HPKE = append(v.HPKE, HPKECase{
			RecipientPrivateKey: hex.EncodeToString(sk.Bytes()), RecipientPublicKey: hex.EncodeToString(sk.PublicKey().Bytes()),
			RoomID: c.room, FromSessionID: c.from, ToSessionID: c.to, KeyIndex: c.index, AAD: hex.EncodeToString(aad),
			Enc: hex.EncodeToString(enc), Ciphertext: hex.EncodeToString(ct), Plaintext: hex.EncodeToString(pt),
		})
	}
	a, b, c := member("alice"), member("bob"), member("carol")
	for _, ms := range [][]Member{{a, b}, {b, a}, {a, b, c}, {a, b, a}, {a}} {
		v.SafetyCode = append(v.SafetyCode, SafetyCase{Members: ms, Code: SafetyCode(ms)})
	}
	return v
}

func TestVectors(t *testing.T) {
	if os.Getenv("HANE_UPDATE_E2EE") == "1" {
		b, _ := json.MarshalIndent(generate(t), "", "  ")
		if err := os.WriteFile(file, append(b, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	raw, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	var v Vectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	// HPKE 密封是随机的：校验已提交的密文仍能解开，AAD 格式没变
	for _, c := range v.HPKE {
		skb, _ := hex.DecodeString(c.RecipientPrivateKey)
		sk, err := hpke.DHKEM(ecdh.X25519()).NewPrivateKey(skb)
		if err != nil {
			t.Fatal(err)
		}
		enc, _ := hex.DecodeString(c.Enc)
		ct, _ := hex.DecodeString(c.Ciphertext)
		r, err := hpke.NewRecipient(enc, sk, hpke.HKDFSHA256(), hpke.AES128GCM(), []byte(v.Info))
		if err != nil {
			t.Fatal(err)
		}
		aad := KeyPackageAAD(c.RoomID, c.FromSessionID, c.ToSessionID, c.KeyIndex)
		if hex.EncodeToString(aad) != c.AAD {
			t.Fatalf("aad format changed: %x", aad)
		}
		pt, err := r.Open(aad, ct)
		if err != nil || hex.EncodeToString(pt) != c.Plaintext {
			t.Fatalf("open: %v", err)
		}
		// 篡改 AAD（例如换一个接收者）必须解不开
		r2, _ := hpke.NewRecipient(enc, sk, hpke.HKDFSHA256(), hpke.AES128GCM(), []byte(v.Info))
		if _, err := r2.Open(KeyPackageAAD(c.RoomID, c.FromSessionID, "someone-else", c.KeyIndex), ct); err == nil {
			t.Fatal("open with wrong aad should fail")
		}
	}
	for _, c := range v.SafetyCode {
		if got := SafetyCode(c.Members); got != c.Code {
			t.Fatalf("safety code: %s != %s", got, c.Code)
		}
	}
	if !bytes.Equal(KeyPackageAAD("r", "a", "b", 1), []byte("r\x00a\x00b\x00\x00\x00\x00\x01")) {
		t.Fatal("aad layout")
	}
}
