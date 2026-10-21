import { ModerationAction } from '@hane/protocol';
import { Info, Lock, Megaphone, Settings, Unlock, Volume2, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { displayAddress, hostPort } from '@hane/core';
import { Avatar } from '../components/Avatar';
import { ChatPanel } from '../components/ChatPanel';
import { ControlBar, type DialogName } from '../components/ControlBar';
import { E2EEBadge } from '../components/E2EEBadge';
import { RoomSidebar } from '../components/RoomSidebar';
import { ShareBar } from '../components/ShareBar';
import { ShareStage } from '../components/ShareStage';
import { Stage } from '../components/Stage';
import { RoleBadge } from '../components/ParticipantList';
import { StatusBanner } from '../components/StatusBanner';
import { AboutDialog } from '../dialogs/AboutDialog';
import { AdminDialog } from '../dialogs/AdminDialog';
import { InfoDialog } from '../dialogs/InfoDialog';
import { RedeemDialog } from '../dialogs/RedeemDialog';
import { DEFAULT_PTT_KEY, PTT_KEY_STORAGE, SettingsDialog, keyLabel } from '../dialogs/SettingsDialog';
import { useT } from '../i18n';
import { useVoiceActions } from '../actions';
import { moderationText, moveText } from '../notices';
import { useClient, useLevels, useMedia, useServices, useVideoTracks } from '../services';
import { useLogoImage, useServerLogo } from '../probe';
import { findRecent, loadRecent, serverTitle } from '../recent';
import { sounds } from '../sounds';

const NO_SHARES: never[] = [];

function isTyping(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
}

export function MeetingPage({ pendingToken, onTokenHandled }: { pendingToken?: string; onTokenHandled?: () => void }) {
  const t = useT();
  const { client, media, platform } = useServices();
  const info = useClient((s) => s.serverInfo);
  const address = useClient((s) => s.address);
  const logo = useLogoImage(useServerLogo(address));
  // 左上角的名称：有备注时显示备注，否则显示服务器名称，都没有时显示地址
  const title = useMemo(() => {
    const shown = address ? displayAddress(address) : '';
    const r = address ? findRecent(loadRecent(platform.storage), `${address.secure ? '' : 'http://'}${hostPort(address)}`) : undefined;
    return serverTitle({ note: r?.note, name: info?.name ?? '', address: shown });
  }, [address, info?.name, platform.storage]);
  const mode = useMedia((s) => s.prefs.mode);
  const [dialog, setDialog] = useState<DialogName | null>(pendingToken ? 'redeem' : null);
  useEffect(() => {
    if (pendingToken) setDialog('redeem');
  }, [pendingToken]);
  const [chatOpen, setChatOpen] = useState(() => window.innerWidth >= 1024);
  const [unread, setUnread] = useState(0);
  const [welcome, setWelcome] = useState(info?.welcomeMessage ?? '');
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(timer);
  }, [notice]);
  const roomId = useClient((s) => s.media?.roomId ?? 'main');
  // 选择器必须返回稳定的引用（zustand 5）：没有共享时用同一个空数组
  const shares = useClient((s) => s.rooms[roomId]?.shares) ?? NO_SHARES;
  const tracks = useVideoTracks();
  const [pttKey, setPttKey] = useState(() => platform.storage.get<string>(PTT_KEY_STORAGE) ?? DEFAULT_PTT_KEY);

  // 有人进入 / 离开当前房间时的提示音；聊天未读数；主持操作和被移动的提示
  const { setMuted } = useVoiceActions();
  useEffect(
    () =>
      client.onEvent((ev) => {
        const s = client.store.getState();
        const room = s.media?.roomId ?? 'main';
        const b = ev.body;
        if (b.case === 'participantJoined' && b.value.participant?.roomId === room) sounds.join();
        if (b.case === 'participantLeft') sounds.leave();
        if (b.case === 'chatMessage' && b.value.senderSessionId !== s.self?.sessionId) setUnread((n) => n + 1);
        if (b.case === 'moderationNotice') {
          setNotice(moderationText(b.value, t));
          // 被强制静音：本地也切到静音（解除后由用户自己开麦）
          if (b.value.action === ModerationAction.FORCE_MUTE) void setMuted(true);
        }
        if (b.case === 'youWereMoved') {
          setNotice(moveText(b.value, s.rooms, t));
          sounds.join();
        }
      }),
    [client, t, setMuted],
  );
  // 切换房间后屏幕共享已结束（共享许可绑定在房间上）
  const lastSwitch = useMedia((s) => s.lastSwitch);
  useEffect(() => {
    if (lastSwitch?.shareStopped) setNotice(t('room.shareStopped'));
  }, [lastSwitch, t]);
  // UDP 不稳定，媒体连接改走 TCP（只提示一次）
  const tcpSwitched = useMedia((s) => s.transport.switched);
  useEffect(() => {
    if (tcpSwitched && tcpSwitched !== 'always') setNotice(t('media.tcpSwitched'));
  }, [tcpSwitched, t]);
  useEffect(() => {
    if (chatOpen) setUnread(0);
  }, [chatOpen, unread]);

  // 按键说话：桌面版用全局热键（窗口不在前台也有效）；网页版只在页面获得焦点时有效
  useEffect(() => {
    if (mode !== 'ptt' || !platform.hotkeys) return;
    const off = platform.hotkeys.registerPushToTalk(pttKey, (pressed) => media.setPushToTalk(pressed));
    return () => {
      off();
      media.setPushToTalk(false);
    };
  }, [mode, pttKey, media, platform]);
  useEffect(() => {
    if (mode !== 'ptt' || platform.hotkeys) return;
    const down = (e: KeyboardEvent) => {
      if (e.code === pttKey && !e.repeat && !isTyping(e)) {
        e.preventDefault();
        media.setPushToTalk(true);
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === pttKey) media.setPushToTalk(false);
    };
    const blur = () => media.setPushToTalk(false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
      media.setPushToTalk(false);
    };
  }, [mode, pttKey, media, platform]);

  const secure = address?.secure ?? true;
  // 桌面版隐藏了系统标题栏：各栏顶部这一行兼作标题栏（可以拖动窗口），并给系统的窗口按钮让出位置（--wco-left / --wco-right）
  const desktop = platform.kind === 'electron';
  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-64 shrink-0 flex-col border-r border-border bg-surface sm:flex">
          <header className="app-drag flex h-12 shrink-0 items-center gap-2 border-b border-border pr-4 pl-[max(1rem,var(--wco-left))]">
            {secure ? <Lock size={14} className="shrink-0 text-success" /> : <Unlock size={14} className="shrink-0 text-warning" />}
            {logo && <img src={logo} alt="" className="size-5 shrink-0 rounded-md object-cover" data-testid="server-logo" />}
            <h1 className="truncate font-semibold" data-testid="server-name">
              {title}
            </h1>
            <E2EEBadge />
          </header>
          <div className="pt-2" />
          <RoomSidebar onNotice={setNotice} />
          <SelfCard onSettings={() => setDialog('settings')} />
        </aside>
        <div className="relative flex min-w-0 flex-1 flex-col">
          {desktop && <StageHeader reserveRight={!chatOpen} />}
          {welcome && (
            <div className="mx-3 mt-3 flex items-start gap-2.5 rounded-xl border border-accent/20 bg-accent/[0.07] px-3 py-2.5 text-sm">
              <Megaphone size={16} className="mt-0.5 shrink-0 text-accent" aria-hidden />
              <p className="flex-1 whitespace-pre-wrap">{welcome}</p>
              <button onClick={() => setWelcome('')} aria-label={t('common.close')} className="rounded-md p-0.5 text-muted hover:text-text">
                <X size={16} />
              </button>
            </div>
          )}
          {/* 浮在舞台上方：状态提示、共享控制条、短暂提示 */}
          <div className={`pointer-events-none absolute inset-x-0 z-20 ${desktop ? 'top-12' : 'top-0'}`}>
            <StatusBanner />
            <ShareBar />
            {notice && (
              <p
                className="pointer-events-auto mx-auto mt-2 flex w-fit max-w-[90%] items-center gap-2 rounded-full border border-border bg-surface/95 px-4 py-1.5 text-sm shadow-lg backdrop-blur"
                role="alert"
                data-testid="notice"
              >
                <Info size={15} className="shrink-0 text-accent" aria-hidden />
                {notice}
              </p>
            )}
          </div>
          {shares.length ? <ShareStage shares={shares} tracks={tracks} /> : <Stage />}
          {mode === 'ptt' && <p className="pb-2 text-center text-xs text-muted">{t('control.pttHint', { key: keyLabel(pttKey) })}</p>}
          <ControlBar
            chatOpen={chatOpen}
            onToggleChat={() => setChatOpen((o) => !o)}
            unread={unread}
            onOpen={setDialog}
            onLeave={() => client.disconnect()}
            onNotice={setNotice}
          />
        </div>
        {chatOpen && <ChatPanel headerClassName="app-drag pr-[max(1rem,var(--wco-right))]" />}
      </div>
      <SettingsDialog
        open={dialog === 'settings'}
        onOpenChange={(o) => setDialog(o ? 'settings' : null)}
        pttKey={pttKey}
        onPttKey={(k) => {
          setPttKey(k);
          platform.storage.set(PTT_KEY_STORAGE, k);
        }}
      />
      <RedeemDialog
        key={pendingToken ?? 'manual'}
        open={dialog === 'redeem'}
        initialToken={pendingToken}
        description={pendingToken ? t('link.tokenPrompt') : undefined}
        onOpenChange={(o) => {
          setDialog(o ? 'redeem' : null);
          if (!o) onTokenHandled?.();
        }}
      />
      {dialog === 'admin' && <AdminDialog open onOpenChange={(o) => setDialog(o ? 'admin' : null)} />}
      <InfoDialog open={dialog === 'info'} onOpenChange={(o) => setDialog(o ? 'info' : null)} />
      <AboutDialog open={dialog === 'about'} onOpenChange={(o) => setDialog(o ? 'about' : null)} />
    </div>
  );
}

