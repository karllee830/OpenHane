// 主页（服务器列表）和网页加入页共用的部分：顶栏、输入框、按钮样式、错误提示、页脚。
import { DEFAULT_PORT, type ServerAddress } from '@hane/core';
import { CircleAlert, Eye, EyeOff, KeyRound, Mic, ShieldCheck, User } from 'lucide-react';
import { useEffect, useState, type ReactNode, type Ref } from 'react';
import { AboutDialog } from '../dialogs/AboutDialog';
import { describeError } from '../errors';
import { useT } from '../i18n';
import { useServices } from '../services';
import { initials } from './Avatar';
import { LogoMark } from './LogoMark';
import { useUpdateState } from './Updates';

/** 显示用的地址：省略默认端口（9800，以及 https 的 443、http 的 80） */
export function shortAddress(a: ServerAddress): string {
  const host = a.host.includes(':') ? `[${a.host}]` : a.host;
  return a.port === DEFAULT_PORT || a.port === (a.secure ? 443 : 80) ? host : `${host}:${a.port}`;
}

/** 服务器的默认名称（与产品同名）：标题和列表里不再重复 */
export const DEFAULT_NAME = 'OpenHane';

export const inputClass =
  'h-11 w-full rounded-lg border border-border bg-surface pl-11 text-base outline-none transition-[border-color,box-shadow] placeholder:text-muted hover:border-muted/50 focus:border-accent focus:ring-4 focus:ring-accent/15 sm:h-9 sm:pl-10 sm:text-sm';
export const primaryButton =
  'group flex h-11 w-full rounded-lg sm:h-9 sm:text-sm items-center justify-center gap-2 bg-accent-solid font-medium text-white shadow-md shadow-accent-solid/25 transition hover:brightness-110 active:brightness-95 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-accent/30 disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none';
/** 不占满整行的主按钮（对话框底部、地址栏里）：高度和圆角由使用的地方指定 */
export const primaryButtonInline = primaryButton.replace('h-11 w-full rounded-lg sm:h-9 sm:text-sm ', 'shrink-0 whitespace-nowrap ');
export const secondaryButton =
  'flex h-10 shrink-0 items-center justify-center whitespace-nowrap rounded-lg border border-border bg-surface px-4 font-medium transition sm:h-8 sm:px-3 sm:text-sm hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-accent/30';

/** 带图标的输入框：标签在上，图标在框内左侧，trailing 在框内右侧（例如显示密码的按钮） */
export function Field({ id, label, icon, trailing, children }: { id: string; label: string; icon: ReactNode; trailing?: ReactNode; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium sm:mb-1 sm:text-[13px]">
        {label}
      </label>
      <div className="relative">
        <span className="pointer-events-none absolute inset-y-0 left-3 flex w-6 items-center justify-center text-muted sm:left-2.5 sm:w-5 sm:[&_svg]:size-4">{icon}</span>
        {children}
        {trailing && <span className="absolute inset-y-0 right-1.5 flex items-center">{trailing}</span>}
      </div>
    </div>
  );
}

/** 昵称输入框：框内左侧是头像预览 */
export function NicknameField({ id, value, onChange, placeholder, inputRef }: { id: string; value: string; onChange: (v: string) => void; placeholder?: string; inputRef?: Ref<HTMLInputElement> }) {
  const t = useT();
  const nick = value.trim();
  return (
    <Field
      id={id}
      label={t('connect.nickname')}
      icon={nick ? <span className="flex size-6 items-center justify-center rounded-full bg-accent-solid text-xs font-semibold text-white sm:size-5 sm:text-[10px]">{initials(nick)}</span> : <User size={18} />}
    >
      <input
        ref={inputRef}
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder ?? t('connect.nicknameHint')}
        maxLength={32}
        autoComplete="nickname"
        className={`${inputClass} pr-3`}
        data-testid="nickname"
      />
    </Field>
  );
}

/** 服务器密码输入框：右侧可以切换显示密码 */
export function PasswordField({ id, value, onChange, inputRef }: { id: string; value: string; onChange: (v: string) => void; inputRef?: Ref<HTMLInputElement> }) {
  const t = useT();
  const [show, setShow] = useState(false);
  return (
    <Field
      id={id}
      label={t('connect.password')}
      icon={<KeyRound size={18} />}
      trailing={
        <button
          type="button"
          onClick={() => setShow((v) => !v)}
          aria-label={show ? t('connect.hidePassword') : t('connect.showPassword')}
          aria-pressed={show}
          className="rounded-md p-1.5 text-muted transition hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          {show ? <EyeOff size={16} aria-hidden /> : <Eye size={16} aria-hidden />}
        </button>
      }
    >
      <input
        ref={inputRef}
        id={id}
        type={show ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t('connect.passwordHint')}
        className={`${inputClass} pr-10`}
        data-testid="password"
      />
    </Field>
  );
}

