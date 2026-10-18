// Package tlsmgr 管理服务端证书：自签名（默认）、文件证书（热加载）、关闭（由反向代理终止 TLS）。
// ACME 模式尚未实现。
//
// 指纹使用 SPKI 的 SHA-256（固定公钥而非证书）：续签证书时只要不换密钥，客户端 TOFU 记住的指纹就不变。
package tlsmgr

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/pem"
	"errors"
	"fmt"
	"log/slog"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/karllee830/OpenHane/server/internal/config"
)

type Manager struct {
	mode config.TLSMode
	log  *slog.Logger

	mu   sync.RWMutex
	cert *tls.Certificate
	spki [32]byte

	// file 模式
	certPath, keyPath string
	modTime           time.Time
}

// New 按配置准备证书。off 模式返回的 Manager 没有证书，TLSConfig 返回 nil。
func New(cfg *config.Config, log *slog.Logger) (*Manager, error) {
	m := &Manager{mode: cfg.TLSMode, log: log}
	switch cfg.TLSMode {
	case config.TLSOff:
		return m, nil
	case config.TLSSelfSigned:
		dir := filepath.Join(cfg.DataDir, "tls")
		m.certPath, m.keyPath = filepath.Join(dir, "server.crt"), filepath.Join(dir, "server.key")
		if _, err := os.Stat(m.certPath); errors.Is(err, os.ErrNotExist) {
			if err := generateSelfSigned(dir, m.certPath, m.keyPath, cfg.PublicHost); err != nil {
				return nil, fmt.Errorf("generate self-signed certificate: %w", err)
			}
			log.Info("generated self-signed certificate", "path", m.certPath)
		}
	case config.TLSFile:
		m.certPath, m.keyPath = cfg.TLSCert, cfg.TLSKey
	default:
		return nil, fmt.Errorf("TLS mode %q not supported yet", cfg.TLSMode)
	}
	if err := m.load(); err != nil {
		return nil, err
	}
	return m, nil
}

// Enabled 表示服务端自己终止 TLS。
func (m *Manager) Enabled() bool { return m.mode != config.TLSOff }

func (m *Manager) Mode() config.TLSMode { return m.mode }

// SPKI 返回当前证书公钥的 SHA-256；TLS 关闭时 ok 为 false。
func (m *Manager) SPKI() (sum [32]byte, ok bool) {
	if !m.Enabled() {
		return sum, false
	}
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.spki, true
}

// Fingerprint 返回展示用的指纹，格式 SHA256:<base64>。
func (m *Manager) Fingerprint() string {
	sum, ok := m.SPKI()
	if !ok {
		return ""
	}
	return FormatFingerprint(sum)
}

func FormatFingerprint(sum [32]byte) string {
	return "SHA256:" + base64.StdEncoding.EncodeToString(sum[:])
}

func (m *Manager) TLSConfig() *tls.Config {
	if !m.Enabled() {
		return nil
	}
	return &tls.Config{
		MinVersion: tls.VersionTLS12,
		NextProtos: []string{"http/1.1"}, // WebSocket 走 HTTP/1.1 升级
		GetCertificate: func(*tls.ClientHelloInfo) (*tls.Certificate, error) {
			m.mu.RLock()
			defer m.mu.RUnlock()
			return m.cert, nil
		},
	}
}

// Reload 重新读取证书文件（file 模式在文件变更或收到 SIGHUP 时调用）。文件没变化时不做任何事。
func (m *Manager) Reload() error {
	if m.mode != config.TLSFile {
		return nil
	}
	st, err := os.Stat(m.certPath)
	if err != nil {
		return err
	}
	m.mu.RLock()
	same := st.ModTime().Equal(m.modTime)
	m.mu.RUnlock()
	if same {
		return nil
	}
	old := m.Fingerprint()
	if err := m.load(); err != nil {
		return err
	}
	if fp := m.Fingerprint(); fp != old {
		m.log.Warn("certificate key changed; clients that pinned the old fingerprint will warn", "fingerprint", fp)
	} else {
		m.log.Info("certificate reloaded", "path", m.certPath)
	}
	return nil
}

func (m *Manager) load() error {
	st, err := os.Stat(m.certPath)
	if err != nil {
		return err
	}
	cert, err := tls.LoadX509KeyPair(m.certPath, m.keyPath)
	if err != nil {
		return fmt.Errorf("load certificate: %w", err)
	}
	leaf, err := x509.ParseCertificate(cert.Certificate[0])
	if err != nil {
		return err
	}
	cert.Leaf = leaf
	m.mu.Lock()
	m.cert = &cert
	m.spki = sha256.Sum256(leaf.RawSubjectPublicKeyInfo)
	m.modTime = st.ModTime()
	m.mu.Unlock()
	return nil
}

// generateSelfSigned 生成 ECDSA P-256 自签名证书，有效期 10 年，SAN 包含本机地址和 publicHost。
func generateSelfSigned(dir, certPath, keyPath, publicHost string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 127))
	if err != nil {
		return err
	}
	tmpl := &x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{CommonName: "OpenHane Server"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().AddDate(10, 0, 0),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames:     []string{"localhost"},
		IPAddresses:  localIPs(),
	}
	if ip := net.ParseIP(publicHost); ip != nil {
		tmpl.IPAddresses = append(tmpl.IPAddresses, ip)
	} else if publicHost != "" {
		tmpl.DNSNames = append(tmpl.DNSNames, publicHost)
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		return err
	}
	keyDER, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return err
	}
	// 先写私钥再写证书：证书文件存在即表示生成完成
	if err := os.WriteFile(keyPath, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER}), 0o600); err != nil {
		return err
	}
	return os.WriteFile(certPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o644)
}

func localIPs() []net.IP {
	ips := []net.IP{net.IPv4(127, 0, 0, 1), net.IPv6loopback}
	addrs, _ := net.InterfaceAddrs()
	for _, a := range addrs {
		if n, ok := a.(*net.IPNet); ok && !n.IP.IsLoopback() && !n.IP.IsLinkLocalUnicast() {
			ips = append(ips, n.IP)
		}
	}
	return ips
}
