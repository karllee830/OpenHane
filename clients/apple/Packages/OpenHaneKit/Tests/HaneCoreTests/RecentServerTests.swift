import Foundation
@testable import HaneCore
import Testing

@Suite struct RecentServerTests {
    private func defaults() -> UserDefaults {
        let name = "hane-recent-\(UUID().uuidString)"
        let d = UserDefaults(suiteName: name)!
        d.removePersistentDomain(forName: name)
        return d
    }

    @Test func migratesAddressOnlyList() {
        let d = defaults()
        d.set(["a.example.com", "10.0.0.2:9900"], forKey: "recent")
        #expect(RecentServers.load(d) == [RecentServer(address: "a.example.com"), RecentServer(address: "10.0.0.2:9900")])
    }

    @Test func rememberDedupesAndLimits() {
        var list: [RecentServer] = []
        for i in 0 ..< 7 { list = RecentServers.remember(RecentServer(address: "s\(i).example.com", name: "S\(i)"), in: list) }
        #expect(list.map(\.address) == ["s6.example.com", "s5.example.com", "s4.example.com", "s3.example.com", "s2.example.com"])

        list = RecentServers.remember(RecentServer(address: "s3.example.com:9800", name: "S3 新名字", needsPassword: true), in: list)
        #expect(list.count == RecentServers.limit)
        #expect(list.first == RecentServer(address: "s3.example.com:9800", name: "S3 新名字", needsPassword: true))
        #expect(list.filter { $0.name.hasPrefix("S3") }.count == 1)
        #expect(RecentServers.find("s3.example.com", in: list)?.needsPassword == true)
        #expect(RecentServers.find("https://s3.example.com", in: list) == nil) // 443 端口：不是同一台
        #expect(RecentServers.find(" ", in: list) == nil)

        let d = defaults()
        RecentServers.save(list, to: d)
        #expect(RecentServers.load(d) == list)
    }

    @Test func keepsFavoritesNotesAndNicknames() {
        var list = RecentServers.remember(RecentServer(address: "fav.example.com", name: "Fav", nickname: "Karl"), in: [])
        list = RecentServers.update("fav.example.com", in: list) { $0.favorite = true; $0.note = "研发组" }
        // 收藏的不受条数限制，也不占最近连接的名额
        for i in 0 ..< 7 { list = RecentServers.remember(RecentServer(address: "s\(i).example.com"), in: list) }
        #expect(list.count == RecentServers.limit + 1)
        #expect(RecentServers.find("fav.example.com", in: list)?.title == "研发组")

        // 再次连接：更新昵称，保留收藏和备注
        list = RecentServers.remember(RecentServer(address: "fav.example.com", name: "Fav", nickname: "K"), in: list)
        #expect(list.first == RecentServer(address: "fav.example.com", name: "Fav", favorite: true, note: "研发组", nickname: "K"))

        // 取消收藏：重新受条数限制
        list = RecentServers.update("fav.example.com", in: list) { $0.favorite = false; $0.note = "" }
        #expect(list.count == RecentServers.limit)
        #expect(list.first?.title == "Fav")
    }

    @Test func searchesFromAddressBar() {
        let list = [RecentServer(address: "10.0.0.25", nickname: "小李"), RecentServer(address: "meet.example.com", name: "研发组", note: "Dev")]
        let find = { (q: String, nick: String) in list.filter { RecentServers.matches($0, q, defaultNickname: nick) } }
        #expect(find("研发", "").map(\.address) == ["meet.example.com"])
        #expect(find("dev", "").map(\.address) == ["meet.example.com"])
        #expect(find("小李", "").map(\.address) == ["10.0.0.25"])
        #expect(find("karl", "Karl").map(\.address) == ["meet.example.com"])
        // 搜索词：连第一台匹配的；完整地址：连这个地址（即使与列表里的某个地址前缀相同）
        #expect(RecentServers.connectTarget(in: list, matches: find("研发", ""), text: "研发") == "meet.example.com")
        #expect(RecentServers.connectTarget(in: list, matches: find("10.0.0.2", ""), text: "10.0.0.2") == "10.0.0.2")
        #expect(RecentServers.connectTarget(in: list, matches: [], text: "meet.example.com:9800") == "meet.example.com")
        #expect(RecentServers.connectTarget(in: list, matches: [], text: "newhost") == "newhost")
    }

    @Test func decodesOldRecords() throws {
        let old = #"[{"address":"a.example.com","name":"A","needsPassword":true}]"#
        let list = try JSONDecoder().decode([RecentServer].self, from: Data(old.utf8))
        #expect(list == [RecentServer(address: "a.example.com", name: "A", needsPassword: true)])
    }

    @Test func dropsInviteCodes() {
        #expect(RecentServers.withoutInvite("https://meet.example.com/j/abcdEFGH") == "meet.example.com:443")
        #expect(RecentServers.withoutInvite("http://10.0.0.2:9800/j/abcdEFGH") == "http://10.0.0.2:9800")
        #expect(RecentServers.withoutInvite(" meet.example.com ") == "meet.example.com")
        let list = RecentServers.remember(RecentServer(address: "openhane://meet.example.com?invite=xyz12345"), in: [])
        #expect(list.first?.address == "meet.example.com:9800")
    }
}
