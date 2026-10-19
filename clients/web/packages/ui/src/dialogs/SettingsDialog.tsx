import { MediaSession, aiNoiseAvailable, type AudioPrefs } from '@hane/media';
import { CircleAlert, Settings } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { Dialog } from '../components/Dialog';
import { UpdateSettings } from '../components/Updates';
import { useT } from '../i18n';
import { useLevels, useMedia, useServices } from '../services';

export const PTT_KEY_STORAGE = 'pttKey';
export const DEFAULT_PTT_KEY = 'Backquote';

/** 把 KeyboardEvent.code 显示成用户能认出的按键名 */
export function keyLabel(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  return (
    { Backquote: '`', Space: 'Space', ShiftLeft: 'Left Shift', ControlLeft: 'Left Ctrl', AltLeft: 'Left Alt', CapsLock: 'Caps Lock', Mouse4: 'Mouse 4', Mouse5: 'Mouse 5' } as Record<string, string>
  )[code] ?? code;
}

function LevelMeter() {
  const local = useLevels((s) => s.local);
  // 还没进入会议：没有麦克风电平可显示
  if (!local) return null;
  const toPct = (db: number) => Math.max(0, Math.min(100, ((db + 80) / 80) * 100));
  return (
    <div className="relative h-3 overflow-hidden rounded bg-surface-2" aria-hidden>
      <div className={`h-full transition-[width] duration-75 ${local?.speaking ? 'bg-success' : 'bg-muted/50'}`} style={{ width: `${toPct(local?.levelDb ?? -100)}%` }} />
      {local && <div className="absolute top-0 h-full w-0.5 bg-danger" style={{ left: `${toPct(local.thresholdDb)}%` }} />}
    </div>
  );
}

