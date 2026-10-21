// 会议控制栏里麦克风和声音按钮的快捷菜单（右键按钮，或点按钮角上的小箭头）：
// 切换设备、调音量；麦克风菜单里还有降噪、回声消除和发言模式这几项常用设置。
import * as DM from '@radix-ui/react-dropdown-menu';
import { MediaSession, aiNoiseAvailable, type AudioPrefs } from '@hane/media';
import { Check, ChevronRight, ChevronUp, Settings } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useT } from '../i18n';
import { useLevels, useMedia, useServices } from '../services';

const menuContent = 'z-50 w-72 rounded-lg border border-border bg-surface p-1 text-sm shadow-lg';
const itemClass = 'relative flex cursor-default items-center gap-2 rounded-md py-1.5 pr-2 pl-7 outline-none select-none data-[disabled]:text-muted data-[highlighted]:bg-surface-2';
const labelClass = 'px-2 pt-1.5 pb-1 text-xs font-medium text-muted';

function Radio({ value, children, testId }: { value: string; children: ReactNode; testId?: string }) {
  return (
    <DM.RadioItem value={value} className={itemClass} data-testid={testId}>
      <DM.ItemIndicator className="absolute left-2 flex items-center">
        <Check size={14} />
      </DM.ItemIndicator>
      <span className="truncate">{children}</span>
    </DM.RadioItem>
  );
}

/** 菜单里的音量滑块（0–200%）。方向键留给滑块，不在菜单项之间移动 */
function VolumeRow({ label, value, onChange, meter, testId }: { label: string; value: number; onChange: (v: number) => void; meter?: ReactNode; testId?: string }) {
  return (
    <div className="px-2 py-1.5">
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium text-muted">{label}</span>
        <span className="tabular-nums text-muted">{Math.round(value * 100)}%</span>
      </div>
      <input
        type="range"
        min={0}
        max={200}
        step={5}
        value={Math.round(value * 100)}
        onChange={(e) => onChange(Number(e.target.value) / 100)}
        onKeyDown={(e) => e.key !== 'Escape' && e.key !== 'Tab' && e.stopPropagation()}
        aria-label={label}
        className="mt-1 w-full accent-[var(--color-accent)]"
        data-testid={testId}
      />
      {meter}
    </div>
  );
}

