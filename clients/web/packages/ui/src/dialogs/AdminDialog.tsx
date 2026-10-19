// 管理面板：服务器设置、权限令牌、用户与角色、封禁、邀请码、审计日志。
import { hostPort, shortUid } from '@hane/core';
import type { AuditEntry, BanInfo, Identity, InviteInfo, TokenInfo } from '@hane/protocol';
import { Role } from '@hane/protocol';
import { Copy } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Dialog } from '../components/Dialog';
import { describeError } from '../errors';
import { useT, type MessageKey } from '../i18n';
import { useClient, useServices } from '../services';

type Tab = 'general' | 'audio' | 'media' | 'rooms' | 'security' | 'tokens' | 'users' | 'bans' | 'invites' | 'audit';
const TABS: { key: Tab; label: MessageKey }[] = [
  { key: 'general', label: 'admin.general' },
  { key: 'audio', label: 'admin.audio' },
  { key: 'media', label: 'admin.media' },
  { key: 'rooms', label: 'admin.rooms' },
  { key: 'security', label: 'admin.security' },
  { key: 'tokens', label: 'admin.tokens' },
  { key: 'users', label: 'admin.users' },
  { key: 'bans', label: 'admin.bans' },
  { key: 'invites', label: 'admin.invites' },
  { key: 'audit', label: 'admin.audit' },
];

const json = (v: string | undefined) => {
  try {
    return v === undefined ? undefined : JSON.parse(v);
  } catch {
    return undefined;
  }
};
const input = 'w-full rounded-md border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent';
const button = 'rounded-md bg-accent-solid px-4 py-2 text-sm text-white disabled:opacity-50';

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block text-sm">
      {label}
      <div className="mt-1">{children}</div>
    </label>
  );
}

// ---------- 服务器设置：字段描述表 ----------

type Spec =
  | { key: string; label: MessageKey; kind: 'text' | 'textarea'; testId?: string; maxLength?: number; placeholder?: MessageKey }
  | { key: string; label: MessageKey; kind: 'number'; min?: number; max?: number }
  | { key: string; label: MessageKey; kind: 'bool' }
  | { key: string; label: MessageKey; kind: 'select'; options: [string, MessageKey][]; testId?: string };

const roleOptions: [string, MessageKey][] = [
  ['member', 'role.member'],
  ['moderator', 'role.moderator'],
  ['admin', 'role.admin'],
];

