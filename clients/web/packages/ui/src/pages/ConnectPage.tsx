import { ErrorCode } from '@hane/protocol';
import { DEFAULT_PORT, hostPort, parseAddress, type ServerAddress } from '@hane/core';
import { ArrowRight, CircleAlert, ExternalLink, Eye, EyeOff, History, KeyRound, LoaderCircle, Lock, LockOpen, Mic, Server, ShieldCheck, Ticket, User, X } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { initials } from '../components/Avatar';
import { LogoMark } from '../components/LogoMark';
import { AboutDialog } from '../dialogs/AboutDialog';
import { useUpdateState } from '../components/Updates';
import { describeError } from '../errors';
import { pickLocale, useT } from '../i18n';
import { findRecent, forgetServer, loadRecent, relativeTime, rememberServer, type RecentServer } from '../recent';
import { useClient, useServices } from '../services';

/** 标题下显示的地址：省略默认端口（9800，以及 https 的 443、http 的 80） */
function shortAddress(a: ServerAddress): string {
  const host = a.host.includes(':') ? `[${a.host}]` : a.host;
  return a.port === DEFAULT_PORT || a.port === (a.secure ? 443 : 80) ? host : `${host}:${a.port}`;
}

/** 服务器的默认名称（与产品同名）：标题里不再重复 */
const DEFAULT_NAME = 'OpenHane';

interface PublicInfo {
  name: string;
  requiresPassword: boolean;
}

/** 网页由服务器提供时（同源），连接前就能读到服务器名称和是否需要密码（GET /api/v1/info） */
function usePublicInfo(serverUrl: string): PublicInfo | null {
  const [info, setInfo] = useState<PublicInfo | null>(null);
  useEffect(() => {
    let url: URL;
    try {
      url = new URL('api/v1/info', serverUrl);
    } catch {
      return;
    }
    if (url.origin !== location.origin) return; // 跨域请求会被浏览器拦下（服务端不提供 CORS）
    const ac = new AbortController();
    fetch(url, { signal: ac.signal, cache: 'no-store' })
      .then((r) => (r.ok ? (r.json() as Promise<{ name?: unknown; requires_password?: unknown }>) : null))
      .then((j) => j && setInfo({ name: typeof j.name === 'string' && j.name.trim() !== DEFAULT_NAME ? j.name.trim() : '', requiresPassword: j.requires_password === true }))
      .catch(() => undefined);
    return () => ac.abort();
  }, [serverUrl]);
  return info;
}

const inputClass =
  'h-11 w-full rounded-lg border border-border bg-bg pl-11 text-base outline-none transition-[border-color,box-shadow] placeholder:text-muted hover:border-muted/50 focus:border-accent focus:ring-4 focus:ring-accent/15 sm:text-[15px]';
const primaryButton =
  'group flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-accent-solid font-medium text-white shadow-md shadow-accent-solid/25 transition hover:brightness-110 active:brightness-95 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-accent/30 disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none';

/** 带图标的输入框：标签在上，图标在框内左侧，trailing 在框内右侧（例如显示密码的按钮） */
function Field({ id, label, icon, trailing, children }: { id: string; label: string; icon: ReactNode; trailing?: ReactNode; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium">
        {label}
      </label>
      <div className="relative">
        <span className="pointer-events-none absolute inset-y-0 left-3 flex w-6 items-center justify-center text-muted">{icon}</span>
        {children}
        {trailing && <span className="absolute inset-y-0 right-1.5 flex items-center">{trailing}</span>}
      </div>
    </div>
  );
}

function Brand() {
  const t = useT();
  return (
    <div className="flex flex-col items-center text-center">
      <span className="drop-shadow-[0_10px_24px_rgb(88_169_254/0.4)]">
        <LogoMark size={56} />
      </span>
      {/* 字标：「Hane」是图标那种通透的玻璃质感（index.css 的 brand-glass；行内 span 不打断单词，屏幕阅读器仍读作 OpenHane） */}
      <p className="mt-4 text-2xl font-semibold tracking-tight">
        Open<span className="brand-glass">Hane</span>
      </p>
      <p className="mt-1 text-sm text-muted">{t('connect.tagline')}</p>
    </div>
  );
}

