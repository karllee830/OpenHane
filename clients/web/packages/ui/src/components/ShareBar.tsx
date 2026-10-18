import type { CustomShare, ShareIntentName } from '@hane/media';
import { SlidersHorizontal, Square } from 'lucide-react';
import { useState } from 'react';
import { useT } from '../i18n';
import { useMedia, useServices } from '../services';
import { CUSTOM_STORAGE, DEFAULT_CUSTOM, ShareCustomDialog } from './ShareCustom';

/** 共享中的悬浮控制条：当前模式与引擎状态、切换模式（自定义时可调分辨率 / 帧率 / 码率）、停止 */
export function ShareBar() {
  const t = useT();
  const { media, platform } = useServices();
  const share = useMedia((s) => s.share);
  const [customOpen, setCustomOpen] = useState(false);
  if (!share) return null;
  const p = share.params;
  const limited = p.level > 0;
  const lastCustom = share.custom ?? platform.storage.get<CustomShare>(CUSTOM_STORAGE) ?? DEFAULT_CUSTOM;
  const applyCustom = (c: CustomShare) => {
    platform.storage.set(CUSTOM_STORAGE, c);
    setCustomOpen(false);
    void media.setShareIntent('custom', c);
  };
  return (
    <div className="pointer-events-auto mx-auto mt-2 flex w-fit items-center gap-3 rounded-full border border-border bg-surface px-4 py-1.5 text-sm shadow-lg" data-testid="share-bar">
      <span className="flex items-center gap-1.5 font-medium text-danger">
        <span className="h-2 w-2 animate-pulse rounded-full bg-danger" />
        {t('share.sharing')}
      </span>
      <select
        className="rounded border border-border bg-bg px-1 py-0.5"
        value={share.intent}
        onChange={(e) => {
          const intent = e.target.value as ShareIntentName;
          // 自定义：先在对话框里确认参数，应用时才切换
          if (intent === 'custom') setCustomOpen(true);
          else void media.setShareIntent(intent);
        }}
        aria-label={t('share.mode')}
        data-testid="share-intent"
      >
        <option value="smart">{t('share.smart')}</option>
        <option value="clarity">{t('share.clarity')}</option>
        <option value="smoothness">{t('share.smoothness')}</option>
        <option value="custom">{t('share.custom')}</option>
      </select>
      {share.intent === 'custom' && (
        <button
          className="flex h-7 w-7 items-center justify-center rounded-full hover:bg-surface-2"
          onClick={() => setCustomOpen(true)}
          aria-label={t('share.custom.edit')}
          title={t('share.custom.edit')}
          data-testid="share-custom-edit"
        >
          <SlidersHorizontal size={15} aria-hidden />
        </button>
      )}
      <span className="text-muted" data-testid="share-state" title={limited ? t('share.limited') : undefined}>
        {share.intent === 'smart' && `${t(p.mode === 'text' ? 'share.state.text' : 'share.state.motion')} · `}
        {p.height}p {p.fps}fps · {share.intent === 'custom' && `${p.maxKbps} kbps · `}
        {share.codec.toUpperCase()}
        {limited && ' ⚠'}
      </span>
      <button className="flex items-center gap-1 rounded-full bg-danger px-3 py-1 text-white" onClick={() => void media.stopScreenShare()} data-testid="share-stop">
        <Square size={12} />
        {t('control.shareStop')}
      </button>
      <ShareCustomDialog open={customOpen} onOpenChange={setCustomOpen} initial={lastCustom} onApply={applyCustom} />
    </div>
  );
}
