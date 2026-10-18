@testable import HaneMedia
import Testing

/// 打开摄像头时选哪个设备：跳过被系统挂起的（笔记本合上屏幕时的内置摄像头），没有可用的直接说明原因，不再等到超时
@Suite struct CameraChoiceTests {
    private func cam(_ id: String, suspended: Bool = false, connected: Bool = true) -> CameraCandidate {
        CameraCandidate(id: id, connected: connected, suspended: suspended)
    }

    @Test func prefersTheSystemDefaultWhenUsable() {
        #expect(chooseCamera([cam("builtin"), cam("usb")], defaultID: "usb") == .success(1))
        #expect(chooseCamera([cam("builtin"), cam("usb")], defaultID: nil) == .success(0))
    }

    @Test func lidClosedSkipsTheSuspendedBuiltInCamera() {
        // 合盖接外接显示器：内置摄像头被挂起（系统默认仍然是它），改用外接摄像头 / 连续互通相机
        #expect(chooseCamera([cam("builtin", suspended: true), cam("iphone")], defaultID: "builtin") == .success(1))
        #expect(chooseCamera([cam("builtin", suspended: true), cam("gone", connected: false), cam("usb")], defaultID: "builtin") == .success(2))
    }

    @Test func reportsWhyNoCameraIsUsable() {
        #expect(chooseCamera([cam("builtin", suspended: true)], defaultID: "builtin") == .failure(.suspended))
        #expect(chooseCamera([], defaultID: nil) == .failure(.none))
    }
}
