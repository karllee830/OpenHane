import Foundation
@testable import HaneCore
import Testing

private struct Refused: Error {}
private struct Fatal: Error {}
private struct TimedOut: Error {}

private final class Discarded: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [String] = []
    func add(_ s: String) { lock.withLock { items.append(s) } }
    var all: [String] { lock.withLock { items } }
}

private func after(_ ms: Int, _ v: String) -> @Sendable () async throws -> String {
    { try await Task.sleep(for: .milliseconds(ms)); return v }
}

private func fail(after ms: Int, _ e: any Error) -> @Sendable () async throws -> String {
    { try await Task.sleep(for: .milliseconds(ms)); throw e }
}

private func run(_ attempts: [@Sendable () async throws -> String], grace: Int = 300, discarded: Discarded = Discarded()) async throws -> String {
    try await firstByPriority(attempts, grace: .milliseconds(grace), decisive: { $0 is Fatal }, discard: { discarded.add($0) })
}

@Suite struct DialTests {
    @Test func prefersFirstWhenBothSucceed() async throws {
        let d = Discarded()
        #expect(try await run([after(100, "a"), after(10, "b")], discarded: d) == "a")
        #expect(d.all == ["b"])
    }

    @Test func fallsBackAfterGraceWhenFirstHangs() async throws {
        let start = ContinuousClock.now
        #expect(try await run([after(10_000, "a"), after(10, "b")]) == "b")
        #expect(ContinuousClock.now - start < .seconds(2)) // 被取消的尝试不拖住返回
    }

    @Test func fallsBackImmediatelyWhenFirstFails() async throws {
        #expect(try await run([fail(after: 5, Refused()), after(10, "b")], grace: 10_000) == "b")
    }

    @Test func stopsAtDecisiveFailure() async throws {
        let d = Discarded()
        await #expect(throws: Fatal.self) { try await run([fail(after: 50, Fatal()), after(5, "b")], discarded: d) }
        #expect(d.all == ["b"])
    }

    @Test func reportsFirstErrorWhenAllFail() async throws {
        await #expect(throws: Refused.self) { _ = try await run([fail(after: 20, Refused()), fail(after: 5, TimedOut())]) }
    }
}
