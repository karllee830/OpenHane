import { ErrorCode } from '@hane/protocol';
import { hostPort, parseAddress } from '@hane/core';
import { ArrowRight, ExternalLink, LoaderCircle, Ticket } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { ConnectError, MicHint, NicknameField, PageFooter, PasswordField, TopBar, primaryButton, secondaryButton, shortAddress, useMicPrompt } from '../components/ConnectBits';
import { SettingsButton } from '../dialogs/SettingsDialog';
import { useT } from '../i18n';
import { fetchInfo, logoUrl, useLogoImage } from '../probe';
import { cleanServerName } from '../recent';
import { useClient, useServices } from '../services';

interface PublicInfo {
  name: string;
  requiresPassword: boolean;
  /** 服务器图标的地址；没有设置时为空 */
  logo: string;
}

/** 网页由服务器提供（同源），连接前就能读到服务器名称和是否需要密码（GET /api/v1/info） */
function usePublicInfo(serverUrl: string): PublicInfo | null {
  const [info, setInfo] = useState<PublicInfo | null>(null);
  useEffect(() => {
    let url: string;
    try {
      url = new URL('api/v1/info', serverUrl).href;
    } catch {
      return;
    }
    let alive = true;
    fetchInfo(url)
      .then(
        (j) =>
          alive &&
          setInfo({
            name: cleanServerName(j.name),
            requiresPassword: j.requires_password === true,
            logo: logoUrl(j.logo, url) ?? '',
          }),
      )
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [serverUrl]);
  return info;
}

/** 页面骨架：顶栏、垂直居中的内容、页脚 */
function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="hane-backdrop flex h-full flex-col overflow-y-auto">
      <TopBar trailing={<SettingsButton />} />
      <div className="mx-auto my-auto w-full max-w-[25rem] px-5 py-8 motion-safe:animate-rise sm:py-10">{children}</div>
      <PageFooter />
    </main>
  );
}

/**
 * 网页加入页：网页由服务器提供时只能连这一台，只需要填昵称（需要时填服务器密码）。标题显示服务器名称。
 * invite 来自邀请链接（/j/<码>）：连接时携带，免服务器密码、可附带角色。
 * landing 为 true 时（邀请落地页）先让用户选择「打开羽见应用」或「在浏览器中加入」。
 */
export function ConnectPage({ address, invite, landing }: { address: string; invite?: string; landing?: boolean }) {
  const t = useT();
  const { client, platform } = useServices();
  const status = useClient((s) => s.status);
  const error = useClient((s) => s.error);
  const [nickname, setNickname] = useState(platform.storage.get<string>('nickname') ?? '');
  const [password, setPassword] = useState('');
  const [inBrowser, setInBrowser] = useState(!landing);
  const micPrompt = useMicPrompt();
  const busy = status === 'connecting';
  const ids = useId();
  const nicknameRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  const parsed = useMemo(() => {
    try {
      return parseAddress(address);
    } catch {
      return null;
    }
  }, [address]);
  const serverUrl = parsed ? `${parsed.secure ? 'https' : 'http'}://${hostPort(parsed)}/` : '';
  const info = usePublicInfo(serverUrl);
  const logo = useLogoImage(info?.logo || undefined);
  const passwordRejected = error?.code === ErrorCode.PASSWORD_REQUIRED || error?.code === ErrorCode.PASSWORD_INVALID;
  // 服务器需要密码时直接显示密码框，不必先失败一次；邀请链接免密码
  const needPassword = passwordRejected || password !== '' || (!invite && !!info?.requiresPassword);

  useEffect(() => {
    if (!inBrowser) return;
    (!nickname.trim() || !needPassword ? nicknameRef : passwordRef).current?.focus();
  }, [inBrowser]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (passwordRejected) passwordRef.current?.focus();
  }, [passwordRejected, error]);

  const nick = nickname.trim();
  const submit = async () => {
    if (!nick || busy) return;
    try {
      await client.connect({ address, nickname: nick, password: password || undefined, inviteCode: invite });
      platform.storage.set('nickname', nick);
    } catch {
      // 错误显示在表单里（来自 store）
    }
  };

  if (!inBrowser && invite) {
    const appLink = parsed ? `openhane://${hostPort(parsed)}?invite=${encodeURIComponent(invite)}` : '';
    return (
      <Shell>
        <span className="flex size-12 items-center justify-center rounded-2xl bg-accent/10 text-accent">
          <Ticket size={22} aria-hidden />
        </span>
        <h1 className="mt-5 text-2xl font-semibold tracking-tight text-balance">{info?.name ? t('invite.landingNamed', { name: info.name }) : t('invite.landingTitle')}</h1>
        {parsed && <p className="mt-1.5 truncate text-sm text-muted">{shortAddress(parsed)}</p>}
        <div className="mt-7 space-y-2.5">
          {appLink && (
            <a href={appLink} className={primaryButton} data-testid="invite-open-app">
              <ExternalLink size={16} aria-hidden />
              {t('invite.openApp')}
            </a>
          )}
          <button className={`${secondaryButton} h-11 w-full`} onClick={() => setInBrowser(true)} data-testid="invite-browser">
            {t('invite.inBrowser')}
          </button>
        </div>
        <p className="mt-5 text-xs leading-relaxed text-muted">{t('invite.appHint')}</p>
      </Shell>
    );
  }

  return (
    <Shell>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {logo && <img src={logo} alt="" className="mb-5 size-14 rounded-2xl object-cover shadow-sm" data-testid="server-logo" />}
        <h1 className="text-2xl font-semibold tracking-tight text-balance">{info?.name ? t('connect.joinNamed', { name: info.name }) : t('connect.joinTitle')}</h1>
        {parsed && <p className="mt-1.5 truncate text-sm text-muted">{shortAddress(parsed)}</p>}
        {invite && (
          <p className="mt-5 flex items-center gap-2 rounded-lg border border-accent/25 bg-accent/[0.07] px-3 py-2 text-sm" data-testid="invite-banner">
            <Ticket size={15} className="shrink-0 text-accent" aria-hidden />
            {t('invite.via')}
          </p>
        )}
        <div className="mt-7 space-y-4">
          <NicknameField id={`${ids}-nickname`} value={nickname} onChange={setNickname} inputRef={nicknameRef} />
          {needPassword && <PasswordField id={`${ids}-password`} value={password} onChange={setPassword} inputRef={passwordRef} />}
        </div>
        {error && status === 'failed' && <ConnectError error={error} serverUrl={serverUrl} className="mt-4" />}
        <button type="submit" disabled={busy || !nick} className={`${primaryButton} mt-6`} data-testid="connect">
          {busy && <LoaderCircle size={18} className="animate-spin" aria-hidden />}
          {busy ? t('connect.connecting') : t('connect.joinSubmit')}
          {!busy && <ArrowRight size={17} className="transition-transform group-hover:translate-x-0.5 group-disabled:translate-x-0" aria-hidden />}
        </button>
        {micPrompt && (
          <div className="mt-4">
            <MicHint />
          </div>
        )}
      </form>
    </Shell>
  );
}
