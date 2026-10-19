// Package chatimage 处理聊天里的图片：检查、重新编码、存放在数据目录，按会话凭据上传和读取。
//
// 客户端先把图片上传到 POST /api/v1/chat/images（拿到图片 ID），再发一条带这个 ID 的聊天消息。
// 上传的原图不保存：服务端解码后按 EXIF 方向转正、缩到 OutputSide 以内，重新编码成 PNG 或 JPEG，
// 原图里的元数据（拍摄位置等）、附加数据和畸形结构都不会留下来。
//
// 文件放在 <数据目录>/chat-images/<房间 ID>/<图片 ID>，随聊天记录一起清理。
package chatimage

import (
	"bytes"
	"errors"
	"fmt"
	"image"
	"image/draw"
	"image/jpeg"
	"image/png"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sync/atomic"

	"github.com/karllee830/OpenHane/server/internal/auth"
	"github.com/karllee830/OpenHane/server/internal/imaging"
)

const (
	// DirName 是数据目录里存放聊天图片的子目录。
	DirName = "chat-images"
	// MaxSide / MaxPixels 是上传的图片允许的最大边长和像素数（先只读文件头检查，防止解码超大图耗尽内存）。
	MaxSide   = 8192
	MaxPixels = 24_000_000
	// OutputSide 是保存的图片的最大边长：更大的缩到这么大。
	OutputSide = 4096
	// jpegQuality 是重新编码 JPEG 的质量。
	jpegQuality = 90
)

var (
	ErrFormat = errors.New("only PNG and JPEG images are supported")
	ErrSize   = fmt.Errorf("the image must be at most %d pixels on each side and %d megapixels in total", MaxSide, MaxPixels/1_000_000)
)

// Info 是一张保存好的图片。
type Info struct {
	ID     string `json:"id"`
	Width  int    `json:"width"`
	Height int    `json:"height"`
	Size   int64  `json:"size"`
}

// Process 检查并重新编码上传的图片，返回要保存的数据和尺寸。PNG 仍然输出 PNG（保留透明），JPEG 输出 JPEG。
func Process(raw []byte) (out []byte, w, h int, err error) {
	ct := http.DetectContentType(raw)
	if ct != "image/png" && ct != "image/jpeg" {
		return nil, 0, 0, ErrFormat
	}
	cfg, _, err := image.DecodeConfig(bytes.NewReader(raw))
	if err != nil {
		return nil, 0, 0, fmt.Errorf("unreadable image: %w", err)
	}
	if cfg.Width < 1 || cfg.Height < 1 || cfg.Width > MaxSide || cfg.Height > MaxSide || cfg.Width*cfg.Height > MaxPixels {
		return nil, 0, 0, ErrSize
	}
	src, _, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		return nil, 0, 0, fmt.Errorf("unreadable image: %w", err)
	}
	rgba := image.NewRGBA(image.Rect(0, 0, cfg.Width, cfg.Height))
	draw.Draw(rgba, rgba.Bounds(), src, src.Bounds().Min, draw.Src)
	src = nil
	if ct == "image/jpeg" {
		// 重新编码会去掉 EXIF，先按其中的方向把像素转正，否则手机拍的照片会横过来
		rgba = imaging.Orient(rgba, imaging.JPEGOrientation(raw))
	}
	w, h = rgba.Bounds().Dx(), rgba.Bounds().Dy()
	if fw, fh := imaging.FitWithin(w, h, OutputSide); fw != w || fh != h {
		rgba = imaging.Downscale(rgba, fw, fh)
		w, h = fw, fh
	}
	var buf bytes.Buffer
	if ct == "image/png" {
		err = png.Encode(&buf, rgba)
	} else {
		err = jpeg.Encode(&buf, rgba, &jpeg.Options{Quality: jpegQuality})
	}
	if err != nil {
		return nil, 0, 0, err
	}
	return buf.Bytes(), w, h, nil
}

var (
	idPattern   = regexp.MustCompile(`^[0-9a-z]{26}$`)
	roomPattern = regexp.MustCompile(`^[0-9a-z_]{1,32}$`)
)

// NewID 生成图片 ID（26 个字符，130 位随机数）。
func NewID() string { return auth.RandomID(26) }

