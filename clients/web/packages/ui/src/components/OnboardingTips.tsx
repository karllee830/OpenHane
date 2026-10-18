// 新用户引导：第一次进入会议时显示几条上手提示，关闭后在这个浏览器里不再出现。
import { Lightbulb, X } from 'lucide-react';
import { useState } from 'react';
import { useT } from '../i18n';

const KEY = 'hane.tipsSeen';

function seen(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return true; // 无法使用本地存储（隐私模式等）时不打扰
  }
}

export function OnboardingTips() {
  const t = useT();
  const [open, setOpen] = useState(() => !seen());
  if (!open) return null;
  const dismiss = () => {
    setOpen(false);
    try {
      localStorage.setItem(KEY, '1');
    } catch {
      /* 忽略 */
    }
  };
  return (
    <section className="flex items-start gap-3 border-b border-border bg-surface-2 px-4 py-3 text-sm" aria-label={t('tips.title')} data-testid="onboarding">
      <Lightbulb size={18} className="mt-0.5 shrink-0 text-accent" aria-hidden />
      <div className="flex-1">
        <p className="font-medium">{t('tips.title')}</p>
        <ul className="mt-1 list-disc space-y-0.5 pl-5">
          <li>{t('tips.voice')}</li>
          <li>{t('tips.rooms')}</li>
          <li>{t('tips.share')}</li>
          <li>{t('tips.invite')}</li>
        </ul>
      </div>
      <button onClick={dismiss} className="shrink-0 rounded-md px-2 py-1 text-accent hover:bg-surface" data-testid="onboarding-dismiss">
        {t('tips.dismiss')}
      </button>
      <button onClick={dismiss} aria-label={t('common.close')} className="shrink-0 text-muted">
        <X size={16} />
      </button>
    </section>
  );
}
