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
	"golang.org/x/text/unicode/norm"
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

// NormalizeNickname 按显示名的规则检查昵称（见 NormalizeDisplayName）。
func NormalizeNickname(s string) (string, error) {
	out, ok := NormalizeDisplayName(s, MaxNicknameRunes)
	if !ok {
		return "", ErrNicknameInvalid
	}
	return out, nil
}

// MaxCombiningRun 是连续组合字符（Mn / Me，例如声调符号）的上限：正常文字最多叠两三个，
// 再多就是把字往上下堆出界的「Zalgo」文字。
const MaxCombiningRun = 3

// NormalizeDisplayName 是昵称、服务器名称等显示名的统一规则：转成 NFC，去掉首尾空白后为 1–maxRunes 个字符；
// 不含控制字符（Cc）、格式字符（Cf，零宽字符、方向控制符等）、换行等非空格的空白，
// 连续的组合字符不超过 MaxCombiningRun 个。客户端显示前也按同样的规则清洗。
func NormalizeDisplayName(s string, maxRunes int) (string, bool) {
	if !utf8.ValidString(s) {
		return "", false
	}
	s = strings.TrimSpace(norm.NFC.String(s))
	if n := utf8.RuneCountInString(s); n == 0 || n > maxRunes {
		return "", false
	}
	run := 0
	for _, r := range s {
		if unicode.Is(unicode.Cc, r) || unicode.Is(unicode.Cf, r) || (unicode.IsSpace(r) && r != ' ' && r != '　') {
			return "", false
		}
		if unicode.In(r, unicode.Mn, unicode.Me) {
			if run++; run > MaxCombiningRun {
				return "", false
			}
		} else {
			run = 0
		}
	}
	return s, true
}

var lineBreaks = strings.NewReplacer("\r\n", "\n", "\r", "\n", " ", "\n", " ", "\n")

// CleanChatText 清洗聊天正文（客户端显示前也按同样的规则处理）：转成 NFC；换行统一成 \n，制表符保留，
// 其他控制字符去掉；去掉格式字符（方向控制符、零宽空格等），但保留零宽连接符 / 非连接符和标签字符
// （emoji 序列和一些文字要用）；连续的组合字符最多保留 MaxCombiningRun 个；去掉首尾空白。s 必须是合法的 UTF-8。
func CleanChatText(s string) string {
	s = lineBreaks.Replace(norm.NFC.String(s))
	var b strings.Builder
	b.Grow(len(s))
	run := 0
	for _, r := range s {
		keep := r == '\n' || r == '\t' || r == '‌' || r == '‍' || (r >= 0xE0020 && r <= 0xE007F)
		if !keep && (unicode.Is(unicode.Cc, r) || unicode.Is(unicode.Cf, r)) {
			continue
		}
		if unicode.In(r, unicode.Mn, unicode.Me) {
			if run++; run > MaxCombiningRun {
				continue
			}
		} else {
			run = 0
		}
		b.WriteRune(r)
	}
	return strings.TrimSpace(b.String())
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
