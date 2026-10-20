import CommonCrypto
import CryptoKit
import Foundation

/// 端到端加密的密码学部分，与 Web 版（packages/core/src/e2ee.ts）、Go 参考实现共用
/// testdata/e2ee/vectors.json：
/// - 每个会话一把 X25519 密钥交换密钥，公钥由身份私钥签名后在握手时上报；
/// - 媒体密钥用 HPKE（DHKEM(X25519, HKDF-SHA256) + HKDF-SHA256 + AES-128-GCM，base 模式）逐个加密给其他成员；
/// - 安全码（8 个 emoji）：所有人看到的相同，就说明大家看到的成员列表一致；
/// - 聊天：用发送者媒体密钥派生的聊天密钥加密正文，图片每张随机一把密钥（见 proto 的 EncryptedChat）。
public enum E2EECrypto {
    public static let keyPackageInfo = Data("OpenHane-E2EE-KeyPackage-v1".utf8)
    static let keyContext = Data("OpenHane-E2EE-Key-v1".utf8)
    static let safetyContext = Data("OpenHane-SafetyCode-v2".utf8)
    /// 安全码 PBKDF2 的迭代次数：让「生成假成员的密钥、凑出相同的安全码」的每次尝试都很慢
    static let safetyIterations: UInt32 = 1 << 20
    /// 安全码的 emoji 个数（每个 6 位，是 SafetyEmoji.all 里的序号）
    public static let safetyLength = 8
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

    /// 安全码的输入：SHA-256("OpenHane-SafetyCode-v2" ‖ 0x00 ‖ 按 UID 排序、去重后的 UID ‖ 0x00 ‖ 身份公钥…)。
    /// 计算很快，可以用来判断成员是否变了
    public static func safetyDigest(members: [(uid: String, publicKey: Data)]) -> Data {
        var byUID: [String: Data] = [:]
        for m in members { byUID[m.uid] = m.publicKey }
        var h = SHA256()
        h.update(data: safetyContext + Data([0]))
        for uid in byUID.keys.sorted() {
            h.update(data: Data(uid.utf8) + Data([0]) + byUID[uid]!)
        }
        return Data(h.finalize())
    }

    /// 由 safetyDigest 的结果算出安全码：PBKDF2-HMAC-SHA256(digest, salt = "OpenHane-SafetyCode-v2", 2^20 次) 取 48 位，
    /// 从高到低每 6 位一组，得到 8 个 0–63 的 emoji 序号。要算零点几秒：不要在主线程调用
    public static func safetyCode(digest: Data) -> [Int] {
        var bits = [UInt8](repeating: 0, count: safetyLength * 6 / 8)
        let status = digest.withUnsafeBytes { pw in
            safetyContext.withUnsafeBytes { salt in
                CCKeyDerivationPBKDF(CCPBKDFAlgorithm(kCCPBKDF2), pw.baseAddress!.assumingMemoryBound(to: CChar.self), pw.count,
                                     salt.baseAddress!.assumingMemoryBound(to: UInt8.self), salt.count,
                                     CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256), safetyIterations, &bits, bits.count)
            }
        }
        precondition(status == kCCSuccess, "PBKDF2 failed: \(status)")
        let v = bits.reduce(UInt64(0)) { $0 << 8 | UInt64($1) }
        return (0 ..< safetyLength).map { i in Int(v >> UInt64(6 * (safetyLength - 1 - i)) & 63) }
    }

    public static func safetyCode(members: [(uid: String, publicKey: Data)]) -> [Int] {
        safetyCode(digest: safetyDigest(members: members))
    }

    static let chatContext = Data("OpenHane-Chat-v1".utf8)
    static let chatImageContext = Data("OpenHane-ChatImage-v1".utf8)
    /// 加密图片文件的开头（后面是 12 字节 nonce 和 AES-256-GCM 密文）
    static let chatImageMagic = Data("HNE1".utf8)

    /// 聊天密钥：HKDF-SHA256(ikm = 媒体密钥, salt = "OpenHane-Chat-v1", info = 空) → AES-256-GCM 密钥
    public static func chatKey(mediaKey: Data) -> SymmetricKey {
        HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: mediaKey), salt: chatContext, info: Data(), outputByteCount: 32)
    }

    /// 聊天密文的 AAD："OpenHane-Chat-v1" ‖ 0x00 ‖ room_id ‖ 0x00 ‖ 发送者 session_id ‖ 0x00 ‖ key_index（4 字节大端）
    public static func chatAAD(room: String, from: String, keyIndex: UInt32) -> Data {
        var d = chatContext + Data([0]) + Data(room.utf8) + Data([0]) + Data(from.utf8) + Data([0])
        withUnsafeBytes(of: keyIndex.bigEndian) { d.append(contentsOf: $0) }
        return d
    }

    /// 加密聊天内容（ChatPlaintext 的编码），返回 nonce 和密文（含 16 字节标签）。nonce 不传时随机生成
    public static func sealChat(_ plaintext: Data, key: SymmetricKey, aad: Data, nonce: Data? = nil) throws -> (nonce: Data, ciphertext: Data) {
        let n = try nonce.map { try AES.GCM.Nonce(data: $0) } ?? AES.GCM.Nonce()
        let box = try AES.GCM.seal(plaintext, using: key, nonce: n, authenticating: aad)
        return (Data(n), box.ciphertext + box.tag)
    }

    /// 解密聊天内容；密钥不对、被篡改或 AAD 不符时抛出异常
    public static func openChat(nonce: Data, ciphertext: Data, key: SymmetricKey, aad: Data) throws -> Data {
        guard ciphertext.count > 16 else { throw CryptoKitError.incorrectParameterSize }
        let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: nonce), ciphertext: ciphertext.dropLast(16), tag: ciphertext.suffix(16))
        return try AES.GCM.open(box, using: key, authenticating: aad)
    }

    /// 加密一张图片：每张图片随机一把密钥，文件 = "HNE1" ‖ nonce ‖ AES-256-GCM(key, nonce, 图片, aad = "OpenHane-ChatImage-v1")。
    /// 返回要上传的文件、密钥和文件的 SHA-256（密钥和摘要放进加密的聊天正文里）
    public static func sealChatImage(_ image: Data, key: Data? = nil, nonce: Data? = nil) throws -> (file: Data, key: Data, digest: Data) {
        let k = key ?? SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) }
        let n = try nonce.map { try AES.GCM.Nonce(data: $0) } ?? AES.GCM.Nonce()
        let box = try AES.GCM.seal(image, using: SymmetricKey(data: k), nonce: n, authenticating: chatImageContext)
        let file = chatImageMagic + Data(n) + box.ciphertext + box.tag
        return (file, k, Data(SHA256.hash(data: file)))
    }

    /// 解密下载的图片：先核对摘要（服务器换不了文件），再解密
    public static func openChatImage(_ file: Data, key: Data, digest: Data) throws -> Data {
        guard Data(SHA256.hash(data: file)) == digest, file.count > chatImageMagic.count + 12 + 16,
              file.prefix(chatImageMagic.count) == chatImageMagic
        else { throw CryptoKitError.authenticationFailure }
        let body = file.dropFirst(chatImageMagic.count)
        let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: body.prefix(12)), ciphertext: body.dropFirst(12).dropLast(16), tag: body.suffix(16))
        return try AES.GCM.open(box, using: SymmetricKey(data: key), authenticating: chatImageContext)
    }
}

