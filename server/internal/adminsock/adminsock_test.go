package adminsock

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLongDataDirUsesShortPath(t *testing.T) {
	long := filepath.Join(os.TempDir(), strings.Repeat("x", 120))
	if p := Path(long); len(p) >= 100 || !strings.HasSuffix(p, ".sock") || Path(long) != p {
		t.Fatal(p)
	}
	if Path("/data") != "/data/run/admin.sock" {
		t.Fatal(Path("/data"))
	}
}

func TestRoundTrip(t *testing.T) {
	// unix 套接字路径长度有限（macOS 104 字节），不用 t.TempDir() 的长路径
	dir, err := os.MkdirTemp("", "hanesock")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)
	path := filepath.Join(dir, "run", "admin.sock")
	s, err := Listen(path, func(_ context.Context, cmd string, args []string) (any, error) {
		switch cmd {
		case "echo":
			return args, nil
		}
		return nil, ErrUnknownCommand
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	if st, _ := os.Stat(path); st.Mode().Perm() != 0o600 {
		t.Fatalf("perm %v", st.Mode().Perm())
	}
	res, err := Call(path, "echo", "a", "b")
	var got []string
	if err != nil || json.Unmarshal(res, &got) != nil || len(got) != 2 {
		t.Fatal(string(res), err)
	}
	if _, err := Call(path, "nope"); err == nil || err.Error() != ErrUnknownCommand.Error() {
		t.Fatal(err)
	}
	// 同一路径不能启动第二个服务
	if _, err := Listen(path, nil, slog.New(slog.NewTextHandler(io.Discard, nil))); err == nil {
		t.Fatal("second listener should fail")
	}
	s.Close()
	if _, err := Call(path, "echo"); !errors.Is(err, ErrNotRunning) {
		t.Fatal(err)
	}
}
