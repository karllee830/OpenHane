package tlsmgr

import (
	"crypto/sha256"
	"crypto/tls"
	"io"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/karllee830/OpenHane/server/internal/config"
)

var discard = slog.New(slog.NewTextHandler(io.Discard, nil))

func TestSelfSignedIsStableAndServes(t *testing.T) {
	dir := t.TempDir()
	cfg := &config.Config{TLSMode: config.TLSSelfSigned, DataDir: dir, PublicHost: "meet.example.com"}
	m, err := New(cfg, discard)
	if err != nil {
		t.Fatal(err)
	}
	fp := m.Fingerprint()
	if len(fp) < 10 {
		t.Fatal(fp)
	}
	if st, _ := os.Stat(filepath.Join(dir, "tls", "server.key")); st.Mode().Perm() != 0o600 {
		t.Fatalf("key perm %v", st.Mode().Perm())
	}
	m2, err := New(cfg, discard)
	if err != nil || m2.Fingerprint() != fp {
		t.Fatalf("fingerprint changed after reload: %s vs %s (%v)", m2.Fingerprint(), fp, err)
	}

	// 握手后客户端看到的 SPKI 应与 Manager 报告的一致
	ln, err := tls.Listen("tcp", "127.0.0.1:0", m.TLSConfig())
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		c, err := ln.Accept()
		if err == nil {
			c.(*tls.Conn).Handshake()
			c.Close()
		}
	}()
	c, err := tls.DialWithDialer(&net.Dialer{Timeout: 2 * time.Second}, "tcp", ln.Addr().String(), &tls.Config{InsecureSkipVerify: true})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	seen := sha256.Sum256(c.ConnectionState().PeerCertificates[0].RawSubjectPublicKeyInfo)
	if want, _ := m.SPKI(); seen != want {
		t.Fatal("SPKI mismatch")
	}
	leaf := c.ConnectionState().PeerCertificates[0]
	if err := leaf.VerifyHostname("meet.example.com"); err != nil {
		t.Fatal(err)
	}
}

func TestOff(t *testing.T) {
	m, err := New(&config.Config{TLSMode: config.TLSOff}, discard)
	if err != nil || m.Enabled() || m.TLSConfig() != nil || m.Fingerprint() != "" {
		t.Fatal("off mode should have no TLS")
	}
}

func TestFileModeReload(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "a")
	if err := generateSelfSigned(src, filepath.Join(src, "c.pem"), filepath.Join(src, "k.pem"), ""); err != nil {
		t.Fatal(err)
	}
	cert, key := filepath.Join(dir, "cert.pem"), filepath.Join(dir, "key.pem")
	copyFile(t, filepath.Join(src, "c.pem"), cert)
	copyFile(t, filepath.Join(src, "k.pem"), key)
	m, err := New(&config.Config{TLSMode: config.TLSFile, TLSCert: cert, TLSKey: key}, discard)
	if err != nil {
		t.Fatal(err)
	}
	fp := m.Fingerprint()

	b := filepath.Join(dir, "b")
	generateSelfSigned(b, filepath.Join(b, "c.pem"), filepath.Join(b, "k.pem"), "")
	copyFile(t, filepath.Join(b, "k.pem"), key)
	copyFile(t, filepath.Join(b, "c.pem"), cert)
	future := time.Now().Add(time.Minute)
	os.Chtimes(cert, future, future)
	if err := m.Reload(); err != nil {
		t.Fatal(err)
	}
	if m.Fingerprint() == fp {
		t.Fatal("fingerprint should change after key rotation")
	}
}

func copyFile(t *testing.T, from, to string) {
	t.Helper()
	b, err := os.ReadFile(from)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(to, b, 0o600); err != nil {
		t.Fatal(err)
	}
}
