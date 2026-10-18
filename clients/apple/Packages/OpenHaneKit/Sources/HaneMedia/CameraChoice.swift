import AVFoundation

/// 打开摄像头时没有可用的设备
public enum CameraUnavailable: Error, Sendable, Equatable {
    /// 有摄像头，但都被系统挂起了：笔记本合上屏幕时内置摄像头不能用（外接显示器、合盖使用）
    case suspended
    /// 一个摄像头都没有
    case none
}

/// 选择摄像头用的设备信息（与 AVCaptureDevice 解耦，便于测试）
struct CameraCandidate: Equatable {
    var id: String
    var connected: Bool
    /// 被系统挂起：合盖时的内置摄像头、关上隐私遮挡的外接摄像头。仍然出现在设备列表里，但打开后一直没有画面，等到超时
    var suspended: Bool
}

/// 选出要打开的摄像头：系统默认摄像头可用就用它，否则按列表顺序（内置、连续互通相机、外接）用第一个可用的。
/// 没有可用的返回原因
func chooseCamera(_ candidates: [CameraCandidate], defaultID: String?) -> Result<Int, CameraUnavailable> {
    let usable = candidates.indices.filter { candidates[$0].connected && !candidates[$0].suspended }
    if let d = defaultID, let i = usable.first(where: { candidates[$0].id == d }) { return .success(i) }
    if let i = usable.first { return .success(i) }
    return .failure(candidates.isEmpty ? .none : .suspended)
}
