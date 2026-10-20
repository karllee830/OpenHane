// Package e2eevec 生成并校验端到端加密的跨端测试向量（testdata/e2ee/vectors.json）。
// 用 Go 标准库的 crypto/hpke 作为独立的第三方实现：TS（@hpke/core）和 Swift（CryptoKit）都必须能解开
// 这里生成的密钥包，并算出相同的 AAD、安全码和聊天密文。安全码的 emoji 表在 testdata/e2ee/safety-emoji.json。
//
// 重新生成：HANE_UPDATE_E2EE=1 go test ./internal/e2eevec
package e2eevec

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/hkdf"
	"crypto/hpke"
	"crypto/pbkdf2"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"testing"

	"google.golang.org/protobuf/proto"

	"github.com/karllee830/OpenHane/server/internal/identity"
	"github.com/karllee830/OpenHane/server/internal/pb"
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

const (
	// SafetyContext 用于安全码的哈希和 PBKDF2 的盐
	SafetyContext = "OpenHane-SafetyCode-v2"
	// SafetyIterations 是 PBKDF2 的迭代次数：让「生成假成员的密钥、凑出相同的安全码」的每次尝试都很慢
	SafetyIterations = 1 << 20
	// SafetyLength 是安全码的 emoji 个数（每个 6 位，对应 safety-emoji.json 里 64 个 emoji 的序号）
	SafetyLength = 8
)

// SafetyCode 计算安全码（emoji 序号）：
//
//	digest = SHA-256("OpenHane-SafetyCode-v2" ‖ 0x00 ‖ 按 UID 排序、去重后每个成员的 UID ‖ 0x00 ‖ 身份公钥)
//	bits   = PBKDF2-HMAC-SHA256(password = digest, salt = "OpenHane-SafetyCode-v2", 2^20 次, 6 字节)
//
// bits 的 48 位从高到低每 6 位一组，得到 8 个 0–63 的序号。
func SafetyCode(members []Member) []int {
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
	h.Write([]byte(SafetyContext + "\x00"))
	for _, u := range uids {
		pk, _ := hex.DecodeString(seen[u].PublicKey)
		h.Write([]byte(u))
		h.Write([]byte{0})
		h.Write(pk)
	}
	bits, err := pbkdf2.Key(sha256.New, string(h.Sum(nil)), []byte(SafetyContext), SafetyIterations, SafetyLength*6/8)
	if err != nil {
		panic(err)
	}
	var v uint64
	for _, b := range bits {
		v = v<<8 | uint64(b)
	}
	code := make([]int, SafetyLength)
	for i := range code {
		code[i] = int(v >> (6 * (SafetyLength - 1 - i)) & 63)
	}
	return code
}

const (
	// ChatContext 用于聊天密钥的派生（HKDF 的 salt）和聊天密文的 AAD
	ChatContext = "OpenHane-Chat-v1"
	// ImageContext 是加密图片的 AAD；ImageMagic 是加密图片文件的开头
	ImageContext = "OpenHane-ChatImage-v1"
	ImageMagic   = "HNE1"
)

// ChatKey = HKDF-SHA256(ikm = 媒体密钥, salt = "OpenHane-Chat-v1", info = 空, 32 字节)，用作 AES-256-GCM 的密钥。
func ChatKey(mediaKey []byte) []byte {
	k, err := hkdf.Key(sha256.New, mediaKey, []byte(ChatContext), "", 32)
	if err != nil {
		panic(err)
	}
	return k
}

// ChatAAD 把聊天密文绑定到房间、发送者和密钥索引：
// "OpenHane-Chat-v1" ‖ 0x00 ‖ room_id ‖ 0x00 ‖ 发送者 session_id ‖ 0x00 ‖ key_index（4 字节大端）
func ChatAAD(room, from string, index uint32) []byte {
	b := []byte(ChatContext + "\x00" + room + "\x00" + from + "\x00")
	return binary.BigEndian.AppendUint32(b, index)
}

func gcm(key []byte) cipher.AEAD {
	block, err := aes.NewCipher(key)
	if err != nil {
		panic(err)
	}
	a, err := cipher.NewGCM(block)
	if err != nil {
		panic(err)
	}
	return a
}

// SealImage 加密一张图片：文件 = "HNE1" ‖ nonce ‖ AES-256-GCM(key, nonce, 图片, aad = "OpenHane-ChatImage-v1")
func SealImage(key, nonce, image []byte) []byte {
	return gcm(key).Seal(append([]byte(ImageMagic), nonce...), nonce, image, []byte(ImageContext))
}

