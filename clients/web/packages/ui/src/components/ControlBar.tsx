import * as DM from '@radix-ui/react-dropdown-menu';
import { BadgeInfo, Hand, Headphones, HeadphoneOff, Info, KeyRound, LogOut, MessageSquare, Mic, MicOff, MonitorUp, MoreHorizontal, Settings, ShieldCheck, Video, VideoOff } from 'lucide-react';
import { ShareCancelled, ShareUnsupported, type CustomShare, type ShareIntentName } from '@hane/media';
import { describeError } from '../errors';
import { SharePickerDialog } from '../dialogs/SharePickerDialog';
import { useState } from 'react';
import { Role } from '@hane/protocol';
import type { ReactNode } from 'react';
import { useVoiceActions } from '../actions';
import { AudioMenuButton } from './AudioMenus';
import { useT } from '../i18n';
import { useClient, useLevels, useMedia, useServices } from '../services';

function Btn({ label, active, danger, onClick, children, testId, badge }: {
  label: string;
  active?: boolean;
  danger?: boolean;
  onClick: () => void;
  children: ReactNode;
  testId?: string;
  badge?: number;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      title={label}
      data-testid={testId}
      className={`relative flex h-11 w-11 items-center justify-center rounded-full transition-colors ${
        danger ? 'bg-danger text-white hover:opacity-90' : active ? 'bg-danger/15 text-danger' : 'bg-surface-2 hover:bg-border'
      }`}
    >
      {children}
      {!!badge && (
        <span className="absolute -right-1 -top-1 min-w-5 rounded-full bg-accent-solid px-1 text-xs leading-5 text-white">{badge > 99 ? '99+' : badge}</span>
      )}
    </button>
  );
}

export type DialogName = 'settings' | 'redeem' | 'admin' | 'info' | 'about';

