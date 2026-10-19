// 成员菜单底部的连接信息（仅管理员）：IP、归属地和往返延迟；IPv6 地址在服务器没有 IPv6 库时提示下载。
import type { GetSessionInfoResult } from '@hane/protocol';
import { useEffect, useState } from 'react';
import { describeError } from '../errors';
import { useT } from '../i18n';
import { useServices } from '../services';
import { Dialog } from './Dialog';

export function MemberInfo({ sessionId, onDownloadV6 }: { sessionId: string; onDownloadV6: () => void }) {
  const t = useT();
  const { client } = useServices();
  const [info, setInfo] = useState<GetSessionInfoResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    client.getSessionInfo(sessionId).then(
      (r) => live && setInfo(r),
      (e) => live && setErr(describeError(e, t)),
    );
    return () => {
      live = false;
    };
  }, [client, sessionId, t]);

  const place = info ? [info.country, info.province, info.city].filter(Boolean).join(' ') : '';
  return (
    <div className="px-2 py-1.5 text-xs text-muted" data-testid="member-info">
      {err ? (
        <span className="text-danger">{err}</span>
      ) : !info ? (
        t('member.infoLoading')
      ) : (
        <>
          <div className="select-text font-mono text-text">{info.ip || t('member.ipUnknown')}</div>
          {info.ipv6DbMissing ? (
            <button type="button" className="text-accent hover:underline" onClick={onDownloadV6} data-testid="geo-v6-missing">
              {t('geo.v6Missing')}
            </button>
          ) : (
            (place || info.isp) && <div>{[place, info.isp].filter(Boolean).join(' · ')}</div>
          )}
          <div>{info.rttMs ? t('member.latency', { ms: info.rttMs }) : t('member.latencyUnknown')}</div>
          <div className="mt-1 text-[11px] opacity-70">{t('member.adminOnly')}</div>
        </>
      )}
    </div>
  );
}

export function IPv6GeoDialog({ onClose, onNotice }: { onClose: () => void; onNotice: (m: string) => void }) {
  const t = useT();
  const { client } = useServices();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()} title={t('geo.v6Title')} description={t('geo.v6Body')}>
      {err && <p className="mb-3 text-sm text-danger">{err}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" className="rounded-md px-3 py-1.5 text-sm hover:bg-surface-2" disabled={busy} onClick={onClose}>
          {t('common.cancel')}
        </button>
        <button
          type="button"
          className="rounded-md bg-accent px-3 py-1.5 text-sm text-white disabled:opacity-60"
          disabled={busy}
          data-testid="geo-v6-download"
          onClick={async () => {
            setBusy(true);
            setErr(null);
            try {
              await client.downloadIPv6GeoDB();
              onNotice(t('geo.v6Done'));
              onClose();
            } catch (e) {
              setErr(t('geo.v6Failed', { error: describeError(e, t) }));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? t('geo.v6Downloading') : t('geo.v6Download')}
        </button>
      </div>
    </Dialog>
  );
}
