import Foundation
import LiveKit
@testable import HaneCore
@testable import HaneMedia
import Testing

/// 端到端加密在真实 SFU 上的密钥交换、帧解密和轮换（成员离开后 2 秒内完成轮换）
@Suite(.serialized) @MainActor struct E2EEIntegrationTests {
    @Test func keyExchangeSafetyCodeAndRotation() async throws {
        try AudioManager.shared.setManualRenderingMode(true)
        let server = try TestServer()
        defer { server.stop() }
        let alice = makeSession(seed: 41, pins: tempPins())
        let bob = makeSession(seed: 42, pins: tempPins())
        let carol = makeSession(seed: 43, pins: tempPins())
        for (s, name) in [(alice, "Alice"), (bob, "Bob"), (carol, "Carol")] {
            try await s.connect(address: server.address, nickname: name)
        }
        #expect(try await alice.redeemToken(server.adminToken) == .admin)
        let am = MediaSession(session: alice)
        let bm = MediaSession(session: bob)
        let cm = MediaSession(session: carol)
        for m in [am, bm, cm] { m.start() }
        try await eventually(20) { [am, bm, cm].allSatisfy { $0.status == .connected } }

        // 加密房间：三人进入，互相拿到密钥，安全码一致
        var overrides = Openhane_V1_RoomOverrides()
        overrides.e2Ee = true
        let room = try await alice.createRoom(name: "机密", options: HaneCore.RoomOptions(overrides: overrides), join: true)
        #expect(room.e2Ee)
        try await bob.joinRoom(room.id)
        try await carol.joinRoom(room.id)
        try await eventually(20) { [am, bm, cm].allSatisfy { $0.liveRoom?.name == room.id && $0.e2ee?.enabled == true } }
        try await eventually(10) { [am, bm, cm].allSatisfy { $0.e2ee?.missing.isEmpty == true && $0.e2ee?.safetyCode != nil } }
        let code = try #require(am.e2ee?.safetyCode)
        #expect(code.count == 8 && code.allSatisfy { (0 ..< 64).contains($0) })
        #expect(bm.e2ee?.safetyCode == code)
        #expect(cm.e2ee?.safetyCode == code)

        // 聊天：服务端转来的是密文，Bob、Carol 解开后显示；图片加密上传，解密后是原来的 PNG，宽高来自加密的正文
        try await alice.sendChat("机密消息")
        try await eventually(5) { [bob, carol].allSatisfy { $0.state.chat[room.id]?.last?.text == "机密消息" } }
        #expect(bob.state.chat[room.id]?.last?.hasEncrypted == true)
        let png = try #require(Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="))
        let imageID = try await alice.uploadChatImage(png, png: true, width: 1, height: 1)
        try await alice.sendChat("", imageID: imageID)
        try await eventually(5) { bob.state.chat[room.id]?.last?.image.id == imageID }
        #expect(bob.state.chat[room.id]?.last?.image.width == 1)
        #expect(try await bob.loadChatImage(room: room.id, id: imageID) == png)

        // 帧确实是加密的，并且能解开：Alice 那里 Bob 的麦克风轨道的解密器状态为 ok
        let bobIdentity = try #require(bm.liveRoom?.localParticipant.identity?.stringValue)
        let decryptsBob = { (m: MediaSession) in m.e2ee?.tracks.values.contains { $0.remote && $0.identity == bobIdentity && $0.state == .ok } == true }
        try await eventually(15) { decryptsBob(am) }
        #expect(am.liveRoom?.remoteParticipants.values.flatMap(\.trackPublications.values).allSatisfy { $0.encryptionType == .gcm } == true)

        // Carol 离开：Alice、Bob 轮换密钥，≤ 2 秒切换到新索引；之后仍能解密
        try await carol.joinRoom("main")
        try await eventually(5) { [am, bm].allSatisfy { $0.e2ee?.lastRotation?.switchedAt != nil } }
        for m in [am, bm] {
            let r = try #require(m.e2ee?.lastRotation)
            let ms = (r.switchedAt! - r.startedAt).components
            print("rotation:", r.index, ms)
            #expect(r.index == 1 && m.e2ee?.keyIndex == 1)
            #expect(ms.seconds < 2)
        }
        try await eventually(5) { am.e2ee?.safetyCode.map { $0 != code } == true && am.e2ee?.safetyCode == bm.e2ee?.safetyCode }
        // 切换后一段时间内没有解密失败
        try await Task.sleep(for: .seconds(1.5))
        #expect(am.e2ee?.tracks.values.contains { $0.remote && $0.state == .decryption_failed } == false)
        #expect(decryptsBob(am))
        // Carol 回到主会议：不再加密
        try await eventually(10) { cm.liveRoom?.name == "main" && cm.e2ee == nil }

        for m in [am, bm, cm] { await m.stop() }
        for s in [alice, bob, carol] { s.disconnect() }
    }
}
