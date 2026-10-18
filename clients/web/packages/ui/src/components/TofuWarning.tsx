import type { FingerprintMismatch } from '@hane/platform';
import { ShieldAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useT } from '../i18n';
import { useServices } from '../services';

/**
 * 证书指纹变化的全屏警告：主按钮是「取消连接」，次要按钮才是「我确认」。
 * 只在提供 TOFU 的平台（Electron）出现。
 */
export function TofuWarning() {
  const t = useT();
  const { platform, client } = useServices();
  const [m, setM] = useState<FingerprintMismatch | null>(null);
  useEffect(() => platform.trust?.onMismatch(setM), [platform]);
  if (!m) return null;
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4" role="alertdialog" aria-labelledby="tofu-title" data-testid="tofu-warning">
      <div className="w-full max-w-lg rounded-xl border-2 border-danger bg-surface p-6 shadow-2xl">
        <div className="flex items-center gap-3 text-danger">
          <ShieldAlert size={28} />
          <h2 id="tofu-title" className="text-lg font-semibold">
            {t('tofu.title')}
          </h2>
        </div>
        <p className="mt-3 text-sm">{t('tofu.body', { host: m.host })}</p>
        <dl className="mt-4 space-y-2 text-xs">
          <dt className="text-muted">{t('tofu.expected')}</dt>
          <dd className="break-all font-mono">{m.expected}</dd>
          <dt className="text-muted">{t('tofu.actual')}</dt>
          <dd className="break-all font-mono text-danger">{m.actual}</dd>
        </dl>
        <div className="mt-6 flex flex-col gap-2 sm:flex-row-reverse">
          <button
            autoFocus
            className="rounded-md bg-accent-solid px-4 py-2 font-medium text-white"
            onClick={() => {
              setM(null);
              client.disconnect();
            }}
            data-testid="tofu-cancel"
          >
            {t('tofu.cancel')}
          </button>
          <button
            className="rounded-md px-4 py-2 text-sm text-danger hover:bg-surface-2"
            onClick={async () => {
              await platform.trust!.acceptFingerprint(m.host, m.actual);
              setM(null);
              await client.reconnect().catch(() => undefined);
            }}
            data-testid="tofu-accept"
          >
            {t('tofu.accept')}
          </button>
        </div>
      </div>
    </div>
  );
}
