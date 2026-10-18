// Package identity 处理密钥身份：UID 计算、昵称规范化与去重、身份安全等级（工作量证明）。
package identity

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base32"
	"errors"
	"fmt"
	"io"
	"math/bits"
	"strings"
	"unicode"
	"unicode/utf8"

	"golang.org/x/crypto/hkdf"
)

var b32 = base32.StdEncoding.WithPadding(base32.NoPadding)

// UID = base32(SHA-256(公钥)) 的前 20 个字符（100 位），小写。
func UID(pub ed25519.PublicKey) string {
	sum := sha256.Sum256(pub)
	return strings.ToLower(b32.EncodeToString(sum[:]))[:20]
}

// ShortUID 是界面展示用的短格式，如 k3m9-x2qa。
func ShortUID(uid string) string {
	if len(uid) < 8 {
		return uid
	}
	return uid[:4] + "-" + uid[4:8]
}

const MaxNicknameRunes = 32

var ErrNicknameInvalid = errors.New("nickname must be 1–32 characters without control or invisible characters")

// NormalizeNickname 去掉首尾空白并校验：1–32 个字符，不含控制字符、格式字符（含零宽字符）。
func NormalizeNickname(s string) (string, error) {
	if !utf8.ValidString(s) {
		return "", ErrNicknameInvalid
	}
	s = strings.TrimSpace(s)
	n := utf8.RuneCountInString(s)
	if n == 0 || n > MaxNicknameRunes {
		return "", ErrNicknameInvalid
	}
	for _, r := range s {
		// Cc 控制字符；Cf 格式字符（零宽空格、方向控制符等）；换行等非空格空白
		if unicode.Is(unicode.Cc, r) || unicode.Is(unicode.Cf, r) || (unicode.IsSpace(r) && r != ' ' && r != '　') {
			return "", ErrNicknameInvalid
		}
	}
	return s, nil
}

// Uniquify 在昵称已被占用时追加后缀「 (2)」「 (3)」……，超长时截断原名。
// taken 按不区分大小写比较由调用方实现。
func Uniquify(name string, taken func(string) bool) string {
	if !taken(name) {
		return name
	}
	for i := 2; ; i++ {
		suffix := fmt.Sprintf(" (%d)", i)
		base := []rune(name)
		if max := MaxNicknameRunes - utf8.RuneCountInString(suffix); len(base) > max {
			base = base[:max]
		}
		if c := string(base) + suffix; !taken(c) {
			return c
		}
	}
}

// SecurityLevel 返回 SHA-256(公钥 || nonce) 的前导零位数（身份安全等级）。
func SecurityLevel(pub ed25519.PublicKey, nonce []byte) int {
	h := sha256.New()
	h.Write(pub)
	h.Write(nonce)
	sum := h.Sum(nil)
	n := 0
	for _, b := range sum {
		if b == 0 {
			n += 8
			continue
		}
		n += bits.LeadingZeros8(b)
		break
	}
	return n
}

// DeriveKey 由主种子为某个服务器派生身份私钥：
//
//	HKDF-SHA256(ikm = 主种子, salt = "OpenHane-Identity-v1", info = server_id) → 32 字节 Ed25519 种子
//
// 每个服务器看到的身份互不相同，用户只需备份一个主种子。服务端不调用它，这里作为各端实现的参考。
func DeriveKey(masterSeed, serverID []byte) ed25519.PrivateKey {
	r := hkdf.New(sha256.New, masterSeed, []byte("OpenHane-Identity-v1"), serverID)
	seed := make([]byte, ed25519.SeedSize)
	if _, err := io.ReadFull(r, seed); err != nil {
		panic(err)
	}
	return ed25519.NewKeyFromSeed(seed)
}
