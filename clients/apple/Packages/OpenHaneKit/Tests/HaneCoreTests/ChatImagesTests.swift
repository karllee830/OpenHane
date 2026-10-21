import Foundation
@testable import HaneCore
import Testing

struct ChatImagesTests {
    @Test func validatesIDsAndHeaders() {
        #expect(ChatImages.isImageID("0123456789abcdefghjkmnpqrs"))
        #expect(!ChatImages.isImageID("../../etc/passwd"))
        #expect(!ChatImages.isImageID("0123456789ABCDEFGHJKMNPQRS"))
        #expect(ChatImages.isRoomID("main") && ChatImages.isRoomID("r_abc"))
        #expect(!ChatImages.isRoomID("a/b") && !ChatImages.isRoomID(""))
        #expect(ChatImages.validSize(4096, 82))
        #expect(!ChatImages.validSize(0, 10) && !ChatImages.validSize(10, 100_000))

        var png = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
        png.append(contentsOf: [0, 0, 0x01, 0x00, 0, 0, 0x00, 0x80]) // 256×128
        #expect(ChatImages.sniff(png) == .png)
        var huge = png
        huge.replaceSubrange(16 ..< 20, with: [0, 0, 0x30, 0x00]) // 12288 宽
        #expect(ChatImages.sniff(huge) == nil)
        #expect(ChatImages.sniff(Data([0xFF, 0xD8, 0xFF, 0xE0])) == .jpeg)
        #expect(ChatImages.sniff(Data("<svg/>".utf8)) == nil)
        #expect(ChatImages.sniff(Data("GIF89a".utf8)) == nil)
    }

    @Test func mapsServerErrors() {
        #expect(ChatImageError(rawValue: "storage_full") == .storageFull)
        #expect(ChatImageError(rawValue: "<script>") == nil)
    }
}