/// 安全码用的 64 个 emoji（与 Matrix 的 emoji 验证相同：在各平台上容易区分、好叫名字），与 testdata/e2ee/safety-emoji.json 一致。
/// 名称是中文，界面显示时按 Localizable.xcstrings 翻译
public enum SafetyEmoji {
    public static let all: [(emoji: String, name: String)] = [
        ("🐶", "狗"), ("🐱", "猫"), ("🦁", "狮子"), ("🐎", "马"), ("🦄", "独角兽"), ("🐷", "猪"), ("🐘", "大象"), ("🐰", "兔子"),
        ("🐼", "熊猫"), ("🐓", "公鸡"), ("🐧", "企鹅"), ("🐢", "乌龟"), ("🐟", "鱼"), ("🐙", "章鱼"), ("🦋", "蝴蝶"), ("🌷", "花"),
        ("🌳", "树"), ("🌵", "仙人掌"), ("🍄", "蘑菇"), ("🌏", "地球"), ("🌙", "月亮"), ("☁️", "云"), ("🔥", "火"), ("🍌", "香蕉"),
        ("🍎", "苹果"), ("🍓", "草莓"), ("🌽", "玉米"), ("🍕", "披萨"), ("🎂", "蛋糕"), ("❤️", "爱心"), ("😀", "笑脸"), ("🤖", "机器人"),
        ("🎩", "帽子"), ("👓", "眼镜"), ("🔧", "扳手"), ("🎅", "圣诞老人"), ("👍", "点赞"), ("☂️", "雨伞"), ("⌛", "沙漏"), ("⏰", "闹钟"),
        ("🎁", "礼物"), ("💡", "灯泡"), ("📕", "书"), ("✏️", "铅笔"), ("📎", "回形针"), ("✂️", "剪刀"), ("🔒", "锁"), ("🔑", "钥匙"),
        ("🔨", "锤子"), ("☎️", "电话"), ("🏁", "旗子"), ("🚂", "火车"), ("🚲", "自行车"), ("✈️", "飞机"), ("🚀", "火箭"), ("🏆", "奖杯"),
        ("⚽", "足球"), ("🎸", "吉他"), ("🎺", "小号"), ("🔔", "铃铛"), ("⚓", "锚"), ("🎧", "耳机"), ("📁", "文件夹"), ("📌", "图钉"),
    ]
}
