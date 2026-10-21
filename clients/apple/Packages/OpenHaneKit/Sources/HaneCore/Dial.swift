import Foundation

private enum Outcome<T: Sendable> {
    case pending, ok(T), failed(any Error), decisive(any Error)

    var decided: Bool {
        switch self {
        case .ok, .decisive: return true
        default: return false
        }
    }
}

private enum DialEvent<T: Sendable>: Sendable {
    case done(Int, Result<T, any Error>)
    case graceOver
}

/// 同时开始所有尝试，返回排在最前面的结果（规则同 Web 客户端 core/dial.ts）：
/// - 排在前面的还没有结果时，后面的成功了也再等 grace，期间前面的成功就用前面的；
/// - decisive(e) 为真的失败（如证书指纹变化）和成功一样算作结果，不再往后找；
/// - 全部普通失败时抛出第一个候选的错误。
/// 选定后取消其余尝试；没被选中的成功结果交给 discard 释放。
func firstByPriority<T: Sendable>(_ attempts: [@Sendable () async throws -> T], grace: Duration,
                                  decisive: @escaping @Sendable (any Error) -> Bool,
                                  discard: @escaping @Sendable (T) -> Void) async throws -> T
{
    precondition(!attempts.isEmpty)
    let result = await withTaskGroup(of: DialEvent<T>.self) { group -> Result<T, any Error> in
        for (i, attempt) in attempts.enumerated() {
            group.addTask {
                do { return .done(i, .success(try await attempt())) } catch { return .done(i, .failure(error)) }
            }
        }
        var outcomes = [Outcome<T>](repeating: .pending, count: attempts.count)
        var graceStarted = false
        var chosen: Int?
        while chosen == nil, let ev = await group.next() {
            switch ev {
            case let .done(i, .success(v)):
                outcomes[i] = .ok(v)
            case let .done(i, .failure(e)):
                outcomes[i] = decisive(e) ? .decisive(e) : .failed(e)
            case .graceOver:
                // 宽限期结束：跳过还没结果的，取第一个已有结果的
                chosen = outcomes.firstIndex { $0.decided }
                continue
            }
            guard let i = outcomes.firstIndex(where: { if case .failed = $0 { return false } else { return true } }) else {
                chosen = 0
                break
            }
            if case .pending = outcomes[i] {
                if !graceStarted, outcomes[(i + 1)...].contains(where: { $0.decided }) {
                    graceStarted = true
                    group.addTask {
                        try? await Task.sleep(for: grace)
                        return .graceOver
                    }
                }
            } else {
                chosen = i
            }
        }
        group.cancelAll()
        while let ev = await group.next() {
            if case let .done(_, .success(v)) = ev { discard(v) }
        }
        for (j, o) in outcomes.enumerated() where j != chosen {
            if case let .ok(v) = o { discard(v) }
        }
        switch outcomes[chosen!] {
        case let .ok(v): return .success(v)
        case let .failed(e), let .decisive(e): return .failure(e)
        case .pending: preconditionFailure("unreachable")
        }
    }
    return try result.get()
}
