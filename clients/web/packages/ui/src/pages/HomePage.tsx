import * as DM from '@radix-ui/react-dropdown-menu';
import { ErrorCode } from '@hane/protocol';
import { hostPort, parseAddress } from '@hane/core';
import { ArrowRight, Copy, Ellipsis, LoaderCircle, Lock, LockOpen, NotebookPen, Server, Star, Ticket, Trash2, User, Users, X } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { initials } from '../components/Avatar';
import { ConnectError, DEFAULT_NAME, Field, MicHint, NicknameField, PageFooter, PasswordField, TopBar, inputClass, primaryButton, primaryButtonInline, secondaryButton, shortAddress, useMicPrompt } from '../components/ConnectBits';
import { Dialog } from '../components/Dialog';
import { SettingsButton } from '../dialogs/SettingsDialog';
import { pickLocale, useT } from '../i18n';
import { signalBars, useServerStatus, type ServerStatus } from '../probe';
import { connectTarget, findRecent, forgetServer, loadRecent, looksLikeAddress, matchesServer, relativeTime, rememberServer, updateServer, type RecentServer } from '../recent';
import { useClient, useServices } from '../services';

/** 列表里显示的名称：备注 → 服务器名称 → 地址 */
const titleOf = (r: RecentServer) => r.note?.trim() || r.name || r.address;

function serverUrl(address: string): string {
  try {
    const a = parseAddress(address);
    return `${a.secure ? 'https' : 'http'}://${hostPort(a)}/`;
  } catch {
    return '';
  }
}

/** 信号格：四格表示延迟由低到高，连不上时显示叉号；悬停显示具体延迟 */
function Signal({ status }: { status: ServerStatus | undefined }) {
  const t = useT();
  const bars = status === undefined ? -1 : signalBars(status.ms);
  const color = bars >= 3 ? 'bg-success' : bars === 2 ? 'bg-warning' : 'bg-danger';
  const label = status === undefined ? t('home.probing') : status.ms === null ? t('home.unreachable') : t('home.latency', { ms: status.ms });
  return (
    <span className="group/signal relative flex h-6 items-center px-1" role="img" aria-label={label} data-testid="server-signal">
      <span className="relative flex h-3.5 items-end gap-[2px]" aria-hidden>
        {[1, 2, 3, 4].map((i) => (
          <span key={i} className={`w-[3px] rounded-[1px] ${i <= bars ? color : 'bg-muted/30'} ${bars < 0 ? 'motion-safe:animate-pulse' : ''}`} style={{ height: `${i * 25}%` }} />
        ))}
        {bars === 0 && <X size={9} strokeWidth={3.5} className="absolute -right-1.5 -bottom-1 rounded-full bg-surface text-danger" />}
      </span>
      <span
        aria-hidden
        className="pointer-events-none absolute right-0 bottom-full z-10 mb-1 rounded-md bg-text px-2 py-1 text-xs font-medium whitespace-nowrap text-bg tabular-nums opacity-0 shadow-md transition-opacity group-hover/signal:opacity-100"
      >
        {/* 气泡里连得上时只显示「42 ms」；读屏仍用 aria-label 里的完整说法 */}
        {status?.ms != null ? `${status.ms} ms` : label}
      </span>
    </span>
  );
}

const menuContent = 'z-50 min-w-48 rounded-lg border border-border bg-surface p-1.5 shadow-lg';
const menuItem = 'flex cursor-default items-center gap-2 rounded px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-surface-2';

