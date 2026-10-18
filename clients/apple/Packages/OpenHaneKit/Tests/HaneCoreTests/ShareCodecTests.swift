@testable import HaneCore
import XCTest

/// 与 Web 版 codec.test.ts 相同的用例
final class ShareCodecTests: XCTestCase {
    // 带 AV1 硬件编码器的 PC、Apple 芯片的 Mac（Chrome：没有 AV1 硬件，1440p 的 H.264 不是能效高的实现）、只有软件编码的机器
    let av1Pc = EncodeCaps(codecs: [(.av1, true), (.h265, true), (.h264, true)])
    let mac = EncodeCaps(codecs: [(.av1, false), (.h265, true), (.h264, false)])
    let softOnly = EncodeCaps(codecs: [(.av1, false), (.h264, false)])
    let all = ["video/av1", "video/h264", "video/h265", "video/vp8", "video/vp9"]

    func pick(_ caps: EncodeCaps, decodable: [String]? = nil, policy: CodecPolicy = .auto, e2ee: Bool = false,
              prefer: ShareCodec? = nil) -> CodecChoice?
    {
        chooseShareCodec(caps: caps, roomDecodable: decodable ?? all, policy: policy, e2ee: e2ee, prefer: prefer)
    }

    func testPrefersHardwareAV1ThenH265ThenH264WithH264Backup() {
        XCTAssertEqual(pick(av1Pc), CodecChoice(codec: .av1, backup: .h264))
        XCTAssertEqual(pick(mac), CodecChoice(codec: .h265, backup: .h264))
        XCTAssertEqual(pick(EncodeCaps(codecs: [(.h265, false), (.h264, true)])), CodecChoice(codec: .h264, backup: nil))
    }

    func testNeverUsesSoftwareAV1OrH265() {
        XCTAssertEqual(pick(softOnly), CodecChoice(codec: .h264, backup: nil))
        XCTAssertEqual(pick(EncodeCaps(codecs: [(.av1, false), (.h265, false), (.h264, false)])), CodecChoice(codec: .h264, backup: nil))
    }

    func testRespectsWhatTheRoomCanDecode() {
        XCTAssertEqual(pick(av1Pc, decodable: ["video/h264", "video/h265", "video/vp8"])?.codec, .h265)
        XCTAssertEqual(pick(mac, decodable: ["video/av1", "video/h264", "video/vp8"]), CodecChoice(codec: .h264, backup: nil))
        // 有人连 H.264 都解不了：仍发 H.264（这个人看不到），不改用软件 VP8
        XCTAssertEqual(pick(mac, decodable: ["video/vp8"]), CodecChoice(codec: .h264, backup: nil))
    }

    func testNeverPicksAV1InE2EERooms() {
        XCTAssertEqual(pick(av1Pc, e2ee: true)?.codec, .h265)
        XCTAssertEqual(pick(mac, e2ee: true)?.codec, .h265)
    }

    func testCompatPolicyIsH264Only() {
        XCTAssertEqual(pick(av1Pc, policy: .compat), CodecChoice(codec: .h264, backup: nil))
        XCTAssertEqual(pick(mac, policy: .compat), CodecChoice(codec: .h264, backup: nil))
    }

    func testCannotShareWithoutAnyUsableEncoder() {
        XCTAssertNil(pick(EncodeCaps(codecs: [(.av1, false)])))
        XCTAssertNil(pick(EncodeCaps(codecs: [(.av1, true)]), e2ee: true))
    }

    func testCustomOnlyHardwareCodecsAreSelectable() {
        XCTAssertEqual(selectableShareCodecs(caps: av1Pc, policy: .auto, e2ee: false), [.av1, .h265, .h264])
        XCTAssertEqual(selectableShareCodecs(caps: mac, policy: .auto, e2ee: false), [.h265])
        XCTAssertEqual(selectableShareCodecs(caps: softOnly, policy: .auto, e2ee: false), [])
        XCTAssertEqual(selectableShareCodecs(caps: av1Pc, policy: .auto, e2ee: true), [.h265, .h264])
        XCTAssertEqual(selectableShareCodecs(caps: av1Pc, policy: .compat, e2ee: false), [])
    }

    func testCustomChosenHardwareCodecWins() {
        XCTAssertEqual(pick(av1Pc, prefer: .h264), CodecChoice(codec: .h264, backup: nil))
        XCTAssertEqual(pick(av1Pc, decodable: ["video/h264", "video/vp8"], prefer: .h265), CodecChoice(codec: .h265, backup: .h264))
        XCTAssertEqual(pick(mac, prefer: .h265), CodecChoice(codec: .h265, backup: .h264))
    }

    func testCustomUnavailableChoiceFallsBackToAutomatic() {
        XCTAssertEqual(pick(mac, prefer: .av1), CodecChoice(codec: .h265, backup: .h264)) // 没有 AV1 硬件
        XCTAssertEqual(pick(mac, prefer: .h264), CodecChoice(codec: .h265, backup: .h264)) // H.264 只有软件
        XCTAssertEqual(pick(av1Pc, e2ee: true, prefer: .av1)?.codec, .h265)
        XCTAssertEqual(pick(av1Pc, policy: .compat, prefer: .h265), CodecChoice(codec: .h264, backup: nil))
    }

    func testDecodeGapListsPeopleWithoutHardwareDecode() {
        func p(_ name: String, _ hw: [String], _ sw: [String]) -> Openhane_V1_Participant {
            .with { $0.nickname = name; $0.decodeHardware = hw.map { "video/\($0)" }; $0.decodeSoftware = sw.map { "video/\($0)" } }
        }
        let mac = p("Mac", ["h264", "h265"], ["vp8", "vp9", "av1"])
        let firefox = p("Firefox", [], ["av1", "h264", "vp8", "vp9"])
        let old = p("Old", [], []) // 旧版本客户端：没有上报，不计入
        XCTAssertTrue(decodeGap(codec: .h265, others: [mac, old]).isEmpty)
        XCTAssertEqual(decodeGap(codec: .av1, others: [mac, old]), DecodeGap(unsupported: [], softwareOnly: ["Mac"]))
        XCTAssertEqual(decodeGap(codec: .h265, others: [mac, firefox]), DecodeGap(unsupported: ["Firefox"], softwareOnly: []))
        XCTAssertEqual(decodeGap(codec: .h264, others: [mac, firefox]), DecodeGap(unsupported: [], softwareOnly: ["Firefox"]))
    }
}
