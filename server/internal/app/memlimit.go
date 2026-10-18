package app

import (
	"log/slog"
	"os"
	"runtime/debug"
	"strconv"
	"strings"
)

// applyMemoryLimit 读取容器的 cgroup 内存上限，把 Go 的软内存上限设为其 80%，避免小内存 VPS 上 OOM。
// 已设置 GOMEMLIMIT 环境变量时尊重用户的设置。（GOMAXPROCS 从 Go 1.25 起自动遵守 CPU 限额。）
func applyMemoryLimit(log *slog.Logger) {
	if os.Getenv("GOMEMLIMIT") != "" {
		return
	}
	limit := cgroupMemoryLimit()
	if limit <= 0 {
		return
	}
	soft := limit / 10 * 8
	debug.SetMemoryLimit(soft)
	log.Info("memory limit from cgroup", "limit_mb", limit>>20, "gomemlimit_mb", soft>>20)
}

func cgroupMemoryLimit() int64 {
	for _, p := range []string{
		"/sys/fs/cgroup/memory.max",                   // cgroup v2
		"/sys/fs/cgroup/memory/memory.limit_in_bytes", // cgroup v1
	} {
		b, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		s := strings.TrimSpace(string(b))
		if s == "max" {
			return 0
		}
		v, err := strconv.ParseInt(s, 10, 64)
		if err != nil || v <= 0 || v >= 1<<60 { // v1 无限制时是一个接近 2^63 的值
			return 0
		}
		return v
	}
	return 0
}
