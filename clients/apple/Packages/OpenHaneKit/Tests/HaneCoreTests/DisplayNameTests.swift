@testable import HaneCore
import Testing

/// 与 Web 客户端 core/src/names.test.ts 相同的用例
@Suite struct DisplayNameTests {
    @Test func keepsNormalNames() {
        #expect(DisplayName.clean("  研发组 ") == "研发组")
        #expect(DisplayName.clean("Việt Nam") == "Việt Nam")
        #expect(DisplayName.clean("Cafe\u{301}") == "Caf\u{e9}") // NFC
    }

    @Test func removesInvisibleAndControlCharacters() {
        #expect(DisplayName.clean("a\u{200B}b") == "ab")
        #expect(DisplayName.clean("evil\u{202E}gpj.exe") == "evilgpj.exe")
        #expect(DisplayName.clean("line1\nline2\u{2028}line3\tend") == "line1 line2 line3 end")
        #expect(DisplayName.clean("\u{0}\u{7}") == "")
    }

    @Test func limitsStackedMarksAndLength() {
        #expect(DisplayName.clean("Z" + String(repeating: "\u{300}", count: 50) + "algo").unicodeScalars.count == 1 + 3 + 4)
        let long = DisplayName.clean(String(repeating: "字", count: 10000))
        #expect(long.count == 33 && long.hasSuffix("…"))
    }

    /// 与服务端 identity.TestCleanChatText、Web 客户端 cleanChatText 相同的用例
    @Test func cleansChatText() {
        let cases: [(String, String)] = [
            ("  你好 \n", "你好"),
            ("Cafe\u{301}", "Caf\u{e9}"),
            ("👨\u{200D}👩\u{200D}👧 1\u{FE0F}\u{20E3}", "👨\u{200D}👩\u{200D}👧 1\u{FE0F}\u{20E3}"),
            ("🏴\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}", "🏴\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}"),
            ("evil\u{202E}gpj.exe", "evilgpj.exe"),
            ("a\u{200B}b\u{2066}c\u{2069}", "abc"),
            ("l1\r\nl2\rl3\u{2028}l4\tend", "l1\nl2\nl3\nl4\tend"),
            ("\u{0}a\u{7}", "a"),
            ("Z" + String(repeating: "\u{300}", count: 50) + "algo", "Z\u{300}\u{300}\u{300}algo"),
        ]
        for (input, want) in cases {
            #expect(DisplayName.cleanChat(input).unicodeScalars.elementsEqual(want.unicodeScalars), "\(input.debugDescription)")
        }
        #expect(DisplayName.cleanChat(String(repeating: "字", count: 100_000)).count == DisplayName.maxChatChars)
    }

    @Test func serverTitles() {
        #expect(DisplayName.serverName("OpenHane") == "")
        // 有备注：备注是标题，服务器名称作为灰色小字
        let r = RecentServer(address: "meet.example.com", name: "研发组", note: "公司")
        #expect(r.title == "公司" && r.subtitle == "研发组")
        // 没有备注：服务器名称是标题；默认名称当作没有，显示地址
        #expect(RecentServer(address: "meet.example.com", name: "研发组").title == "研发组")
        #expect(RecentServer(address: "meet.example.com", name: "OpenHane").title == "meet.example.com")
        #expect(RecentServer(address: "meet.example.com", name: "研发组", note: "研发组").subtitle == "")
        // 旧记录里没清洗过的名称，显示时也清洗
        #expect(RecentServer(address: "a", name: "x\u{202E}y").title == "xy")
    }
}
