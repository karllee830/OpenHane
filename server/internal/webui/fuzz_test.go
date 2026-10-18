package webui

import (
	"net/http/httptest"
	"testing"
)

// 任意路径：只能返回入口页、真实存在的嵌入资源或 404，不会读到其他内容
func FuzzPath(f *testing.F) {
	for _, p := range []string{"/", "/assets/app-123.js", "/j/abc/assets/style-1.css", "/../../etc/passwd", "/assets/../index.html", "//assets//app-123.js", "/assets/%2e%2e/x"} {
		f.Add(p)
	}
	h := testHandler()
	f.Fuzz(func(t *testing.T, p string) {
		r := httptest.NewRequest("GET", "/", nil)
		r.URL.Path = p
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, r)
		body := rec.Body.String()
		switch rec.Code {
		case 200:
			if rec.Header().Get("Content-Encoding") == "" && body != "<html>app</html>" && body != "body{}" && len(body) != len("console.log('x');")*200 {
				t.Fatalf("path %q served unexpected content %q", p, body)
			}
		case 404, 304, 206, 416:
		default:
			t.Fatalf("path %q: status %d", p, rec.Code)
		}
	})
}