// ValidID / ValidRoom 检查来自请求的 ID 能不能安全地用作文件名。
func ValidID(id string) bool     { return idPattern.MatchString(id) }
func ValidRoom(room string) bool { return roomPattern.MatchString(room) }

// Store 管理磁盘上的聊天图片，并记下占用的总空间（供存储上限检查）。
type Store struct {
	dir  string
	log  *slog.Logger
	used atomic.Int64
	// 同时解码的图片数：一张大图解码时要占用一两百 MB 内存
	sem chan struct{}
}

// Open 打开（必要时创建）图片目录，统计已占用的空间。
func Open(dataDir string, log *slog.Logger) (*Store, error) {
	s := &Store{dir: filepath.Join(dataDir, DirName), log: log, sem: make(chan struct{}, 2)}
	if err := os.MkdirAll(s.dir, 0o750); err != nil {
		return nil, err
	}
	var used int64
	_ = filepath.WalkDir(s.dir, func(_ string, d fs.DirEntry, err error) error {
		if err == nil && d.Type().IsRegular() {
			if info, err := d.Info(); err == nil {
				used += info.Size()
			}
		}
		return nil
	})
	s.used.Store(used)
	return s, nil
}

// Used 返回图片占用的总字节数。
func (s *Store) Used() int64 { return s.used.Load() }

func (s *Store) path(room, id string) (string, bool) {
	if !ValidRoom(room) || !ValidID(id) {
		return "", false
	}
	return filepath.Join(s.dir, room, id), true
}

// Save 写入一张图片（先写临时文件再改名，读的人不会看到写了一半的文件）。
func (s *Store) Save(room, id string, data []byte) error {
	p, ok := s.path(room, id)
	if !ok {
		return errors.New("invalid image path")
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o750); err != nil {
		return err
	}
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, data, 0o640); err != nil {
		return err
	}
	if err := os.Rename(tmp, p); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	s.used.Add(int64(len(data)))
	return nil
}

// Open 打开一张图片用于读取。
func (s *Store) Open(room, id string) (*os.File, fs.FileInfo, error) {
	p, ok := s.path(room, id)
	if !ok {
		return nil, nil, fs.ErrNotExist
	}
	f, err := os.Open(p)
	if err != nil {
		return nil, nil, err
	}
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		f.Close()
		return nil, nil, fs.ErrNotExist
	}
	return f, info, nil
}

// Delete 删除一张图片（不存在时忽略）。
func (s *Store) Delete(room, id string) {
	p, ok := s.path(room, id)
	if !ok {
		return
	}
	if info, err := os.Lstat(p); err == nil {
		if os.Remove(p) == nil {
			s.used.Add(-info.Size())
		}
	}
}

// DeleteRoom 删除一个房间的所有图片（临时房间关闭时）。
func (s *Store) DeleteRoom(room string) {
	if !ValidRoom(room) {
		return
	}
	s.removeDir(filepath.Join(s.dir, room))
}

func (s *Store) removeDir(dir string) {
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if info, err := e.Info(); err == nil && info.Mode().IsRegular() && os.Remove(filepath.Join(dir, e.Name())) == nil {
			s.used.Add(-info.Size())
		}
	}
	_ = os.Remove(dir)
}

// Sweep 删除 keep 之外的所有图片（启动时调用：只保留数据库里的聊天记录引用的图片）。keep 的键是「房间/图片 ID」
func (s *Store) Sweep(keep map[string]bool) {
	rooms, _ := os.ReadDir(s.dir)
	removed := 0
	for _, r := range rooms {
		dir := filepath.Join(s.dir, r.Name())
		if !r.IsDir() {
			_ = os.Remove(dir)
			continue
		}
		files, _ := os.ReadDir(dir)
		for _, f := range files {
			if keep[r.Name()+"/"+f.Name()] {
				continue
			}
			if info, err := f.Info(); err == nil && os.Remove(filepath.Join(dir, f.Name())) == nil {
				s.used.Add(-info.Size())
				removed++
			}
		}
		_ = os.Remove(dir) // 空目录才会删掉
	}
	if removed > 0 {
		s.log.Info("removed unreferenced chat images", "count", removed)
	}
}
