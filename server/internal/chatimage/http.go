package chatimage

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"
)

// uploadTimeout 是读完一次上传的时限（10 MB 在 1 Mbps 的上行下约 80 秒）
const uploadTimeout = 3 * time.Minute

// 上传、读取被拒绝的原因（由 Access 返回，对应不同的 HTTP 状态码）。
var (
	ErrUnauthorized = errors.New("unauthorized")
	ErrForbidden    = errors.New("forbidden")
	ErrDisabled     = errors.New("disabled")
	ErrRateLimited  = errors.New("rate_limited")
)

// Access 是会话和房间的权限检查（由 hub 实现）。token 是 Welcome 里下发的会话凭据。
type Access interface {
	// BeginUpload 检查能否向 room 上传图片，返回会话 ID、单张图片的大小上限和总存储上限（字节）
	BeginUpload(ctx context.Context, token, room string) (session string, maxBytes, quota int64, err error)
	// FinishUpload 登记上传好的图片，等它随聊天消息发出；会话已经离开或不在这个房间时返回 false
	FinishUpload(ctx context.Context, session, room string, img Info) bool
	// CanRead 返回凭据对应的会话能否查看 room 里的图片
	CanRead(ctx context.Context, token, room string) bool
}

// Handler 处理 /api/v1/chat/images 下的请求：
//
//	POST /api/v1/chat/images?room=<房间 ID>     请求体是图片本身，返回 Info（JSON）
//	GET  /api/v1/chat/images/<房间 ID>/<图片 ID>
//
// 都要带 Authorization: Bearer <会话凭据>。允许跨域（凭据在请求头里，不用 Cookie），桌面版和其他服务器的网页版也能用。
func Handler(store *Store, access Access, log *slog.Logger) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("OPTIONS /api/v1/chat/images", preflight)
	mux.HandleFunc("OPTIONS /api/v1/chat/images/{room}/{id}", preflight)
	mux.HandleFunc("POST /api/v1/chat/images", func(w http.ResponseWriter, r *http.Request) {
		cors(w)
		room := r.URL.Query().Get("room")
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		session, maxBytes, quota, err := access.BeginUpload(ctx, bearer(r), room)
		cancel()
		if err != nil {
			fail(w, err)
			return
		}
		// 慢速上传不能一直占着连接
		_ = http.NewResponseController(w).SetReadDeadline(time.Now().Add(uploadTimeout))
		raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBytes))
		if err != nil {
			var tooBig *http.MaxBytesError
			if errors.As(err, &tooBig) {
				writeError(w, http.StatusRequestEntityTooLarge, "too_large")
				return
			}
			writeError(w, http.StatusBadRequest, "invalid")
			return
		}
		// 解码占用内存多，同时最多处理两张，其余的排队（客户端断开就放弃）
		select {
		case store.sem <- struct{}{}:
		case <-r.Context().Done():
			return
		}
		data, width, height, err := Process(raw)
		<-store.sem
		raw = nil
		switch {
		case errors.Is(err, ErrFormat):
			writeError(w, http.StatusUnsupportedMediaType, "unsupported")
			return
		case errors.Is(err, ErrSize):
			writeError(w, http.StatusRequestEntityTooLarge, "too_large")
			return
		case err != nil:
			writeError(w, http.StatusBadRequest, "invalid")
			return
		}
		if quota > 0 && store.Used()+int64(len(data)) > quota {
			log.Warn("chat image storage is full", "used_mb", store.Used()>>20, "quota_mb", quota>>20)
			writeError(w, http.StatusInsufficientStorage, "storage_full")
			return
		}
		img := Info{ID: NewID(), Width: width, Height: height, Size: int64(len(data))}
		if err := store.Save(room, img.ID, data); err != nil {
			log.Error("saving chat image failed", "err", err)
			writeError(w, http.StatusInternalServerError, "internal")
			return
		}
		ctx, cancel = context.WithTimeout(context.Background(), 5*time.Second)
		ok := access.FinishUpload(ctx, session, room, img)
		cancel()
		if !ok {
			store.Delete(room, img.ID)
			writeError(w, http.StatusForbidden, "forbidden")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(img)
	})
	mux.HandleFunc("GET /api/v1/chat/images/{room}/{id}", func(w http.ResponseWriter, r *http.Request) {
		cors(w)
		room, id := r.PathValue("room"), r.PathValue("id")
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		ok := access.CanRead(ctx, bearer(r), room)
		cancel()
		if !ok {
			writeError(w, http.StatusForbidden, "forbidden")
			return
		}
		f, info, err := store.Open(room, id)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		defer f.Close()
		head := make([]byte, 512)
		n, _ := io.ReadFull(f, head)
		ct := http.DetectContentType(head[:n])
		if ct != "image/png" && ct != "image/jpeg" {
			http.NotFound(w, r)
			return
		}
		if _, err := f.Seek(0, io.SeekStart); err != nil {
			http.NotFound(w, r)
			return
		}
		h := w.Header()
		h.Set("Content-Type", ct)
		// 图片 ID 不会复用，内容不会变
		h.Set("Cache-Control", "private, max-age=604800, immutable")
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Content-Security-Policy", "default-src 'none'; sandbox")
		http.ServeContent(w, r, "", info.ModTime(), f)
	})
	return mux
}

func bearer(r *http.Request) string {
	v := r.Header.Get("Authorization")
	if len(v) > 7 && strings.EqualFold(v[:7], "bearer ") {
		return strings.TrimSpace(v[7:])
	}
	return ""
}

func cors(w http.ResponseWriter) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
}

func preflight(w http.ResponseWriter, _ *http.Request) {
	h := w.Header()
	cors(w)
	h.Set("Access-Control-Allow-Methods", "GET, POST")
	h.Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
	h.Set("Access-Control-Max-Age", "600")
	w.WriteHeader(http.StatusNoContent)
}

func fail(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrUnauthorized):
		writeError(w, http.StatusUnauthorized, "unauthorized")
	case errors.Is(err, ErrDisabled):
		writeError(w, http.StatusForbidden, "disabled")
	case errors.Is(err, ErrRateLimited):
		w.Header().Set("Retry-After", "2")
		writeError(w, http.StatusTooManyRequests, "rate_limited")
	case errors.Is(err, ErrForbidden):
		writeError(w, http.StatusForbidden, "forbidden")
	default:
		writeError(w, http.StatusServiceUnavailable, "unavailable")
	}
}

// writeError 返回 {"error": "<原因>"}，客户端据此显示提示
func writeError(w http.ResponseWriter, status int, code string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": code})
}