/** 连接失败的原因和建议 */
export function ConnectError({ error, serverUrl, className = '' }: { error: unknown; serverUrl?: string; className?: string }) {
  const t = useT();
  return (
    <div className={`flex gap-2.5 rounded-lg border border-danger/30 bg-danger/[0.07] px-3 py-2.5 text-sm sm:gap-2 sm:py-2 sm:text-[13px] ${className}`} role="alert" data-testid="connect-error">
      <CircleAlert size={16} className="mt-0.5 shrink-0 text-danger" aria-hidden />
      <p className="min-w-0 break-words">{describeError(error, t, serverUrl)}</p>
    </div>
  );
}

/** 品牌字标：英文的「Hane」、中文的「羽」是图标那种通透的玻璃质感（index.css 的 brand-glass；行内 span 不打断单词，屏幕阅读器仍读作完整名称） */
function Wordmark() {
  const t = useT();
  const name = t('app.name');
  const glass = t('brand.glass');
  const at = name.indexOf(glass);
  return (
    <span className="text-[15px] font-semibold tracking-tight">
      {name.slice(0, at)}
      <span className="brand-glass">{glass}</span>
      {name.slice(at + glass.length)}
    </span>
  );
}

/** 顶栏：左上角是标识和字标，右侧放按钮。桌面版隐藏了系统标题栏，这一行兼作标题栏（可以拖动窗口，两侧让出系统的窗口按钮） */
export function TopBar({ trailing }: { trailing?: ReactNode }) {
  return (
    <header className="app-drag flex h-12 shrink-0 items-center gap-2.5 pr-[max(0.75rem,var(--wco-right))] pl-[max(1.25rem,var(--wco-left))]">
      <LogoMark size={22} />
      <Wordmark />
      <span className="flex-1" />
      {trailing}
    </header>
  );
}

/** 首次使用：浏览器还没授权麦克风时，先说明用途，再由浏览器弹出授权框 */
export function useMicPrompt(): boolean {
  const [prompt, setPrompt] = useState(false);
  useEffect(() => {
    let alive = true;
    navigator.permissions
      ?.query({ name: 'microphone' as PermissionName })
      .then((p) => alive && setPrompt(p.state === 'prompt'))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  return prompt;
}

export function MicHint() {
  const t = useT();
  return (
    <p className="flex items-start gap-2 text-xs leading-relaxed text-muted" data-testid="mic-hint">
      <Mic size={14} className="mt-px shrink-0" aria-hidden />
      {t('connect.micHint')}
    </p>
  );
}

/** 页脚：身份保存在哪里、版本号和「关于」、已下载的更新 */
export function PageFooter() {
  const t = useT();
  const { client, platform } = useServices();
  const update = useUpdateState();
  const [aboutOpen, setAboutOpen] = useState(false);
  return (
    <footer className="flex shrink-0 flex-col items-center gap-x-6 gap-y-1.5 px-5 py-4 text-center text-xs text-muted sm:flex-row sm:justify-between sm:py-3 sm:text-left sm:text-[11px]">
      <p className="max-w-[30rem] text-balance">
        <ShieldCheck size={13} className="mr-1.5 inline -translate-y-px" aria-hidden />
        {platform.kind === 'electron' ? t('connect.identityDesktop') : t('connect.identity')}
      </p>
      <p className="flex shrink-0 items-center gap-3">
        {update?.status === 'ready' && (
          <button className="font-medium text-accent hover:underline" onClick={() => platform.updates?.install()} data-testid="update-ready">
            {t('update.ready', { version: update.version ?? '' })}
          </button>
        )}
        <button className="hover:text-text hover:underline" onClick={() => setAboutOpen(true)} data-testid="about-open">
          {t('app.name')} {client.appVersion} · {t('more.about')}
        </button>
      </p>
      <AboutDialog open={aboutOpen} onOpenChange={setAboutOpen} />
    </footer>
  );
}
