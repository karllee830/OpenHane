package auth

import (
	"strings"
	"testing"
)

// 令牌由用户粘贴：规范化结果只能是 20 个 Crockford 字符，且再规范化一次不变
func FuzzNormalizeToken(f *testing.F) {
	for _, s := range []string{"HANE-7F3K-9QX2-MZ8P-4LTA-H6WD", "hane 7f3k 9qx2 mz8p 4lta h6wd", "OOOOIIIILLLL00001111", "", "HANE-", "ü"} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, in string) {
		out, err := NormalizeToken(in)
		if err != nil {
			return
		}
		if len(out) != tokenChars {
			t.Fatalf("length %d: %q", len(out), out)
		}
		for _, r := range out {
			if !strings.ContainsRune(crockford, r) {
				t.Fatalf("invalid rune %q in %q", r, out)
			}
		}
		if again, err := NormalizeToken(out); err != nil || again != out {
			t.Fatalf("not idempotent: %q → %q (%v)", out, again, err)
		}
	})
}
