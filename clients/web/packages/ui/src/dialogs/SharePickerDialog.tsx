import type { CustomShare, ShareIntentName } from '@hane/media';
import type { ShareSource } from '@hane/platform';
import { useEffect, useState } from 'react';
import { Dialog } from '../components/Dialog';
import { CUSTOM_STORAGE, DEFAULT_CUSTOM, ShareCustomFields } from '../components/ShareCustom';
import { useT } from '../i18n';
import { useServices } from '../services';

/** 自定义共享选择面板：来源（缩略图每 2 秒刷新）+ 模式（默认智能；自定义时设置分辨率、帧率、码率）+ 共享声音 */
export function SharePickerDialog({ open, onOpenChange, onStart }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onStart: (sourceId: string, intent: ShareIntentName, withAudio: boolean, custom?: CustomShare) => void;
}) {
  const t = useT();
  const { platform } = useServices();
  const picker = platform.screenPicker!;
  const [sources, setSources] = useState<ShareSource[] | null>(null);
  const [tab, setTab] = useState<'screen' | 'window'>('screen');
  const [selected, setSelected] = useState<string | null>(null);
  // 每台设备记住上次选择的模式和共享声音开关
  const [intent, setIntent] = useState<ShareIntentName>(() => platform.storage.get<ShareIntentName>('shareIntent') ?? 'smart');
  const [audio, setAudio] = useState(() => platform.storage.get<boolean>('shareAudio') ?? false);
  const [custom, setCustom] = useState<CustomShare>(() => platform.storage.get<CustomShare>(CUSTOM_STORAGE) ?? DEFAULT_CUSTOM);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    const load = () =>
      picker.listSources().then(
        (list) => alive && setSources(list),
        () => alive && setSources([]),
      );
    void load();
    const timer = setInterval(load, 2000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [open, picker]);

  const shown = (sources ?? []).filter((s) => s.kind === tab);
  const start = () => {
    if (!selected) return;
    platform.storage.set('shareIntent', intent);
    platform.storage.set('shareAudio', audio);
    if (intent === 'custom') platform.storage.set(CUSTOM_STORAGE, custom);
    onStart(selected, intent, audio && picker.audioSupported, intent === 'custom' ? custom : undefined);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={t('picker.title')} wide>
      <div className="mb-3 flex gap-1 border-b border-border" role="tablist">
        {(['screen', 'window'] as const).map((k) => (
          <button
            key={k}
            role="tab"
            aria-selected={tab === k}
            onClick={() => setTab(k)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === k ? 'border-accent text-accent' : 'border-transparent text-muted'}`}
          >
            {t(k === 'screen' ? 'picker.screens' : 'picker.windows')}
          </button>
        ))}
      </div>
      {sources !== null && sources.length === 0 && <p className="mb-3 text-sm text-muted">{t('picker.none')}</p>}
      <div className="grid max-h-80 grid-cols-2 gap-3 overflow-y-auto sm:grid-cols-3" data-testid="picker-sources">
        {shown.map((s) => (
          <button
            key={s.id}
            onClick={() => setSelected(s.id)}
            onDoubleClick={() => {
              setSelected(s.id);
              start();
            }}
            className={`flex flex-col gap-1 rounded-lg border-2 p-1.5 text-left ${selected === s.id ? 'border-accent' : 'border-transparent hover:border-border'}`}
            data-testid="picker-source"
          >
            <div className="flex aspect-video w-full items-center justify-center overflow-hidden rounded bg-surface-2">
              {s.thumbnail ? <img src={s.thumbnail} alt="" className="h-full w-full object-contain" /> : null}
            </div>
            <span className="flex items-center gap-1 truncate text-xs">
              {s.appIcon && <img src={s.appIcon} alt="" className="h-4 w-4" />}
              {s.name}
            </span>
          </button>
        ))}
      </div>
      <fieldset className="mt-4 space-y-1 text-sm">
        <legend className="mb-1 font-medium">{t('share.mode')}</legend>
        {(['smart', 'clarity', 'smoothness', 'custom'] as const).map((m) => (
          <label key={m} className="flex items-start gap-2">
            <input type="radio" name="intent" className="mt-1" checked={intent === m} onChange={() => setIntent(m)} data-testid={`picker-intent-${m}`} />
            <span>
              {t(`share.${m}`)}
              <span className="ml-2 text-muted">{t(`share.${m}Desc`)}</span>
            </span>
          </label>
        ))}
        {intent === 'custom' && (
          <div className="pt-1 pl-6">
            <ShareCustomFields value={custom} onChange={setCustom} />
          </div>
        )}
      </fieldset>
      <label className={`mt-3 flex items-center gap-2 text-sm ${picker.audioSupported ? '' : 'text-muted'}`}>
        <input type="checkbox" checked={audio && picker.audioSupported} disabled={!picker.audioSupported} onChange={(e) => setAudio(e.target.checked)} />
        {t('share.withAudio')}
        {!picker.audioSupported && <span className="text-xs">（{t('picker.audioUnsupported')}）</span>}
      </label>
      <div className="mt-4 flex justify-end gap-2">
        <button className="rounded-md px-4 py-2 text-sm hover:bg-surface-2" onClick={() => onOpenChange(false)}>
          {t('common.cancel')}
        </button>
        <button className="rounded-md bg-accent-solid px-4 py-2 text-sm text-white disabled:opacity-50" disabled={!selected} onClick={start} data-testid="picker-start">
          {t('picker.start')}
        </button>
      </div>
    </Dialog>
  );
}
