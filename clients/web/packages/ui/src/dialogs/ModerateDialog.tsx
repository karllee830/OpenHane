// 踢出 / 封禁：填写原因；封禁可选时长和同时封禁 IP。
import type { Participant } from '@hane/protocol';
import { ModerationAction, Role } from '@hane/protocol';
import { useState } from 'react';
import { Dialog } from '../components/Dialog';
import { describeError } from '../errors';
import { useT } from '../i18n';
import { useClient, useServices } from '../services';

export type ModerateKind = 'kick' | 'ban';

const input = 'w-full rounded-md border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent';
/** 封禁时长（秒）；0 表示永久（只有管理员可以） */
const DURATIONS = [600, 3600, 86400, 604800, 0];

export function ModerateDialog({ target, kind, onClose, onNotice }: { target: Participant; kind: ModerateKind; onClose: () => void; onNotice: (m: string) => void }) {
  const t = useT();
  const { client } = useServices();
  const role = useClient((s) => s.self?.role ?? Role.MEMBER);
  const [reason, setReason] = useState('');
  const [duration, setDuration] = useState(3600);
  const [banIp, setBanIp] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const durations = role >= Role.ADMIN ? DURATIONS : DURATIONS.filter((d) => d > 0 && d <= 86400);
  const label = (d: number) => (d === 0 ? t('ban.forever') : d < 3600 ? t('time.minutes', { n: d / 60 }) : d < 86400 ? t('time.hours', { n: d / 3600 }) : t('time.days', { n: d / 86400 }));

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={t(kind === 'kick' ? 'mod.kickTitle' : 'mod.banTitle', { name: target.nickname })}>
      <form
        className="space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            if (kind === 'kick') await client.moderate(target.sessionId, ModerationAction.KICK, { reason });
            else await client.moderate(target.sessionId, ModerationAction.BAN, { reason, durationSec: duration, banIp });
            onNotice(t(kind === 'kick' ? 'mod.kicked' : 'mod.banned', { name: target.nickname }));
            onClose();
          } catch (e2) {
            setErr(describeError(e2, t));
          }
        }}
      >
        <label className="block text-sm">
          {t('mod.reason')}
          <input className={`${input} mt-1`} value={reason} maxLength={200} autoFocus onChange={(e) => setReason(e.target.value)} data-testid="mod-reason" />
        </label>
        {kind === 'ban' && (
          <>
            <label className="block text-sm">
              {t('ban.duration')}
              <select className={`${input} mt-1`} value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
                {durations.map((d) => (
                  <option key={d} value={d}>
                    {label(d)}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={banIp} onChange={(e) => setBanIp(e.target.checked)} />
              {t('ban.ip')}
            </label>
          </>
        )}
        {err && <p className="text-sm text-danger">{err}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className="rounded-md border border-border px-4 py-2 text-sm" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="rounded-md bg-danger px-4 py-2 text-sm text-white" data-testid="mod-confirm">
            {t(kind === 'kick' ? 'mod.kick' : 'mod.ban')}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
