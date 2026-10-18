import { displayAddress, shortUid } from '@hane/core';
import { Dialog } from '../components/Dialog';
import { useT } from '../i18n';
import { useClient, useMedia } from '../services';

export function InfoDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const t = useT();
  const address = useClient((s) => s.address);
  const info = useClient((s) => s.serverInfo);
  const self = useClient((s) => s.self);
  const rtt = useClient((s) => s.rttMs);
  const mediaStatus = useMedia((s) => s.status);
  const transport = useMedia((s) => s.transport);
  const rows: [string, string][] = [
    [t('info.server'), `${info?.name ?? ''} · ${address ? displayAddress(address) : ''}`],
    [t('info.version'), info?.version ?? ''],
    [t('info.uid'), self ? `${shortUid(self.uid)} (${self.uid})` : ''],
    [t('info.rtt'), rtt === null ? '—' : `${rtt} ms`],
    [t('info.media'), mediaStatus],
    [t('info.transport'), transport.protocol ? `${transport.protocol.toUpperCase()}${transport.switched && transport.switched !== 'always' ? t('info.transportSwitched') : ''}` : '—'],
  ];
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={t('info.title')}>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted">{k}</dt>
            <dd className="break-all">{v}</dd>
          </div>
        ))}
      </dl>
    </Dialog>
  );
}