export function SettingsDialog({ open, onOpenChange, pttKey, onPttKey }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  pttKey: string;
  onPttKey: (code: string) => void;
}) {
  const t = useT();
  const { media, platform } = useServices();
  const prefs = useMedia((s) => s.prefs);
  const ns = useLevels((s) => s.local?.ns);
  const [devices, setDevices] = useState<{ inputs: MediaDeviceInfo[]; outputs: MediaDeviceInfo[]; cameras: MediaDeviceInfo[] }>({ inputs: [], outputs: [], cameras: [] });
  const [capturing, setCapturing] = useState(false);
  const nsHint = useId();

  useEffect(() => {
    if (open) void MediaSession.devices().then(setDevices).catch(() => undefined);
  }, [open]);

  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      onPttKey(e.code);
      setCapturing(false);
    };
    // 鼠标侧键（后退 / 前进）：button 3 / 4
    const onMouse = (e: MouseEvent) => {
      if (e.button !== 3 && e.button !== 4) return;
      e.preventDefault();
      onPttKey(e.button === 3 ? 'Mouse4' : 'Mouse5');
      setCapturing(false);
    };
    window.addEventListener('keydown', onKey, { capture: true });
    window.addEventListener('mousedown', onMouse, { capture: true });
    return () => {
      window.removeEventListener('keydown', onKey, { capture: true });
      window.removeEventListener('mousedown', onMouse, { capture: true });
    };
  }, [capturing, onPttKey]);

  const set = (p: Partial<AudioPrefs>) => void media.setPrefs(p);
  const select = 'mt-1 w-full rounded-md border border-border bg-bg px-2 py-1.5 text-sm';

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={t('settings.title')}>
      <div className="space-y-4 text-sm">
        <label className="block">
          {t('settings.input')}
          <select className={select} value={prefs.inputDeviceId} onChange={(e) => set({ inputDeviceId: e.target.value })}>
            <option value="default">{t('settings.default')}</option>
            {devices.inputs.filter((d) => d.deviceId !== 'default' && d.deviceId).map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || d.deviceId.slice(0, 8)}
              </option>
            ))}
          </select>
        </label>
        {devices.outputs.length > 0 && (
          <label className="block">
            {t('settings.output')}
            <select className={select} value={prefs.outputDeviceId} onChange={(e) => set({ outputDeviceId: e.target.value })}>
              <option value="default">{t('settings.default')}</option>
              {devices.outputs.filter((d) => d.deviceId !== 'default' && d.deviceId).map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || d.deviceId.slice(0, 8)}
                </option>
              ))}
            </select>
          </label>
        )}
        {devices.cameras.length > 0 && (
          <label className="block">
            {t('settings.camera')}
            <select className={select} value={prefs.cameraDeviceId ?? 'default'} onChange={(e) => set({ cameraDeviceId: e.target.value })} data-testid="camera-select">
              <option value="default">{t('settings.default')}</option>
              {devices.cameras.filter((d) => d.deviceId !== 'default' && d.deviceId).map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || d.deviceId.slice(0, 8)}
                </option>
              ))}
            </select>
          </label>
        )}
        <div>
          <label className="block">
            {t('settings.ns')}
            <select
              className={select}
              value={prefs.ns}
              onChange={(e) => set({ ns: e.target.value as AudioPrefs['ns'], nsChosen: true })}
              aria-describedby={nsHint}
              data-testid="ns-select"
            >
              {aiNoiseAvailable && <option value="ai">{t('settings.nsAi')}</option>}
              <option value="standard">{t('settings.nsStandard')}</option>
              <option value="off">{t('settings.nsOff')}</option>
            </select>
          </label>
          <p id={nsHint} className="mt-1 text-xs text-muted">
            {t(prefs.ns === 'ai' ? 'settings.nsHintAi' : prefs.ns === 'standard' ? 'settings.nsHintStandard' : 'settings.nsHintOff')}
            {ns === 'loading' && <span className="block">{t('settings.nsLoading')}</span>}
            {(ns === 'fallback' || ns === 'slow') && (
              // 警告色（琥珀色）做文字对比度不够，只用在图标上
              <span className="mt-0.5 flex items-start gap-1 text-text">
                <CircleAlert size={13} className="mt-px shrink-0 text-warning" aria-hidden />
                {t(ns === 'slow' ? 'settings.nsSlow' : 'settings.nsFallback')}
              </span>
            )}
            {ns === 'unavailable' && <span className="block text-danger">{t('settings.nsUnavailable')}</span>}
          </p>
        </div>
        <fieldset>
          <legend>{t('settings.mode')}</legend>
          <div className="mt-1 flex flex-wrap gap-3">
            {(['voice', 'ptt', 'open'] as const).map((m) => (
              <label key={m} className="flex items-center gap-1.5">
                <input type="radio" name="mode" checked={prefs.mode === m} onChange={() => set({ mode: m })} />
                {t(m === 'voice' ? 'settings.modeVoice' : m === 'ptt' ? 'settings.modePtt' : 'settings.modeOpen')}
              </label>
            ))}
          </div>
        </fieldset>
        {prefs.mode === 'ptt' && (
          <div>
            <div className="flex items-center gap-2">
              {t('settings.pttKey')}
              <button className="rounded-md border border-border px-3 py-1 font-mono" onClick={() => setCapturing(true)}>
                {capturing ? t('settings.pttKeyPress') : keyLabel(pttKey)}
              </button>
            </div>
            {platform.hotkeys ? (
              <p className="mt-1 text-xs text-muted">
                {platform.hotkeys.unavailableReason ? t('settings.hotkeyUnavailable', { reason: platform.hotkeys.unavailableReason === 'macos-accessibility' ? t('settings.hotkeyNeedsAccessibility') : platform.hotkeys.unavailableReason }) : t('settings.pttMouse')}
              </p>
            ) : (
              <p className="mt-1 text-xs text-muted">{t('settings.pttWebNote')}</p>
            )}
          </div>
        )}
        <div>
          <div className="mb-1 flex items-center justify-between">
            <span>{prefs.mode === 'voice' ? t('settings.sensitivity') : t('settings.level')}</span>
            {prefs.mode === 'voice' && (
              <label className="flex items-center gap-1.5 text-xs">
                <input type="checkbox" checked={prefs.threshold === 'auto'} onChange={(e) => set({ threshold: e.target.checked ? 'auto' : -50 })} />
                {t('settings.auto')}
              </label>
            )}
          </div>
          <LevelMeter />
          {prefs.mode === 'voice' && prefs.threshold !== 'auto' && (
            <input
              type="range"
              min={-80}
              max={0}
              value={prefs.threshold}
              onChange={(e) => set({ threshold: Number(e.target.value) })}
              className="mt-2 w-full accent-[var(--color-accent)]"
              aria-label={t('settings.sensitivity')}
            />
          )}
        </div>
        <label className="flex items-start gap-2">
          <input type="checkbox" className="mt-0.5" checked={prefs.headphones} onChange={(e) => set({ headphones: e.target.checked })} />
          {t('settings.headphones')}
        </label>
        <UpdateSettings />
        <div className="flex justify-end">
          <button className="rounded-md bg-accent-solid px-4 py-2 text-white" onClick={() => onOpenChange(false)}>
            {t('settings.close')}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

/** 主页和加入页右上角的设置按钮（还没进入会议时也能选设备和降噪） */
export function SettingsButton() {
  const t = useT();
  const { platform } = useServices();
  const [open, setOpen] = useState(false);
  const [pttKey, setPttKey] = useState(() => platform.storage.get<string>(PTT_KEY_STORAGE) ?? DEFAULT_PTT_KEY);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex size-9 items-center justify-center rounded-lg text-muted transition hover:bg-surface-2 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        aria-label={t('settings.title')}
        title={t('settings.title')}
        data-testid="home-settings"
      >
        <Settings size={18} aria-hidden />
      </button>
      <SettingsDialog
        open={open}
        onOpenChange={setOpen}
        pttKey={pttKey}
        onPttKey={(k) => {
          setPttKey(k);
          platform.storage.set(PTT_KEY_STORAGE, k);
        }}
      />
    </>
  );
}
