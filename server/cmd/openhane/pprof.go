package main

import (
	"net"
	"net/http"
	_ "net/http/pprof" // 注册 /debug/pprof/*（只在 HANE_DEBUG_PPROF 指定的本机地址上提供）
	"os"
)

// startPprof：HANE_DEBUG_PPROF=127.0.0.1:6060 时提供 Go 性能剖析接口（排查性能问题用，默认关闭）。
// 只允许回环地址，避免误把剖析接口暴露到公网。
func startPprof() {
	addr := os.Getenv("HANE_DEBUG_PPROF")
	if addr == "" {
		return
	}
	host, _, err := net.SplitHostPort(addr)
	if ip := net.ParseIP(host); err != nil || ip == nil || !ip.IsLoopback() {
		os.Stderr.WriteString("HANE_DEBUG_PPROF 只能监听回环地址（例如 127.0.0.1:6060），已忽略\n")
		return
	}
	go func() { _ = http.ListenAndServe(addr, nil) }()
}
