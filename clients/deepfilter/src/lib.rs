//! 羽见的 AI 降噪：DeepFilterNet3。
//!
//! 只导出几个 C ABI 函数（include/hane_deepfilter.h）：
//! - 网页版 / 桌面版编译成 WASM，在 AudioWorklet 里直接实例化。不用 wasm-bindgen：它的 JS 胶水依赖
//!   TextDecoder 等接口，AudioWorkletGlobalScope 里没有。
//! - 苹果端编译成静态库，由 HaneMedia 在采集后处理回调里调用。
//!
//! 一个实例只能在一个线程上使用。所有函数都不会让调用方崩溃：内部出错时返回空指针或 NaN。
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::ptr::null_mut;

use df::tract::{DfParams, DfTract, RuntimeParams};
use ndarray::{ArrayView2, ArrayViewMut2};

// 局部信噪比阈值，与官方命令行工具 deep-filter 的默认值一致：低于 -15 dB 的帧当作纯噪声，
// 高于 35 dB 的帧跳过对应的解码器。libDF 的 RuntimeParams::default() 是 -10 / 30 / 20 dB，
// 会把局部信噪比在 -15～-10 dB 之间的帧整帧静音，嘈杂时会吞掉人声（键盘噪声下 SI-SDR 从 16.7 dB 掉到 6.0 dB）。
const MIN_DB_THRESH: f32 = -15.;
const MAX_DB_ERB_THRESH: f32 = 35.;
const MAX_DB_DF_THRESH: f32 = 35.;

pub struct OmDeepFilter {
    df: DfTract,
}

/// 从模型（DeepFilterNet3_onnx.tar.gz 的内容）创建降噪实例，失败返回空指针。
/// atten_lim_db 为最大衰减量（100 表示不限制）。要解析并优化模型，耗时 0.1–0.5 秒。
///
/// # Safety
/// `model` 指向 `len` 字节的可读内存（调用结束后即可释放）。
#[no_mangle]
pub unsafe extern "C" fn hane_df_create(model: *const u8, len: usize, atten_lim_db: f32) -> *mut OmDeepFilter {
    catch_unwind(AssertUnwindSafe(|| {
        let bytes = std::slice::from_raw_parts(model, len);
        let params = DfParams::from_bytes(bytes).ok()?;
        let rp = RuntimeParams::default_with_ch(1)
            .with_atten_lim(atten_lim_db)
            .with_thresholds(MIN_DB_THRESH, MAX_DB_ERB_THRESH, MAX_DB_DF_THRESH);
        let df = DfTract::new(params, &rp).ok()?;
        Some(Box::into_raw(Box::new(OmDeepFilter { df })))
    }))
    .ok()
    .flatten()
    .unwrap_or(null_mut())
}

/// 模型的采样率（DeepFilterNet3 为 48000）。
///
/// # Safety
/// `st` 来自 `hane_df_create`。
#[no_mangle]
pub unsafe extern "C" fn hane_df_sample_rate(st: *const OmDeepFilter) -> usize {
    (*st).df.sr
}

/// 每帧的采样数（48 kHz 下为 480，即 10 ms）。
///
/// # Safety
/// `st` 来自 `hane_df_create`。
#[no_mangle]
pub unsafe extern "C" fn hane_df_hop(st: *const OmDeepFilter) -> usize {
    (*st).df.hop_size
}

/// 处理一帧（hop 个 [-1, 1] 浮点采样），返回本帧的局部信噪比估计（dB，约 -15～35）；出错返回 NaN。
/// 输出比输入晚 2 帧（模型的前瞻）加上分析窗的延迟，合计约 30 ms。
///
/// # Safety
/// `st` 来自 `hane_df_create`；`input` 和 `output` 各指向 hop 个 f32，且不能是同一块内存。
#[no_mangle]
pub unsafe extern "C" fn hane_df_process(st: *mut OmDeepFilter, input: *const f32, output: *mut f32) -> f32 {
    catch_unwind(AssertUnwindSafe(|| {
        let s = &mut *st;
        let n = s.df.hop_size;
        let i = ArrayView2::from_shape((1, n), std::slice::from_raw_parts(input, n)).ok()?;
        let o = ArrayViewMut2::from_shape((1, n), std::slice::from_raw_parts_mut(output, n)).ok()?;
        s.df.process(i, o).ok()
    }))
    .ok()
    .flatten()
    .unwrap_or(f32::NAN)
}

/// 调整最大衰减量（dB，100 表示不限制）。
///
/// # Safety
/// `st` 来自 `hane_df_create`。
#[no_mangle]
pub unsafe extern "C" fn hane_df_set_atten_lim(st: *mut OmDeepFilter, db: f32) {
    (*st).df.set_atten_lim(db)
}

/// 释放实例。
///
/// # Safety
/// `st` 来自 `hane_df_create`，之后不能再使用。
#[no_mangle]
pub unsafe extern "C" fn hane_df_destroy(st: *mut OmDeepFilter) {
    if !st.is_null() {
        drop(Box::from_raw(st));
    }
}

#[cfg(target_arch = "wasm32")]
mod wasm {
    // tract-onnx 的随机数算子会引入 getrandom，它在 wasm32-unknown-unknown 上需要指定实现。
    // DeepFilterNet 的模型里没有随机算子，推理用不到随机数。
    fn no_rng(buf: &mut [u8]) -> Result<(), getrandom::Error> {
        buf.fill(0x5a);
        Ok(())
    }
    getrandom::register_custom_getrandom!(no_rng);

    /// 在 WASM 内存里分配缓冲区（JS 侧写入模型和音频帧）。
    #[no_mangle]
    pub extern "C" fn hane_alloc(len: usize) -> *mut u8 {
        let mut v = Vec::<u8>::with_capacity(len);
        let p = v.as_mut_ptr();
        std::mem::forget(v);
        p
    }

    /// 释放 `hane_alloc` 分配的缓冲区。
    ///
    /// # Safety
    /// `p` 来自 `hane_alloc(len)`。
    #[no_mangle]
    pub unsafe extern "C" fn hane_free(p: *mut u8, len: usize) {
        drop(Vec::from_raw_parts(p, 0, len));
    }
}
