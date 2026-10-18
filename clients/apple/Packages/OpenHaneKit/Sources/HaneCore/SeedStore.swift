import Foundation
import Security

/// 主种子（32 字节）的存储。
public protocol SeedStore: Sendable {
    func masterSeed() throws -> Data
}

/// 钥匙串存储。默认开启 iCloud 钥匙串同步（kSecAttrSynchronizable），iPhone、iPad、Mac 自动是同一个人。
/// 没有相应权限（例如未签名的开发版本）时退回本机钥匙串。
/// 读取可能弹出系统的钥匙串密码框（本机钥匙串的条目绑定在应用签名上，临时签名的版本每次更新都会问一次），
/// 期间调用线程会一直等着：不要在主线程上调用（见 ServerSession.loadSeed）。
public final class KeychainSeedStore: SeedStore, @unchecked Sendable {
    private let service = "com.0http.openhane.identity"
    private let account = "master-seed"
    private let synchronizable: Bool
    private let lock = NSLock()
    private var cached: Data?

    public init(synchronizable: Bool = true) {
        self.synchronizable = synchronizable
    }

    public func masterSeed() throws -> Data {
        try lock.withLock {
            if let cached { return cached }
            if let existing = try read() {
                cached = existing
                return existing
            }
            var seed = Data(count: 32)
            let status = seed.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!) }
            guard status == errSecSuccess else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
            try write(seed)
            cached = seed
            return seed
        }
    }

    private func baseQuery(sync: Bool, dataProtection: Bool) -> [CFString: Any] {
        var q: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: account,
            kSecAttrSynchronizable: sync ? kCFBooleanTrue! : kCFBooleanFalse!,
        ]
        if dataProtection { q[kSecUseDataProtectionKeychain] = true }
        return q
    }

    /// 读取已有的种子；确实没有时返回 nil（这时才生成新身份）。用户在密码框里点了拒绝、钥匙串锁着等情况抛出错误：
    /// 不能当成「没有」去生成新种子，否则会换成一个新身份
    private func read() throws -> Data? {
        for (sync, dp) in [(true, true), (false, true), (false, false)] {
            var q = baseQuery(sync: sync, dataProtection: dp)
            q[kSecReturnData] = true
            var out: CFTypeRef?
            let status = SecItemCopyMatching(q as CFDictionary, &out)
            switch status {
            case errSecSuccess:
                if let d = out as? Data, d.count == 32 { return d }
            case errSecItemNotFound, errSecMissingEntitlement, errSecNoSuchKeychain:
                continue // 这个位置没有：试下一个
            default:
                throw NSError(domain: NSOSStatusErrorDomain, code: Int(status),
                              userInfo: [NSLocalizedDescriptionKey: "cannot read identity from keychain (\(status))"])
            }
        }
        return nil
    }

    private func write(_ seed: Data) throws {
        let attempts: [(Bool, Bool)] = synchronizable ? [(true, true), (false, true), (false, false)] : [(false, true), (false, false)]
        var last: OSStatus = errSecSuccess
        for (sync, dp) in attempts {
            var q = baseQuery(sync: sync, dataProtection: dp)
            q[kSecValueData] = seed
            q[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlock
            q[kSecAttrLabel] = "OpenHane identity"
            last = SecItemAdd(q as CFDictionary, nil)
            if last == errSecSuccess { return }
        }
        throw NSError(domain: NSOSStatusErrorDomain, code: Int(last), userInfo: [NSLocalizedDescriptionKey: "cannot store identity in keychain (\(last))"])
    }
}

/// 内存存储（测试使用）。
public final class MemorySeedStore: SeedStore {
    private let seed: Data
    public init(seed: Data) { self.seed = seed }
    public func masterSeed() throws -> Data { seed }
}
