import { customMode, shareCodecOptions, type CustomShare, type ShareCodecPref } from '@hane/media';
import { CodecMode, type Participant } from '@hane/protocol';
import { CircleAlert, Clapperboard, FileText, Info } from 'lucide-react';
import { CODEC_LABEL, codecOptionLabel, decodeGap, decodeNote } from '../codecNote';
import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { Dialog } from './Dialog';
import { useT } from '../i18n';
import { useClient, useMedia } from '../services';

/** 自定义档的默认值：原始分辨率、30 fps、码率自动 */
export const DEFAULT_CUSTOM: CustomShare = { height: null, fps: 30, kbps: null };
/** 每台设备记住上次的自定义参数 */
export const CUSTOM_STORAGE = 'shareCustom';

const HEIGHTS = [2160, 1440, 1080, 720, 480];
const FPS = [5, 10, 15, 24, 30, 60];

/** 服务器（管理员 / 房间）给屏幕共享设的上限；没有设置时与引擎的默认值一致 */
export function useShareLimits() {
  const screen = useClient((s) => s.media?.policy?.screen);
  return {
    maxHeight: screen?.maxHeight || 2160,
    maxFps: screen?.maxFps || 60,
    maxKbps: screen?.maxBitrateBps ? Math.round(screen.maxBitrateBps / 1000) : 8000,
  };
}

