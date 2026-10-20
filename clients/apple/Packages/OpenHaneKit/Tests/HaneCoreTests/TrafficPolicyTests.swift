import Foundation
@testable import HaneCore
import Testing

/// 与 Web 版 packages/media/src/traffic.test.ts 共用的测试向量（testdata/traffic/vectors.json）
@Suite struct TrafficPolicyTests {
    struct Vector: Decodable {
        let name: String
        let samples: [TrafficSample]
        let expected: [TrafficState]
    }

    static let vectors: [Vector] = {
        struct File: Decodable { let vectors: [Vector] }
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../../../../../testdata/traffic/vectors.json").standardizedFileURL
        return try! JSONDecoder().decode(File.self, from: Data(contentsOf: url)).vectors
    }()

    @Test(arguments: vectors.map(\.name)) func matchesSharedVectors(_ name: String) {
        let v = Self.vectors.first { $0.name == name }!
        var p = TrafficPolicy()
        let got = v.samples.map { p.update($0) }
        #expect(got == v.expected)
    }

    @MainActor @Test func pacerLetsBytesThroughAtTheRate() async throws {
        var t = 0.0
        let p = TrafficPacer(now: { t })
        p.set(up: 100_000, down: 100_000)
        // 起始时能攒半秒的量
        try await p.wait(.up, bytes: 50000)
        let waiting = Task { try await p.wait(.up, bytes: 50000) }
        t += 500 // 半秒后又攒够了
        try await waiting.value
        #expect(p.takeActivity() == (true, false))
        #expect(p.takeActivity() == (false, false))
        #expect(p.chunkBytes(.up) == 50000)
        p.set(up: 1000, down: 1000)
        #expect(p.chunkBytes(.down) == 16 << 10)
    }

    /// 与 Web 版 sampleTraffic 的下行部分相同的用例
    @Test func countersFillTheDownlinkPart() {
        var prev = TrafficCounters()
        var s = TrafficSample(t: 0)
        var c = TrafficCounters()
        c.received = 100
        c.jitterDelay = 2
        c.jitterEmitted = 100
        prev.fill(&s, now: c)
        c.lost = 5
        c.received = 195
        c.jitterDelay = 6
        c.jitterEmitted = 200
        c.freezes = 2
        prev.fill(&s, now: c)
        #expect(s.downLoss == 0.05 && s.downPackets == 95 && s.jitterBufferMs == 40 && s.freezes == 2)
        // 轨道换了（累计值变小）：这一次没有下行数据
        var small = TrafficCounters()
        small.received = 10
        small.jitterDelay = 0.1
        small.jitterEmitted = 10
        prev.fill(&s, now: small)
        #expect(s.downLoss == nil && s.downPackets == 0 && s.jitterBufferMs == nil && s.freezes == 0)
    }
}
