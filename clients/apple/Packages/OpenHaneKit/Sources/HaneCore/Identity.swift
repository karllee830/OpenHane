import CryptoKit
import Foundation

/// 密钥身份：每个服务器的 Ed25519 私钥由主种子派生，UID 由公钥计算。
/// 与服务端 internal/identity、Web 客户端 core/identity 共用测试向量。
public enum Identity {
    /// HKDF-SHA256(ikm = 主种子, salt = "OpenHane-Identity-v1", info = server_id) → Ed25519 种子
    public static func deriveKey(masterSeed: Data, serverID: Data) -> Curve25519.Signing.PrivateKey {
        let okm = HKDF<SHA256>.deriveKey(
            inputKeyMaterial: SymmetricKey(data: masterSeed),
            salt: Data("OpenHane-Identity-v1".utf8),
            info: serverID,
            outputByteCount: 32
        )
        // 32 字节一定是合法的 Ed25519 种子
        return try! Curve25519.Signing.PrivateKey(rawRepresentation: okm.withUnsafeBytes { Data($0) })
    }

    /// UID = base32(SHA-256(公钥)) 的前 20 个字符，小写
    public static func uid(publicKey: Data) -> String {
        String(base32(Data(SHA256.hash(data: publicKey))).prefix(20)).lowercased()
    }

    /// 界面展示用的短 UID，如 k3m9-x2qa
    public static func shortUID(_ uid: String) -> String {
        guard uid.count >= 8 else { return uid }
        return "\(uid.prefix(4))-\(uid.dropFirst(4).prefix(4))"
    }

    /// 鉴权签名内容："OpenHane-Auth-v1" || 0x00 || server_id || nonce || seen_spki || timestamp_ms（大端 8 字节）
    public static func authSignatureInput(serverID: Data, nonce: Data, seenSPKI: Data, timestampMs: Int64) -> Data {
        var d = Data("OpenHane-Auth-v1".utf8)
        d.append(0)
        d.append(serverID)
        d.append(nonce)
        d.append(seenSPKI)
        withUnsafeBytes(of: UInt64(bitPattern: timestampMs).bigEndian) { d.append(contentsOf: $0) }
        return d
    }

    private static let alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")
    static func base32(_ data: Data) -> String {
        var out = ""
        var buffer: UInt32 = 0
        var bits = 0
        for byte in data {
            buffer = (buffer << 8) | UInt32(byte)
            bits += 8
            while bits >= 5 {
                out.append(alphabet[Int((buffer >> UInt32(bits - 5)) & 31)])
                bits -= 5
            }
        }
        if bits > 0 { out.append(alphabet[Int((buffer << UInt32(5 - bits)) & 31)]) }
        return out
    }
}
