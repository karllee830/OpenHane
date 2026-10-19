// Package logo 处理数据目录里的服务器图标，供公开接口提供给客户端。
//
// 管理员放的原图（logo.png / logo.jpg / logo.jpeg）不动；服务端把它处理成数据目录里的隐藏文件 .logo
// （边长超过 Output 的缩到 Output，统一重新编码成带透明通道的 PNG），客户端拿到的只有这个文件。
// 重新编码后原图里的附加数据、元数据和畸形结构都不会发给客户端。
//
// 每次提供前用 stat 检查原图和 .logo 是否变过（是否同一个文件、大小、修改时间），不读内容；
// 变了（换图、删图，或 .logo 被改动）就重新处理。启动后第一次使用时总是重新生成一次。
package logo

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"image"
	"image/draw"
	_ "image/jpeg" // 解码 JPEG 原图
	"image/png"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Names 是按优先级查找的原图文件名。
var Names = []string{"logo.png", "logo.jpg", "logo.jpeg"}

const (
	// OutputName 是处理后的图标（数据目录里的隐藏文件，不带后缀）。
	OutputName = ".logo"
	// MaxBytes 是原图文件的大小上限。
	MaxBytes = 1 << 20
	// MinSide / MaxSide 是原图边长的范围（必须是正方形）。
	MinSide = 256
	MaxSide = 1024
	// Output 是处理后的最大边长：更大的原图缩到这么大，客户端在 3 倍屏上显示到 170 左右仍然清晰。
	Output = 512
)

// Image 是处理好、可以提供给客户端的图标。
type Image struct {
	// Path 是 .logo 的路径（PNG）
	Path    string
	ModTime time.Time
	// ETag 是内容的摘要，也作为 /api/v1/info 里的 logo 字段：客户端据此判断图标是否换过
	ETag string
}

type Store struct {
	dir string
	log *slog.Logger

	mu sync.Mutex
	// 上次处理时原图和 .logo 的文件信息：都没变就直接用 .logo
	src fs.FileInfo
	out fs.FileInfo
	img *Image
	// 上次因为原图不合格而警告过的文件（同一个文件只警告一次）
	warned fs.FileInfo
}

func New(dir string, log *slog.Logger) *Store {
	return &Store{dir: dir, log: log}
}

// Get 返回当前的图标；没有原图或原图不合格时返回 nil。
func (s *Store) Get() *Image {
	s.mu.Lock()
	defer s.mu.Unlock()
	srcPath, src := s.findSource()
	outPath := filepath.Join(s.dir, OutputName)
	out, _ := os.Stat(outPath)
	if src == nil {
		if out != nil {
			_ = os.Remove(outPath)
		}
		s.src, s.out, s.img = nil, nil, nil
		return nil
	}
	if s.img != nil && same(s.src, src) && same(s.out, out) {
		return s.img
	}
	if s.warned != nil && same(s.warned, src) {
		return nil // 同一个不合格的原图，不必每次重新解码
	}
	img, err := s.process(srcPath, src, outPath)
	if err != nil {
		s.warned = src
		s.log.Warn("server logo ignored", "file", srcPath, "err", err)
		_ = os.Remove(outPath)
		s.src, s.out, s.img = nil, nil, nil
		return nil
	}
	s.warned = nil
	return img
}

// same：同一个文件（设备号和 inode）、大小和修改时间都没变。换图时新文件即使大小和修改时间恰好相同，也能认出来
func same(a, b fs.FileInfo) bool {
	return a != nil && b != nil && os.SameFile(a, b) && a.Size() == b.Size() && a.ModTime().Equal(b.ModTime())
}

func (s *Store) findSource() (string, fs.FileInfo) {
	for _, name := range Names {
		path := filepath.Join(s.dir, name)
		if info, err := os.Stat(path); err == nil && info.Mode().IsRegular() {
			return path, info
		}
	}
	return "", nil
}

// process 检查并处理原图，写出 .logo，记下两边的文件信息
func (s *Store) process(srcPath string, src fs.FileInfo, outPath string) (*Image, error) {
	data, err := encode(srcPath, src)
	if err != nil {
		return nil, err
	}
	// 先写临时文件再改名：客户端不会读到写了一半的文件
	tmp := outPath + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return nil, err
	}
	if err := os.Rename(tmp, outPath); err != nil {
		_ = os.Remove(tmp)
		return nil, err
	}
	out, err := os.Stat(outPath)
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256(data)
	s.src, s.out = src, out
	s.img = &Image{Path: outPath, ModTime: out.ModTime(), ETag: hex.EncodeToString(sum[:8])}
	return s.img, nil
}

// encode 检查原图（格式、大小、尺寸），解码后缩到 Output 以内，重新编码成 PNG。
// 先只读文件头检查尺寸，不合格的不做完整解码（防止伪装成小文件的超大图耗尽内存）
func encode(path string, info fs.FileInfo) ([]byte, error) {
	if info.Size() > MaxBytes {
		return nil, fmt.Errorf("file is larger than %d KB", MaxBytes>>10)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	if ct := http.DetectContentType(raw); ct != "image/png" && ct != "image/jpeg" {
		return nil, errors.New("not a PNG or JPEG image")
	}
	cfg, _, err := image.DecodeConfig(bytes.NewReader(raw))
	if err != nil {
		return nil, fmt.Errorf("unreadable image: %w", err)
	}
	if cfg.Width != cfg.Height {
		return nil, fmt.Errorf("image is %d×%d, must be square", cfg.Width, cfg.Height)
	}
	if cfg.Width < MinSide || cfg.Width > MaxSide {
		return nil, fmt.Errorf("image is %d×%d, the side must be %d–%d pixels", cfg.Width, cfg.Height, MinSide, MaxSide)
	}
	src, _, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		return nil, fmt.Errorf("unreadable image: %w", err)
	}
	// 转成预乘透明度的 RGBA 再缩放：半透明边缘不会发黑，透明的地方仍然透明
	rgba := image.NewRGBA(image.Rect(0, 0, cfg.Width, cfg.Height))
	draw.Draw(rgba, rgba.Bounds(), src, src.Bounds().Min, draw.Src)
	if cfg.Width > Output {
		rgba = downscale(rgba, Output)
	}
	var buf bytes.Buffer
	if err := (&png.Encoder{CompressionLevel: png.BestCompression}).Encode(&buf, rgba); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// downscale 把正方形图片按面积平均缩到 size×size（只用于缩小）。先横向再纵向，各自按覆盖比例加权
func downscale(src *image.RGBA, size int) *image.RGBA {
	n := src.Bounds().Dx()
	taps := weights(n, size)
	// 横向：n 行 × size 列
	tmp := make([]float64, n*size*4)
	for y := range n {
		row := src.Pix[y*src.Stride:]
		for x, ts := range taps {
			var acc [4]float64
			for _, t := range ts {
				p := row[t.i*4:]
				for c := range 4 {
					acc[c] += float64(p[c]) * t.w
				}
			}
			copy(tmp[(y*size+x)*4:], acc[:])
		}
	}
	// 纵向：size 行 × size 列
	dst := image.NewRGBA(image.Rect(0, 0, size, size))
	for y, ts := range taps {
		for x := range size {
			var acc [4]float64
			for _, t := range ts {
				p := tmp[(t.i*size+x)*4:]
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
