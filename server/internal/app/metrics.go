package app

import (
	"context"
	"fmt"
	"runtime"
	"strings"
	"time"
)

// metrics 以 Prometheus 文本格式输出运行指标（HANE_METRICS=true 时由 /metrics 提供）。
func (a *App) metrics(ctx context.Context) string {
	var b strings.Builder
	gauge := func(name, help string, v any, labels ...string) {
		fmt.Fprintf(&b, "# HELP %s %s\n# TYPE %s gauge\n", name, help, name)
		writeSample(&b, name, v, labels...)
	}
	counter := func(name, help string, v any) {
		fmt.Fprintf(&b, "# HELP %s %s\n# TYPE %s counter\n", name, help, name)
		writeSample(&b, name, v)
	}

	gauge("hane_build_info", "Server version.", 1, "version", a.Version)
	gauge("hane_uptime_seconds", "Seconds since the server started.", int64(time.Since(a.started).Seconds()))
	if a.hub != nil {
		st := a.hub.Stats(ctx)
		fmt.Fprintf(&b, "# HELP hane_sessions Control-plane sessions.\n# TYPE hane_sessions gauge\n")
		writeSample(&b, "hane_sessions", st.Sessions-st.Reconnecting, "state", "online")
		writeSample(&b, "hane_sessions", st.Reconnecting, "state", "reconnecting")
		gauge("hane_media_connected", "Sessions connected to the media server.", st.MediaOnline)
		gauge("hane_rooms", "Open rooms (main + temporary).", st.Rooms)
		gauge("hane_admins_online", "Administrators online.", st.Admins)
	}
	if a.ws != nil {
		counter("hane_handshakes_ok_total", "Successful client handshakes.", a.ws.HandshakesOK.Load())
		counter("hane_handshakes_rejected_total", "Rejected client handshakes (bad password, banned, server full, ...).", a.ws.HandshakesRejected.Load())
		counter("hane_connections_rate_limited_total", "Connections refused by the per-IP rate limit.", a.ws.RateLimited.Load())
	}
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	gauge("go_goroutines", "Number of goroutines.", runtime.NumGoroutine())
	gauge("go_memstats_heap_inuse_bytes", "Heap bytes in use.", ms.HeapInuse)
	gauge("go_memstats_sys_bytes", "Bytes obtained from the OS.", ms.Sys)
	return b.String()
}

func writeSample(b *strings.Builder, name string, v any, labels ...string) {
	b.WriteString(name)
	if len(labels) > 0 {
		b.WriteByte('{')
		for i := 0; i+1 < len(labels); i += 2 {
			if i > 0 {
				b.WriteByte(',')
			}
			fmt.Fprintf(b, "%s=%q", labels[i], labels[i+1])
		}
		b.WriteByte('}')
	}
	fmt.Fprintf(b, " %v\n", v)
}
