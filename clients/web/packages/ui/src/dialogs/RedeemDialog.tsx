import { Role } from '@hane/protocol';
import { useState } from 'react';
import { Dialog } from '../components/Dialog';
import { describeError } from '../errors';
import { useT } from '../i18n';
import { useClient, useServices } from '../services';

export function RedeemDialog({ open, onOpenChange, initialToken = '', description }: { open: boolean; onOpenChange: (o: boolean) => void; initialToken?: string; description?: string }) {
  const t = useT();
  const { client } = useServices();
  const before = useClient((s) => s.self?.role);
  const [token, setToken] = useState(initialToken);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const submit = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const role = await client.redeemToken(token);
      const name = role === Role.ADMIN ? t('role.admin') : t('role.moderator');
      setMsg(role === before ? { ok: true, text: t('redeem.unchanged') } : { ok: true, text: t('redeem.success', { role: name }) });
      setToken('');
    } catch (e) {
      setMsg({ ok: false, text: describeError(e, t) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) setMsg(null); }} title={t('redeem.title')} description={description ?? t('redeem.desc')}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="space-y-3"
      >
        <input
          autoFocus
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="HANE-XXXX-XXXX-XXXX-XXXX-XXXX"
          className="w-full rounded-md border border-border bg-bg px-3 py-2 font-mono text-sm uppercase outline-none focus:border-accent"
          aria-label={t('redeem.title')}
          data-testid="redeem-input"
        />
        {msg && <p className={`text-sm ${msg.ok ? 'text-success' : 'text-danger'}`} data-testid="redeem-result">{msg.text}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className="rounded-md px-4 py-2 text-sm hover:bg-surface-2" onClick={() => onOpenChange(false)}>
            {t('common.close')}
          </button>
          <button type="submit" disabled={busy || token.trim().length < 20} className="rounded-md bg-accent-solid px-4 py-2 text-sm text-white disabled:opacity-50" data-testid="redeem-submit">
            {t('redeem.submit')}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