/** 麦克风的实时电平（进入会议后才有） */
function InputMeter() {
  const local = useLevels((s) => s.local);
  if (!local) return null;
  const pct = Math.max(0, Math.min(100, ((local.levelDb + 80) / 80) * 100));
  return (
    <div className="mt-1 h-1 overflow-hidden rounded bg-surface-2" aria-hidden>
      <div className={`h-full transition-[width] duration-75 ${local.speaking ? 'bg-success' : 'bg-muted/50'}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

function SubMenu({ label, value, children }: { label: string; value: string; children: ReactNode }) {
  return (
    <DM.Sub>
      <DM.SubTrigger className={`${itemClass} data-[state=open]:bg-surface-2`}>
        <span className="flex-1">{label}</span>
        <span className="truncate text-xs text-muted">{value}</span>
        <ChevronRight size={14} className="shrink-0 text-muted" />
      </DM.SubTrigger>
      <DM.Portal>
        <DM.SubContent sideOffset={6} className="z-50 min-w-44 rounded-lg border border-border bg-surface p-1 text-sm shadow-lg">
          {children}
        </DM.SubContent>
      </DM.Portal>
    </DM.Sub>
  );
}

function useDevices(open: boolean) {
  const [devices, setDevices] = useState<{ inputs: MediaDeviceInfo[]; outputs: MediaDeviceInfo[] }>({ inputs: [], outputs: [] });
  useEffect(() => {
    if (open) void MediaSession.devices().then(setDevices).catch(() => undefined);
  }, [open]);
  const real = (list: MediaDeviceInfo[]) => list.filter((d) => d.deviceId && d.deviceId !== 'default');
  return { inputs: real(devices.inputs), outputs: real(devices.outputs) };
}

/**
 * 给按钮加上快捷菜单：右键按钮或点角上的小箭头打开。
 * kind 为 input 时是麦克风菜单，output 时是声音（输出设备）菜单。
 */
export function AudioMenuButton({ kind, onOpenSettings, children }: { kind: 'input' | 'output'; onOpenSettings: () => void; children: ReactNode }) {
  const t = useT();
  const { media } = useServices();
  const prefs = useMedia((s) => s.prefs);
  const [open, setOpen] = useState(false);
  const { inputs, outputs } = useDevices(open);
  const set = (p: Partial<AudioPrefs>) => void media.setPrefs(p);
  const nsLabel = { ai: t('settings.nsAi'), standard: t('settings.nsStandard'), off: t('settings.nsOff') }[prefs.ns];
  const modeLabel = { voice: t('settings.modeVoice'), ptt: t('settings.modePtt'), open: t('settings.modeOpen') }[prefs.mode];

  return (
    <div
      className="relative"
      onContextMenu={(e) => {
        e.preventDefault();
        setOpen(true);
      }}
    >
      {children}
      <DM.Root open={open} onOpenChange={setOpen} modal={false}>
        <DM.Trigger
          className="absolute -right-0.5 -bottom-0.5 flex size-[18px] items-center justify-center rounded-full border border-border bg-surface text-muted shadow-sm transition hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent data-[state=open]:text-text"
          aria-label={kind === 'input' ? t('audio.inputMenu') : t('audio.outputMenu')}
          title={kind === 'input' ? t('audio.inputMenu') : t('audio.outputMenu')}
          data-testid={kind === 'input' ? 'mic-menu' : 'output-menu'}
        >
          <ChevronUp size={11} strokeWidth={2.5} />
        </DM.Trigger>
        <DM.Portal>
          <DM.Content side="top" align="start" sideOffset={10} collisionPadding={8} className={menuContent}>
            {kind === 'input' ? (
              <>
                <DM.Label className={labelClass}>{t('settings.input')}</DM.Label>
                <DM.RadioGroup value={inputs.some((d) => d.deviceId === prefs.inputDeviceId) ? prefs.inputDeviceId : 'default'} onValueChange={(v) => set({ inputDeviceId: v })}>
                  <Radio value="default">{t('settings.default')}</Radio>
                  {inputs.map((d) => (
                    <Radio key={d.deviceId} value={d.deviceId}>
                      {d.label || d.deviceId.slice(0, 8)}
                    </Radio>
                  ))}
                </DM.RadioGroup>
                <DM.Separator className="my-1 h-px bg-border" />
                <VolumeRow label={t('audio.inputVolume')} value={prefs.inputVolume ?? 1} onChange={(v) => set({ inputVolume: v })} meter={<InputMeter />} testId="input-volume" />
                <DM.Separator className="my-1 h-px bg-border" />
                <SubMenu label={t('settings.ns')} value={nsLabel}>
                  <DM.RadioGroup value={prefs.ns} onValueChange={(v) => set({ ns: v as AudioPrefs['ns'], nsChosen: true })}>
                    {aiNoiseAvailable && <Radio value="ai">{t('settings.nsAi')}</Radio>}
                    <Radio value="standard">{t('settings.nsStandard')}</Radio>
                    <Radio value="off">{t('settings.nsOff')}</Radio>
                  </DM.RadioGroup>
                </SubMenu>
                <DM.CheckboxItem checked={!prefs.headphones} onCheckedChange={(c) => set({ headphones: !c })} onSelect={(e) => e.preventDefault()} className={itemClass} data-testid="echo-toggle">
                  <DM.ItemIndicator className="absolute left-2 flex items-center">
                    <Check size={14} />
                  </DM.ItemIndicator>
                  {t('audio.echo')}
                </DM.CheckboxItem>
                <SubMenu label={t('settings.mode')} value={modeLabel}>
                  <DM.RadioGroup value={prefs.mode} onValueChange={(v) => set({ mode: v as AudioPrefs['mode'] })}>
                    <Radio value="voice">{t('settings.modeVoice')}</Radio>
                    <Radio value="ptt">{t('settings.modePtt')}</Radio>
                    <Radio value="open">{t('settings.modeOpen')}</Radio>
                  </DM.RadioGroup>
                </SubMenu>
              </>
            ) : (
              <>
                <DM.Label className={labelClass}>{t('settings.output')}</DM.Label>
                {outputs.length > 0 ? (
                  <DM.RadioGroup value={outputs.some((d) => d.deviceId === prefs.outputDeviceId) ? prefs.outputDeviceId : 'default'} onValueChange={(v) => set({ outputDeviceId: v })}>
                    <Radio value="default">{t('settings.default')}</Radio>
                    {outputs.map((d) => (
                      <Radio key={d.deviceId} value={d.deviceId}>
                        {d.label || d.deviceId.slice(0, 8)}
                      </Radio>
                    ))}
                  </DM.RadioGroup>
                ) : (
                  <DM.Item disabled className={itemClass}>
                    {t('audio.outputSystem')}
                  </DM.Item>
                )}
                <DM.Separator className="my-1 h-px bg-border" />
                <VolumeRow label={t('audio.outputVolume')} value={prefs.outputVolume ?? 1} onChange={(v) => set({ outputVolume: v })} testId="output-volume" />
              </>
            )}
            <DM.Separator className="my-1 h-px bg-border" />
            <DM.Item onSelect={onOpenSettings} className={itemClass} data-testid="audio-settings">
              <Settings size={14} className="absolute left-2" aria-hidden />
              {t('audio.allSettings')}
            </DM.Item>
          </DM.Content>
        </DM.Portal>
      </DM.Root>
    </div>
  );
}
