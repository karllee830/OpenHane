import Foundation
@testable import HaneCore
import SwiftProtobuf
import Testing

/// 协议一致性：proto/testdata/conformance/ 中由 Go 生成的样例，Swift 必须解码出与规范 JSON 相同的内容，
/// 重新编码后再解码仍然相同；带未知字段的消息（模拟新版本服务端）必须照常解码。
@Suite struct ConformanceTests {
    static let dir = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().appendingPathComponent("../../../../../../proto/testdata/conformance").standardized

    static var names: [String] {
        (try? JSONDecoder().decode([String].self, from: Data(contentsOf: dir.appendingPathComponent("index.json")))) ?? []
    }

    private func object(_ json: Data) throws -> NSDictionary {
        try #require(try JSONSerialization.jsonObject(with: json) as? NSDictionary)
    }

    @Test func hasSamples() { #expect(Self.names.count > 20) }

    @Test(arguments: names)
    func sample(name: String) throws {
        let bin = try Data(contentsOf: Self.dir.appendingPathComponent("\(name).bin"))
        let want = try object(Data(contentsOf: Self.dir.appendingPathComponent("\(name).json")))
        let msg = try Openhane_V1_Envelope(serializedBytes: bin)
        #expect(try object(msg.jsonUTF8Data()) == want)
        let again = try Openhane_V1_Envelope(serializedBytes: msg.serializedData())
        #expect(try object(again.jsonUTF8Data()) == want)
    }
}
