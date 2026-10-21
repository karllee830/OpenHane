import CryptoKit
import Foundation
import HaneCore
import ImageIO
import SwiftUI
import UniformTypeIdentifiers

/// 服务器图标的本地缓存：缓存目录里每台服务器一个文件，偏好设置里记下对应的图标地址（服务器换了图标，地址就变）。
/// 下次打开服务器列表时先显示缓存的图标，不必等探测完。
enum ServerLogoCache {
    private static let urlsKey = "serverLogoURLs"

    private static var dir: URL {
        // macOS 版不在沙盒里，缓存目录是所有应用共用的，要放进以应用标识命名的子目录
        let d = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent(Bundle.main.bundleIdentifier ?? "com.0http.openhane")
            .appendingPathComponent("ServerLogos")
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }

    private static func file(_ address: String) -> URL {
        let digest = SHA256.hash(data: Data(address.lowercased().utf8)).prefix(8).map { String(format: "%02x", $0) }.joined()
        return dir.appendingPathComponent(digest)
    }

    private static var urls: [String: String] {
        get { UserDefaults.standard.dictionary(forKey: urlsKey) as? [String: String] ?? [:] }
        set { UserDefaults.standard.set(newValue, forKey: urlsKey) }
    }

    static func data(for address: String) -> Data? { try? Data(contentsOf: file(address)) }

    /// 缓存的图标对应的地址：与探测到的地址相同就不必重新下载
    static func url(for address: String) -> String? { urls[address] }

    static func save(_ data: Data, url: URL, for address: String) {
        try? data.write(to: file(address), options: .atomic)
        urls[address] = url.absoluteString
    }

    static func remove(_ address: String) {
        try? FileManager.default.removeItem(at: file(address))
        urls[address] = nil
    }
}

extension AppModel {
    /// 探测到服务器的状态后更新列表记录：服务器名称；换了图标就重新下载，服务器去掉了图标就删掉缓存（连不上时保留）
    func updateFromProbe(_ address: String, status: ServerStatus) async {
        guard status.latencyMs != nil else { return }
        // 顺带记下最新的服务器名称（服务器改名后列表跟着变）
        if let r = recentServer(for: address), r.name != status.name {
            recentServers = RecentServers.update(r.address, in: recentServers) { $0.name = status.name }
        }
        guard let url = status.logo else {
            if serverLogos[address] != nil || ServerLogoCache.url(for: address) != nil {
                ServerLogoCache.remove(address)
                serverLogos[address] = nil
            }
            return
        }
        guard ServerLogoCache.url(for: address) != url.absoluteString || serverLogos[address] == nil else { return }
        guard let data = await ServerProbe.logo(url, trust: session.trust), decodeLogo(data) != nil else { return }
        ServerLogoCache.save(data, url: url, for: address)
        serverLogos[address] = data
    }

    /// 会议页左上角的名称：有备注时显示备注，否则显示服务器名称，都没有时显示地址
    var meetingTitle: String {
        guard let a = session.address else { return session.state.serverInfo.name }
        let r = recentServer(for: (a.secure ? "" : "http://") + a.hostPort)
        let note = r?.note.trimmingCharacters(in: .whitespaces) ?? ""
        let name = DisplayName.serverName(session.state.serverInfo.name)
        return !note.isEmpty ? note : !name.isEmpty ? name : a.display
    }

    /// 正在连接的服务器的图标（会议页显示）
    var currentServerLogo: Data? {
        guard let a = session.address else { return nil }
        guard let r = recentServer(for: (a.secure ? "" : "http://") + a.hostPort) else { return nil }
        return serverLogos[r.address]
    }
}

/// 解码服务器图标：服务端给的数据不可信，只按 PNG 解码（不让系统自动识别其他格式），
/// 解码前再检查一次文件头和尺寸（本地缓存的文件也可能被改过）
func decodeLogo(_ data: Data) -> CGImage? {
    guard data.count <= ServerProbe.logoMaxBytes, ServerProbe.isSafePNG(data) else { return nil }
    let options = [kCGImageSourceTypeIdentifierHint: UTType.png.identifier, kCGImageSourceShouldCache: false] as CFDictionary
    guard let source = CGImageSourceCreateWithData(data as CFData, options),
          CGImageSourceGetType(source) as String? == UTType.png.identifier, CGImageSourceGetCount(source) == 1
    else { return nil }
    return CGImageSourceCreateImageAtIndex(source, 0, options)
}

/// 服务器图标：按给定大小裁成圆角方形。服务端给的是 512 以内的图，缩到几十个点用高质量插值，细线条不会出锯齿
struct ServerLogoImage: View {
    let data: Data
    var size: CGFloat

    var body: some View {
        if let image = decodeLogo(data) {
            Image(decorative: image, scale: 1)
                .resizable()
                .interpolation(.high)
                .scaledToFill()
                .frame(width: size, height: size)
                .clipShape(RoundedRectangle(cornerRadius: size * 0.26, style: .continuous))
        }
    }
}
