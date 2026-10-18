import Foundation
import LiveKit
@testable import HaneCore
@testable import HaneMedia
import Testing

/// 房间切换（先连后断）、主持操作在真实 SFU 上的效果
@Suite(.serialized) @MainActor struct RoomTests {
    @Test func switchRoomsModerateMoveAndClose() async throws {
        try AudioManager.shared.setManualRenderingMode(true)
        let server = try TestServer()
        defer { server.stop() }
        let alice = makeSession(seed: 31, pins: tempPins())
        let bob = makeSession(seed: 32, pins: tempPins())
        try await alice.connect(address: server.address, nickname: "Alice")
        try await bob.connect(address: server.address, nickname: "Bob")
        #expect(try await alice.redeemToken(server.adminToken) == .admin)
        let am = MediaSession(session: alice)
        let bm = MediaSession(session: bob)
        am.start()
        bm.start()
        try await eventually(20) { am.status == .connected && bm.status == .connected }
        try await eventually(10) { bm.liveRoom?.localParticipant.audioTracks.isEmpty == false }

        // 建房并进入：先连后断，切换 ≤ 1 秒
        let room = try await alice.createRoom(name: "设计评审", options: RoomOptions(password: "pw"), join: true)
        try await eventually(10) { am.lastSwitch != nil }
        let sw = try #require(am.lastSwitch)
        print("room switch:", sw)
        // 目标 ≤ 1 秒；CI 的共享虚拟机较慢、且几个测试套件并行，放宽到 3 秒，只防止明显退化
        #expect(sw.totalMs < (ProcessInfo.processInfo.environment["CI"] != nil ? 3000 : 1000))
        #expect(am.liveRoom?.name == room.id)
        #expect(am.liveRoom?.localParticipant.audioTracks.isEmpty == false)

        // 密码
        await #expect(throws: HaneError.self) { try await bob.joinRoom(room.id, password: "wrong") }
        try await bob.joinRoom(room.id, password: "pw")
        try await eventually(10) { bm.liveRoom?.name == room.id && bm.lastSwitch != nil }
        let bobID = bob.state.me!.sessionID
        try await eventually(10) { alice.state.participants[bobID]?.mediaConnected == true }

        // 强制静音：SFU 取消发布 Bob 的麦克风；解除后麦克风自动重新发布
        try await alice.moderate(bobID, .forceMute)
        try await eventually(10) { bm.liveRoom?.localParticipant.audioTracks.isEmpty == true }
        try await alice.moderate(bobID, .unmute)
        try await eventually(10) { bm.liveRoom?.localParticipant.audioTracks.isEmpty == false }

        // 移动 Bob 回主会议：Bob 凭事件附带的令牌直接切换媒体
        try await alice.moveParticipant(bobID, to: "main")
        try await eventually(10) { bob.state.media?.roomID == "main" && bm.liveRoom?.name == "main" }

        // 关闭房间：Alice 回到主会议，房间从列表消失
        try await alice.closeRoom(room.id)
        try await eventually(10) { am.liveRoom?.name == "main" && alice.state.rooms[room.id] == nil && bob.state.rooms[room.id] == nil }

        await am.stop()
        await bm.stop()
        alice.disconnect()
        bob.disconnect()
    }
}
