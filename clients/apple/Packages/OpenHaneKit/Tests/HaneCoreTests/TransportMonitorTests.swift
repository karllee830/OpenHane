@testable import HaneCore
import XCTest

/// 与 Web 版 transport.test.ts 相同的用例
final class TransportMonitorTests: XCTestCase {
    let good = TransportSample(protocol: .udp, rttMs: 25, lossUp: 0, lossDown: 0, packetsDown: 500)

    func run(_ m: TransportMonitor, _ samples: [TransportSample], from: Double = 6000) -> [Bool] {
        samples.enumerated().map { i, s in m.update(now: from + Double(i) * 2000, s) }
    }

    func with(_ f: (inout TransportSample) -> Void) -> TransportSample {
        var s = good
        f(&s)
        return s
    }

    func testSwitchesAfterSustainedUDPLossOnlyOnce() {
        let m = TransportMonitor(mode: .auto, startedAt: 0)
        _ = run(m, [good], from: 0)
        let lossy = with { $0.lossUp = 0.12 }
        XCTAssertEqual(run(m, [lossy, lossy, good, lossy]), [false, false, false, false])
        XCTAssertTrue(m.update(now: 20000, lossy))
        XCTAssertEqual(m.reason, .loss)
        XCTAssertFalse(m.update(now: 22000, lossy))
    }

    func testCountsDownloadLossOnlyWithEnoughPackets() {
        let m = TransportMonitor(mode: .auto, startedAt: 0)
        let few = with { $0.lossDown = 0.5; $0.packetsDown = 10 }
        XCTAssertFalse(run(m, Array(repeating: few, count: 5)).contains(true))
        let down = with { $0.lossDown = 0.08; $0.packetsDown = 300 }
        XCTAssertEqual(run(m, Array(repeating: down, count: 4), from: 20000).last, true)
    }

    func testSwitchesWhenRoundTripTimeBalloons() {
        let m = TransportMonitor(mode: .auto, startedAt: 0)
        _ = run(m, [good, good], from: 0)
        XCTAssertEqual(run(m, Array(repeating: with { $0.rttMs = 900 }, count: 4)).last, true)
        XCTAssertEqual(m.reason, .rtt)
        // 本来就远的服务器（基线 280 ms，偶尔 400 ms）不算
        let far = TransportMonitor(mode: .auto, startedAt: 0)
        _ = run(far, [with { $0.rttMs = 280 }], from: 0)
        XCTAssertFalse(run(far, Array(repeating: with { $0.rttMs = 400 }, count: 6)).contains(true))
    }

    func testIgnoresWarmUpTCPAndOffMode() {
        let lossy = with { $0.lossUp = 0.3 }
        XCTAssertFalse(run(TransportMonitor(mode: .auto, startedAt: 0), Array(repeating: lossy, count: 3), from: 0).contains(true))
        var tcp = lossy
        tcp.protocol = .tcp
        XCTAssertFalse(run(TransportMonitor(mode: .auto, startedAt: 0), Array(repeating: tcp, count: 6)).contains(true))
        XCTAssertFalse(run(TransportMonitor(mode: .off, startedAt: 0), Array(repeating: lossy, count: 6)).contains(true))
    }

    func testAlwaysModeSwitchesAsSoonAsItSeesUDP() {
        let m = TransportMonitor(mode: .always, startedAt: 0)
        XCTAssertFalse(m.update(now: 0, with { $0.protocol = nil }))
        XCTAssertTrue(m.update(now: 500, good))
        XCTAssertEqual(m.reason, .always)
    }
}
