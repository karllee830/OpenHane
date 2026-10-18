import LiveKit
import ReplayKit

/// 广播上传扩展：采集整个屏幕，经应用组里的套接字把帧（和共享的声音）传给主应用。
/// 主应用不在会议中时会立即结束广播。
final class SampleHandler: LKSampleHandler, @unchecked Sendable {
    override init() {
        // 主应用退出时套接字被关闭：忽略 SIGPIPE，写操作改为返回错误，而不是直接结束扩展进程
        signal(SIGPIPE, SIG_IGN)
        super.init()
    }
}
