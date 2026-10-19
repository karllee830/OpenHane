package imaging

import (
	"encoding/binary"
	"image"
	"image/color"
	"testing"
)

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
	dst := Downscale(src, 2, 2)
	for y := range 2 {
		for x := range 2 {
			if c := dst.RGBAAt(x, y); c.R != 128 || c.A != 255 {
				t.Fatalf("(%d,%d) = %v, want gray 128", x, y, c)
			}
		}
	}
	// 长方形：6×2 缩成 3×1
	if d := Downscale(image.NewRGBA(image.Rect(0, 0, 6, 2)), 3, 1); d.Bounds().Dx() != 3 || d.Bounds().Dy() != 1 {
		t.Fatalf("rect: %v", d.Bounds())
	}
}

func TestFitWithin(t *testing.T) {
	for _, c := range []struct{ w, h, side, ww, wh int }{
		{100, 50, 200, 100, 50},
		{8000, 4000, 4096, 4096, 2048},
		{3000, 6000, 4096, 2048, 4096},
		{10000, 1, 4096, 4096, 1},
	} {
		if w, h := FitWithin(c.w, c.h, c.side); w != c.ww || h != c.wh {
			t.Errorf("FitWithin(%d,%d,%d) = %d×%d, want %d×%d", c.w, c.h, c.side, w, h, c.ww, c.wh)
		}
	}
}

// exifJPEG 生成只有文件头和一个 EXIF 段的 JPEG 片段（够读方向用）
func exifJPEG(order string, orientation uint16) []byte {
	var bo binary.ByteOrder = binary.BigEndian
	if order == "II" {
		bo = binary.LittleEndian
	}
	tiff := make([]byte, 8+2+12+4)
	copy(tiff, order)
	bo.PutUint16(tiff[2:], 42)
	bo.PutUint32(tiff[4:], 8)
	bo.PutUint16(tiff[8:], 1)
	e := tiff[10:]
	bo.PutUint16(e[0:], 0x0112)
	bo.PutUint16(e[2:], 3)
	bo.PutUint32(e[4:], 1)
	bo.PutUint16(e[8:], orientation)
	seg := append([]byte("Exif\x00\x00"), tiff...)
	out := []byte{0xFF, 0xD8, 0xFF, 0xE1, 0, 0}
	binary.BigEndian.PutUint16(out[4:], uint16(len(seg)+2))
	out = append(out, seg...)
	return append(out, 0xFF, 0xDA, 0, 2)
}

func TestJPEGOrientation(t *testing.T) {
	if o := JPEGOrientation(exifJPEG("MM", 6)); o != 6 {
		t.Fatalf("big endian: %d", o)
	}
	if o := JPEGOrientation(exifJPEG("II", 8)); o != 8 {
		t.Fatalf("little endian: %d", o)
	}
	if o := JPEGOrientation(exifJPEG("II", 42)); o != 1 {
		t.Fatalf("out of range: %d", o)
	}
	// 截断、畸形的数据不会越界，按没有方向处理
	b := exifJPEG("MM", 6)
	for n := range len(b) {
		if o := JPEGOrientation(b[:n]); o != 1 && o != 6 {
			t.Fatalf("truncated at %d: %d", n, o)
		}
	}
	if o := JPEGOrientation([]byte("not a jpeg")); o != 1 {
		t.Fatalf("garbage: %d", o)
	}
}

func TestOrient(t *testing.T) {
	// 3×2 的图，每个像素的 R 是它的编号：
	//   0 1 2
	//   3 4 5
	src := image.NewRGBA(image.Rect(0, 0, 3, 2))
	for i := range 6 {
		src.Pix[i*4] = uint8(i)
	}
	read := func(img *image.RGBA) (out []uint8) {
		for y := range img.Bounds().Dy() {
			for x := range img.Bounds().Dx() {
				out = append(out, img.RGBAAt(x, y).R)
			}
		}
		return
	}
	for o, want := range map[int][]uint8{
		1: {0, 1, 2, 3, 4, 5},
		2: {2, 1, 0, 5, 4, 3},
		3: {5, 4, 3, 2, 1, 0},
		4: {3, 4, 5, 0, 1, 2},
		5: {0, 3, 1, 4, 2, 5},
		6: {3, 0, 4, 1, 5, 2},
		7: {5, 2, 4, 1, 3, 0},
		8: {2, 5, 1, 4, 0, 3},
	} {
		got := read(Orient(src, o))
		if string(got) != string(want) {
			t.Errorf("orientation %d: %v, want %v", o, got, want)
		}
	}
}
