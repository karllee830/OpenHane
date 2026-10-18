// 会议界面共用的小部件（与苹果客户端 Shared/Views/MeetingShared.swift 对应）。
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
export function YouTag() {
  const t = useT();
  return <span className="shrink-0 rounded-full bg-accent-solid px-1.5 text-[11px] font-semibold leading-[18px] text-white">{t('member.youTag')}</span>;
}