const SETTINGS: Record<'general' | 'audio' | 'media' | 'rooms' | 'security', Spec[]> = {
  general: [
    { key: 'server.name', label: 'admin.name', kind: 'text', testId: 'admin-name', maxLength: 32, placeholder: 'admin.nameDefault' },
    { key: 'server.welcome_message', label: 'admin.welcome', kind: 'textarea' },
    { key: 'server.max_clients', label: 'admin.maxClients', kind: 'number', min: 1 },
    { key: 'join.force_mute', label: 'admin.forceMute', kind: 'bool' },
    { key: 'chat.retention_days', label: 'admin.chatRetention', kind: 'number', min: 0 },
    { key: 'chat.image_max_mb', label: 'admin.chatImageMax', kind: 'number', min: 0, max: 50 },
    { key: 'chat.image_storage_mb', label: 'admin.chatImageStorage', kind: 'number', min: 100 },
  ],
  audio: [
    {
      key: 'audio.preset',
      label: 'admin.preset',
      kind: 'select',
      testId: 'admin-preset',
      options: [
        ['economy', 'admin.presetEconomy'],
        ['standard', 'admin.presetStandard'],
        ['hd', 'admin.presetHd'],
        ['music', 'admin.presetMusic'],
      ],
    },
    { key: 'audio.allow_music_mode', label: 'admin.musicMode', kind: 'bool' },
  ],
  media: [
    { key: 'camera.enabled', label: 'admin.cameraEnabled', kind: 'bool' },
    {
      key: 'camera.max_resolution',
      label: 'admin.cameraMaxRes',
      kind: 'select',
      options: [
        ['360p', 'res.360p'],
        ['540p', 'res.540p'],
        ['720p', 'res.720p'],
        ['1080p', 'res.1080p'],
      ],
    },
    { key: 'screen.enabled', label: 'admin.screenEnabled', kind: 'bool' },
    { key: 'screen.min_role', label: 'admin.screenMinRole', kind: 'select', options: roleOptions },
    {
      key: 'screen.max_resolution',
      label: 'admin.screenMaxRes',
      kind: 'select',
      options: [
        ['1080p', 'res.1080p'],
        ['1440p', 'res.1440p'],
        ['2160p', 'res.2160p'],
        ['native', 'res.native'],
      ],
    },
    { key: 'screen.max_fps', label: 'admin.screenMaxFps', kind: 'number', min: 5, max: 120 },
    { key: 'screen.max_bitrate_kbps', label: 'admin.screenMaxKbps', kind: 'number', min: 300, max: 50000 },
    { key: 'screen.max_concurrent', label: 'admin.screenConcurrent', kind: 'number', min: 1, max: 20 },
    { key: 'screen.allow_audio', label: 'admin.screenAudio', kind: 'bool' },
    {
      key: 'media.share_transport',
      label: 'admin.shareTransport',
      kind: 'select',
      options: [
        ['tcp', 'admin.shareTransportTcp'],
        ['udp', 'admin.shareTransportUdp'],
      ],
    },
  ],
  rooms: [
    { key: 'rooms.main_name', label: 'admin.mainName', kind: 'text' },
    { key: 'rooms.create_min_role', label: 'admin.roomCreateRole', kind: 'select', options: roleOptions },
    { key: 'rooms.max_temporary', label: 'admin.roomMax', kind: 'number', min: 0, max: 200 },
    { key: 'rooms.empty_timeout_sec', label: 'admin.roomTimeout', kind: 'number', min: 0, max: 86400 },
  ],
  security: [
    {
      key: 'security.e2ee_policy',
      label: 'admin.e2eePolicy',
      kind: 'select',
      options: [
        ['off', 'admin.e2eeOff'],
        ['optional', 'admin.e2eeOptional'],
        ['required', 'admin.e2eeRequired'],
      ],
    },
    { key: 'privacy.store_ip', label: 'admin.storeIp', kind: 'bool' },
    { key: 'audit.retention_days', label: 'admin.auditRetention', kind: 'number', min: 1 },
  ],
};

function Settings({ tab }: { tab: keyof typeof SETTINGS }) {
  const t = useT();
  const { client } = useServices();
  const [values, setValues] = useState<Record<string, string> | null>(null);
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [password, setPassword] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    client.getSettings().then(setValues, (e) => setMsg({ ok: false, text: describeError(e, t) }));
  }, [client, t]);
  if (!values) return <p className="text-sm text-muted">…</p>;

  const val = (k: string) => (k in draft ? draft[k] : json(values[k]));
  const set = (k: string, v: unknown) => setDraft((d) => ({ ...d, [k]: v }));
  const passwordSet = values['server.password'] !== 'null';

  const save = async (clearPassword = false) => {
    const patch: Record<string, string> = {};
    for (const [k, v] of Object.entries(draft)) patch[k] = JSON.stringify(v);
    // 服务器名称留空：恢复默认名称（HANE_SERVER_NAME，没有设置时是 OpenHane）
    if (typeof draft['server.name'] === 'string' && !draft['server.name'].trim()) patch['server.name'] = 'null';
    if (password) patch['server.password'] = JSON.stringify(password);
    if (clearPassword) patch['server.password'] = 'null';
    if (!Object.keys(patch).length) return;
    try {
      setValues(await client.updateSettings(patch));
      setDraft({});
      setPassword('');
      setMsg({ ok: true, text: t('admin.saved') });
    } catch (e) {
      setMsg({ ok: false, text: describeError(e, t) });
    }
  };

  const render = (s: Spec) => {
    switch (s.kind) {
      case 'bool':
        return (
          <label key={s.key} className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={!!val(s.key)} onChange={(e) => set(s.key, e.target.checked)} />
            {t(s.label)}
          </label>
        );
      case 'select':
        return (
          <Field key={s.key} label={t(s.label)}>
            <select className={input} value={String(val(s.key))} onChange={(e) => set(s.key, e.target.value)} data-testid={s.testId}>
              {s.options.map(([v, l]) => (
                <option key={v} value={v}>
                  {t(l)}
                </option>
              ))}
            </select>
          </Field>
        );
      case 'number':
        return (
          <Field key={s.key} label={t(s.label)}>
            <input className={input} type="number" min={s.min} max={s.max} value={Number(val(s.key) ?? 0)} onChange={(e) => set(s.key, Number(e.target.value))} />
          </Field>
        );
      case 'textarea':
        return (
          <Field key={s.key} label={t(s.label)}>
            <textarea className={input} rows={2} value={String(val(s.key) ?? '')} onChange={(e) => set(s.key, e.target.value)} />
          </Field>
        );
      default:
        return (
          <Field key={s.key} label={t(s.label)}>
            <input
              className={input}
              value={String(val(s.key) ?? '')}
              onChange={(e) => set(s.key, e.target.value)}
              maxLength={s.maxLength}
              placeholder={s.placeholder && t(s.placeholder)}
              data-testid={s.testId}
            />
          </Field>
        );
    }
  };

  return (
    <div className="space-y-4">
      {SETTINGS[tab].map(render)}
      {tab === 'general' && (
        <Field label={t('admin.password')}>
          <div className="flex gap-2">
            <input className={input} type="password" autoComplete="new-password" value={password} placeholder={passwordSet ? t('admin.passwordSet') : ''} onChange={(e) => setPassword(e.target.value)} />
            {passwordSet && (
              <button className="shrink-0 rounded-md border border-border px-3 text-sm" onClick={() => void save(true)}>
                {t('admin.passwordClear')}
              </button>
            )}
          </div>
        </Field>
      )}
      {msg && <p className={`text-sm ${msg.ok ? 'text-success' : 'text-danger'}`}>{msg.text}</p>}
      <div className="flex justify-end">
        <button className={button} onClick={() => void save()} data-testid="admin-save">
          {t('admin.save')}
        </button>
      </div>
    </div>
  );
}

