import Foundation
@_exported import HaneProtocol

/// 连接或请求错误：协议错误（服务端拒绝）或本地错误。
public enum HaneError: Error, Equatable, Sendable {
    case server(Openhane_V1_ErrorCode, message: String, detail: Openhane_V1_Error?)
    case unreachable(String)
    case connectionLost
    case timeout
    case protocolViolation(String)
    case fingerprintChanged(TrustStore.Mismatch)

    static func from(_ e: Openhane_V1_Error) -> HaneError {
        .server(e.code, message: e.message, detail: e)
    }

    public var code: Openhane_V1_ErrorCode? {
        if case let .server(code, _, _) = self { return code }
        return nil
    }

    /// 这些错误不应自动重连：重试只会得到同样的结果。
    public var isFatal: Bool {
        switch self {
        case .fingerprintChanged: return true
        case let .server(code, _, _):
            return [.protocolVersionUnsupported, .authFailed, .tlsMitmSuspected, .banned, .passwordRequired,
                    .passwordInvalid, .securityLevelTooLow, .nicknameInvalid, .kicked, .sessionReplaced].contains(code)
        default: return false
        }
    }
}
