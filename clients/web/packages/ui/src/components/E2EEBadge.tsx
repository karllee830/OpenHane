// 端到端加密标识：点击查看安全码（8 个 emoji 和名称，方便在会议里念出来核对）。所有人看到的安全码相同，就说明大家看到的成员列表一致，
// 服务器没有偷偷塞进一个人。
import * as DM from '@radix-ui/react-dropdown-menu';
import { SAFETY_EMOJI } from '@hane/core';
import { ShieldCheck } from 'lucide-react';
import { useT, type MessageKey } from '../i18n';
import { useMedia } from '../services';

export function E2EEBadge() {
  const t = useT();
  const e2ee = useMedia((s) => s.e2ee);
  if (!e2ee?.enabled) return null;
  const pending = Object.keys(e2ee.missing).length;
  return (
    <DM.Root modal={false}>
      <DM.Trigger className="ml-auto flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-success hover:bg-surface-2" data-testid="e2ee-badge" aria-label={t('e2ee.title')}>
        <ShieldCheck size={14} />
        {t('e2ee.short')}
      </DM.Trigger>
      <DM.Portal>
        <DM.Content align="start" sideOffset={6} className="z-50 w-72 rounded-lg border border-border bg-surface p-4 text-sm shadow-lg">
          <div className="mb-1 font-medium">{t('e2ee.title')}</div>
          <p className="text-muted">{t('e2ee.explain')}</p>
          <p className="text-muted">{t('e2ee.compare')}</p>
          <div className="mt-3 text-xs text-muted">{t('e2ee.safetyCode')}</div>
          <div className="mt-2" data-testid="safety-code" data-code={e2ee.safetyCode?.join(',') ?? ''}>
            {e2ee.safetyCode ? (
              <ol className="grid grid-cols-4 gap-x-1 gap-y-2">
                {e2ee.safetyCode.map((n, i) => (
                  <li key={i} className="flex flex-col items-center gap-0.5">
                    <span className="text-2xl leading-none" aria-hidden>
                      {SAFETY_EMOJI[n]}
                    </span>
                    <span className="max-w-full truncate text-xs text-muted">{t(`e2ee.emoji.${n}` as MessageKey)}</span>
                  </li>
                ))}
              </ol>
            ) : (
              <div className="text-lg text-muted">…</div>
            )}
          </div>
          {pending > 0 && <p className="mt-2 text-xs text-warning">{t('e2ee.pendingCount', { n: pending })}</p>}
        </DM.Content>
      </DM.Portal>
    </DM.Root>
  );
}
