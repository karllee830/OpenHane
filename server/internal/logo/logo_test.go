package logo

import (
	"bytes"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// 一张 w×h 的图：左半边不透明的红色，右半边完全透明，正中一列半透明（检查透明通道和缩放）
func pngImage(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for y := range h {
		for x := range w {
			switch {
			case x < w/2:
				img.SetNRGBA(x, y, color.NRGBA{255, 0, 0, 255})
			case x == w/2:
				img.SetNRGBA(x, y, color.NRGBA{0, 0, 255, 128})
			}
		}
	}
	var b bytes.Buffer
	if err := png.Encode(&b, img); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func newStore(t *testing.T) (*Store, string) {
	dir := t.TempDir()
	return New(dir, slog.New(slog.NewTextHandler(io.Discard, nil))), dir
}

// 写入原图并把修改时间往后挪，保证与上一次不同
func put(t *testing.T, path string, data []byte, tick *time.Time) {
	t.Helper()
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
	*tick = tick.Add(time.Second)
	_ = os.Chtimes(path, *tick, *tick)
}

func decodeOutput(t *testing.T, img *Image) image.Image {
	t.Helper()
	data, err := os.ReadFile(img.Path)
	if err != nil {
		t.Fatal(err)
	}
	out, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func TestProcessesLogo(t *testing.T) {
	s, dir := newStore(t)
	src := filepath.Join(dir, "logo.png")
	tick := time.Now()
	if s.Get() != nil {
		t.Fatal("no logo file: want nil")
	}

	// 1024 的原图缩到 512，写成隐藏的 .logo，原图不动；透明的地方仍然透明
	orig := pngImage(t, 1024, 1024)
	put(t, src, orig, &tick)
	a := s.Get()
	if a == nil || filepath.Base(a.Path) != OutputName || len(a.ETag) != 16 {
		t.Fatalf("1024: %+v", a)
	}
	if b, _ := os.ReadFile(src); !bytes.Equal(b, orig) {
		t.Fatal("source was modified")
	}
	out := decodeOutput(t, a)
	if out.Bounds().Dx() != Output || out.Bounds().Dy() != Output {
		t.Fatalf("output is %v, want %d×%d", out.Bounds(), Output, Output)
	}
	if _, _, _, alpha := out.At(Output-1, 0).RGBA(); alpha != 0 {
		t.Fatalf("transparent pixel became alpha %d", alpha)
	}
	if r, _, _, alpha := out.At(0, 0).RGBA(); alpha != 0xffff || r != 0xffff {
		t.Fatalf("opaque red pixel: r=%d alpha=%d", r, alpha)
	}
	// 半透明的那一列和完全透明的一列平均后是半透明的，不会变成不透明
	if _, _, _, alpha := out.At(Output/2, 0).RGBA(); alpha == 0 || alpha == 0xffff {
		t.Fatalf("semi-transparent edge: alpha %d", alpha)
	}

	// 没变：直接用 .logo，不重新处理
	if b := s.Get(); b != a {
		t.Fatal("unchanged source: want the same image")
	}

	// .logo 被改动或删掉：从原图重新生成
	_ = os.WriteFile(a.Path, []byte("tampered"), 0o644)
	if b := s.Get(); b == nil || decodeOutput(t, b).Bounds().Dx() != Output {
		t.Fatal("tampered .logo: want regenerated")
	}
	_ = os.Remove(a.Path)
	if b := s.Get(); b == nil {
		t.Fatal("deleted .logo: want regenerated")
	}

	// 在 256–512 之间的原图保持原尺寸，只重新编码
	put(t, src, pngImage(t, 300, 300), &tick)
	b := s.Get()
	if b == nil || b.ETag == a.ETag || decodeOutput(t, b).Bounds().Dx() != 300 {
		t.Fatalf("300: %+v", b)
	}

	// JPEG 原图也输出 PNG
	_ = os.Remove(src)
	var jb bytes.Buffer
	_ = jpeg.Encode(&jb, image.NewRGBA(image.Rect(0, 0, 600, 600)), nil)
	put(t, filepath.Join(dir, "logo.jpg"), jb.Bytes(), &tick)
	if c := s.Get(); c == nil || decodeOutput(t, c).Bounds().Dx() != Output {
		t.Fatal("jpeg: want a 512 PNG")
	}

	// 删掉原图：.logo 也删掉
	_ = os.Remove(filepath.Join(dir, "logo.jpg"))
	if s.Get() != nil {
		t.Fatal("removed source: want nil")
	}
	if _, err := os.Stat(filepath.Join(dir, OutputName)); !os.IsNotExist(err) {
		t.Fatal(".logo should be removed with the source")
	}
}

func TestRejectsBadLogos(t *testing.T) {
	s, dir := newStore(t)
	src := filepath.Join(dir, "logo.png")
	tick := time.Now()
	for name, data := range map[string][]byte{
		"too small":  pngImage(t, 128, 128),
		"too large":  pngImage(t, 2048, 2048),
		"not square": pngImage(t, 512, 300),
		"not image":  []byte("<svg xmlns='http://www.w3.org/2000/svg'/>"),
		"too big":    append(pngImage(t, 512, 512), make([]byte, MaxBytes)...),
	} {
		put(t, src, data, &tick)
		if img := s.Get(); img != nil {
			t.Errorf("%s: want nil, got %+v", name, img)
		}
		if _, err := os.Stat(filepath.Join(dir, OutputName)); !os.IsNotExist(err) {
			t.Errorf("%s: .logo should not exist", name)
		}
	}
}

func TestDownscaleAveragesArea(t *testing.T) {
	// 4×4 的棋盘（黑白相间）缩成 2×2：每个像素都是一半黑一半白的平均
	src := image.NewRGBA(image.Rect(0, 0, 4, 4))
	for y := range 4 {
		for x := range 4 {
			v := uint8(0)
			if (x+y)%2 == 0 {
				v = 255
			}
			src.SetRGBA(x, y, color.RGBA{v, v, v, 255})
		}
	}
	dst := downscale(src, 2)
	for y := range 2 {
		for x := range 2 {
			if c := dst.RGBAAt(x, y); c.R != 128 || c.A != 255 {
				t.Fatalf("(%d,%d) = %v, want gray 128", x, y, c)
			}
		}
	}
}
