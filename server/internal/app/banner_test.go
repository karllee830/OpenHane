package app

import "testing"

func TestDisplayWidth(t *testing.T) {
	cases := map[string]int{"abc": 3, "中文": 4, "菜单 → 使用": 11, "★ 令牌：": 8, "UDP 9800 ✓": 10}
	for s, want := range cases {
		if got := displayWidth(s); got != want {
			t.Errorf("%q: %d want %d", s, got, want)
		}
	}
}
