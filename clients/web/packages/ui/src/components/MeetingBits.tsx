// 会议界面共用的小部件（与苹果客户端 Shared/Views/MeetingShared.swift 对应）。
import { Platform } from '@hane/protocol';
import type { CSSProperties } from 'react';
import { useT } from '../i18n';
import { avatarColor } from './Avatar';

/** 舞台画面的底色：带一点这个人头像颜色的渐变，没开摄像头时一眼能分清谁是谁 */
export function tileTint(uid: string): CSSProperties {
  const c = avatarColor(uid);
  return {
    background: `linear-gradient(135deg, color-mix(in oklab, ${c} 24%, var(--color-surface)), color-mix(in oklab, ${c} 7%, var(--color-surface)))`,
  };
}

/** 成员列表里自己那一行的「你」 */
/** 客户端类型（产品名，不翻译） */
const PLATFORM_NAMES: Partial<Record<Platform, string>> = {
  [Platform.MACOS]: 'macOS',
  [Platform.IOS]: 'iOS',
  [Platform.WINDOWS]: 'Windows',
  [Platform.LINUX]: 'Linux',
  [Platform.ANDROID]: 'Android',
  [Platform.WEB]: 'Web',
};

/** 客户端类型的名称，未知类型为空 */
export const platformName = (platform: Platform) => PLATFORM_NAMES[platform] ?? '';

export function YouTag() {
  const t = useT();
  return <span className="shrink-0 rounded-full bg-accent-solid px-1.5 text-[11px] font-semibold leading-[18px] text-white">{t('member.youTag')}</span>;
}
