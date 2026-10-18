import type { UpdateState } from '@hane/platform';
import { useEffect, useState } from 'react';
import { useT } from '../i18n';
import { useClient, useServices } from '../services';

const NON_RELEASE_BUILDS = ['dev', 'e2e'];

export function useUpdateState(): UpdateState | null {
  const { platform } = useServices();
  const updates = platform.updates;
  const [state, setState] = useState<UpdateState | null>(() => updates?.state() ?? null);
  useEffect(() => updates?.onChange(setState), [updates]);
  return state;
}

/** 网页版：服务端升级后，页面里还是旧版本的网页，需要刷新 */
export function useServerUpdated(): string | null {
  const { platform, client } = useServices();
  const serverVersion = useClient((s) => s.serverInfo?.version);
  if (platform.kind !== 'web' || !serverVersion || NON_RELEASE_BUILDS.includes(client.appVersion)) return null;
  return serverVersion !== client.appVersion ? serverVersion : null;
}

/** 设置里的「更新」一节（桌面版） */
export function UpdateSettings() {
  const t = useT();
  const { platform } = useServices();
  const updates = platform.updates;
  const state = useUpdateState();
  const [beta, setBeta] = useState(() => updates?.beta() ?? false);
  if (!updates) return null;

  const status =
    state?.status === 'checking'
      ? t('update.checking')
      : state?.status === 'up-to-date'
        ? t('update.upToDate')
        : state?.status === 'downloading'
          ? t('update.downloading', { version: state.version ?? '', percent: String(state.percent ?? 0) })
          : state?.status === 'ready'
            ? t('update.ready', { version: state.version ?? '' })
            : state?.status === 'error'
              ? t('update.error', { error: state.error ?? '' })
              : '';

  return (
    <div className="space-y-2 border-t border-border pt-4 text-sm" data-testid="update-settings">
      <p className="font-medium">{t('update.title')}</p>
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={beta}
          onChange={(e) => {
            setBeta(e.target.checked);
            updates.setBeta(e.target.checked);
          }}
        />
        {t('update.beta')}
      </label>
      {updates.automatic ? (
        <div className="flex items-center gap-3">
          <button className="rounded-md border border-border px-3 py-1.5 hover:bg-surface-2 disabled:opacity-50" disabled={state?.status === 'checking' || state?.status === 'downloading'} onClick={() => updates.check()}>
            {t('update.check')}
          </button>
          {state?.status === 'ready' ? (
            <button className="text-accent hover:underline" onClick={() => updates.install()}>
              {status}
            </button>
          ) : (
            <span className="text-muted">{status}</span>
          )}
        </div>
      ) : (
        <p className="text-muted">
          {t('update.manual')}{' '}
          <a href={updates.releasesUrl} target="_blank" rel="noreferrer" className="text-accent hover:underline">
            {t('update.releases')}
          </a>
        </p>
      )}
    </div>
  );
}
