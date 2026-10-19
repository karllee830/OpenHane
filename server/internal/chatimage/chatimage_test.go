package chatimage

import (
	"bytes"
	"context"
	"errors"
	"image"
	"image/color"
	"image/png"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
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
	err      error
	maxBytes int64
	quota    int64
}

func (f *fakeAccess) BeginUpload(context.Context, string, string) (string, int64, int64, error) {
	return "s1", f.maxBytes, f.quota, f.err
}
func (f *fakeAccess) FinishUpload(context.Context, string, string, Info) bool { return true }
func (f *fakeAccess) CanRead(context.Context, string, string) bool            { return true }

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
	// 跨域预检
	req, _ := http.NewRequest("OPTIONS", srv.URL+"/api/v1/chat/images", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil || resp.StatusCode != http.StatusNoContent || resp.Header.Get("Access-Control-Allow-Headers") == "" {
		t.Fatal("preflight", resp, err)
	}
	resp.Body.Close()
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
