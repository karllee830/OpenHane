package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"strings"
)

// 权限令牌格式：HANE- 前缀 + 20 个 Crockford Base32 字符（100 位熵），4 个一组用连字符分隔：
//
//	HANE-7F3K-9QX2-MZ8P-4LTA-H6WD
//
// 输入时忽略大小写、空白和连字符，并纠正易混字符（O→0、I/L→1）。服务端只保存 SHA-256(规范化后的 20 个字符)。
const (
	crockford   = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
	tokenPrefix = "HANE-"
	tokenChars  = 20
)

var ErrTokenFormat = errors.New("not a privilege token")

// NewToken 生成新令牌，返回展示用的明文和存储用的哈希。
func NewToken() (display string, hash []byte) {
	raw := randomCrockford(tokenChars)
	var b strings.Builder
	b.WriteString(tokenPrefix)
	for i := 0; i < tokenChars; i += 4 {
		if i > 0 {
			b.WriteByte('-')
		}
		b.WriteString(raw[i : i+4])
	}
	return b.String(), HashToken(raw)
}

// NewTokenID 生成用于列表展示和吊销的短 ID。
func NewTokenID() string { return strings.ToLower(randomCrockford(8)) }

// NormalizeToken 把用户输入规范化为 20 个 Crockford 字符。
func NormalizeToken(in string) (string, error) {
	s := strings.ToUpper(strings.TrimSpace(in))
	s = strings.TrimPrefix(s, "HANE")
	var b strings.Builder
	for _, r := range s {
		switch {
		case r == '-' || r == ' ' || r == '\t':
			continue
		case r == 'O':
			r = '0'
		case r == 'I' || r == 'L':
			r = '1'
		}
		if !strings.ContainsRune(crockford, r) {
			return "", ErrTokenFormat
		}
		b.WriteRune(r)
	}
	if b.Len() != tokenChars {
		return "", ErrTokenFormat
	}
	return b.String(), nil
}

// HashToken 计算规范化令牌的哈希。
func HashToken(normalized string) []byte {
	sum := sha256.Sum256([]byte(normalized))
	return sum[:]
}

func randomCrockford(n int) string {
	buf := make([]byte, n)
	rand.Read(buf)
	for i := range buf {
		buf[i] = crockford[buf[i]&31] // 256 是 32 的整数倍，没有取模偏差
	}
	return string(buf)
}

// RandomID 生成 n 个字符的小写 Crockford 随机 ID（会话 ID 等）。
func RandomID(n int) string { return strings.ToLower(randomCrockford(n)) }
