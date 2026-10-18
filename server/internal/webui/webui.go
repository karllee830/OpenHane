// Package webui 提供嵌入二进制的 Web 客户端（clients/web/apps/web 的构建产物）。
//
// 构建镜像时把产物复制到 dist/；本地没有构建前端时 dist 只有占位文件，Available 返回 false。
package webui

import (
	"bytes"
	"compress/gzip"
	"embed"
	"io/fs"
	"mime"
	"net/http"
	"path"
	"strings"
	"sync"
	"time"
)

//go:embed all:dist
var embedded embed.FS

// csp 限制页面只能加载自身的资源。wasm-unsafe-eval：RNNoise 降噪需要编译 WebAssembly；
// style-src 'unsafe-inline'：React 的 style 属性（头像颜色等）。
const csp = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; " +
	"img-src 'self' data: blob:; media-src 'self' blob: mediastream:; connect-src 'self'; worker-src 'self' blob:; " +
	"frame-ancestors 'none'; base-uri 'none'; form-action 'none'"

type Handler struct {
	files fs.FS
	index []byte
	gz    sync.Map // 路径 → 压缩后的内容
	start time.Time
}

func dist() fs.FS {
	sub, _ := fs.Sub(embedded, "dist")
	return sub
}

// Available 表示二进制中是否带有 Web 客户端。
func Available() bool {
	_, err := fs.Stat(dist(), "index.html")
	return err == nil
}

// New 返回 Web 客户端的处理器；没有嵌入 Web 客户端时返回 nil。
func New() *Handler {
	files := dist()
	index, err := fs.ReadFile(files, "index.html")
	if err != nil {
		return nil
	}
	return &Handler{files: files, index: index, start: time.Now()}
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	p := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
	// 页面用相对路径引用资源（便于部署在反向代理的子路径下）：在 /j/<邀请码> 这类深一层的路径下，
	// 浏览器会请求 /j/assets/…，这里统一映射到真正的资源
	if i := strings.Index(p, "/assets/"); i >= 0 {
		p = p[i+1:]
	}
	if strings.HasPrefix(p, "assets/") {
		data, err := fs.ReadFile(h.files, p)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		// 文件名带内容哈希，可以长期缓存
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		h.serve(w, r, p, data)
		return
	}
	// 其余路径（/、/j/<邀请码> 等）都返回单页应用入口
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Content-Security-Policy", csp)
	h.serve(w, r, "index.html", h.index)
}

func (h *Handler) serve(w http.ResponseWriter, r *http.Request, name string, data []byte) {
	ctype := mime.TypeByExtension(path.Ext(name))
	if ctype == "" {
		ctype = http.DetectContentType(data)
	}
	w.Header().Set("Content-Type", ctype)
	w.Header().Add("Vary", "Accept-Encoding")
	// wasm：AI 降噪的 WASM 约 13 MB，gzip 后约 3 MB（模型本身已经是 tar.gz，不再压缩）
	compressible := strings.HasPrefix(ctype, "text/") || strings.Contains(ctype, "javascript") || strings.Contains(ctype, "json") ||
		strings.Contains(ctype, "svg") || ctype == "application/wasm"
	if compressible && len(data) > 1024 && strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
		w.Header().Set("Content-Encoding", "gzip")
		data = h.gzipped(name, data)
	}
	http.ServeContent(w, r, "", h.start, bytes.NewReader(data))
}

// gzipped 压缩一次后缓存在内存中（资源是只读的嵌入文件）。
func (h *Handler) gzipped(name string, data []byte) []byte {
	if v, ok := h.gz.Load(name); ok {
		return v.([]byte)
	}
	var buf bytes.Buffer
	// 大文件（AI 降噪的 WASM）用默认级别：最高级别压 13 MB 要好几秒，第一个下载的人要一直等着，体积只差约 3%
	level := gzip.BestCompression
	if len(data) > 1<<20 {
		level = gzip.DefaultCompression
	}
	zw, _ := gzip.NewWriterLevel(&buf, level)
	zw.Write(data)
	zw.Close()
	out := buf.Bytes()
	h.gz.Store(name, out)
	return out
}
