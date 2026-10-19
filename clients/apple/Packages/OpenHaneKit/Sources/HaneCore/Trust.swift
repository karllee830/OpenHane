import CryptoKit
import Foundation
import Security

/// TOFU 证书固定：按 `主机:端口` 记录服务器证书的 SPKI SHA-256 指纹。
/// 由受信任 CA 签发的有效证书走系统校验；自签名证书第一次见到时记住，之后指纹一致才信任。
public final class TrustStore: @unchecked Sendable {
    public struct Mismatch: Equatable, Sendable {
        public let hostPort: String
        public let expected: String
        public let actual: String
    }

    private let fileURL: URL
    private let lock = NSLock()
    private var pins: [String: String]
    private var seen: [String: Data] = [:]
    private var mismatches: [String: Mismatch] = [:]

    public init(fileURL: URL) {
        self.fileURL = fileURL
        pins = (try? JSONDecoder().decode([String: String].self, from: Data(contentsOf: fileURL))) ?? [:]
    }

    /// 默认位置：Application Support/OpenHane/pins.json
    public static func defaultStore() -> TrustStore {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("OpenHane")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return TrustStore(fileURL: dir.appendingPathComponent("pins.json"))
    }

    /// 校验一次 TLS 握手中的证书。hostPort 用于按端口区分同一主机上的多个服务器。
    public func evaluate(_ trust: SecTrust, hostPort: String) -> Bool {
        let key = hostPort.lowercased()
        guard let spki = Self.spki(trust) else { return false }
        lock.withLock { seen[key] = spki }
        if SecTrustEvaluateWithError(trust, nil) { return true } // CA 签发的有效证书
        let fp = Self.format(spki)
        return lock.withLock {
            switch pins[key] {
            case nil:
                pins[key] = fp
                save()
                return true
            case fp:
                mismatches[key] = nil
                return true
            case let pinned?:
                mismatches[key] = Mismatch(hostPort: key, expected: pinned, actual: fp)
                return false
            }
        }
    }

    /// 只检查、不记住：CA 签发的有效证书，或与已记住的指纹一致（服务器列表探测延迟用，不能替用户信任新证书）
    public func isTrusted(_ trust: SecTrust, hostPort: String) -> Bool {
        if SecTrustEvaluateWithError(trust, nil) { return true }
        guard let spki = Self.spki(trust) else { return false }
        return lock.withLock { pins[hostPort.lowercased()] } == Self.format(spki)
    }

    /// 生成给 URLSession / LiveKit SDK 使用的信任回调（回调里只有主机名，端口由调用方提供）。
    public func evaluator(port: Int) -> @Sendable (SecTrust, String) -> Bool {
        { [self] trust, host in
            evaluate(trust, hostPort: host.contains(":") ? "[\(host)]:\(port)" : "\(host):\(port)")
        }
    }

    /// 最近一次握手看到的 SPKI SHA-256（鉴权签名中携带，服务端据此发现中间人）
    public func seenSPKI(hostPort: String) -> Data? { lock.withLock { seen[hostPort.lowercased()] } }

    /// 最近一次因指纹不一致被拒绝的详情
    public func mismatch(hostPort: String) -> Mismatch? { lock.withLock { mismatches[hostPort.lowercased()] } }

    /// 用户确认指纹变化是正常的：改为信任新指纹
    public func accept(_ m: Mismatch) {
        lock.withLock {
            pins[m.hostPort] = m.actual
            mismatches[m.hostPort] = nil
            save()
        }
    }

    public func pinned(hostPort: String) -> String? { lock.withLock { pins[hostPort.lowercased()] } }

    private func save() {
        if let data = try? JSONEncoder().encode(pins) { try? data.write(to: fileURL, options: .atomic) }
    }

    public static func format(_ spki: Data) -> String { "SHA256:" + spki.base64EncodedString() }

    /// 叶子证书公钥的 SPKI（SubjectPublicKeyInfo DER）的 SHA-256。支持 ECDSA P-256 / P-384 和 RSA。
    public static func spki(_ trust: SecTrust) -> Data? {
        guard let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate], let leaf = chain.first,
              let key = SecCertificateCopyKey(leaf),
              let attrs = SecKeyCopyAttributes(key) as? [CFString: Any],
              let raw = SecKeyCopyExternalRepresentation(key, nil) as Data?,
              let type = attrs[kSecAttrKeyType] as? String,
              let bits = attrs[kSecAttrKeySizeInBits] as? Int
        else { return nil }
        let ec = type == (kSecAttrKeyTypeECSECPrimeRandom as String)
        let der: Data
        if ec, bits == 256 {
            der = Data([0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x02, 0x01,
                        0x06, 0x08, 0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00]) + raw
        } else if ec, bits == 384 {
            der = Data([0x30, 0x76, 0x30, 0x10, 0x06, 0x07, 0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x02, 0x01,
                        0x06, 0x05, 0x2B, 0x81, 0x04, 0x00, 0x22, 0x03, 0x62, 0x00]) + raw
        } else if type == (kSecAttrKeyTypeRSA as String) {
            // SEQUENCE { SEQUENCE { rsaEncryption, NULL }, BIT STRING { 0x00, RSAPublicKey } }
            let algo = Data([0x30, 0x0D, 0x06, 0x09, 0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01, 0x01, 0x05, 0x00])
            let bitString = Data([0x03]) + derLength(raw.count + 1) + Data([0x00]) + raw
            let body = algo + bitString
            der = Data([0x30]) + derLength(body.count) + body
        } else {
            return nil
        }
        return Data(SHA256.hash(data: der))
    }

    static func derLength(_ n: Int) -> Data {
        if n < 0x80 { return Data([UInt8(n)]) }
        var bytes: [UInt8] = []
        var v = n
        while v > 0 { bytes.insert(UInt8(v & 0xFF), at: 0); v >>= 8 }
        return Data([0x80 | UInt8(bytes.count)] + bytes)
    }
}
