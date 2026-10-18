import CryptoKit
import Foundation

/// 端到端加密的密码学部分，与 Web 版（packages/core/src/e2ee.ts）、Go 参考实现共用
/// testdata/e2ee/vectors.json：
/// - 每个会话一把 X25519 密钥交换密钥，公钥由身份私钥签名后在握手时上报；
/// - 媒体密钥用 HPKE（DHKEM(X25519, HKDF-SHA256) + HKDF-SHA256 + AES-128-GCM，base 模式）逐个加密给其他成员；
/// - 安全码：所有人看到的相同，就说明大家看到的成员列表一致。
public enum E2EECrypto {
    public static let keyPackageInfo = Data("OpenHane-E2EE-KeyPackage-v1".utf8)
    static let keyContext = Data("OpenHane-E2EE-Key-v1".utf8)
    static let safetyContext = Data("OpenHane-SafetyCode-v1".utf8)
    static let suite = HPKE.Ciphersuite(kem: .Curve25519_HKDF_SHA256, kdf: .HKDF_SHA256, aead: .AES_GCM_128)

    /// 身份私钥对 X25519 公钥的签名内容："OpenHane-E2EE-Key-v1" ‖ 0x00 ‖ 公钥
    public static func keySigInput(_ x25519Pub: Data) -> Data {
        keyContext + Data([0]) + x25519Pub
    }

    /// 校验成员的 E2EE 公钥：身份公钥必须与 UID 对应，且签名有效（服务端无法替换成员的密钥交换公钥）
    public static func verifyKey(uid: String, identityPub: Data, x25519Pub: Data, signature: Data) -> Bool {
        guard identityPub.count == 32, x25519Pub.count == 32, signature.count == 64,
              Identity.uid(publicKey: identityPub) == uid,
              let key = try? Curve25519.Signing.PublicKey(rawRepresentation: identityPub)
        else { return false }
        return key.isValidSignature(signature, for: keySigInput(x25519Pub))
    }

    /// 密钥包的 AAD：room_id ‖ 0x00 ‖ from ‖ 0x00 ‖ to ‖ 0x00 ‖ key_index（4 字节大端）
    public static func keyPackageAAD(room: String, from: String, to: String, keyIndex: UInt32) -> Data {
        var d = Data("\(room)\0\(from)\0\(to)\0".utf8)
        withUnsafeBytes(of: keyIndex.bigEndian) { d.append(contentsOf: $0) }
        return d
    }

    public static func seal(mediaKey: Data, to recipientPub: Data, aad: Data) throws -> (enc: Data, ciphertext: Data) {
        let pk = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: recipientPub)
        var sender = try HPKE.Sender(recipientKey: pk, ciphersuite: suite, info: keyPackageInfo)
        let ct = try sender.seal(mediaKey, authenticating: aad)
        return (sender.encapsulatedKey, ct)
    }

    public static func open(enc: Data, ciphertext: Data, privateKey: Curve25519.KeyAgreement.PrivateKey, aad: Data) throws -> Data {
        var r = try HPKE.Recipient(privateKey: privateKey, ciphersuite: suite, info: keyPackageInfo, encapsulatedKey: enc)
        return try r.open(ciphertext, authenticating: aad)
    }

    /// 新的随机媒体密钥（32 字节，LiveKit 用 HKDF 从中派生帧加密密钥）
    public static func newMediaKey() -> Data {
        SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) }
    }

    /// 安全码：SHA-256(context ‖ 0x00 ‖ 按 UID 排序、去重后的 UID ‖ 0x00 ‖ 身份公钥…)，
    /// 取前 30 字节，每 5 字节对 100000 取余，得到 6 组 5 位数字
    public static func safetyCode(members: [(uid: String, publicKey: Data)]) -> String {
        var byUID: [String: Data] = [:]
        for m in members { byUID[m.uid] = m.publicKey }
        var h = SHA256()
        h.update(data: safetyContext + Data([0]))
        for uid in byUID.keys.sorted() {
            h.update(data: Data(uid.utf8) + Data([0]) + byUID[uid]!)
        }
        let d = Array(h.finalize())
        return (0 ..< 6).map { i in
            let v = d[i * 5 ..< i * 5 + 5].reduce(UInt64(0)) { $0 << 8 | UInt64($1) }
            return String(format: "%05llu", v % 100_000)
        }.joined(separator: " ")
    }
}
