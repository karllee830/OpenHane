import Foundation
#if HANE_DEEPFILTER
import HaneDeepFilter
#endif

/// AI 降噪：DeepFilterNet3（clients/deepfilter 编译的静态库）。
/// 只有一个线程（采集后处理回调）会调用 process；创建要解析模型，耗时约 0.15 秒，不要在音频线程上创建。
final class DeepFilter: @unchecked Sendable {
    static let sampleRate = 48000
    static let frame = 480

    /// 这次构建是否带有 AI 降噪（没装 Rust 时构建不带，见 Package.swift）
    static var available: Bool {
        #if HANE_DEEPFILTER
        true
        #else
        false
        #endif
    }

    #if HANE_DEEPFILTER
    private let st: OpaquePointer
    private var input = [Float](repeating: 0, count: frame)
    private var output = [Float](repeating: 0, count: frame)

    init?() {
        guard let url = Bundle.module.url(forResource: "deepfilternet3", withExtension: "bin"),
              let model = try? Data(contentsOf: url, options: .alwaysMapped)
        else { return nil }
        let st = model.withUnsafeBytes { buf -> OpaquePointer? in
            guard let p = buf.bindMemory(to: UInt8.self).baseAddress else { return nil }
            return hane_df_create(p, buf.count, 100)
        }
        guard let st else { return nil }
        guard hane_df_sample_rate(st) == Self.sampleRate, hane_df_hop(st) == Self.frame else {
            hane_df_destroy(st)
            return nil
        }
        self.st = st
    }

    deinit { hane_df_destroy(st) }

    /// 原地处理一帧（480 个采样，WebRTC 音频缓冲的数值范围是 16 位 PCM），返回局部信噪比估计（dB，出错时为 NaN）。
    /// 输出比输入晚约 30 ms（模型前瞻 2 帧 + 分析窗）。
    func process(_ samples: UnsafeMutablePointer<Float>) -> Float {
        input.withUnsafeMutableBufferPointer { inp in
            output.withUnsafeMutableBufferPointer { out in
                for i in 0 ..< Self.frame { inp[i] = samples[i] / 32768 }
                let lsnr = hane_df_process(st, inp.baseAddress!, out.baseAddress!)
                for i in 0 ..< Self.frame { samples[i] = out[i] * 32768 }
                return lsnr
            }
        }
    }
    #else
    init?() { nil }
    func process(_: UnsafeMutablePointer<Float>) -> Float { .nan }
    #endif
}
