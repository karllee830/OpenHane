import Foundation

/// 显示名的清洗：服务端（以及经服务端转来的）名称一律不信任，显示前按与服务端相同的规则处理
/// （见 server/internal/identity 的 NormalizeDisplayName，与 Web 客户端 core/src/names.ts 一致）。
/// 这里不拒绝，而是去掉不合规的部分、过长时截断。
public enum DisplayName {
    /// 名称最多显示多少个字符（服务端的上限）
    public static let maxChars = 32
    /// 连续的组合字符（声调符号等）最多保留几个：再多就是把字往上下堆出界的「Zalgo」文字
    static let maxCombiningRun = 3
    /// 服务器的默认名称（与产品同名）：没有意义，列表和标题里改为显示备注或地址
    public static let defaultServerName = "OpenHane"

    /// 清洗一个显示名：转成 NFC；去掉格式字符（零宽字符、方向控制符等）；控制字符、换行和其他空白换成空格并合并；
    /// 连续的组合字符最多保留 3 个；超过 max 个字符时截断并加省略号
    public static func clean(_ raw: String, max: Int = maxChars) -> String {
        // 先截一段再处理：服务端可能发来极长的字符串
        let s = String(raw.unicodeScalars.prefix(max * 8)).precomposedStringWithCanonicalMapping
        var out = String.UnicodeScalarView()
        var run = 0
        var lastSpace = true
        for u in s.unicodeScalars {
            switch u.properties.generalCategory {
            case .format:
                continue
            case .control, .lineSeparator, .paragraphSeparator, .spaceSeparator:
                if !lastSpace { out.append(" ") }
                lastSpace = true
                run = 0
            case .nonspacingMark, .enclosingMark:
                run += 1
                if run <= maxCombiningRun { out.append(u) }
            default:
                out.append(u)
                lastSpace = false
                run = 0
            }
        }
        let trimmed = String(out).trimmingCharacters(in: .whitespaces)
        return trimmed.count > max ? String(trimmed.prefix(max)).trimmingCharacters(in: .whitespaces) + "…" : trimmed
    }

    /// 服务端给的服务器名称：清洗后；是默认名称时当作没有名称
    public static func serverName(_ raw: String) -> String {
        let name = clean(raw)
        return name == defaultServerName ? "" : name
    }
}

extension ServerInfo {
    /// 名称清洗过的副本（放进会话状态，界面各处都从状态里取）
    func withCleanName() -> ServerInfo {
        var copy = self
        copy.name = DisplayName.clean(name)
        return copy
    }
}
