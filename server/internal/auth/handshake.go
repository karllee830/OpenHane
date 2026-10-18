// Package auth 实现握手鉴权所需的密码学校验和权限令牌格式。
package auth

import (
	"bytes"
	"crypto/ed25519"
	"encoding/binary"
)

const (
	authContext = "OpenHane-Auth-v1"
	e2eeContext = "OpenHane-E2EE-Key-v1"
)

// ZeroSPKI 是拿不到证书指纹的客户端（浏览器）填写的值。
var ZeroSPKI = make([]byte, 32)

// SigInput 构造鉴权签名的内容：
//
//	"OpenHane-Auth-v1" || 0x00 || server_id(16) || nonce(32) || seen_spki_sha256(32) || timestamp_ms(8，大端序)
func SigInput(serverID, nonce, seenSPKI []byte, timestampMs int64) []byte {
	b := make([]byte, 0, len(authContext)+1+16+32+32+8)
	b = append(b, authContext...)
	b = append(b, 0)
	b = append(b, serverID...)
	b = append(b, nonce...)
	b = append(b, seenSPKI...)
	return binary.BigEndian.AppendUint64(b, uint64(timestampMs))
}

// VerifyAuth 校验 ClientAuth 的签名。
func VerifyAuth(pub, sig, serverID, nonce, seenSPKI []byte, timestampMs int64) bool {
	if len(pub) != ed25519.PublicKeySize || len(sig) != ed25519.SignatureSize ||
		len(serverID) != 16 || len(nonce) != 32 || len(seenSPKI) != 32 {
		return false
	}
	return ed25519.Verify(pub, SigInput(serverID, nonce, seenSPKI, timestampMs), sig)
}

// SPKIMismatch 判断客户端看到的证书指纹与服务端自身的不一致（疑似中间人）。
// 全零表示客户端拿不到指纹（浏览器），不做比较。
func SPKIMismatch(seen []byte, own [32]byte) bool {
	if bytes.Equal(seen, ZeroSPKI) {
		return false
	}
	return !bytes.Equal(seen, own[:])
}

// E2EEKeyInput 是 E2EE 公钥签名的内容："OpenHane-E2EE-Key-v1" || 0x00 || public_key(32)。
func E2EEKeyInput(x25519Pub []byte) []byte {
	b := append([]byte(e2eeContext), 0)
	return append(b, x25519Pub...)
}

// VerifyE2EEKey 校验身份私钥对 X25519 公钥的签名。
func VerifyE2EEKey(identityPub, x25519Pub, sig []byte) bool {
	if len(identityPub) != ed25519.PublicKeySize || len(x25519Pub) != 32 || len(sig) != ed25519.SignatureSize {
		return false
	}
	return ed25519.Verify(identityPub, E2EEKeyInput(x25519Pub), sig)
}
