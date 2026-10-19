// Package imaging 是服务器图标和聊天图片共用的图片处理：按面积平均缩小、按 JPEG 的 EXIF 方向转正。
package imaging

import (
	"encoding/binary"
	"image"
)

// Downscale 把图片按面积平均缩到 w×h（只用于缩小）。src 是预乘透明度的 RGBA，半透明边缘不会发黑。
// 先横向再纵向，各自按覆盖比例加权
func Downscale(src *image.RGBA, w, h int) *image.RGBA {
	sw, sh := src.Bounds().Dx(), src.Bounds().Dy()
	xs, ys := weights(sw, w), weights(sh, h)
	// 横向：sh 行 × w 列
	tmp := make([]float64, sh*w*4)
	for y := range sh {
		row := src.Pix[y*src.Stride:]
		for x, ts := range xs {
			var acc [4]float64
			for _, t := range ts {
				p := row[t.i*4:]
				for c := range 4 {
					acc[c] += float64(p[c]) * t.w
				}
			}
			copy(tmp[(y*w+x)*4:], acc[:])
		}
	}
	// 纵向：h 行 × w 列
	dst := image.NewRGBA(image.Rect(0, 0, w, h))
	for y, ts := range ys {
		for x := range w {
			var acc [4]float64
			for _, t := range ts {
				p := tmp[(t.i*w+x)*4:]
				for c := range 4 {
					acc[c] += p[c] * t.w
				}
			}
			o := dst.Pix[y*dst.Stride+x*4:]
			a := clamp(acc[3])
			// 预乘的颜色不能超过透明度
			o[0], o[1], o[2], o[3] = min(clamp(acc[0]), a), min(clamp(acc[1]), a), min(clamp(acc[2]), a), a
		}
	}
	return dst
}

type tap struct {
	i int
	w float64
}

// weights：目标的每个像素覆盖原图的哪些像素、各占多少比例（权重之和为 1）
func weights(n, m int) [][]tap {
	scale := float64(n) / float64(m)
	out := make([][]tap, m)
	for d := range m {
		start, end := float64(d)*scale, float64(d+1)*scale
		for i := int(start); float64(i) < end && i < n; i++ {
			w := min(end, float64(i+1)) - max(start, float64(i))
			if w > 0 {
				out[d] = append(out[d], tap{i, w / scale})
			}
		}
	}
	return out
}

func clamp(v float64) uint8 {
	return uint8(min(255, max(0, v+0.5)))
}

// FitWithin 返回把 w×h 等比缩到长边不超过 side 后的尺寸（本来就不超过时原样返回）。
func FitWithin(w, h, side int) (int, int) {
	if w <= side && h <= side {
		return w, h
	}
	if w >= h {
		return side, max(1, (h*side+w/2)/w)
	}
	return max(1, (w*side+h/2)/h), side
}

// JPEGOrientation 读出 JPEG 的 EXIF 方向（1–8）；没有或读不出时返回 1。
// 只扫描图像数据之前的标记段，所有偏移都检查边界（文件内容不可信）
func JPEGOrientation(b []byte) int {
	if len(b) < 4 || b[0] != 0xFF || b[1] != 0xD8 {
		return 1
	}
	for i := 2; i+4 <= len(b); {
		if b[i] != 0xFF {
			return 1
		}
		marker := b[i+1]
		if marker == 0xD8 || marker == 0x01 || (marker >= 0xD0 && marker <= 0xD7) {
			i += 2 // 没有长度字段的标记
			continue
		}
		if marker == 0xDA || marker == 0xD9 {
			return 1 // 到了图像数据或文件结尾
		}
		n := int(binary.BigEndian.Uint16(b[i+2:]))
		if n < 2 || i+2+n > len(b) {
			return 1
		}
		seg := b[i+4 : i+2+n]
		if marker == 0xE1 && len(seg) > 6 && string(seg[:6]) == "Exif\x00\x00" {
			return exifOrientation(seg[6:])
		}
		i += 2 + n
	}
	return 1
}

// exifOrientation 在 TIFF 结构的第一个 IFD 里找方向标签（0x0112）
func exifOrientation(t []byte) int {
	if len(t) < 8 {
		return 1
	}
	var bo binary.ByteOrder
	switch string(t[:2]) {
	case "II":
		bo = binary.LittleEndian
	case "MM":
		bo = binary.BigEndian
	default:
		return 1
	}
	off := int(bo.Uint32(t[4:]))
	if off < 8 || off+2 > len(t) {
		return 1
	}
	count := int(bo.Uint16(t[off:]))
	for k := range count {
		e := off + 2 + k*12
		if e+12 > len(t) {
			return 1
		}
		// 方向是 SHORT 类型（3），数量 1，值在条目的值字段前两个字节
		if bo.Uint16(t[e:]) == 0x0112 && bo.Uint16(t[e+2:]) == 3 {
			if v := int(bo.Uint16(t[e+8:])); v >= 1 && v <= 8 {
				return v
			}
			return 1
		}
	}
	return 1
}

// Orient 按 EXIF 方向（1–8）把图片转正：翻转或旋转后，像素顺序就是显示时的样子。
func Orient(src *image.RGBA, o int) *image.RGBA {
	if o < 2 || o > 8 {
		return src
	}
	sw, sh := src.Bounds().Dx(), src.Bounds().Dy()
	dw, dh := sw, sh
	if o >= 5 {
		dw, dh = sh, sw
	}
	dst := image.NewRGBA(image.Rect(0, 0, dw, dh))
	for y := range dh {
		for x := range dw {
			var sx, sy int
			switch o {
			case 2: // 水平翻转
				sx, sy = sw-1-x, y
			case 3: // 旋转 180°
				sx, sy = sw-1-x, sh-1-y
			case 4: // 垂直翻转
				sx, sy = x, sh-1-y
			case 5: // 沿主对角线翻转
				sx, sy = y, x
			case 6: // 顺时针旋转 90°
				sx, sy = y, sh-1-x
			case 7: // 沿副对角线翻转
				sx, sy = sw-1-y, sh-1-x
			case 8: // 逆时针旋转 90°
				sx, sy = sw-1-y, x
			}
			copy(dst.Pix[y*dst.Stride+x*4:y*dst.Stride+x*4+4], src.Pix[sy*src.Stride+sx*4:])
		}
	}
	return dst
}
