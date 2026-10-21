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
	// BeginUpload 检查能否向 room 上传图片，返回会话 ID、单张图片的大小上限、总存储上限（字节），
	// 以及房间是否端到端加密（是的话只接受加密的图片）
	BeginUpload(ctx context.Context, token, room string) (session string, maxBytes, quota int64, encrypted bool, err error)
	// FinishUpload 登记上传好的图片，等它随聊天消息发出；会话已经离开或不在这个房间时返回 false
	FinishUpload(ctx context.Context, session, room string, img Info) bool
	// CanRead 返回凭据对应的会话能否查看 room 里的图片
	CanRead(ctx context.Context, token, room string) bool
}

// Handler 处理 /api/v1/chat/images 下的请求：
//
//	POST /api/v1/chat/images?room=<房间 ID>                   请求体是图片本身，返回 Info（JSON）
//	POST /api/v1/chat/images/uploads?room=<房间 ID>&size=<字节数>  开始分块上传，返回 {"upload": <上传 ID>}
//	PUT  /api/v1/chat/images/uploads/<上传 ID>?offset=<偏移>     按顺序上传一块
//	POST /api/v1/chat/images/uploads/<上传 ID>/finish          传完后处理和保存，返回 Info（JSON）
//	GET  /api/v1/chat/images/<房间 ID>/<图片 ID>                 支持 Range（客户端按自己的节奏分段下载）
//
// 分块上传让客户端能控制上传的速度：会议中媒体拥堵时放慢、给语音和视频让路。
// 都要带 Authorization: Bearer <会话凭据>。允许跨域（凭据在请求头里，不用 Cookie），桌面版和其他服务器的网页版也能用。
func Handler(store *Store, access Access, log *slog.Logger) http.Handler {
	h := &handler{store: store, access: access, log: log, uploads: newUploads()}
	mux := http.NewServeMux()
	mux.HandleFunc("OPTIONS /api/v1/chat/images", preflight)
	mux.HandleFunc("OPTIONS /api/v1/chat/images/{room}/{id}", preflight)
	mux.HandleFunc("OPTIONS /api/v1/chat/images/uploads/{id}", preflight)
	mux.HandleFunc("OPTIONS /api/v1/chat/images/uploads/{id}/finish", preflight)
	mux.HandleFunc("POST /api/v1/chat/images", h.post)
	mux.HandleFunc("POST /api/v1/chat/images/uploads", h.beginChunked)
	mux.HandleFunc("PUT /api/v1/chat/images/uploads/{id}", h.putChunk)
	mux.HandleFunc("POST /api/v1/chat/images/uploads/{id}/finish", h.finishChunked)
	mux.HandleFunc("GET /api/v1/chat/images/{room}/{id}", h.get)
	return mux
}

type handler struct {
	store   *Store
	access  Access
	log     *slog.Logger
	uploads *uploads
}

// begin 检查能否上传，返回上传要用的参数（大小上限已经算上加密的额外字节）
func (h *handler) begin(w http.ResponseWriter, r *http.Request) (u *upload, ok bool) {
	room := r.URL.Query().Get("room")
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	session, maxBytes, quota, encrypted, err := h.access.BeginUpload(ctx, bearer(r), room)
	cancel()
	if err != nil {
		fail(w, err)
		return nil, false
	}
	if encrypted {
		maxBytes += int64(EncryptedOverhead)
	}
	return &upload{token: bearer(r), session: session, room: room, maxBytes: maxBytes, quota: quota, encrypted: encrypted}, true
}

func (h *handler) post(w http.ResponseWriter, r *http.Request) {
	cors(w)
	u, ok := h.begin(w, r)
	if !ok {
		return
	}
	// 慢速上传不能一直占着连接
	_ = http.NewResponseController(w).SetReadDeadline(time.Now().Add(uploadTimeout))
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, u.maxBytes))
	if err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			writeError(w, http.StatusRequestEntityTooLarge, "too_large")
			return
		}
		writeError(w, http.StatusBadRequest, "invalid")
		return
	}
	h.save(w, r, u, raw)
}

// save 检查（明文图片重新编码）、保存并登记上传好的图片，返回 Info
func (h *handler) save(w http.ResponseWriter, r *http.Request, u *upload, raw []byte) {
	var data []byte
	var width, height int
	var err error
	if u.encrypted {
		// 密文：服务端看不到内容，只检查格式（解密后的检查由接收方做）
		if !IsEncrypted(raw) {
			writeError(w, http.StatusUnsupportedMediaType, "unsupported")
			return
		}
		data = raw
	} else {
		// 解码占用内存多，同时最多处理两张，其余的排队（客户端断开就放弃）
		select {
		case h.store.sem <- struct{}{}:
		case <-r.Context().Done():
			return
		}
		data, width, height, err = Process(raw)
		<-h.store.sem
	}
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
	if u.quota > 0 && h.store.Used()+int64(len(data)) > u.quota {
		h.log.Warn("chat image storage is full", "used_mb", h.store.Used()>>20, "quota_mb", u.quota>>20)
		writeError(w, http.StatusInsufficientStorage, "storage_full")
		return
	}
	img := Info{ID: NewID(), Width: width, Height: height, Size: int64(len(data)), Encrypted: u.encrypted}
	if err := h.store.Save(u.room, img.ID, data); err != nil {
		h.log.Error("saving chat image failed", "err", err)
		writeError(w, http.StatusInternalServerError, "internal")
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	ok := h.access.FinishUpload(ctx, u.session, u.room, img)
	cancel()
	if !ok {
		h.store.Delete(u.room, img.ID)
		writeError(w, http.StatusForbidden, "forbidden")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(img)
}

func (h *handler) get(w http.ResponseWriter, r *http.Request) {
	cors(w)
	room, id := r.PathValue("room"), r.PathValue("id")
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	ok := h.access.CanRead(ctx, bearer(r), room)
	cancel()
	if !ok {
		writeError(w, http.StatusForbidden, "forbidden")
		return
	}
	f, info, err := h.store.Open(room, id)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	head := make([]byte, 512)
	n, _ := io.ReadFull(f, head)
	ct := http.DetectContentType(head[:n])
	if IsEncrypted(head[:n]) {
		ct = "application/octet-stream"
	} else if ct != "image/png" && ct != "image/jpeg" {
		http.NotFound(w, r)
		return
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		http.NotFound(w, r)
		return
	}
	hd := w.Header()
	hd.Set("Content-Type", ct)
	// 图片 ID 不会复用，内容不会变
	hd.Set("Cache-Control", "private, max-age=604800, immutable")
	hd.Set("X-Content-Type-Options", "nosniff")
	hd.Set("Content-Security-Policy", "default-src 'none'; sandbox")
	http.ServeContent(w, r, "", info.ModTime(), f)
}

func bearer(r *http.Request) string {
	v := r.Header.Get("Authorization")
	if len(v) > 7 && strings.EqualFold(v[:7], "bearer ") {
		return strings.TrimSpace(v[7:])
	}
	return ""
}

func cors(w http.ResponseWriter) {
	h := w.Header()
	h.Set("Access-Control-Allow-Origin", "*")
	// 分段下载时客户端要读 Content-Range 才知道总大小
	h.Set("Access-Control-Expose-Headers", "Content-Range")
}

func preflight(w http.ResponseWriter, _ *http.Request) {
	h := w.Header()
	cors(w)
	h.Set("Access-Control-Allow-Methods", "GET, POST, PUT")
	h.Set("Access-Control-Allow-Headers", "Authorization, Content-Type, Range")
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
