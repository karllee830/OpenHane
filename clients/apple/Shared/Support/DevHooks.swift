import Foundation

/// 开发和自动化检查用的环境变量（HANE_AUTOCONNECT、HANE_SNAPSHOT_*、HANE_SEED_BYTE 等）。
/// 只在 Debug 构建里生效，正式版一律视为未设置。
enum DevHooks {
    static let environment: [String: String] = {
        #if DEBUG
        ProcessInfo.processInfo.environment
        #else
        [:]
        #endif
    }()
}