/** 自定义里可以选的编码器：本机能硬件编码的（加密房间没有 AV1；服务器设为只用 H.264 时为空） */
function useShareCodecOptions(): ShareCodecPref[] {
  const e2ee = useMedia((s) => !!s.e2ee?.enabled);
  const compat = useClient((s) => s.media?.policy?.codecs?.mode === CodecMode.COMPAT);
  const [options, setOptions] = useState<ShareCodecPref[]>([]);
  useEffect(() => {
    let alive = true;
    shareCodecOptions({ policy: compat ? 'compat' : 'auto', e2ee })
      .then((o) => alive && setOptions(o))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [e2ee, compat]);
  return options;
}

/** 同一房间里的其他成员 */
function useRoomOthers(): Participant[] {
  const participants = useClient((s) => s.participants);
  const selfId = useClient((s) => s.self?.sessionId);
  return useMemo(() => {
    const room = selfId ? participants[selfId]?.roomId : undefined;
    return Object.values(participants).filter((p) => p.sessionId !== selfId && p.roomId === room);
  }, [participants, selfId]);
}

/** 一组胶囊式单选按钮（原生 radio，键盘方向键可切换） */
function Choices<T extends string | number>({ label, value, options, onChange, testId, children }: {
  label: string;
  value: T;
  options: { value: T; label: ReactNode; title?: string; badge?: ReactNode }[];
  onChange: (v: T) => void;
  testId: string;
  children?: ReactNode;
}) {
  const name = useId();
  return (
    <fieldset>
      <legend className="mb-1.5 text-sm font-medium">{label}</legend>
      <div className="flex flex-wrap gap-1.5" data-testid={testId}>
        {options.map((o) => (
          <label key={o.value} className="cursor-pointer" title={o.title}>
            <input
              type="radio"
              name={name}
              className="peer sr-only"
              checked={o.value === value}
              onChange={() => onChange(o.value)}
              aria-label={o.title}
              data-testid={`${testId}-${o.value}`}
            />
            <span className="inline-flex h-8 items-center gap-1.5 rounded-full border border-border bg-bg px-3 text-sm transition-colors select-none hover:bg-surface-2 peer-checked:border-accent peer-checked:bg-accent/10 peer-checked:font-medium peer-checked:text-accent peer-focus-visible:ring-2 peer-focus-visible:ring-accent/40">
              {o.label}
              {o.badge}
            </span>
          </label>
        ))}
      </div>
      {children}
    </fieldset>
  );
}

/** 自定义档的参数：分辨率、帧率、码率（留空为自动）、编码器（只列出能硬件编码的）。超过服务器上限的选项不提供 */
export function ShareCustomFields({ value, onChange }: { value: CustomShare; onChange: (v: CustomShare) => void }) {
  const t = useT();
  const limits = useShareLimits();
  const codecs = useShareCodecOptions();
  const others = useRoomOthers();
  const selected = value.codec && codecs.includes(value.codec) ? value.codec : null;
  const codecNote = selected ? decodeNote(selected, others, t) : '';
  const heights = HEIGHTS.filter((h) => h <= limits.maxHeight);
  const fpsList = [...new Set([...FPS.filter((f) => f <= limits.maxFps), limits.maxFps])].sort((a, b) => a - b);
  const motion = customMode(value) === 'motion';
  const kbpsId = useId();
  // 码率：留空为自动；输入时直接生效（引擎也会截到 100 kbps～上限），离开输入框时把超出范围的值改正
  const setKbps = (text: string) => {
    const n = Math.round(Number(text));
    onChange({ ...value, kbps: text.trim() === '' || !Number.isFinite(n) || n <= 0 ? null : n });
  };
  const clampKbps = () => {
    if (value.kbps !== null) onChange({ ...value, kbps: Math.max(100, Math.min(value.kbps, limits.maxKbps)) });
  };

  return (
    <div className="space-y-4" data-testid="share-custom">
      <Choices
        label={t('share.custom.resolution')}
        value={value.height ?? 0}
        options={[{ value: 0, label: t('share.custom.native') }, ...heights.map((h) => ({ value: h, label: h === 2160 ? '4K' : `${h}p` }))]}
        onChange={(h) => onChange({ ...value, height: h || null })}
        testId="share-custom-height"
      />
      <Choices
        label={t('share.custom.fps')}
        value={Math.min(value.fps, limits.maxFps)}
        options={fpsList.map((f) => ({ value: f, label: `${f}` }))}
        onChange={(fps) => onChange({ ...value, fps })}
        testId="share-custom-fps"
      >
        {/* 24 fps 及以上按动态画面处理：随帧率实时变化，比一大段说明好懂 */}
        <p className="mt-2 flex items-center gap-1.5 text-xs text-muted" data-testid="share-custom-mode">
          {motion ? <Clapperboard size={13} aria-hidden /> : <FileText size={13} aria-hidden />}
          {t(motion ? 'share.custom.asMotion' : 'share.custom.asText')}
        </p>
      </Choices>
      <div>
        <label className="mb-1.5 block text-sm font-medium" htmlFor={kbpsId}>
          {t('share.custom.bitrate')}
        </label>
        <div className="flex items-center gap-3">
          <div className="relative w-36 shrink-0">
            <input
              id={kbpsId}
              type="number"
              inputMode="numeric"
              min={100}
              max={limits.maxKbps}
              step={100}
              placeholder={t('share.custom.auto')}
              className="h-8 w-full rounded-md border border-border bg-bg pr-12 pl-3 text-sm focus:border-accent focus:outline-none"
              value={value.kbps ?? ''}
              onChange={(e) => setKbps(e.target.value)}
              onBlur={clampKbps}
              data-testid="share-custom-kbps"
            />
            <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted">kbps</span>
          </div>
          <span className="text-xs text-muted">{t('share.custom.kbpsHint', { max: limits.maxKbps })}</span>
        </div>
      </div>
      {codecs.length > 0 && (
        <Choices
          label={t('share.custom.codec')}
          value={selected ?? 'auto'}
          options={[
            { value: 'auto' as const, label: t('share.custom.auto') },
            ...codecs.map((c) => {
              const g = decodeGap(c, others);
              const n = g.none.length + g.soft.length;
              return {
                value: c,
                label: CODEC_LABEL[c],
                title: codecOptionLabel(c, others, t),
                // 有人不能硬件解码：在按钮上标出人数，完整说明在下面
                badge: n > 0 && (
                  <span className="inline-flex items-center gap-0.5 rounded-full bg-warning/20 px-1.5 text-[11px] leading-4 font-medium text-text">
                    <CircleAlert size={11} className="text-warning" aria-hidden />
                    {n}
                  </span>
                ),
              };
            }),
          ]}
          onChange={(c) => onChange({ ...value, codec: c === 'auto' ? null : c })}
          testId="share-custom-codec"
        >
          {codecNote ? (
            <p className="mt-2 flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs leading-5" data-testid="share-custom-codec-note">
              <CircleAlert size={14} className="mt-0.5 shrink-0 text-warning" aria-hidden />
              {codecNote}
            </p>
          ) : (
            <p className="mt-2 text-xs text-muted">{t('share.custom.codecHint')}</p>
          )}
        </Choices>
      )}
      <p className="flex items-center gap-1.5 border-t border-border pt-3 text-xs text-muted">
        <Info size={13} aria-hidden />
        {t('share.custom.limits', { h: limits.maxHeight, fps: limits.maxFps, kbps: limits.maxKbps })}
      </p>
    </div>
  );
}

/** 共享中调整自定义参数（网页版的模式在共享开始后选择，所以也从这里进入自定义档） */
export function ShareCustomDialog({ open, onOpenChange, initial, onApply }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  initial: CustomShare;
  onApply: (c: CustomShare) => void;
}) {
  const t = useT();
  const [value, setValue] = useState(initial);
  useEffect(() => {
    if (open) setValue(initial);
  }, [open, initial]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={t('share.custom.title')}>
      <ShareCustomFields value={value} onChange={setValue} />
      <div className="mt-4 flex justify-end gap-2">
        <button className="rounded-md px-4 py-2 text-sm hover:bg-surface-2" onClick={() => onOpenChange(false)}>
          {t('common.cancel')}
        </button>
        <button
          className="rounded-md bg-accent-solid px-4 py-2 text-sm text-white"
          onClick={() => onApply(value)}
          data-testid="share-custom-apply"
        >
          {t('share.custom.apply')}
        </button>
      </div>
    </Dialog>
  );
}