/** 列表里的一台服务器：点一下连接；右侧是在线人数、信号、收藏和更多操作 */
function ServerRow({ server, status, defaultNickname, connecting, disabled, target, onConnect, onFavorite, onEdit, onForget }: {
  server: RecentServer;
  status: ServerStatus | undefined;
  defaultNickname: string;
  connecting: boolean;
  disabled: boolean;
  /** 在地址栏按回车会连这一台（搜索时高亮） */
  target: boolean;
  onConnect: () => void;
  onFavorite: () => void;
  onEdit: () => void;
  onForget: () => void;
}) {
  const t = useT();
  const locale = useMemo(() => pickLocale(), []);
  const title = titleOf(server);
  const nick = server.nickname || defaultNickname;
  let addr = server.address;
  try {
    addr = shortAddress(parseAddress(server.address));
  } catch {
    // 无法解析：原样显示
  }
  return (
    <li className="group relative">
      <button
        type="button"
        disabled={disabled}
        onClick={onConnect}
        className={`flex w-full items-center gap-3 rounded-[10px] py-2.5 pr-[4.5rem] pl-2.5 text-left sm:gap-2.5 sm:py-1 sm:pr-16 sm:pl-2 transition hover:bg-accent/[0.06] focus-visible:bg-accent/[0.06] focus-visible:outline-none disabled:cursor-wait ${target ? 'bg-accent/[0.08]' : ''}`}
        data-testid="recent-server"
      >
        <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-[10px] bg-accent/10 text-sm font-semibold text-accent sm:size-8 sm:rounded-lg sm:text-xs">
          {connecting ? <LoaderCircle size={16} className="animate-spin" /> : server.note?.trim() || server.name ? initials(title) : <Server size={16} />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium sm:text-[13px]">{title}</span>
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted sm:text-[11px]">
            {title !== server.address && <span className="truncate">{addr}</span>}
            {nick && (
              <span className="flex min-w-0 shrink items-center gap-1" title={t('home.nicknameUsed', { name: nick })}>
                {title !== server.address && <span aria-hidden>·</span>}
                <User size={11} className="shrink-0" aria-hidden />
                <span className="sr-only">{t('connect.nickname')}</span>
                <span className="truncate" data-testid="server-nickname">
                  {nick}
                </span>
              </span>
            )}
            {server.at > 0 && (
              <span className="hidden shrink-0 sm:inline">
                <span aria-hidden>· </span>
                {relativeTime(server.at, locale, t('connect.justNow'))}
              </span>
            )}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {status?.online !== undefined && status.ms !== null && (
            <span className="flex items-center gap-1 text-xs text-muted tabular-nums sm:text-[11px]" title={t('home.online', { n: status.online })} data-testid="server-online">
              <Users size={13} aria-hidden />
              <span className="sr-only">{t('home.online', { n: status.online })}</span>
              <span aria-hidden>{status.online}</span>
            </span>
          )}
          <Signal status={status} />
        </span>
      </button>
      {/* 收藏：收藏过的星星常亮并排在最前面，其余的点一下星星即可收藏 */}
      <button
        type="button"
        onClick={onFavorite}
        aria-pressed={!!server.favorite}
        aria-label={server.favorite ? t('home.unfavorite') : t('home.favorite')}
        title={server.favorite ? t('home.unfavorite') : t('home.favorite')}
        className={`absolute top-1/2 right-9 -translate-y-1/2 rounded-md p-1.5 transition sm:right-7 sm:p-1 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
          server.favorite ? 'text-amber-500' : 'text-muted/60 hover:text-text'
        }`}
        data-testid="server-star"
      >
        <Star size={14} fill={server.favorite ? 'currentColor' : 'none'} aria-hidden />
      </button>
      <DM.Root modal={false}>
        <DM.Trigger
          className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded-md p-1.5 text-muted sm:p-1 transition hover:bg-surface-2 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent data-[state=open]:bg-surface-2"
          aria-label={t('home.menu', { name: title })}
          data-testid="server-menu"
        >
          <Ellipsis size={15} aria-hidden />
        </DM.Trigger>
        <DM.Portal>
          <DM.Content align="end" sideOffset={4} className={menuContent}>
            <DM.Item className={menuItem} onSelect={onEdit} data-testid="server-edit">
              <NotebookPen size={15} aria-hidden />
              {t('home.edit')}
            </DM.Item>
            <DM.Item className={menuItem} onSelect={() => void navigator.clipboard?.writeText(server.address)}>
              <Copy size={15} aria-hidden />
              {t('home.copy')}
            </DM.Item>
            <DM.Separator className="my-1 h-px bg-border" />
            <DM.Item className={`${menuItem} text-danger`} onSelect={onForget} data-testid="recent-forget">
              <Trash2 size={15} aria-hidden />
              {t('home.remove')}
            </DM.Item>
          </DM.Content>
        </DM.Portal>
      </DM.Root>
    </li>
  );
}

function Section({ id, icon, title, children }: { id: string; icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="mt-6">
      <h2 id={id} className="mb-1.5 flex items-center gap-1.5 px-1 text-xs font-medium text-muted sm:text-[11px]">
        {icon}
        {title}
      </h2>
      <ul className="rounded-xl border border-border bg-surface p-1 shadow-sm shadow-black/[0.03]">{children}</ul>
    </section>
  );
}

/** 编辑一台服务器：备注和在这台服务器上用的昵称 */
function EditDialog({ server, defaultNickname, onClose, onSave }: { server: RecentServer | null; defaultNickname: string; onClose: () => void; onSave: (note: string, nickname: string) => void }) {
  const t = useT();
  const ids = useId();
  const [note, setNote] = useState('');
  const [nickname, setNickname] = useState('');
  useEffect(() => {
    if (!server) return;
    setNote(server.note ?? '');
    setNickname(server.nickname ?? '');
  }, [server]);
  return (
    <Dialog narrow open={!!server} onOpenChange={(o) => !o && onClose()} title={t('home.editTitle')} description={server?.address}>
      <form
        className="space-y-4 sm:space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          onSave(note.trim(), nickname.trim());
        }}
      >
        <Field id={`${ids}-note`} label={t('home.note')} icon={<NotebookPen size={18} />}>
          <input
            id={`${ids}-note`}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={server?.name || t('home.notePlaceholder')}
            maxLength={40}
            className={`${inputClass} pr-3`}
            data-testid="edit-note"
          />
        </Field>
        <NicknameField id={`${ids}-nickname`} value={nickname} onChange={setNickname} placeholder={defaultNickname ? t('home.nicknameDefault', { name: defaultNickname }) : undefined} />
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className={secondaryButton} onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className={`${primaryButtonInline} h-10 rounded-lg px-5 sm:h-8 sm:px-4 sm:text-sm`} data-testid="edit-save">
            {t('home.save')}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

interface JoinTarget {
  address: string;
  title: string;
  nickname: string;
  needPassword: boolean;
}

/** 还缺昵称或服务器密码时，连接前先补上 */
function JoinDialog({ target, busy, error, onClose, onSubmit }: { target: JoinTarget | null; busy: boolean; error: unknown; onClose: () => void; onSubmit: (nickname: string, password: string) => void }) {
  const t = useT();
  const ids = useId();
  const [nickname, setNickname] = useState('');
  const [password, setPassword] = useState('');
  const nicknameRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!target) return;
    setNickname(target.nickname);
    setPassword('');
    setTimeout(() => (target.nickname && target.needPassword ? passwordRef : nicknameRef).current?.focus());
  }, [target]);
  const nick = nickname.trim();
  return (
    <Dialog narrow open={!!target} onOpenChange={(o) => !o && onClose()} title={t('home.joinTitle', { name: target?.title ?? '' })} description={target?.title !== target?.address ? target?.address : undefined}>
      <form
        className="space-y-4 sm:space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (nick && !busy) onSubmit(nick, password);
        }}
      >
        <NicknameField id={`${ids}-nickname`} value={nickname} onChange={setNickname} inputRef={nicknameRef} />
        {target?.needPassword && <PasswordField id={`${ids}-password`} value={password} onChange={setPassword} inputRef={passwordRef} />}
        {!!error && <ConnectError error={error} serverUrl={target ? serverUrl(target.address) : undefined} />}
        <button type="submit" disabled={busy || !nick} className={primaryButton} data-testid="join-submit">
          {busy && <LoaderCircle size={18} className="animate-spin" aria-hidden />}
          {busy ? t('connect.connecting') : t('connect.submit')}
          {!busy && <ArrowRight size={17} className="transition-transform group-hover:translate-x-0.5 group-disabled:translate-x-0" aria-hidden />}
        </button>
      </form>
    </Dialog>
  );
}

