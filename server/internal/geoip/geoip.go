// Package geoip 用 ip2region 离线库查询 IP 归属地（国家、省份、城市、运营商，名称是中文）。
//
// IPv4 库在构建时嵌入（scripts/fetch-geoip.sh）；IPv6 库较大，不嵌入，由管理员在需要时下载到数据目录，之后启动时直接加载。
package geoip

import (
	"context"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/lionsoul2014/ip2region/binding/golang/xdb"
)

//go:embed all:data
var embedded embed.FS

const (
	// V6File 是 IPv6 库在数据目录里的文件名
	V6File   = "ip2region_v6.xdb"
	v6URL    = "https://github.com/lionsoul2014/ip2region/raw/f8b0792b0cd729f5b2593f690aeed225e49c1967/data/ip2region_v6.xdb"
	v6SHA256 = "939f6b46bd2b8bec3cf7c5ceb8ba782266ae9b1f35b5ba7916700dec0b7506ed"
	v6Size   = 37277813
)

// ErrNoDB 表示没有这个协议版本的库
var ErrNoDB = errors.New("geoip: database not loaded")

type Location struct {
	Country, Province, City, ISP string
	CountryCode                  string // ISO 3166-1 两位代码（大写），没有时为空
}

type DB struct {
	dir string
	log *slog.Logger

	mu     sync.Mutex // Searcher 查询时会改内部计数，不能并发使用
	v4, v6 *xdb.Searcher

	download sync.Mutex // 同一时间只下载一次
}

// Open 加载嵌入的 IPv4 库和数据目录里的 IPv6 库（有的话）。缺少或损坏的库只记录日志。
func Open(dataDir string, log *slog.Logger) *DB {
	d := &DB{dir: dataDir, log: log}
	if buf, err := embedded.ReadFile("data/ip2region_v4.xdb"); err == nil {
		d.v4, err = xdb.NewWithBuffer(xdb.IPv4, buf)
		if err != nil {
			log.Warn("geoip: embedded IPv4 database invalid", "err", err)
		}
	} else {
		log.Info("geoip: built without IPv4 database")
	}
	if dataDir != "" {
		if err := d.loadV6(filepath.Join(dataDir, V6File)); err != nil && !errors.Is(err, os.ErrNotExist) {
			log.Warn("geoip: IPv6 database invalid", "err", err)
		}
	}
	return d
}

func (d *DB) loadV6(path string) error {
	buf, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	// NewWithBuffer 不检查内容：先确认文件头是 IPv6 库
	h, err := xdb.LoadHeaderFromBuff(buf)
	if err != nil {
		return err
	}
	if v, err := xdb.VersionFromHeader(h); err != nil || v.Id != xdb.IPv6VersionNo {
		return errors.New("geoip: not an IPv6 ip2region database")
	}
	s, err := xdb.NewWithBuffer(xdb.IPv6, buf)
	if err != nil {
		return err
	}
	d.mu.Lock()
	d.v6 = s
	d.mu.Unlock()
	return nil
}

// HasV6 报告 IPv6 库是否已加载
func (d *DB) HasV6() bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.v6 != nil
}

// Lookup 查询 ip 的归属地。没有对应版本的库时返回 ErrNoDB。
func (d *DB) Lookup(ip netip.Addr) (Location, error) {
	ip = ip.Unmap()
	d.mu.Lock()
	s := d.v4
	if ip.Is6() {
		s = d.v6
	}
	if s == nil {
		d.mu.Unlock()
		return Location{}, ErrNoDB
	}
	region, err := s.Search(ip.AsSlice())
	d.mu.Unlock()
	if err != nil {
		return Location{}, err
	}
	return parse(region), nil
}

// parse 解析「国家|省份|城市|运营商|国家代码」，ip2region 用 0 表示未知
func parse(region string) Location {
	f := strings.Split(region, "|")
	for len(f) < 5 {
		f = append(f, "")
	}
	clean := func(s string) string {
		if s = strings.TrimSpace(s); s == "0" {
			return ""
		}
		return s
	}
	l := Location{Country: clean(f[0]), Province: clean(f[1]), City: clean(f[2]), ISP: clean(f[3])}
	if c := strings.TrimSpace(f[4]); len(c) == 2 && c[0] >= 'A' && c[0] <= 'Z' && c[1] >= 'A' && c[1] <= 'Z' {
		l.CountryCode = c
	}
	if l.City == l.Province {
		l.City = ""
	}
	return l
}

// DownloadV6 下载 IPv6 库到数据目录并加载。已加载时直接返回。
func (d *DB) DownloadV6(ctx context.Context) error {
	d.download.Lock()
	defer d.download.Unlock()
	if d.HasV6() {
		return nil
	}
	if d.dir == "" {
		return errors.New("geoip: no data directory")
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, v6URL, nil)
	if err != nil {
		return err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("geoip: download: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("geoip: download: HTTP %d", resp.StatusCode)
	}
	path := filepath.Join(d.dir, V6File)
	tmp, err := os.CreateTemp(d.dir, V6File+".*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(tmp, h), io.LimitReader(resp.Body, v6Size+1))
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return fmt.Errorf("geoip: download: %w", err)
	}
	if n != v6Size || hex.EncodeToString(h.Sum(nil)) != v6SHA256 {
		return errors.New("geoip: downloaded IPv6 database failed checksum")
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		return err
	}
	if err := d.loadV6(path); err != nil {
		return err
	}
	d.log.Info("geoip: IPv6 database downloaded", "path", path)
	return nil
}