/** 桌面版舞台上方的一行：当前房间名和人数，兼作窗口标题栏（可以拖动窗口）；聊天收起时给右上角的窗口按钮让出位置 */
function StageHeader({ reserveRight }: { reserveRight: boolean }) {
  const t = useT();
  const roomId = useClient((s) => s.media?.roomId ?? 'main');
  const room = useClient((s) => s.rooms[roomId]);
  const count = useClient((s) => Object.values(s.participants).filter((p) => p.roomId === roomId).length);
  return (
    <div
      className={`app-drag flex h-12 shrink-0 items-center gap-2 border-b border-border pl-[max(1rem,var(--wco-left))] sm:pl-4 ${
        reserveRight ? 'pr-[max(1rem,var(--wco-right))]' : 'pr-4'
      }`}
    >
      <Volume2 size={15} className="shrink-0 text-accent" aria-hidden />
      <span className="truncate text-sm font-semibold">{room?.name || t('room.main')}</span>
      <span className="rounded-full bg-surface-2 px-1.5 text-[11px] leading-[18px] tabular-nums text-text/75">{t('room.members', { n: count })}</span>
    </div>
  );
}

/** 侧栏底部的个人卡片：自己的昵称、发言方式和网络延迟；齿轮打开设置 */
function SelfCard({ onSettings }: { onSettings: () => void }) {
  const t = useT();
  const me = useClient((s) => (s.self ? s.participants[s.self.sessionId] : undefined));
  const rtt = useClient((s) => s.rttMs);
  const mode = useMedia((s) => s.prefs.mode);
  const speaking = useLevels((s) => (me ? !!s.speaking[me.mediaIdentity] : false));
  if (!me) return null;
  const modeLabel = mode === 'ptt' ? t('settings.modePtt') : mode === 'open' ? t('settings.modeOpen') : t('settings.modeVoice');
  return (
    <div className="m-2 flex items-center gap-2.5 rounded-xl border border-border bg-surface px-3 py-2" data-testid="self-card">
      <Avatar name={me.nickname} uid={me.uid} speaking={speaking} size={32} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1 text-sm font-semibold">
          <span className="truncate">{me.nickname}</span>
          <RoleBadge role={me.role} />
        </div>
        <div className="truncate text-xs text-muted">{rtt != null ? `${modeLabel} · ${rtt} ms` : modeLabel}</div>
      </div>
      <button onClick={onSettings} className="rounded-md p-1.5 text-muted hover:bg-surface-2 hover:text-text" title={t('more.settings')} aria-label={t('more.settings')}>
        <Settings size={16} aria-hidden />
      </button>
    </div>
  );
}
