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

    @Test func dropsInviteCodes() {
        #expect(RecentServers.withoutInvite("https://meet.example.com/j/abcdEFGH") == "meet.example.com:443")
        #expect(RecentServers.withoutInvite("http://10.0.0.2:9800/j/abcdEFGH") == "http://10.0.0.2:9800")
        #expect(RecentServers.withoutInvite(" meet.example.com ") == "meet.example.com")
        let list = RecentServers.remember(RecentServer(address: "openhane://meet.example.com?invite=xyz12345"), in: [])
        #expect(list.first?.address == "meet.example.com:9800")
    }
}
