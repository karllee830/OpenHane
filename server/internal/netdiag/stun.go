// Package netdiag 负责公网地址的确定和连通性自检。
package netdiag

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"time"

	"github.com/pion/stun/v3"
)

// ProbePublicIP 并行向所有 STUN 服务器查询本机的公网 IPv4，返回多数服务器一致的结果。
// 只有一台服务器响应时直接采用它的结果。
func ProbePublicIP(ctx context.Context, servers []string, timeout time.Duration) (netip.Addr, error) {
	if len(servers) == 0 {
		return netip.Addr{}, errors.New("no STUN servers configured")
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	type result struct {
		addr netip.Addr
		err  error
	}
	ch := make(chan result, len(servers))
	for _, s := range servers {
		go func() {
			a, err := stunQuery(ctx, s)
			ch <- result{a, err}
		}()
	}
	votes := map[netip.Addr]int{}
	var errs []error
	for range servers {
		r := <-ch
		if r.err != nil {
			errs = append(errs, r.err)
			continue
		}
		votes[r.addr]++
		// 已有两台一致即可提前返回
		if votes[r.addr] >= 2 {
			return r.addr, nil
		}
	}
	var best netip.Addr
	for a, n := range votes {
		if !best.IsValid() || n > votes[best] {
			best = a
		}
	}
	if best.IsValid() {
		return best, nil
	}
	return netip.Addr{}, fmt.Errorf("all STUN servers failed: %w", errors.Join(errs...))
}

func stunQuery(ctx context.Context, server string) (netip.Addr, error) {
	var d net.Dialer
	conn, err := d.DialContext(ctx, "udp4", server)
	if err != nil {
		return netip.Addr{}, fmt.Errorf("%s: %w", server, err)
	}
	defer conn.Close()
	if dl, ok := ctx.Deadline(); ok {
		conn.SetDeadline(dl)
	}
	msg := stun.MustBuild(stun.TransactionID, stun.BindingRequest)
	buf := make([]byte, 1500)
	// UDP 可能丢包：每 500 ms 重发一次，直到超时
	for {
		if _, err := conn.Write(msg.Raw); err != nil {
			return netip.Addr{}, fmt.Errorf("%s: %w", server, err)
		}
		conn.SetReadDeadline(time.Now().Add(500 * time.Millisecond))
		n, err := conn.Read(buf)
		if err != nil {
			var ne net.Error
			if errors.As(err, &ne) && ne.Timeout() && ctx.Err() == nil {
				continue
			}
			return netip.Addr{}, fmt.Errorf("%s: %w", server, err)
		}
		res := &stun.Message{Raw: append([]byte(nil), buf[:n]...)}
		if err := res.Decode(); err != nil || res.TransactionID != msg.TransactionID {
			continue
		}
		var xor stun.XORMappedAddress
		if err := xor.GetFrom(res); err != nil {
			return netip.Addr{}, fmt.Errorf("%s: %w", server, err)
		}
		a, ok := netip.AddrFromSlice(xor.IP)
		if !ok {
			return netip.Addr{}, fmt.Errorf("%s: bad address", server)
		}
		return a.Unmap(), nil
	}
}

// ResolveHost 把 HANE_PUBLIC_HOST（IP 或域名）解析成 IP，优先 IPv4。
func ResolveHost(ctx context.Context, host string) (netip.Addr, error) {
	if a, err := netip.ParseAddr(host); err == nil {
		return a.Unmap(), nil
	}
	addrs, err := net.DefaultResolver.LookupNetIP(ctx, "ip", host)
	if err != nil {
		return netip.Addr{}, err
	}
	for _, a := range addrs {
		if a.Unmap().Is4() {
			return a.Unmap(), nil
		}
	}
	if len(addrs) > 0 {
		return addrs[0], nil
	}
	return netip.Addr{}, fmt.Errorf("%s has no address", host)
}

// IsLocalAddr 判断地址是否属于本机网卡（服务器直接拥有公网 IP 时为 true）。
func IsLocalAddr(a netip.Addr) bool {
	addrs, _ := net.InterfaceAddrs()
	for _, x := range addrs {
		if n, ok := x.(*net.IPNet); ok {
			if b, ok := netip.AddrFromSlice(n.IP); ok && b.Unmap() == a {
				return true
			}
		}
	}
	return false
}
