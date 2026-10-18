import Foundation

/// 测试辅助：编译并启动真实的 Go 服务端（自签名证书、不探测公网 IP）。
/// 设置 HANE_SERVER_BIN 可以复用已编译好的服务端。
final class TestServer: @unchecked Sendable {
    let port: Int
    let adminToken: String
    let fingerprint: String
    private let process: Process
    private let dataDir: URL

    var address: String { "127.0.0.1:\(port)" }

    private static let serverDir = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().appendingPathComponent("../../../../../../server").standardized

    nonisolated(unsafe) private static var binary: String?

    private static func build() throws -> String {
        if let b = ProcessInfo.processInfo.environment["HANE_SERVER_BIN"] { return b }
        if let binary { return binary }
        // 固定位置、每次覆盖，避免临时目录里积累一百多 MB 的二进制（Go 有编译缓存，重新编译很快）
        let out = FileManager.default.temporaryDirectory.appendingPathComponent("hane-swift-server/openhane").path
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        p.arguments = ["go", "build", "-o", out, "./cmd/openhane"]
        p.currentDirectoryURL = serverDir
        try p.run()
        p.waitUntilExit()
        guard p.terminationStatus == 0 else { throw NSError(domain: "TestServer", code: 1, userInfo: [NSLocalizedDescriptionKey: "go build failed"]) }
        binary = out
        return out
    }

    static func freePort() -> Int {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        defer { close(fd) }
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        addr.sin_port = 0
        var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        _ = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, len) } }
        _ = withUnsafeMutablePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &len) } }
        return Int(UInt16(bigEndian: addr.sin_port))
    }

    init(env: [String: String] = [:]) throws {
        let bin = try Self.build()
        port = Self.freePort()
        dataDir = FileManager.default.temporaryDirectory.appendingPathComponent("hane-data-\(UUID().uuidString)")
        let p = Process()
        p.executableURL = URL(fileURLWithPath: bin)
        p.arguments = ["serve"]
        var e = ProcessInfo.processInfo.environment
        e.merge(["HANE_PORT": "\(port)", "HANE_TCP_FALLBACK_PORT": "0", "HANE_TLS_MODE": "self-signed",
                 "HANE_STUN_SERVERS": "off", "HANE_DATA_DIR": dataDir.path], uniquingKeysWith: { $1 })
        e.merge(env, uniquingKeysWith: { $1 })
        p.environment = e
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = pipe
        try p.run()
        process = p
        var output = ""
        let deadline = Date().addingTimeInterval(20)
        var token: String?
        while token == nil, Date() < deadline {
            let chunk = pipe.fileHandleForReading.availableData
            output += String(decoding: chunk, as: UTF8.self)
            token = output.range(of: #"HANE-[0-9A-Z-]{24}"#, options: .regularExpression).map { String(output[$0]) }
        }
        guard let token else { p.terminate(); throw NSError(domain: "TestServer", code: 2, userInfo: [NSLocalizedDescriptionKey: output]) }
        adminToken = token
        fingerprint = output.range(of: #"SHA256:[A-Za-z0-9+/=]+"#, options: .regularExpression).map { String(output[$0]) } ?? ""
        // 继续读走输出，避免管道写满阻塞服务端
        pipe.fileHandleForReading.readabilityHandler = { _ = $0.availableData }
    }

    func stop() {
        process.terminate()
        process.waitUntilExit()
        try? FileManager.default.removeItem(at: dataDir)
    }
}
