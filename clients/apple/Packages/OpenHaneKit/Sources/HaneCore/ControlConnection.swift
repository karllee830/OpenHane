import Foundation
import SwiftProtobuf

/// 一条控制协议 WebSocket 连接（URLSession，证书按 TOFU 校验）。只负责帧的收发，不含业务状态。
final class ControlConnection: NSObject, URLSessionWebSocketDelegate, @unchecked Sendable {
    private var session: URLSession!
    private var task: URLSessionWebSocketTask!
    private let trust: TrustStore
    private let hostPort: String
    private let opened = AsyncStream<Result<Void, Error>>.makeStream()
    /// 本次连接中因指纹不一致而拒绝的证书
    private var rejected: TrustStore.Mismatch?

    init(url: URL, hostPort: String, trust: TrustStore) {
        self.trust = trust
        self.hostPort = hostPort
        super.init()
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 10
        session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
        task = session.webSocketTask(with: url, protocols: ["hane.v1"])
        task.maximumMessageSize = 1 << 20
    }

    /// 建立连接（TLS 握手 + WebSocket 升级）
    func open() async throws {
        task.resume()
        for await result in opened.stream {
            try result.get()
            return
        }
        throw HaneError.connectionLost
    }

    func send(_ env: Openhane_V1_Envelope) async throws {
        try await task.send(.data(env.serializedData()))
    }

    func receive() async throws -> Openhane_V1_Envelope {
        while true {
            switch try await task.receive() {
            case let .data(d): return try Openhane_V1_Envelope(serializedBytes: d)
            case .string: continue // 忽略文本帧
            @unknown default: continue
            }
        }
    }

    /// leaving 为 true 表示用户主动离开：以「正常关闭」断开，服务端立即移除会话；
    /// 否则（心跳超时、网络切换）以「离开」状态断开，服务端保留会话，可在宽限期内恢复。
    func close(leaving: Bool = false) {
        task.cancel(with: leaving ? .normalClosure : .goingAway, reason: nil)
        session.invalidateAndCancel()
        opened.continuation.finish()
    }

    // MARK: URLSession 回调

    func urlSession(_: URLSession, webSocketTask _: URLSessionWebSocketTask, didOpenWithProtocol _: String?) {
        opened.continuation.yield(.success(()))
    }

    func urlSession(_: URLSession, task _: URLSessionTask, didCompleteWithError error: Error?) {
        if let mismatch = rejected {
            opened.continuation.yield(.failure(HaneError.fingerprintChanged(mismatch)))
        } else {
            opened.continuation.yield(.failure(HaneError.unreachable(error?.localizedDescription ?? "closed")))
        }
        opened.continuation.finish()
    }

    func urlSession(_: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void)
    {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let serverTrust = challenge.protectionSpace.serverTrust
        else {
            completionHandler(.performDefaultHandling, nil)
            return
        }
        if trust.evaluate(serverTrust, hostPort: hostPort) {
            completionHandler(.useCredential, URLCredential(trust: serverTrust))
        } else {
            rejected = trust.mismatch(hostPort: hostPort)
            completionHandler(.cancelAuthenticationChallenge, nil)
        }
    }
}
