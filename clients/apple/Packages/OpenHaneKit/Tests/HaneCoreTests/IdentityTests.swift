import CryptoKit
import Foundation
@testable import HaneCore
import Testing

private func hex(_ d: Data) -> String { d.map { String(format: "%02x", $0) }.joined() }

@Suite struct IdentityTests {
    @Test func zeroSeedUIDVector() throws {
        // 与 server/internal/identity 的固定向量一致（已用 OpenSSL 独立核对）
        let key = try Curve25519.Signing.PrivateKey(rawRepresentation: Data(count: 32))
        #expect(hex(key.publicKey.rawRepresentation) == "3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29")
        #expect(Identity.uid(publicKey: key.publicKey.rawRepresentation) == "copdsqhgjnkjc4rardm2")
        #expect(Identity.shortUID("copdsqhgjnkjc4rardm2") == "copd-sqhg")
    }

    @Test func derivationVector() {
        // 主种子 00×32，server_id = "server-a-16bytes"（与 Go / TypeScript 实现共用）
        let key = Identity.deriveKey(masterSeed: Data(count: 32), serverID: Data("server-a-16bytes".utf8))
        #expect(Identity.uid(publicKey: key.publicKey.rawRepresentation) == "2gqiydvtufme24hxgoyk")
    }

    @Test func authSignatureInputVector() {
        let input = Identity.authSignatureInput(serverID: Data(repeating: 0x11, count: 16), nonce: Data(repeating: 0x22, count: 32),
                                                seenSPKI: Data(repeating: 0x33, count: 32), timestampMs: 0x0102_0304_0506_0708)
        let want = hex(Data("OpenHane-Auth-v1".utf8)) + "00" + String(repeating: "11", count: 16) +
            String(repeating: "22", count: 32) + String(repeating: "33", count: 32) + "0102030405060708"
        #expect(hex(input) == want)
    }
}

@Suite struct AddressTests {
    @Test(arguments: [
        ("meet.example.com", "meet.example.com", 9800, true, nil as String?),
        ("meet.example.com:443", "meet.example.com", 443, true, nil),
        ("203.0.113.10:9800", "203.0.113.10", 9800, true, nil),
        ("[2001:db8::1]:9800", "2001:db8::1", 9800, true, nil),
        ("2001:db8::1", "2001:db8::1", 9800, true, nil),
        ("http://localhost:9800", "localhost", 9800, false, nil),
        ("https://meet.example.com/j/AbC123", "meet.example.com", 443, true, "AbC123"),
        ("openhane://meet.example.com?invite=x1", "meet.example.com", 9800, true, "x1"),
    ])
    func parses(input: String, host: String, port: Int, secure: Bool, invite: String?) throws {
        let a = try ServerAddress.parse(input)
        #expect(a.host == host && a.port == port && a.secure == secure && a.invite == invite)
    }

    @Test func rejectsBadInput() {
        for bad in ["", "host:port", "ftp://x", "host:70000"] {
            #expect(throws: (any Error).self) { try ServerAddress.parse(bad) }
        }
    }

    @Test func urls() throws {
        let a = try ServerAddress.parse("[::1]:9850")
        #expect(a.controlURL.absoluteString == "wss://[::1]:9850/ws")
        #expect(try ServerAddress.parse("http://localhost:9800").mediaURL.absoluteString == "ws://localhost:9800")
        #expect(try ServerAddress.parse("meet.example.com").display == "meet.example.com")
    }
}

@Suite struct TrustEncodingTests {
    @Test func derLength() {
        #expect(TrustStore.derLength(5) == Data([5]))
        #expect(TrustStore.derLength(0x10F) == Data([0x82, 0x01, 0x0F]))
    }
}

@Suite struct ReducerTests {
    private func participant(_ id: String, _ name: String, room: String = "main") -> Participant {
        .with {
            $0.sessionID = id
            $0.nickname = name
            $0.roomID = room
            $0.uid = "u" + id
        }
    }

    @Test func welcomeThenEvents() {
        var s = SessionState()
        let w = Openhane_V1_Welcome.with {
            $0.sessionID = "a"
            $0.uid = "ua"
            $0.nickname = "Alice"
            $0.role = .member
            $0.snapshot = .with {
                $0.info.name = "Srv"
                $0.participants = [participant("a", "Alice")]
                $0.rooms = [.with { $0.id = "main"; $0.kind = .main }]
            }
            $0.autoJoin = .with {
                $0.roomID = "main"
                $0.media.token = "tok"
                $0.policy.audio.maxBitrateBps = 32000
            }
        }
        s.apply(welcome: w, mediaURL: URL(string: "wss://h:9800")!)
        #expect(s.media?.token == "tok" && s.media?.version == 1 && s.media?.url.absoluteString == "wss://h:9800")

        s.apply(event: .with { $0.participantJoined = .with { $0.participant = participant("b", "Bob") } })
        #expect(s.members(of: "main").map(\.nickname) == ["Alice", "Bob"])

        var me = participant("a", "Alice2")
        me.role = .admin
        s.apply(event: .with { $0.participantUpdated = .with { $0.participant = me } })
        #expect(s.me?.nickname == "Alice2" && s.me?.role == .admin)

        s.apply(event: .with { $0.chatMessage = .with { $0.id = 2; $0.roomID = "main"; $0.text = "b" } })
        s.mergeChat(room: "main", [.with { $0.id = 1; $0.roomID = "main"; $0.text = "a" }, .with { $0.id = 2; $0.roomID = "main"; $0.text = "b" }])
        #expect(s.chat["main"]?.map(\.text) == ["a", "b"])

        s.apply(event: .with { $0.policyUpdated = .with { $0.roomID = "main"; $0.policy.audio.maxBitrateBps = 64000 } })
        #expect(s.media?.policy.audio.maxBitrateBps == 64000)

        s.apply(event: .with { $0.participantLeft = .with { $0.sessionID = "b" } })
        #expect(s.members(of: "main").count == 1)
    }

    @Test func backoffGrowsAndCaps() {
        let a = ServerSession.backoff(attempt: 1)
        let b = ServerSession.backoff(attempt: 20)
        #expect(a >= .milliseconds(400) && a <= .milliseconds(600))
        #expect(b <= .seconds(36))
    }
}
