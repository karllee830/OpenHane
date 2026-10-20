import CryptoKit
import Foundation
@testable import HaneCore
import Testing

/// 与 Go 参考实现、Web 版共用的测试向量（testdata/e2ee/vectors.json）
@Suite struct E2EETests {
    struct Vectors: Decodable {
        struct HPKECase: Decodable {
            let recipientPrivateKey, recipientPublicKey, roomId, fromSessionId, toSessionId, aad, enc, ciphertext, plaintext: String
            let keyIndex: UInt32
        }

        struct Member: Decodable { let uid, publicKey: String }
        struct SafetyCase: Decodable {
            let members: [Member]
            let code: [Int]
        }

        struct ChatCase: Decodable {
            let mediaKey, roomId, fromSessionId, aad, nonce, plaintext, ciphertext, text: String
            let keyIndex: UInt32
        }

        struct ImageCase: Decodable { let key, nonce, image, file, digest: String }

        let hpke: [HPKECase]
        let safetyCode: [SafetyCase]
        let chat: [ChatCase]
        let chatImage: [ImageCase]
    }

    static let vectors: Vectors = {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../../../../../testdata/e2ee/vectors.json").standardizedFileURL
        return try! JSONDecoder().decode(Vectors.self, from: Data(contentsOf: url))
    }()

    static func hex(_ s: String) -> Data {
        var d = Data()
        var i = s.startIndex
        while i < s.endIndex {
            let j = s.index(i, offsetBy: 2)
            d.append(UInt8(s[i ..< j], radix: 16)!)
            i = j
        }
        return d
    }

    @Test func opensKeyPackagesFromGoReference() throws {
        for c in Self.vectors.hpke {
            let aad = E2EECrypto.keyPackageAAD(room: c.roomId, from: c.fromSessionId, to: c.toSessionId, keyIndex: c.keyIndex)
            #expect(aad == Self.hex(c.aad))
            let sk = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: Self.hex(c.recipientPrivateKey))
            #expect(sk.publicKey.rawRepresentation == Self.hex(c.recipientPublicKey))
            let pt = try E2EECrypto.open(enc: Self.hex(c.enc), ciphertext: Self.hex(c.ciphertext), privateKey: sk, aad: aad)
            #expect(pt == Self.hex(c.plaintext))
            let wrong = E2EECrypto.keyPackageAAD(room: c.roomId, from: c.fromSessionId, to: "other", keyIndex: c.keyIndex)
            #expect(throws: (any Error).self) { try E2EECrypto.open(enc: Self.hex(c.enc), ciphertext: Self.hex(c.ciphertext), privateKey: sk, aad: wrong) }
        }
    }

    @Test func sealsAndOpens() throws {
        let sk = Curve25519.KeyAgreement.PrivateKey()
        let key = E2EECrypto.newMediaKey()
        let aad = E2EECrypto.keyPackageAAD(room: "r_1", from: "a", to: "b", keyIndex: 3)
        let (enc, ct) = try E2EECrypto.seal(mediaKey: key, to: sk.publicKey.rawRepresentation, aad: aad)
        #expect(enc.count == 32)
        #expect(try E2EECrypto.open(enc: enc, ciphertext: ct, privateKey: sk, aad: aad) == key)
    }

    @Test func safetyCodesMatch() {
        for c in Self.vectors.safetyCode {
            #expect(E2EECrypto.safetyCode(members: c.members.map { ($0.uid, Self.hex($0.publicKey)) }) == c.code)
        }
    }

    @Test func chatMatchesGoReference() throws {
        for c in Self.vectors.chat {
            let key = E2EECrypto.chatKey(mediaKey: Self.hex(c.mediaKey))
            let aad = E2EECrypto.chatAAD(room: c.roomId, from: c.fromSessionId, keyIndex: c.keyIndex)
            #expect(aad == Self.hex(c.aad))
            #expect(try E2EECrypto.sealChat(Self.hex(c.plaintext), key: key, aad: aad, nonce: Self.hex(c.nonce)).ciphertext == Self.hex(c.ciphertext))
            let pt = try E2EECrypto.openChat(nonce: Self.hex(c.nonce), ciphertext: Self.hex(c.ciphertext), key: key, aad: aad)
            #expect(pt == Self.hex(c.plaintext))
            #expect(try Openhane_V1_ChatPlaintext(serializedBytes: pt).text == c.text)
            // 换了发送者（AAD 不符）就解不开
            let wrong = E2EECrypto.chatAAD(room: c.roomId, from: "other", keyIndex: c.keyIndex)
            #expect(throws: (any Error).self) { try E2EECrypto.openChat(nonce: Self.hex(c.nonce), ciphertext: Self.hex(c.ciphertext), key: key, aad: wrong) }
        }
        for c in Self.vectors.chatImage {
            let sealed = try E2EECrypto.sealChatImage(Self.hex(c.image), key: Self.hex(c.key), nonce: Self.hex(c.nonce))
            #expect(sealed.file == Self.hex(c.file) && sealed.digest == Self.hex(c.digest))
            #expect(try E2EECrypto.openChatImage(Self.hex(c.file), key: Self.hex(c.key), digest: Self.hex(c.digest)) == Self.hex(c.image))
            var other = Self.hex(c.file)
            other[other.count - 1] ^= 1
            #expect(throws: (any Error).self) { try E2EECrypto.openChatImage(other, key: Self.hex(c.key), digest: Self.hex(c.digest)) }
        }
    }

    @Test func safetyEmojiMatchesSharedTable() throws {
        struct Entry: Decodable { let emoji, zh: String }
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../../../../../testdata/e2ee/safety-emoji.json").standardizedFileURL
        let table = try JSONDecoder().decode([Entry].self, from: Data(contentsOf: url))
        #expect(SafetyEmoji.all.map(\.emoji) == table.map(\.emoji))
        #expect(SafetyEmoji.all.map(\.name) == table.map(\.zh))
    }

    @Test func verifiesKeySignatures() throws {
        let id = Curve25519.Signing.PrivateKey()
        let uid = Identity.uid(publicKey: id.publicKey.rawRepresentation)
        let kx = Curve25519.KeyAgreement.PrivateKey().publicKey.rawRepresentation
        let sig = try id.signature(for: E2EECrypto.keySigInput(kx))
        #expect(E2EECrypto.verifyKey(uid: uid, identityPub: id.publicKey.rawRepresentation, x25519Pub: kx, signature: sig))
        let forged = Curve25519.KeyAgreement.PrivateKey().publicKey.rawRepresentation
        #expect(!E2EECrypto.verifyKey(uid: uid, identityPub: id.publicKey.rawRepresentation, x25519Pub: forged, signature: sig))
        #expect(!E2EECrypto.verifyKey(uid: "aaaaaaaaaaaaaaaaaaaa", identityPub: id.publicKey.rawRepresentation, x25519Pub: kx, signature: sig))
    }
}
