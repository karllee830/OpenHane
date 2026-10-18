// Package adminsock 是本地管理套接字：管理 CLI 通过它操作运行中的服务，修改立即生效。
//
// 协议：每个连接发送一行 JSON 请求，收到一行 JSON 响应后关闭。套接字文件权限 0600，只有同一用户可以连接
// （容器中即 docker exec 进入的同一用户）。
package adminsock

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"time"
)

type Request struct {
	Cmd  string   `json:"cmd"`
	Args []string `json:"args,omitempty"`
}

type Response struct {
	OK     bool            `json:"ok"`
	Error  string          `json:"error,omitempty"`
	Result json.RawMessage `json:"result,omitempty"`
}

// Handler 处理一个命令，返回可序列化为 JSON 的结果。
type Handler func(ctx context.Context, cmd string, args []string) (any, error)

// ErrUnknownCommand 由 Handler 返回，表示不支持该命令。
var ErrUnknownCommand = errors.New("unknown command")

// Path 返回数据目录下的套接字路径。unix 套接字路径有长度上限（macOS 约 104 字节），
// 数据目录很长时改用临时目录下按数据目录哈希命名的路径（CLI 用同样的规则找到它）。
func Path(dataDir string) string {
	p := filepath.Join(dataDir, "run", "admin.sock")
	if len(p) < 100 {
		return p
	}
	abs, err := filepath.Abs(dataDir)
	if err != nil {
		abs = dataDir
	}
	sum := sha256.Sum256([]byte(abs))
	return filepath.Join(os.TempDir(), "openhane-"+hex.EncodeToString(sum[:6])+".sock")
}

type Server struct {
	ln  net.Listener
	log *slog.Logger
}

// Listen 在 path 上创建套接字（清理上次异常退出留下的文件）并开始服务。
func Listen(path string, h Handler, log *slog.Logger) (*Server, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	if c, err := net.DialTimeout("unix", path, 200*time.Millisecond); err == nil {
		c.Close()
		return nil, fmt.Errorf("another server is already using %s", path)
	}
	_ = os.Remove(path)
	ln, err := net.Listen("unix", path)
	if err != nil {
		return nil, err
	}
	if err := os.Chmod(path, 0o600); err != nil {
		ln.Close()
		return nil, err
	}
	s := &Server{ln: ln, log: log}
	go s.serve(h)
	return s, nil
}

func (s *Server) serve(h Handler) {
	for {
		c, err := s.ln.Accept()
		if err != nil {
			return
		}
		go func() {
			defer c.Close()
			c.SetDeadline(time.Now().Add(30 * time.Second))
			var req Request
			if err := json.NewDecoder(bufio.NewReader(c)).Decode(&req); err != nil {
				json.NewEncoder(c).Encode(Response{Error: "bad request"})
				return
			}
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			res, err := h(ctx, req.Cmd, req.Args)
			resp := Response{OK: err == nil}
			if err != nil {
				resp.Error = err.Error()
			} else if res != nil {
				resp.Result, _ = json.Marshal(res)
			}
			json.NewEncoder(c).Encode(resp)
			s.log.Info("admin command", "cmd", req.Cmd, "ok", resp.OK)
		}()
	}
}

func (s *Server) Close() error {
	path := s.ln.Addr().String()
	err := s.ln.Close()
	_ = os.Remove(path)
	return err
}

// ErrNotRunning 表示没有运行中的服务（套接字不存在或连不上）。
var ErrNotRunning = errors.New("server is not running")

// Call 向运行中的服务发送命令。
func Call(path, cmd string, args ...string) (json.RawMessage, error) {
	c, err := net.DialTimeout("unix", path, time.Second)
	if err != nil {
		return nil, ErrNotRunning
	}
	defer c.Close()
	c.SetDeadline(time.Now().Add(30 * time.Second))
	if err := json.NewEncoder(c).Encode(Request{Cmd: cmd, Args: args}); err != nil {
		return nil, err
	}
	var resp Response
	if err := json.NewDecoder(c).Decode(&resp); err != nil {
		return nil, err
	}
	if !resp.OK {
		return nil, errors.New(resp.Error)
	}
	return resp.Result, nil
}
