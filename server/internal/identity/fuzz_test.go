package identity

import (
	"strings"
	"testing"
	"unicode"
	"unicode/utf8"
)

// 昵称来自客户端，原样广播给所有人：规范化后的结果必须满足约束，且再规范化一次不变
func FuzzNormalizeNickname(f *testing.F) {
	for _, s := range []string{"Alice", "  张三  ", "a​b", "\t", "😀😀", strings.Repeat("长", 40), "a\nb", "\xff"} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, in string) {
		out, err := NormalizeNickname(in)
		if err != nil {
			return
		}
		n := utf8.RuneCountInString(out)
		if !utf8.ValidString(out) || n == 0 || n > MaxNicknameRunes || out != strings.TrimSpace(out) {
			t.Fatalf("invalid result %q from %q", out, in)
		}
		for _, r := range out {
			if unicode.Is(unicode.Cc, r) || unicode.Is(unicode.Cf, r) {
				t.Fatalf("control/format rune %U in %q", r, out)
			}
		}
		if again, err := NormalizeNickname(out); err != nil || again != out {
			t.Fatalf("not idempotent: %q → %q (%v)", out, again, err)
		}
		// 去重后的昵称同样满足长度约束
		u := Uniquify(out, func(c string) bool { return c == out })
		if utf8.RuneCountInString(u) > MaxNicknameRunes || u == out {
			t.Fatalf("uniquify %q → %q", out, u)
		}
	})
}