type ChatCase struct {
	MediaKey      string `json:"mediaKey"`
	RoomID        string `json:"roomId"`
	FromSessionID string `json:"fromSessionId"`
	KeyIndex      uint32 `json:"keyIndex"`
	ChatKey       string `json:"chatKey"`
	AAD           string `json:"aad"`
	Nonce         string `json:"nonce"`
	Plaintext     string `json:"plaintext"` // ChatPlaintext 的 protobuf 编码
	Ciphertext    string `json:"ciphertext"`
	Text          string `json:"text"`
}

type ImageCase struct {
	Key    string `json:"key"`
	Nonce  string `json:"nonce"`
	Image  string `json:"image"`
	File   string `json:"file"` // 上传的文件
	Digest string `json:"digest"`
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
	Code    []int    `json:"code"`
}

type Vectors struct {
	Suite      string       `json:"suite"`
	Info       string       `json:"info"`
	HPKE       []HPKECase   `json:"hpke"`
	SafetyCode []SafetyCase `json:"safetyCode"`
	Chat       []ChatCase   `json:"chat"`
	ChatImage  []ImageCase  `json:"chatImage"`
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
	img := []byte("\x89PNG\r\n\x1a\n 不是真的图片，只用来测试加密")
	imgKey, imgNonce := seeded("hane-chat-image-key"), seeded("hane-chat-image-nonce")[:12]
	file := SealImage(imgKey, imgNonce, img)
	digest := sha256.Sum256(file)
	v.ChatImage = []ImageCase{{Key: hex.EncodeToString(imgKey), Nonce: hex.EncodeToString(imgNonce), Image: hex.EncodeToString(img),
		File: hex.EncodeToString(file), Digest: hex.EncodeToString(digest[:])}}
	for i, c := range []struct {
		room, from, text string
		index            uint32
		image            bool
	}{{"main", "4qy8nkgc2b", "你好 👋", 0, false}, {"r_abc123", "s_alice", "", 7, true}} {
		mk := seeded(fmt.Sprintf("hane-chat-media-key-%d", i))
		nonce := seeded(fmt.Sprintf("hane-chat-nonce-%d", i))[:12]
		plain := &pb.ChatPlaintext{Text: c.text}
		if c.image {
			plain.Image = &pb.EncryptedImageKey{Key: imgKey, Digest: digest[:], Mime: "image/png", Width: 640, Height: 480}
		}
		pt, err := proto.Marshal(plain)
		if err != nil {
			t.Fatal(err)
		}
		key, aad := ChatKey(mk), ChatAAD(c.room, c.from, c.index)
		v.Chat = append(v.Chat, ChatCase{
			MediaKey: hex.EncodeToString(mk), RoomID: c.room, FromSessionID: c.from, KeyIndex: c.index,
			ChatKey: hex.EncodeToString(key), AAD: hex.EncodeToString(aad), Nonce: hex.EncodeToString(nonce),
			Plaintext: hex.EncodeToString(pt), Ciphertext: hex.EncodeToString(gcm(key).Seal(nil, nonce, pt, aad)), Text: c.text,
		})
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
		if got := SafetyCode(c.Members); !slices.Equal(got, c.Code) {
			t.Fatalf("safety code: %v != %v", got, c.Code)
		}
	}
	// 聊天：密钥派生、AAD 和加密结果不变（nonce 固定时 AES-GCM 是确定的）
	for _, c := range v.Chat {
		mk, _ := hex.DecodeString(c.MediaKey)
		nonce, _ := hex.DecodeString(c.Nonce)
		pt, _ := hex.DecodeString(c.Plaintext)
		key, aad := ChatKey(mk), ChatAAD(c.RoomID, c.FromSessionID, c.KeyIndex)
		if hex.EncodeToString(key) != c.ChatKey || hex.EncodeToString(aad) != c.AAD ||
			hex.EncodeToString(gcm(key).Seal(nil, nonce, pt, aad)) != c.Ciphertext {
			t.Fatal("chat vector changed")
		}
		var plain pb.ChatPlaintext
		if err := proto.Unmarshal(pt, &plain); err != nil || plain.GetText() != c.Text {
			t.Fatal("chat plaintext", err)
		}
	}
	for _, c := range v.ChatImage {
		key, _ := hex.DecodeString(c.Key)
		nonce, _ := hex.DecodeString(c.Nonce)
		img, _ := hex.DecodeString(c.Image)
		file := SealImage(key, nonce, img)
		digest := sha256.Sum256(file)
		if hex.EncodeToString(file) != c.File || hex.EncodeToString(digest[:]) != c.Digest {
			t.Fatal("image vector changed")
		}
	}
	if !bytes.Equal(KeyPackageAAD("r", "a", "b", 1), []byte("r\x00a\x00b\x00\x00\x00\x00\x01")) {
		t.Fatal("aad layout")
	}
}