/**
 * 主页：上方是地址栏（连接按钮在框内右侧），下面是服务器列表（收藏的置顶，点星星即可收藏）。
 * 每台服务器记住自己的昵称；还缺昵称或密码时先弹出对话框补上。
 * linkAddress / invite 来自应用链接（openhane://…?invite=）：预填地址栏，连接时携带邀请码（免服务器密码、可附带角色）。
 */
export function HomePage({ linkAddress, invite }: { linkAddress?: string; invite?: string }) {
  const t = useT();
  const { client, platform } = useServices();
  const status = useClient((s) => s.status);
  const error = useClient((s) => s.error);
  const [recent, setRecent] = useState(() => loadRecent(platform.storage));
  const [address, setAddress] = useState(linkAddress ?? '');
  const [defaultNickname, setDefaultNickname] = useState(platform.storage.get<string>('nickname') ?? '');
  const [connectingTo, setConnectingTo] = useState('');
  /** 最近一次尝试连接的地址：连接失败的提示只对它显示 */
  const [attempt, setAttempt] = useState('');
  const [join, setJoin] = useState<JoinTarget | null>(null);
  const [editing, setEditing] = useState<RecentServer | null>(null);
  const micPrompt = useMicPrompt();
  const busy = status === 'connecting';
  const ids = useId();
  const addressRef = useRef<HTMLInputElement>(null);
  const statuses = useServerStatus(useMemo(() => recent.map((r) => r.address), [recent]));

  // 列表为空或由链接打开时聚焦地址栏（手机上不必一打开就弹出键盘）
  useEffect(() => {
    if (!recent.length || linkAddress) addressRef.current?.focus();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // 输入的是搜索词时不显示加密状态
  const parsed = useMemo(() => {
    if (!looksLikeAddress(address)) return null;
    try {
      return parseAddress(address);
    } catch {
      return null; // 地址不完整
    }
  }, [address]);
  const failed = status === 'failed' && error && attempt ? error : null;

  const submit = async (target: string, nickname: string, password: string) => {
    const a = target.trim();
    setConnectingTo(a);
    setAttempt(a);
    try {
      await client.connect({ address: a, nickname, password: password || undefined, inviteCode: invite });
      platform.storage.set('nickname', nickname);
      setDefaultNickname(nickname);
      const s = client.store.getState().serverInfo;
      // 默认名称与应用同名，记下来没有意义：列表里改为显示地址
      const name = s?.name && s.name !== DEFAULT_NAME ? s.name : '';
      // 每台服务器记住自己用的昵称；最近一次用的昵称同时作为新服务器的默认昵称
      setRecent(rememberServer(platform.storage, { address: a, name, at: Date.now(), password: s?.requiresPassword || undefined, nickname }));
      setJoin(null);
    } catch {
      // 服务器要密码：在对话框里补上；其他错误显示在对话框或地址栏下面（来自 store）
      const code = client.store.getState().error?.code;
      if (code === ErrorCode.PASSWORD_REQUIRED || code === ErrorCode.PASSWORD_INVALID) {
        const r = findRecent(recent, a);
        setJoin((j) => ({ address: a, title: j?.title ?? (r ? titleOf(r) : a), nickname, needPassword: true }));
      }
    } finally {
      setConnectingTo('');
    }
  };

  /** 连接一台服务器：昵称和密码都有就直接连，否则先弹出对话框 */
  const connectTo = (target: string) => {
    const a = target.trim();
    if (!a || busy) return;
    const r = findRecent(recent, a);
    const nickname = r?.nickname || defaultNickname;
    const needPassword = !invite && !!r?.password;
    if (!nickname || needPassword) {
      setAttempt('');
      setJoin({ address: a, title: r ? titleOf(r) : a, nickname, needPassword });
    } else void submit(a, nickname, '');
  };

  // 收藏的排在最前面，其余按最近连接的时间；地址栏兼作搜索框
  const servers = [...recent.filter((r) => r.favorite), ...recent.filter((r) => !r.favorite)];
  const query = address.trim();
  const shown = query ? servers.filter((r) => matchesServer(r, query, defaultNickname)) : servers;
  const target = query ? connectTarget(recent, shown, query) : '';
  const row = (r: RecentServer) => (
    <ServerRow
      key={r.address}
      server={r}
      status={statuses[r.address]}
      defaultNickname={defaultNickname}
      connecting={busy && connectingTo === r.address}
      disabled={busy}
      target={r.address === target}
      onConnect={() => connectTo(r.address)}
      onFavorite={() => setRecent(updateServer(platform.storage, r.address, { favorite: !r.favorite }))}
      onEdit={() => setEditing(r)}
      onForget={() => setRecent(forgetServer(platform.storage, r.address))}
    />
  );

  return (
    <main className="hane-backdrop flex h-full flex-col overflow-y-auto">
      <TopBar trailing={<SettingsButton />} />
      <div className="mx-auto w-full max-w-[40rem] flex-1 px-4 pt-6 pb-10 motion-safe:animate-rise sm:px-6 sm:pt-7">
        <h1 className="sr-only">{t('connect.title')}</h1>
        <form
          className="relative"
          onSubmit={(e) => {
            e.preventDefault();
            connectTo(target);
          }}
        >
          <label htmlFor={`${ids}-address`} className="sr-only">
            {t('connect.address')}
          </label>
          <Server size={16} className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-muted" aria-hidden />
          <input
            ref={addressRef}
            id={`${ids}-address`}
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setAddress('')}
            placeholder={t('home.addressHint')}
            className="h-12 w-full rounded-[14px] border border-border bg-surface pr-[7.5rem] pl-10 text-base shadow-sm sm:h-10 sm:rounded-xl sm:pr-28 sm:text-sm shadow-black/[0.04] outline-none transition-[border-color,box-shadow] placeholder:text-muted hover:border-muted/50 focus:border-accent focus:ring-4 focus:ring-accent/15"
            inputMode="url"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            data-testid="address"
          />
          <span className="absolute inset-y-0 right-1.5 flex items-center gap-1">
            {parsed && (
              <span role="img" aria-label={parsed.secure ? t('connect.secure') : t('connect.insecure')} title={parsed.secure ? t('connect.secure') : t('connect.insecure')} className={`p-1.5 ${parsed.secure ? 'text-success' : 'text-warning'}`}>
                {parsed.secure ? <Lock size={15} aria-hidden /> : <LockOpen size={15} aria-hidden />}
              </span>
            )}
            <button type="submit" disabled={busy || !address.trim()} className={`${primaryButtonInline} h-9 rounded-[10px] px-3.5 text-sm sm:h-7 sm:rounded-lg sm:px-3 sm:text-[13px]`} data-testid="connect">
              {busy && connectingTo === target ? <LoaderCircle size={14} className="animate-spin" aria-hidden /> : null}
              {t('connect.submit')}
              {!(busy && connectingTo === target) && <ArrowRight size={14} className="transition-transform group-hover:translate-x-0.5 group-disabled:translate-x-0" aria-hidden />}
            </button>
          </span>
        </form>
        <div className="mt-3 space-y-3 px-1 empty:hidden">
          {parsed && !parsed.secure && <p className="text-xs text-muted">{t('connect.insecure')}</p>}
          {invite && (
            <p className="flex items-center gap-2 rounded-lg border border-accent/25 bg-accent/[0.07] px-3 py-2 text-sm" data-testid="invite-banner">
              <Ticket size={15} className="shrink-0 text-accent" aria-hidden />
              {t('invite.via')}
            </p>
          )}
          {failed && !join && <ConnectError error={failed} serverUrl={serverUrl(attempt)} />}
          {micPrompt && <MicHint />}
        </div>

        {shown.length > 0 && (
          <Section id={`${ids}-servers`} icon={<Server size={13} aria-hidden />} title={t('home.servers')}>
            {shown.map(row)}
          </Section>
        )}
        {servers.length > 0 && shown.length === 0 && (
          <p className="mt-6 px-1 text-sm text-muted sm:text-[13px]" data-testid="search-empty">
            {t('home.noMatch')}
          </p>
        )}
        {recent.length === 0 && (
          <div className="mt-10 flex flex-col items-center rounded-2xl border border-dashed border-border px-6 py-10 text-center" data-testid="recent-empty">
            <span className="flex size-11 items-center justify-center rounded-full bg-surface-2 text-muted">
              <Server size={20} aria-hidden />
            </span>
            <p className="mt-3 text-sm font-medium">{t('home.empty')}</p>
            <p className="mt-1 max-w-[22rem] text-xs leading-relaxed text-balance text-muted">{t('home.emptyHint')}</p>
          </div>
        )}
      </div>
      <PageFooter />

      <JoinDialog target={join} busy={busy} error={join && join.address === attempt ? failed : null} onClose={() => setJoin(null)} onSubmit={(nick, pw) => join && void submit(join.address, nick, pw)} />
      <EditDialog
        server={editing}
        defaultNickname={defaultNickname}
        onClose={() => setEditing(null)}
        onSave={(note, nickname) => {
          if (editing) setRecent(updateServer(platform.storage, editing.address, { note, nickname }));
          setEditing(null);
        }}
      />
    </main>
  );
}