// ---------- 权限令牌 ----------

function Tokens() {
  const t = useT();
  const { client } = useServices();
  const [tokens, setTokens] = useState<TokenInfo[]>([]);
  const [role, setRole] = useState<Role>(Role.MODERATOR);
  const [uses, setUses] = useState(1);
  const [created, setCreated] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const reload = () => client.listTokens().then(setTokens, (e) => setErr(describeError(e, t)));
  useEffect(() => {
    void reload();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="space-y-4 text-sm">
      <div className="flex flex-wrap items-end gap-3">
        <Field label={t('admin.tokenRole')}>
          <select className={input} value={role} onChange={(e) => setRole(Number(e.target.value) as Role)}>
            <option value={Role.MODERATOR}>{t('role.moderator')}</option>
            <option value={Role.ADMIN}>{t('role.admin')}</option>
          </select>
        </Field>
        <Field label={t('admin.tokenUses')}>
          <input className={`${input} w-28`} type="number" min={0} value={uses} onChange={(e) => setUses(Number(e.target.value))} />
        </Field>
        <button
          className={button}
          onClick={async () => {
            try {
              const r = await client.createToken(role, uses);
              setCreated(r.token);
              void reload();
            } catch (e) {
              setErr(describeError(e, t));
            }
          }}
        >
          {t('admin.tokenCreate')}
        </button>
      </div>
      {created && <CopyBox label={t('admin.tokenCreated')} value={created} testId="created-token" />}
      {err && <p className="text-danger">{err}</p>}
      <ul className="divide-y divide-border">
        {tokens.length === 0 && <li className="py-2 text-muted">{t('admin.tokenNone')}</li>}
        {tokens.map((tk) => (
          <li key={tk.id} className="flex items-center gap-3 py-2">
            <code className="font-mono text-xs">{tk.id}</code>
            <span>{tk.role === Role.ADMIN ? t('role.admin') : t('role.moderator')}</span>
            <span className="text-muted">{t('admin.tokenUsed', { used: tk.usedCount, max: tk.maxUses || '∞' })}</span>
            <span className="flex-1 truncate text-muted">{tk.note}</span>
            {tk.revokedAtMs ? (
              <span className="text-muted">{t('admin.tokenRevoked')}</span>
            ) : (
              <button className="text-danger hover:underline" onClick={() => client.revokeToken(tk.id).then(reload, (e) => setErr(describeError(e, t)))}>
                {t('admin.tokenRevoke')}
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function CopyBox({ label, value, testId }: { label: string; value: string; testId?: string }) {
  const t = useT();
  return (
    <div className="rounded-md bg-surface-2 p-3">
      <div className="text-xs text-muted">{label}</div>
      <div className="mt-1 flex items-center gap-2">
        <code className="min-w-0 flex-1 select-all break-all font-mono text-xs" data-testid={testId}>
          {value}
        </code>
        <button className="flex shrink-0 items-center gap-1 rounded border border-border px-2 py-1 text-xs" onClick={() => void navigator.clipboard?.writeText(value)}>
          <Copy size={12} />
          {t('admin.tokenCopy')}
        </button>
      </div>
    </div>
  );
}

const time = (ms: bigint) => (ms ? new Date(Number(ms)).toLocaleString() : '');

// ---------- 用户与角色 ----------

function Users() {
  const t = useT();
  const { client } = useServices();
  const selfUid = useClient((s) => s.self?.uid);
  const [filter, setFilter] = useState<Role>(Role.UNSPECIFIED);
  const [list, setList] = useState<{ identities: Identity[]; total: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const reload = () => client.listIdentities(filter, 200).then(setList, (e) => setErr(describeError(e, t)));
  useEffect(() => {
    void reload();
  }, [filter]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="space-y-3 text-sm">
      <div className="flex items-center gap-2">
        <select className="rounded-md border border-border bg-bg px-2 py-1" value={filter} onChange={(e) => setFilter(Number(e.target.value) as Role)}>
          <option value={Role.UNSPECIFIED}>{t('admin.usersAll')}</option>
          <option value={Role.ADMIN}>{t('role.admin')}</option>
          <option value={Role.MODERATOR}>{t('role.moderator')}</option>
          <option value={Role.MEMBER}>{t('role.member')}</option>
        </select>
        <span className="text-muted">{list ? t('admin.usersTotal', { n: list.total }) : '…'}</span>
      </div>
      {err && <p className="text-danger">{err}</p>}
      <ul className="divide-y divide-border">
        {list?.identities.map((u) => (
          <li key={u.uid} className="flex items-center gap-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="truncate">{u.lastNickname}</div>
              <div className="font-mono text-xs text-muted" title={u.uid}>
                {shortUid(u.uid)} · {t('admin.lastSeen', { time: time(u.lastSeenAtMs) })}
                {u.lastIp ? ` · ${u.lastIp}` : ''}
              </div>
            </div>
            <select
              className="rounded-md border border-border bg-bg px-2 py-1"
              value={u.role}
              disabled={u.uid === selfUid}
              onChange={(e) => client.setRole(u.uid, Number(e.target.value) as Role).then(reload, (e2) => setErr(describeError(e2, t)))}
              aria-label={t('admin.role')}
            >
              <option value={Role.MEMBER}>{t('role.member')}</option>
              <option value={Role.MODERATOR}>{t('role.moderator')}</option>
              <option value={Role.ADMIN}>{t('role.admin')}</option>
            </select>
            <button
              className="text-danger hover:underline disabled:opacity-40"
              disabled={u.uid === selfUid || u.role === Role.ADMIN}
              onClick={() => client.addBan({ uid: u.uid }).then(() => setErr(null), (e) => setErr(describeError(e, t)))}
            >
              {t('mod.ban')}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------- 封禁 ----------

const BAN_DURATIONS = [600, 3600, 86400, 604800, 0];

function Bans() {
  const t = useT();
  const { client } = useServices();
  const [bans, setBans] = useState<BanInfo[]>([]);
  const [target, setTarget] = useState('');
  const [duration, setDuration] = useState(86400);
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const reload = () => client.listBans().then(setBans, (e) => setMsg({ ok: false, text: describeError(e, t) }));
  useEffect(() => {
    void reload();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const now = Date.now();
  const label = (d: number) => (d === 0 ? t('ban.forever') : d < 3600 ? t('time.minutes', { n: d / 60 }) : d < 86400 ? t('time.hours', { n: d / 3600 }) : t('time.days', { n: d / 86400 }));

  return (
    <div className="space-y-4 text-sm">
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          const v = target.trim();
          const isIp = /^[0-9a-f:.]+(\/\d+)?$/i.test(v) && /[.:]/.test(v);
          try {
            const r = await client.addBan({ uid: isIp ? undefined : v, ipCidr: isIp ? v : undefined, durationSec: duration, reason });
            setMsg({ ok: true, text: t('ban.added', { n: r.kicked }) });
            setTarget('');
            setReason('');
            void reload();
          } catch (e2) {
            setMsg({ ok: false, text: describeError(e2, t) });
          }
        }}
      >
        <Field label={t('ban.target')}>
          <input className={`${input} w-56`} value={target} onChange={(e) => setTarget(e.target.value)} placeholder="UID / 203.0.113.0/24" required />
        </Field>
        <Field label={t('ban.duration')}>
          <select className={input} value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
            {BAN_DURATIONS.map((d) => (
              <option key={d} value={d}>
                {label(d)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('mod.reason')}>
          <input className={`${input} w-40`} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <button type="submit" className={button}>
          {t('ban.add')}
        </button>
      </form>
      {msg && <p className={msg.ok ? 'text-success' : 'text-danger'}>{msg.text}</p>}
      <ul className="divide-y divide-border">
        {bans.length === 0 && <li className="py-2 text-muted">{t('ban.none')}</li>}
        {bans.map((b) => {
          const expired = b.expiresAtMs !== 0n && Number(b.expiresAtMs) < now;
          return (
            <li key={String(b.id)} className={`flex items-center gap-3 py-2 ${expired ? 'opacity-50' : ''}`}>
              <div className="min-w-0 flex-1">
                <div className="truncate">
                  {b.nickname || (b.uid ? shortUid(b.uid) : b.ipCidr)}
                  {b.uid && b.ipCidr ? ` · ${b.ipCidr}` : ''}
                </div>
                <div className="text-xs text-muted">
                  {b.reason || t('ban.noReason')} · {b.expiresAtMs ? (expired ? t('ban.expired') : t('ban.until', { time: time(b.expiresAtMs) })) : t('ban.forever')}
                </div>
              </div>
              <button className="text-accent hover:underline" onClick={() => client.removeBan(b.id).then(reload, (e) => setMsg({ ok: false, text: describeError(e, t) }))}>
                {t('ban.remove')}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ---------- 邀请码 ----------

function Invites() {
  const t = useT();
  const { client } = useServices();
  const address = useClient((s) => s.address);
  const [invites, setInvites] = useState<InviteInfo[]>([]);
  const [uses, setUses] = useState(0);
  const [expires, setExpires] = useState(604800);
  const [bypass, setBypass] = useState(true);
  const [role, setRole] = useState<Role>(Role.MEMBER);
  const [created, setCreated] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const reload = () => client.listInvites().then(setInvites, (e) => setErr(describeError(e, t)));
  useEffect(() => {
    void reload();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const link = (code: string) => (address ? `${address.secure ? 'https' : 'http'}://${hostPort(address)}/j/${code}` : code);

  return (
    <div className="space-y-4 text-sm">
      <div className="flex flex-wrap items-end gap-3">
        <Field label={t('invite.uses')}>
          <input className={`${input} w-24`} type="number" min={0} value={uses} onChange={(e) => setUses(Math.max(0, Number(e.target.value)))} />
        </Field>
        <Field label={t('invite.expires')}>
          <select className={input} value={expires} onChange={(e) => setExpires(Number(e.target.value))}>
            <option value={86400}>{t('time.days', { n: 1 })}</option>
            <option value={604800}>{t('time.days', { n: 7 })}</option>
            <option value={2592000}>{t('time.days', { n: 30 })}</option>
            <option value={0}>{t('invite.never')}</option>
          </select>
        </Field>
        <Field label={t('invite.role')}>
          <select className={input} value={role} onChange={(e) => setRole(Number(e.target.value) as Role)}>
            <option value={Role.MEMBER}>{t('invite.roleNone')}</option>
            <option value={Role.MODERATOR}>{t('role.moderator')}</option>
          </select>
        </Field>
        <label className="flex items-center gap-2 pb-2">
          <input type="checkbox" checked={bypass} onChange={(e) => setBypass(e.target.checked)} />
          {t('invite.bypass')}
        </label>
        <button
          className={button}
          onClick={async () => {
            try {
              const inv = await client.createInvite({ maxUses: uses, expiresInSec: expires, bypassPassword: bypass, role });
              if (inv) setCreated(link(inv.code));
              void reload();
            } catch (e) {
              setErr(describeError(e, t));
            }
          }}
          data-testid="invite-create"
        >
          {t('invite.create')}
        </button>
      </div>
      {created && <CopyBox label={t('invite.created')} value={created} testId="invite-link" />}
      {err && <p className="text-danger">{err}</p>}
      <ul className="divide-y divide-border">
        {invites.length === 0 && <li className="py-2 text-muted">{t('invite.none')}</li>}
        {invites.map((inv) => (
          <li key={inv.code} className="flex items-center gap-3 py-2">
            <code className="font-mono text-xs">{inv.code}</code>
            <span className="text-muted">{t('admin.tokenUsed', { used: inv.usedCount, max: inv.maxUses || '∞' })}</span>
            <span className="flex-1 truncate text-xs text-muted">
              {[inv.bypassPassword && t('invite.bypassShort'), inv.role === Role.MODERATOR && t('role.moderator'), inv.expiresAtMs ? t('ban.until', { time: time(inv.expiresAtMs) }) : t('invite.never')]
                .filter(Boolean)
                .join(' · ')}
            </span>
            <button className="text-accent hover:underline" onClick={() => void navigator.clipboard?.writeText(link(inv.code))}>
              {t('admin.tokenCopy')}
            </button>
            <button className="text-danger hover:underline" onClick={() => client.revokeInvite(inv.code).then(reload, (e) => setErr(describeError(e, t)))}>
              {t('admin.tokenRevoke')}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------- 审计日志 ----------

const AUDIT_FILTERS: [string, MessageKey][] = [
  ['', 'audit.all'],
  ['moderate.', 'audit.moderate'],
  ['room.', 'audit.room'],
  ['ban.', 'audit.ban'],
  ['settings.', 'audit.settings'],
  ['token.', 'audit.token'],
  ['invite.', 'audit.invite'],
  ['user.', 'audit.user'],
  ['security.', 'audit.security'],
];

function Audit() {
  const t = useT();
  const { client } = useServices();
  const [prefix, setPrefix] = useState('');
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const load = async (more: boolean) => {
    try {
      const r = await client.auditLog({ actionPrefix: prefix, beforeId: more ? entries.at(-1)?.id : 0n, limit: 100 });
      setEntries((cur) => (more ? [...cur, ...r.entries] : r.entries));
      setHasMore(r.hasMore);
    } catch (e) {
      setErr(describeError(e, t));
    }
  };
  useEffect(() => {
    void load(false);
  }, [prefix]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="space-y-3 text-sm">
      <select className="rounded-md border border-border bg-bg px-2 py-1" value={prefix} onChange={(e) => setPrefix(e.target.value)} aria-label={t('audit.filter')}>
        {AUDIT_FILTERS.map(([v, l]) => (
          <option key={v} value={v}>
            {t(l)}
          </option>
        ))}
      </select>
      {err && <p className="text-danger">{err}</p>}
      <ul className="divide-y divide-border" data-testid="audit-list">
        {entries.length === 0 && <li className="py-2 text-muted">{t('audit.none')}</li>}
        {entries.map((e) => (
          <li key={String(e.id)} className="py-1.5">
            <div className="flex gap-2">
              <span className="shrink-0 text-xs text-muted">{time(e.atMs)}</span>
              <span className="font-mono text-xs">{e.action}</span>
              <span className="truncate">{e.actorName || (e.actorUid ? shortUid(e.actorUid) : t('audit.system'))}</span>
            </div>
            {(e.target || e.detail) && (
              <div className="truncate pl-1 font-mono text-xs text-muted" title={e.detail}>
                {e.target} {e.detail}
              </div>
            )}
          </li>
        ))}
      </ul>
      {hasMore && (
        <button className="text-accent hover:underline" onClick={() => void load(true)}>
          {t('audit.more')}
        </button>
      )}
    </div>
  );
}

export function AdminDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const t = useT();
  const [tab, setTab] = useState<Tab>('general');
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={t('admin.title')} wide>
      <div className="mb-4 flex flex-wrap gap-1 border-b border-border" role="tablist">
        {TABS.map(({ key, label }) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={`-mb-px border-b-2 px-2.5 py-2 text-sm ${tab === key ? 'border-accent text-accent' : 'border-transparent text-muted'}`}
            data-testid={`admin-tab-${key}`}
          >
            {t(label)}
          </button>
        ))}
      </div>
      {tab === 'tokens' ? (
        <Tokens />
      ) : tab === 'users' ? (
        <Users />
      ) : tab === 'bans' ? (
        <Bans />
      ) : tab === 'invites' ? (
        <Invites />
      ) : tab === 'audit' ? (
        <Audit />
      ) : (
        <Settings key={tab} tab={tab} />
      )}
    </Dialog>
  );
}
