package chatimage

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"sync"
	"time"
)

const (
	// chunkMaxBytes 是分块上传时一块的大小上限
	chunkMaxBytes = 1 << 20
	// uploadIdle 是分块上传两块之间最长的间隔：超时就丢弃（客户端放慢上传时一块之间最多隔几秒）
	uploadIdle = 2 * time.Minute
	// uploadsPerSession / uploadsMax 是每个会话、整个服务器同时进行的分块上传数
	uploadsPerSession = 2
	uploadsMax        = 64
)

// upload 是一次上传：开始时检查过的参数，分块上传时还有已经收到的数据
type upload struct {
	token     string // 会话凭据：后面的分块必须由同一个会话上传
	session   string
	room      string
	maxBytes  int64
	quota     int64
	encrypted bool

	size  int64 // 声明的总大小
	buf   []byte
	timer *time.Timer
}

type uploads struct {
	mu   sync.Mutex
	byID map[string]*upload
}

func newUploads() *uploads { return &uploads{byID: map[string]*upload{}} }

func (us *uploads) start(u *upload) (string, bool) {
	us.mu.Lock()
	defer us.mu.Unlock()
	n := 0
	for _, o := range us.byID {
		if o.session == u.session {
			n++
		}
	}
	if n >= uploadsPerSession || len(us.byID) >= uploadsMax {
		return "", false
	}
	id := NewID()
	us.byID[id] = u
	u.timer = time.AfterFunc(uploadIdle, func() { us.drop(id, u) })
	return id, true
}

// get 返回凭据对应的进行中的上传，并推迟它的超时
func (us *uploads) get(id, token string) *upload {
	us.mu.Lock()
	defer us.mu.Unlock()
	u := us.byID[id]
	if u == nil || subtle.ConstantTimeCompare([]byte(u.token), []byte(token)) != 1 {
		return nil
	}
	u.timer.Reset(uploadIdle)
	return u
}

func (us *uploads) drop(id string, u *upload) {
	us.mu.Lock()
	defer us.mu.Unlock()
	if us.byID[id] == u {
		u.timer.Stop()
		delete(us.byID, id)
	}
}

func (h *handler) beginChunked(w http.ResponseWriter, r *http.Request) {
	cors(w)
	size, err := strconv.ParseInt(r.URL.Query().Get("size"), 10, 64)
	if err != nil || size <= 0 {
		writeError(w, http.StatusBadRequest, "invalid")
		return
	}
	u, ok := h.begin(w, r)
	if !ok {
		return
	}
	if size > u.maxBytes {
		writeError(w, http.StatusRequestEntityTooLarge, "too_large")
		return
	}
	u.size = size
	id, ok := h.uploads.start(u)
	if !ok {
		w.Header().Set("Retry-After", "2")
		writeError(w, http.StatusTooManyRequests, "rate_limited")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"upload": id})
}

func (h *handler) putChunk(w http.ResponseWriter, r *http.Request) {
	cors(w)
	id := r.PathValue("id")
	u := h.uploads.get(id, bearer(r))
	if u == nil {
		writeError(w, http.StatusNotFound, "not_found")
		return
	}
	offset, err := strconv.ParseInt(r.URL.Query().Get("offset"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid")
		return
	}
	_ = http.NewResponseController(w).SetReadDeadline(time.Now().Add(uploadTimeout))
	chunk, err := io.ReadAll(http.MaxBytesReader(w, r.Body, chunkMaxBytes))
	if err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			writeError(w, http.StatusRequestEntityTooLarge, "too_large")
			return
		}
		writeError(w, http.StatusBadRequest, "invalid")
		return
	}
	h.uploads.mu.Lock()
	defer h.uploads.mu.Unlock()
	// 同一次上传的分块按顺序到达；重复发送的同一块（客户端重试）直接确认
	switch have := int64(len(u.buf)); {
	case offset+int64(len(chunk)) == have && offset < have:
		w.WriteHeader(http.StatusNoContent)
		return
	case offset != have:
		writeError(w, http.StatusConflict, "offset")
		return
	case have+int64(len(chunk)) > u.size:
		writeError(w, http.StatusRequestEntityTooLarge, "too_large")
		return
	}
	if u.buf == nil {
		u.buf = make([]byte, 0, u.size)
	}
	u.buf = append(u.buf, chunk...)
	w.WriteHeader(http.StatusNoContent)
}

func (h *handler) finishChunked(w http.ResponseWriter, r *http.Request) {
	cors(w)
	id := r.PathValue("id")
	u := h.uploads.get(id, bearer(r))
	if u == nil {
		writeError(w, http.StatusNotFound, "not_found")
		return
	}
	h.uploads.mu.Lock()
	complete := int64(len(u.buf)) == u.size
	h.uploads.mu.Unlock()
	if !complete {
		writeError(w, http.StatusBadRequest, "incomplete")
		return
	}
	h.uploads.drop(id, u)
	raw := u.buf
	u.buf = nil
	h.save(w, r, u, raw)
}
