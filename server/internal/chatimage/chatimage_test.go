package chatimage

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func pngOf(t *testing.T, w, h int, alpha uint8) []byte {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for y := range h {
		for x := range w {
			img.SetNRGBA(x, y, color.NRGBA{0, 0, 255, alpha})
		}
	}
	var b bytes.Buffer
	if err := png.Encode(&b, img); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func TestProcess(t *testing.T) {
	// PNG 输出仍是 PNG，透明度保留
	out, w, h, err := Process(pngOf(t, 30, 20, 100))
	if err != nil || w != 30 || h != 20 {
		t.Fatal(w, h, err)
	}
	img, err := png.Decode(bytes.NewReader(out))
	if err != nil {
		t.Fatal(err)
	}
	if _, _, _, a := img.At(5, 5).RGBA(); a == 0 || a == 0xffff {
		t.Fatalf("alpha lost: %d", a)
	}
	// 边长、像素数超限的只读文件头就拒绝
	if _, _, _, err := Process(pngOf(t, MaxSide+1, 1, 255)); !errors.Is(err, ErrSize) {
		t.Fatal("too wide:", err)
	}
	for name, data := range map[string][]byte{
		"svg":       []byte("<svg xmlns='http://www.w3.org/2000/svg'/>"),
		"gif":       []byte("GIF89a\x01\x00\x01\x00\x00\x00\x00;"),
		"truncated": pngOf(t, 10, 10, 255)[:40],
	} {
		if _, _, _, err := Process(data); err == nil {
			t.Errorf("%s: want error", name)
		}
	}
}

type fakeAccess struct {
	err       error
	maxBytes  int64
	quota     int64
	encrypted bool
	last      Info
}

func (f *fakeAccess) BeginUpload(context.Context, string, string) (string, int64, int64, bool, error) {
	return "s1", f.maxBytes, f.quota, f.encrypted, f.err
}
func (f *fakeAccess) FinishUpload(_ context.Context, _, _ string, img Info) bool {
	f.last = img
	return true
}
func (f *fakeAccess) CanRead(context.Context, string, string) bool { return true }

func TestHandlerErrors(t *testing.T) {
	store, err := Open(t.TempDir(), slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	acc := &fakeAccess{maxBytes: 1 << 20, quota: 1 << 30}
	srv := httptest.NewServer(Handler(store, acc, slog.New(slog.NewTextHandler(io.Discard, nil))))
	defer srv.Close()
	post := func(body []byte) int {
		resp, err := http.Post(srv.URL+"/api/v1/chat/images?room=main", "image/png", bytes.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return resp.StatusCode
	}
	small := pngOf(t, 10, 10, 255)
	if code := post(small); code != http.StatusOK || store.Used() == 0 {
		t.Fatalf("ok: %d, used %d", code, store.Used())
	}
	acc.err = ErrDisabled
	if code := post(small); code != http.StatusForbidden {
		t.Fatalf("disabled: %d", code)
	}
	acc.err = nil
	acc.maxBytes = 10
	if code := post(small); code != http.StatusRequestEntityTooLarge {
		t.Fatalf("too large: %d", code)
	}
	acc.maxBytes, acc.quota = 1<<20, store.Used()
	if code := post(small); code != http.StatusInsufficientStorage {
		t.Fatalf("storage full: %d", code)
	}
	// 端到端加密房间：只收加密的文件，原样保存，读取时按二进制返回；明文图片不收
	acc.quota, acc.encrypted = 1<<30, true
	if code := post(small); code != http.StatusUnsupportedMediaType {
		t.Fatalf("plain image in encrypted room: %d", code)
	}
	blob := append([]byte(EncryptedMagic), bytes.Repeat([]byte{7}, 12+16+100)...)
	if code := post(blob); code != http.StatusOK || !acc.last.Encrypted || acc.last.Width != 0 || acc.last.Size != int64(len(blob)) {
		t.Fatalf("encrypted: %d %+v", code, acc.last)
	}
	resp, err := http.Get(srv.URL + "/api/v1/chat/images/main/" + acc.last.ID)
	if err != nil {
		t.Fatal(err)
	}
	got, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.Header.Get("Content-Type") != "application/octet-stream" || !bytes.Equal(got, blob) {
		t.Fatalf("read encrypted: %s %d bytes", resp.Header.Get("Content-Type"), len(got))
	}
	// 跨域预检
	req, _ := http.NewRequest("OPTIONS", srv.URL+"/api/v1/chat/images", nil)
	resp, err = http.DefaultClient.Do(req)
	if err != nil || resp.StatusCode != http.StatusNoContent || resp.Header.Get("Access-Control-Allow-Headers") == "" {
		t.Fatal("preflight", resp, err)
	}
	resp.Body.Close()
}

// 分块上传：按顺序传完再处理；重复的一块直接确认，乱序、超出声明大小、别的会话的凭据都被拒绝。读取支持 Range
func TestChunkedUploadAndRange(t *testing.T) {
	store, err := Open(t.TempDir(), slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	acc := &fakeAccess{maxBytes: 1 << 20, quota: 1 << 30}
	srv := httptest.NewServer(Handler(store, acc, slog.New(slog.NewTextHandler(io.Discard, nil))))
	defer srv.Close()
	do := func(method, path, token string, body []byte, hdr ...string) (*http.Response, []byte) {
		req, _ := http.NewRequest(method, srv.URL+path, bytes.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+token)
		for i := 0; i+1 < len(hdr); i += 2 {
			req.Header.Set(hdr[i], hdr[i+1])
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		return resp, b
	}
	img := pngOf(t, 40, 30, 255)
	resp, body := do("POST", fmt.Sprintf("/api/v1/chat/images/uploads?room=main&size=%d", len(img)), "tok", nil)
	var started struct{ Upload string }
	if resp.StatusCode != http.StatusOK || json.Unmarshal(body, &started) != nil || started.Upload == "" {
		t.Fatalf("begin: %d %s", resp.StatusCode, body)
	}
	put := func(token string, off int, chunk []byte) int {
		r, _ := do("PUT", fmt.Sprintf("/api/v1/chat/images/uploads/%s?offset=%d", started.Upload, off), token, chunk)
		return r.StatusCode
	}
	half := len(img) / 2
	if code := put("tok", 0, img[:half]); code != http.StatusNoContent {
		t.Fatalf("chunk 1: %d", code)
	}
	if code := put("tok", 0, img[:half]); code != http.StatusNoContent {
		t.Fatalf("retried chunk: %d", code)
	}
	if code := put("other", half, img[half:]); code != http.StatusNotFound {
		t.Fatalf("other session: %d", code)
	}
	if code := put("tok", half+1, img[half:]); code != http.StatusConflict {
		t.Fatalf("gap: %d", code)
	}
	if r, _ := do("POST", "/api/v1/chat/images/uploads/"+started.Upload+"/finish", "tok", nil); r.StatusCode != http.StatusBadRequest {
		t.Fatalf("finish early: %d", r.StatusCode)
	}
	if code := put("tok", half, append(img[half:], 0)); code != http.StatusRequestEntityTooLarge {
		t.Fatalf("over size: %d", code)
	}
	if code := put("tok", half, img[half:]); code != http.StatusNoContent {
		t.Fatalf("chunk 2: %d", code)
	}
	resp, body = do("POST", "/api/v1/chat/images/uploads/"+started.Upload+"/finish", "tok", nil)
	var info Info
	if resp.StatusCode != http.StatusOK || json.Unmarshal(body, &info) != nil || info.Width != 40 || info.Height != 30 {
		t.Fatalf("finish: %d %s", resp.StatusCode, body)
	}
	if r, _ := do("POST", "/api/v1/chat/images/uploads/"+started.Upload+"/finish", "tok", nil); r.StatusCode != http.StatusNotFound {
		t.Fatalf("finish twice: %d", r.StatusCode)
	}
	// 声明的大小超过上限
	if r, _ := do("POST", "/api/v1/chat/images/uploads?room=main&size=2000000", "tok", nil); r.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("declared too large: %d", r.StatusCode)
	}
	// 分段读取：206 和 Content-Range（跨域时客户端也能读到）
	resp, body = do("GET", "/api/v1/chat/images/main/"+info.ID, "tok", nil, "Range", "bytes=0-9")
	if resp.StatusCode != http.StatusPartialContent || len(body) != 10 || !strings.HasPrefix(resp.Header.Get("Content-Range"), "bytes 0-9/") ||
		!strings.Contains(resp.Header.Get("Access-Control-Expose-Headers"), "Content-Range") {
		t.Fatalf("range: %d %d %q", resp.StatusCode, len(body), resp.Header.Get("Content-Range"))
	}
}

func TestStoreSweepAndDelete(t *testing.T) {
	store, err := Open(t.TempDir(), slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	a, b := NewID(), NewID()
	_ = store.Save("main", a, []byte("aaaa"))
	_ = store.Save("r_x", b, []byte("bb"))
	if store.Used() != 6 {
		t.Fatalf("used %d", store.Used())
	}
	if err := store.Save("../x", a, []byte("x")); err == nil {
		t.Fatal("invalid room accepted")
	}
	store.Sweep(map[string]bool{"main/" + a: true})
	if store.Used() != 4 {
		t.Fatalf("after sweep: %d", store.Used())
	}
	if _, _, err := store.Open("r_x", b); err == nil {
		t.Fatal("unreferenced image should be swept")
	}
	store.Delete("main", a)
	if store.Used() != 0 {
		t.Fatalf("after delete: %d", store.Used())
	}
}