export function ControlBar({ chatOpen, onToggleChat, unread, onOpen, onLeave, onNotice }: {
  chatOpen: boolean;
  onToggleChat: () => void;
  unread: number;
  onOpen: (d: DialogName) => void;
  onLeave: () => void;
  onNotice: (text: string) => void;
}) {
  const t = useT();
  const { client, media, platform } = useServices();
  const [pickerOpen, setPickerOpen] = useState(false);
  const cameraOn = useMedia((s) => s.cameraOn);
  const sharing = useMedia((s) => !!s.share);
  const policy = useClient((s) => s.media?.policy);
  const canShare = (policy?.screen?.allowed ?? true) && typeof navigator.mediaDevices?.getDisplayMedia === 'function';
  const startShare = async (intent: ShareIntentName, withAudio: boolean, sourceId?: string, custom?: CustomShare) => {
    try {
      if (sourceId) await platform.screenPicker!.select(sourceId);
      // 浏览器：请求共享声音时，浏览器自带的选择框会提供「同时共享音频」选项，由用户决定
      await media.startScreenShare(intent, withAudio && (policy?.screen?.audioAllowed ?? false), custom);
    } catch (e) {
      if (e instanceof ShareUnsupported) onNotice(t('share.noCodec'));
      else if (!(e instanceof ShareCancelled)) onNotice(describeError(e, t));
    }
  };
  const toggleShare = async () => {
    if (sharing) return media.stopScreenShare();
    // 桌面版：自定义选择面板（缩略图 + 模式）；网页版：浏览器自带的选择框，模式在共享开始后选择
    if (platform.screenPicker) setPickerOpen(true);
    else await startShare('smart', true);
  };
  const { setMuted, setDeafened } = useVoiceActions();
  const muted = useMedia((s) => s.micMuted);
  const deafened = useMedia((s) => s.deafened);
  const mode = useMedia((s) => s.prefs.mode);
  const transmitting = useLevels((s) => !!s.local?.speaking);
  const role = useClient((s) => s.self?.role);
  const selfId = useClient((s) => s.self?.sessionId ?? '');
  const handRaised = useClient((s) => !!s.participants[selfId]?.state?.handRaised);
  const forceMuted = useClient((s) => !!s.participants[selfId]?.forceMuted);

  return (
    <footer className="flex items-center justify-center gap-3 border-t border-border bg-surface px-4 py-3">
      {/* 麦克风和声音按钮：右键或点角上的小箭头打开快捷菜单（设备、音量、降噪等） */}
      <AudioMenuButton kind="input" onOpenSettings={() => onOpen('settings')}>
        <Btn
          label={forceMuted ? t('control.forceMuted') : muted ? t('control.unmute') : t('control.mute')}
          active={muted || forceMuted}
          onClick={() => (forceMuted ? onNotice(t('mod.notice.forceMute', { by: t('role.moderator') })) : setMuted(!muted))}
          testId="mic"
        >
          {muted ? <MicOff size={20} /> : <Mic size={20} className={transmitting && mode !== 'open' ? 'text-success' : ''} />}
        </Btn>
      </AudioMenuButton>
      <AudioMenuButton kind="output" onOpenSettings={() => onOpen('settings')}>
        <Btn label={deafened ? t('control.undeafen') : t('control.deafen')} active={deafened} onClick={() => setDeafened(!deafened)} testId="deafen">
          {deafened ? <HeadphoneOff size={20} /> : <Headphones size={20} />}
        </Btn>
      </AudioMenuButton>
      {(policy?.camera?.allowed ?? true) && (
        <Btn label={cameraOn ? t('control.cameraOff') : t('control.camera')} active={false} onClick={() => void media.setCameraEnabled(!cameraOn)} testId="camera">
          {cameraOn ? <Video size={20} className="text-accent" /> : <VideoOff size={20} />}
        </Btn>
      )}
      {canShare && (
        <Btn label={sharing ? t('control.shareStop') : t('control.share')} active={sharing} onClick={() => void toggleShare()} testId="share">
          <MonitorUp size={20} />
        </Btn>
      )}
      <Btn label={handRaised ? t('control.handDown') : t('control.hand')} active={false} onClick={() => void client.updateSelf({ handRaised: !handRaised })}>
        <Hand size={20} className={handRaised ? 'text-warning' : ''} />
      </Btn>
      <Btn label={t('control.chat')} active={false} onClick={onToggleChat} badge={chatOpen ? 0 : unread} testId="chat-toggle">
        <MessageSquare size={20} className={chatOpen ? 'text-accent' : ''} />
      </Btn>
      <DM.Root>
        <DM.Trigger asChild>
          <button aria-label={t('control.more')} title={t('control.more')} className="flex h-11 w-11 items-center justify-center rounded-full bg-surface-2 hover:bg-border" data-testid="more">
            <MoreHorizontal size={20} />
          </button>
        </DM.Trigger>
        <DM.Portal>
          <DM.Content side="top" sideOffset={8} className="z-50 min-w-52 rounded-lg border border-border bg-surface p-1 shadow-lg">
            {[
              { d: 'settings' as const, icon: <Settings size={16} />, label: t('more.settings') },
              { d: 'redeem' as const, icon: <KeyRound size={16} />, label: t('more.redeem') },
              ...(role === Role.ADMIN ? [{ d: 'admin' as const, icon: <ShieldCheck size={16} />, label: t('more.admin') }] : []),
              { d: 'info' as const, icon: <Info size={16} />, label: t('more.info') },
              { d: 'about' as const, icon: <BadgeInfo size={16} />, label: t('more.about') },
            ].map((item) => (
              <DM.Item
                key={item.d}
                onSelect={() => onOpen(item.d)}
                className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm outline-none data-[highlighted]:bg-surface-2"
                data-testid={`more-${item.d}`}
              >
                {item.icon}
                {item.label}
              </DM.Item>
            ))}
          </DM.Content>
        </DM.Portal>
      </DM.Root>
      <Btn label={t('control.leave')} danger onClick={onLeave} testId="leave">
        <LogOut size={20} />
      </Btn>
      {platform.screenPicker && (
        <SharePickerDialog
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          onStart={(id, intent, audio, custom) => {
            setPickerOpen(false);
            void startShare(intent, audio, id, custom);
          }}
        />
      )}
    </footer>
  );
}