/** 页面骨架：内容居中；wide 时（有最近连接）宽屏上分成两栏 */
function Shell({ wide, children }: { wide?: boolean; children: ReactNode }) {
  return (
    <main className="hane-backdrop flex min-h-full flex-col items-center px-4 py-10 sm:py-12">
      <div className={`my-auto w-full max-w-[25rem] motion-safe:animate-rise ${wide ? 'lg:max-w-[52rem]' : ''}`}>{children}</div>
    </main>
  );
}

const card = 'rounded-2xl border border-border bg-surface shadow-xl shadow-black/[0.04] dark:shadow-black/30';

/**
 * 连接页（地址 → 昵称 → 连接）。invite 来自邀请链接（网页 /j/<码>、应用链接 ?invite=）：连接时携带，免服务器密码、可附带角色。
 * landing 为 true 时（网页邀请落地页）先让用户选择「打开羽见应用」或「在浏览器中加入」。
 * 网页由服务器提供时（defaultAddress）不显示地址栏和最近连接，标题显示服务器名称。
 */
export function ConnectPage({ defaultAddress, linkAddress, invite, landing }: { defaultAddress?: string; linkAddress?: string; invite?: string; landing?: boolean }) {
  const t = useT();
  const locale = useMemo(() => pickLocale(), []);
  const { client, platform } = useServices();
  const status = useClient((s) => s.status);
  const error = useClient((s) => s.error);
  const [recent, setRecent] = useState(() => loadRecent(platform.storage));
  const [address, setAddress] = useState(defaultAddress ?? linkAddress ?? recent[0]?.address ?? '');
  const [nickname, setNickname] = useState(platform.storage.get<string>('nickname') ?? '');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const update = useUpdateState();
  const [inBrowser, setInBrowser] = useState(!landing);
  const busy = status === 'connecting';
  const ids = useId();
  const addressRef = useRef<HTMLInputElement>(null);
  const nicknameRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  // 首次使用：浏览器还没授权麦克风时，先说明用途，再由浏览器弹出授权框
  const [micPrompt, setMicPrompt] = useState(false);
  useEffect(() => {
    let alive = true;
    navigator.permissions
      ?.query({ name: 'microphone' as PermissionName })
      .then((p) => alive && setMicPrompt(p.state === 'prompt'))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const parsed = useMemo(() => {
    try {
      return parseAddress(address);
    } catch {
      return null; // 地址不完整
    }
  }, [address]);
  const serverUrl = parsed ? `${parsed.secure ? 'https' : 'http'}://${hostPort(parsed)}/` : '';
  const info = usePublicInfo(defaultAddress ? serverUrl : '');
  const known = findRecent(recent, address);
  const passwordRejected = error?.code === ErrorCode.PASSWORD_REQUIRED || error?.code === ErrorCode.PASSWORD_INVALID;
  // 已知服务器需要密码时直接显示密码框，不必先失败一次；邀请链接免密码
  const needPassword = passwordRejected || password !== '' || (!invite && (!!known?.password || !!info?.requiresPassword));

  // 打开页面时聚焦第一个需要填写的输入框（只在页面出现时执行一次，之后由用户自己切换焦点）
  useEffect(() => {
    if (!inBrowser) return;
    const target = !defaultAddress && !address.trim() ? addressRef : !nickname.trim() ? nicknameRef : needPassword ? passwordRef : defaultAddress ? nicknameRef : addressRef;
    target.current?.focus();
  }, [inBrowser]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (passwordRejected) passwordRef.current?.focus();
  }, [passwordRejected, error]);

  const submit = async (target = address) => {
    const a = target.trim();
    const nick = nickname.trim();
    if (!a || !nick || busy) return;
    try {
      await client.connect({ address: a, nickname: nick, password: password || undefined, inviteCode: invite });
      platform.storage.set('nickname', nick);
      if (!defaultAddress) {
        const s = client.store.getState().serverInfo;
        // 默认名称与应用同名，记下来没有意义：列表里改为显示地址
        const name = s?.name && s.name !== DEFAULT_NAME ? s.name : '';
        rememberServer(platform.storage, { address: a, name, at: Date.now(), password: s?.requiresPassword || undefined });
      }
    } catch {
      // 错误显示在表单里（来自 store）
    }
  };

  // 最近连接：点一下直接连接；还缺昵称或密码时先补上
  const pick = (r: RecentServer) => {
    setAddress(r.address);
    if (!nickname.trim()) nicknameRef.current?.focus();
    else if (r.password && !invite && !password) setTimeout(() => passwordRef.current?.focus());
    else void submit(r.address);
  };

  if (!inBrowser && invite) {
    let appLink = '';
    try {
      appLink = `openhane://${hostPort(parseAddress(address))}?invite=${encodeURIComponent(invite)}`;
    } catch {
      // 地址无效：只提供在浏览器中加入
    }
    return (
      <Shell>
        <Brand />
        <div className={`${card} mt-8 p-6 text-center sm:p-7`}>
          <span className="mx-auto flex size-12 items-center justify-center rounded-full bg-accent/10 text-accent">
            <Ticket size={22} aria-hidden />
          </span>
          <h1 className="mt-4 text-lg font-semibold text-balance">{info?.name ? t('invite.landingNamed', { name: info.name }) : t('invite.landingTitle')}</h1>
          {parsed && <p className="mt-1 truncate text-sm text-muted">{shortAddress(parsed)}</p>}
          <div className="mt-6 space-y-2.5">
            {appLink && (
              <a href={appLink} className={primaryButton} data-testid="invite-open-app">
                <ExternalLink size={16} aria-hidden />
                {t('invite.openApp')}
              </a>
            )}
            <button
              className="flex h-11 w-full items-center justify-center rounded-lg border border-border font-medium transition hover:bg-accent/[0.06] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-accent/30"
              onClick={() => setInBrowser(true)}
              data-testid="invite-browser"
            >
              {t('invite.inBrowser')}
            </button>
          </div>
          <p className="mt-5 text-xs leading-relaxed text-muted">{t('invite.appHint')}</p>
        </div>
      </Shell>
    );
  }

  const hosted = !!defaultAddress;
  const title = hosted ? (info?.name ? t('connect.joinNamed', { name: info.name }) : t('connect.joinTitle')) : t('connect.title');
  const subtitle = hosted ? (parsed ? shortAddress(parsed) : '') : t('connect.subtitle');
  const nick = nickname.trim();

  const showRecent = !hosted && recent.length > 0;
  return (
    <Shell wide={showRecent}>
      <Brand />
      <div className={`mt-8 ${showRecent ? 'grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,25rem)_minmax(0,1fr)] lg:items-start lg:gap-5' : ''}`}>
        <form
          className={`${card} p-6 sm:p-7`}
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <h1 className="text-lg font-semibold text-balance">{title}</h1>
          {subtitle && <p className={`mt-0.5 text-sm text-muted ${hosted ? 'truncate' : ''}`}>{subtitle}</p>}
          {invite && (
            <p className="mt-4 flex items-center gap-2 rounded-lg border border-accent/25 bg-accent/[0.07] px-3 py-2 text-sm" data-testid="invite-banner">
              <Ticket size={15} className="shrink-0 text-accent" aria-hidden />
              {t('invite.via')}
            </p>
          )}

          <div className="mt-5 space-y-4">
            {!hosted && (
              <Field
                id={`${ids}-address`}
                label={t('connect.address')}
                icon={<Server size={18} />}
                trailing={
                  parsed && (
                    <span
                      role="img"
                      aria-label={parsed.secure ? t('connect.secure') : t('connect.insecure')}
                      title={parsed.secure ? t('connect.secure') : t('connect.insecure')}
                      className={`p-1.5 ${parsed.secure ? 'text-success' : 'text-warning'}`}
                    >
                      {parsed.secure ? <Lock size={15} aria-hidden /> : <LockOpen size={15} aria-hidden />}
                    </span>
                  )
                }
              >
                <input
                  ref={addressRef}
                  id={`${ids}-address`}
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  placeholder={t('connect.addressHint')}
                  className={`${inputClass} pr-10`}
                  inputMode="url"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  data-testid="address"
                  required
                />
              </Field>
            )}
            {!hosted && parsed && !parsed.secure && <p className="-mt-2 text-xs text-muted">{t('connect.insecure')}</p>}

            <Field
              id={`${ids}-nickname`}
              label={t('connect.nickname')}
              icon={
                nick ? (
                  <span className="flex size-6 items-center justify-center rounded-full bg-accent-solid text-xs font-semibold text-white">{initials(nick)}</span>
                ) : (
                  <User size={18} />
                )
              }
            >
              <input
                ref={nicknameRef}
                id={`${ids}-nickname`}
                value={nickname}
                onChange={(e) => setNickname(e.target.value)}
                placeholder={t('connect.nicknameHint')}
                maxLength={32}
                autoComplete="nickname"
                className={`${inputClass} pr-3`}
                data-testid="nickname"
                required
              />
            </Field>

            {needPassword && (
              <Field
                id={`${ids}-password`}
                label={t('connect.password')}
                icon={<KeyRound size={18} />}
                trailing={
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? t('connect.hidePassword') : t('connect.showPassword')}
                    aria-pressed={showPassword}
                    className="rounded-md p-1.5 text-muted transition hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  >
                    {showPassword ? <EyeOff size={16} aria-hidden /> : <Eye size={16} aria-hidden />}
                  </button>
                }
              >
                <input
                  ref={passwordRef}
                  id={`${ids}-password`}
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={t('connect.passwordHint')}
                  className={`${inputClass} pr-10`}
                  data-testid="password"
                />
              </Field>
            )}
          </div>

          {error && status === 'failed' && (
            <div className="mt-4 flex gap-2.5 rounded-lg border border-danger/30 bg-danger/[0.07] px-3 py-2.5 text-sm" role="alert" data-testid="connect-error">
              <CircleAlert size={16} className="mt-0.5 shrink-0 text-danger" aria-hidden />
              <p className="min-w-0 break-words">{describeError(error, t, serverUrl)}</p>
            </div>
          )}

          <button type="submit" disabled={busy || !nick || !address.trim()} className={`${primaryButton} mt-5`} data-testid="connect">
            {busy && <LoaderCircle size={18} className="animate-spin" aria-hidden />}
            {busy ? t('connect.connecting') : hosted ? t('connect.joinSubmit') : t('connect.submit')}
            {!busy && <ArrowRight size={17} className="transition-transform group-hover:translate-x-0.5 group-disabled:translate-x-0" aria-hidden />}
          </button>
          {micPrompt && (
            <p className="mt-4 flex items-start gap-2 text-xs leading-relaxed text-muted" data-testid="mic-hint">
              <Mic size={14} className="mt-px shrink-0" aria-hidden />
              {t('connect.micHint')}
            </p>
          )}
        </form>

        {showRecent && (
          <section className={`${card} p-1.5`} aria-labelledby={`${ids}-recent`}>
            <h2 id={`${ids}-recent`} className="flex items-center gap-1.5 px-3 pb-1 pt-2 text-xs font-medium text-muted">
              <History size={13} aria-hidden />
              {t('connect.recent')}
            </h2>
            <ul>
              {recent.map((r) => (
                <li key={r.address} className="group relative">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => pick(r)}
                    className="flex w-full items-center gap-3 rounded-xl py-2 pl-2.5 pr-11 text-left transition hover:bg-accent/[0.06] focus-visible:bg-accent/[0.06] focus-visible:outline-none disabled:cursor-wait"
                    data-testid="recent-server"
                  >
                    <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-sm font-semibold text-accent">
                      {r.name ? initials(r.name) : <Server size={16} />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{r.name || r.address}</span>
                      {(r.name || r.at > 0) && (
                        <span className="block truncate text-xs text-muted">{[r.name && r.address, r.at > 0 && relativeTime(r.at, locale, t('connect.justNow'))].filter(Boolean).join(' · ')}</span>
                      )}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setRecent(forgetServer(platform.storage, r.address))}
                    aria-label={t('connect.forget', { name: r.name || r.address })}
                    title={t('connect.forget', { name: r.name || r.address })}
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-1.5 text-muted transition hover:bg-surface-2 hover:text-text focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent sm:opacity-0 sm:group-hover:opacity-100"
                    data-testid="recent-forget"
                  >
                    <X size={15} aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>

      <footer className="mt-6 space-y-1 text-center text-xs text-muted">
        {update?.status === 'ready' && (
          <p>
            <button className="text-accent hover:underline" onClick={() => platform.updates?.install()} data-testid="update-ready">
              {t('update.ready', { version: update.version ?? '' })}
            </button>
          </p>
        )}
        <p className="mx-auto max-w-[22rem] text-balance">
          <ShieldCheck size={13} className="mr-1 inline -translate-y-px" aria-hidden />
          {platform.kind === 'electron' ? t('connect.identityDesktop') : t('connect.identity')}
        </p>
        <p>
          <button className="hover:text-text hover:underline" onClick={() => setAboutOpen(true)} data-testid="about-open">
            {t('app.name')} {client.appVersion} · {t('more.about')}
          </button>
        </p>
      </footer>
      <AboutDialog open={aboutOpen} onOpenChange={setAboutOpen} />
    </Shell>
  );
}
