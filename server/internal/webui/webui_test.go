package webui

import (
	"compress/gzip"
	"io"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
	"time"
)

func testHandler() *Handler {
	big := strings.Repeat("console.log('x');", 200)
	return &Handler{
		files: fstest.MapFS{
			"index.html":         {Data: []byte("<html>app</html>")},
			"assets/app-123.js":  {Data: []byte(big)},
			"assets/style-1.css": {Data: []byte("body{}")},
			"assets/dfn-1.wasm":  {Data: append([]byte("\x00asm\x01\x00\x00\x00"), make([]byte, 4096)...)},
			"assets/model-1.bin": {Data: make([]byte, 4096)},
		},
		index: []byte("<html>app</html>"),
		start: time.Now(),
	}
}

func TestServesSPAAndAssets(t *testing.T) {
	h := testHandler()
	for _, p := range []string{"/", "/j/AbC123", "/anything"} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest("GET", p, nil))
		if rec.Code != 200 || rec.Body.String() != "<html>app</html>" || rec.Header().Get("Content-Security-Policy") == "" {
			t.Fatalf("%s: %d %q", p, rec.Code, rec.Body.String())
		}
	}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/assets/app-123.js", nil)
	req.Header.Set("Accept-Encoding", "gzip, br")
	h.ServeHTTP(rec, req)
	if rec.Header().Get("Content-Encoding") != "gzip" || !strings.Contains(rec.Header().Get("Cache-Control"), "immutable") ||
		!strings.Contains(rec.Header().Get("Content-Type"), "javascript") {
		t.Fatalf("headers: %v", rec.Header())
	}
	zr, _ := gzip.NewReader(rec.Body)
	body, _ := io.ReadAll(zr)
	if !strings.HasPrefix(string(body), "console.log") {
		t.Fatal("bad gzip body")
	}
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/assets/missing.js", nil))
	if rec.Code != 404 {
		t.Fatal(rec.Code)
	}
	// 邀请落地页 /j/<码> 下的相对资源路径
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/j/abc123/assets/style-1.css", nil))
	if rec.Code != 200 || rec.Body.String() != "body{}" {
		t.Fatal(rec.Code, rec.Body.String())
	}
}

// AI 降噪的 WASM 压缩传输；模型（已经是 tar.gz）原样传输，不能带 Content-Encoding（否则浏览器会解压掉）
func TestWasmCompressedModelAsIs(t *testing.T) {
	h := testHandler()
	get := func(p string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest("GET", p, nil)
		req.Header.Set("Accept-Encoding", "gzip")
		h.ServeHTTP(rec, req)
		return rec
	}
	rec := get("/assets/dfn-1.wasm")
	if rec.Header().Get("Content-Type") != "application/wasm" || rec.Header().Get("Content-Encoding") != "gzip" {
		t.Fatalf("wasm headers: %v", rec.Header())
	}
	zr, err := gzip.NewReader(rec.Body)
	if err != nil {
		t.Fatal(err)
	}
	if body, _ := io.ReadAll(zr); len(body) != 4104 || string(body[:4]) != "\x00asm" {
		t.Fatalf("wasm body: %d bytes", len(body))
	}
	rec = get("/assets/model-1.bin")
	if rec.Header().Get("Content-Encoding") != "" || rec.Body.Len() != 4096 {
		t.Fatalf("model: %v, %d bytes", rec.Header(), rec.Body.Len())
	}
}
