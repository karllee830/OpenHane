import Foundation
@testable import HaneCore
import Testing

/// 假的服务端：按路径返回不同的内容（包括永远发不完的响应）
private final class StubServer: URLProtocol {
    override class func canInit(with _: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let url = request.url!
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        switch url.path {
        case "/endless":
            // 一直发数据，直到客户端取消
            for _ in 0 ..< 1000 {
                client?.urlProtocol(self, didLoad: Data(count: 16 << 10))
            }
        default:
            client?.urlProtocol(self, didLoad: Data(#"{"online":3}"#.utf8))
        }
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

@Suite struct ServerProbeTests {
    private func pngHeader(_ w: UInt32, _ h: UInt32) -> Data {
        var d = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
        for v in [w, h] { withUnsafeBytes(of: v.bigEndian) { d.append(contentsOf: $0) } }
        return d + Data(count: 9)
    }

    @Test func acceptsOnlySanePNGs() {
        #expect(ServerProbe.isSafePNG(pngHeader(512, 512)))
        #expect(ServerProbe.isSafePNG(pngHeader(1024, 1024)))
        #expect(!ServerProbe.isSafePNG(pngHeader(50000, 50000))) // 解压炸弹
        #expect(!ServerProbe.isSafePNG(pngHeader(0, 512)))
        #expect(!ServerProbe.isSafePNG(Data([0xFF, 0xD8, 0xFF, 0xE0]) + Data(count: 30))) // JPEG
        #expect(!ServerProbe.isSafePNG(Data(#"<svg xmlns="http://www.w3.org/2000/svg"/>"#.utf8)))
    }

    @Test func buildsLogoURLOnlyFromHexDigest() {
        let info = URL(string: "https://meet.example.com:9800/api/v1/info")!
        #expect(ServerProbe.logoURL("16b8097ffe033265", relativeTo: info)?.absoluteString == "https://meet.example.com:9800/api/v1/logo?v=16b8097ffe033265")
        for bad in ["", "//evil.example.com/x", "../../etc", "abc", "ABCDEF0123456789", "16b8097ffe03326#"] {
            #expect(ServerProbe.logoURL(bad, relativeTo: info) == nil)
        }
        #expect(ServerProbe.logoURL(nil, relativeTo: info) == nil)
    }

    @Test func stopsReadingAtTheLimit() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubServer.self]
        let session = URLSession(configuration: config)
        defer { session.invalidateAndCancel() }
        await #expect(throws: URLError.self) {
            _ = try await ServerProbe.readLimited(URL(string: "https://evil.example.com/endless")!, session, limit: 64 << 10)
        }
        let ok = try await ServerProbe.readLimited(URL(string: "https://ok.example.com/api/v1/info")!, session, limit: 64 << 10)
        #expect(String(decoding: ok, as: UTF8.self) == #"{"online":3}"#)
    }
}
