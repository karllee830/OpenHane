// 羽见的 AI 降噪：DeepFilterNet3（clients/deepfilter）。
// 一个实例只能在一个线程上使用。函数内部出错时返回 NULL 或 NaN，不会让调用方崩溃。
#pragma once

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct OmDeepFilter OmDeepFilter;

/// 从模型（DeepFilterNet3_onnx.tar.gz 的内容）创建降噪实例，失败返回 NULL。
/// atten_lim_db 为最大衰减量（100 表示不限制）。要解析并优化模型，耗时 0.1–0.5 秒，不要在实时音频线程上调用。
OmDeepFilter *_Nullable hane_df_create(const unsigned char *_Nonnull model, size_t len, float atten_lim_db);

/// 模型的采样率（DeepFilterNet3 为 48000）。
size_t hane_df_sample_rate(const OmDeepFilter *_Nonnull st);

/// 每帧的采样数（48 kHz 下为 480，即 10 ms）。
size_t hane_df_hop(const OmDeepFilter *_Nonnull st);

/// 处理一帧（hop 个 [-1, 1] 浮点采样），返回本帧的局部信噪比估计（dB，约 -15～35）；出错返回 NaN。
/// input 和 output 不能是同一块内存。输出比输入晚约 30 ms（模型前瞻 2 帧 + 分析窗）。
float hane_df_process(OmDeepFilter *_Nonnull st, const float *_Nonnull input, float *_Nonnull output);

/// 调整最大衰减量（dB，100 表示不限制）。
void hane_df_set_atten_lim(OmDeepFilter *_Nonnull st, float db);

/// 释放实例，之后不能再使用。
void hane_df_destroy(OmDeepFilter *_Nullable st);

#ifdef __cplusplus
}
#endif
