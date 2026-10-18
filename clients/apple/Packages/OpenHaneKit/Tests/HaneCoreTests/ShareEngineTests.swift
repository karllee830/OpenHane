// 用共享测试向量检验 Swift 版引擎（与 Web 版 engine.test.ts 相同的向量）
import Foundation
import Testing
@testable import HaneCore

private struct VectorFile: Decodable { let vectors: [Vector] }
private struct Vector: Decodable {
    let name: String
    let intent: String
    let custom: CustomShare?
    let codec: String
    let caps: Caps
    let source: Source
    let samples: [Sample]
    let expect: [[String: JSONValue]]
    struct Caps: Decodable { let maxHeight: Int, maxFps: Int, maxKbps: Int }
    struct Source: Decodable { let width: Int, height: Int }
    struct Sample: Decodable {
        let t: Double, changedAreaRatio: Double, changeFps: Double, uplinkKbps: Double
        let qualityLimitation: String, thermal: String
        let rttMs: Double?, sentKbps: Double?
    }
}

private enum JSONValue: Decodable, CustomStringConvertible {
    case number(Double), string(String)
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let d = try? c.decode(Double.self) { self = .number(d) } else { self = .string(try c.decode(String.self)) }
    }
    var description: String { switch self { case let .number(d): "\(d)"; case let .string(s): s } }
}

private func loadVectors() throws -> [Vector] {
    // 仓库根目录的 testdata/share-engine/vectors.json（与 Web 版共用）
    let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        .appendingPathComponent("../../../../../../testdata/share-engine/vectors.json").standardized
    return try JSONDecoder().decode(VectorFile.self, from: Data(contentsOf: url)).vectors
}

@Test("共享测试向量", arguments: try loadVectors().map(\.name))
func vector(name: String) throws {
    let v = try #require(try loadVectors().first { $0.name == name })
    let engine = ScreenShareEngine(intent: EngineIntent(rawValue: v.intent)!,
                                   caps: ShareCaps(maxHeight: v.caps.maxHeight, maxFps: v.caps.maxFps, maxKbps: v.caps.maxKbps),
                                   source: SourceSize(width: v.source.width, height: v.source.height),
                                   codec: ShareCodec(rawValue: v.codec)!, custom: v.custom)
    var outputs: [Double: ShareParams] = [:]
    for s in v.samples {
        outputs[s.t] = engine.update(ShareSignals(t: s.t, changedAreaRatio: s.changedAreaRatio, changeFps: s.changeFps,
                                                  uplinkKbps: s.uplinkKbps,
                                                  qualityLimitation: ShareLimitation(rawValue: s.qualityLimitation)!,
                                                  thermal: ShareThermal(rawValue: s.thermal)!,
                                                  rttMs: s.rttMs, sentKbps: s.sentKbps))
    }
    for e in v.expect {
        guard case let .number(t)? = e["t"] else { Issue.record("expectation without t"); continue }
        let got = try #require(outputs[t], "no output at t=\(t)")
        for (key, want) in e where key != "t" {
            let actual: String = switch key {
            case "mode": got.mode.rawValue
            case "level": "\(Double(got.level))"
            case "height": "\(Double(got.height))"
            case "width": "\(Double(got.width))"
            case "fps": "\(Double(got.fps))"
            case "maxKbps": "\(Double(got.maxKbps))"
            case "degradationPreference": got.degradationPreference
            default: "?"
            }
            #expect(actual == want.description, "t=\(t) \(key): got \(actual), want \(want)")
        }
    }
}
