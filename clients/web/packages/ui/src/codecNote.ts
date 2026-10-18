import type { ShareCodecPref } from '@hane/media';
import type { Participant } from '@hane/protocol';
import type { Translate } from './i18n';

export const CODEC_LABEL: Record<ShareCodecPref, string> = { av1: 'AV1', h265: 'H.265', h264: 'H.264' };

/**
 * 同一房间里（不含自己）不能硬件解码某个编码器的人。没有上报解码能力的旧版本客户端不计入。
 * none：完全解不了（AV1 / H.265 时看备用的 H.264 画面，H.264 时看不到画面）；soft：只能软件解码
 */
export function decodeGap(codec: ShareCodecPref, others: Participant[]): { none: Participant[]; soft: Participant[] } {
  const mime = `video/${codec}`;
  const reported = others.filter((p) => p.decodeHardware.length + p.decodeSoftware.length > 0);
  return {
    none: reported.filter((p) => !p.decodeHardware.includes(mime) && !p.decodeSoftware.includes(mime)),
    soft: reported.filter((p) => p.decodeSoftware.includes(mime)),
  };
}

/** 下拉选项的文字：有人受影响时只加人数，完整说明显示在下拉框下面 */
export function codecOptionLabel(codec: ShareCodecPref, others: Participant[], t: Translate): string {
  const g = decodeGap(codec, others);
  const n = g.none.length + g.soft.length;
  return n ? t('share.custom.affected', { codec: CODEC_LABEL[codec], n }) : CODEC_LABEL[codec];
}

/** 选中编码器后显示在下拉框下面的完整说明（谁不能硬件解码、谁完全解不了）；没有问题时为空 */
export function decodeNote(codec: ShareCodecPref, others: Participant[], t: Translate): string {
  const { none, soft } = decodeGap(codec, others);
  const who = (ps: Participant[]) => {
    const names = ps.slice(0, 2).map((p) => p.nickname).join(t('share.custom.sep'));
    return ps.length > 2 ? t('share.custom.whoMany', { names, n: ps.length }) : names;
  };
  const codecName = CODEC_LABEL[codec];
  const parts: string[] = [];
  if (none.length) parts.push(t(codec === 'h264' ? 'share.custom.noDecodeH264' : 'share.custom.noDecode', { who: who(none), codec: codecName }));
  if (soft.length) parts.push(t('share.custom.noHwDecode', { who: who(soft), codec: codecName }));
  // 中文：名字是汉字时去掉模板里留给拉丁字母名字的空格（「等 4 人 不支持」→「等 4 人不支持」）
  return parts.join(t('share.custom.noteSep')).replace(/([\u4e00-\u9fff]) (?=[\u4e00-\u9fff])/g, '$1');
}
