import type { Participant } from '@hane/protocol';
import { Role } from '@hane/protocol';
import * as DM from '@radix-ui/react-dropdown-menu';
import { Hand, HeadphoneOff, MicOff, RefreshCw, Shield, ShieldCheck, Unplug } from 'lucide-react';
import { useMemo } from 'react';
import { useT } from '../i18n';
import { useClient, useLevels, useMedia, useServices } from '../services';
import { Avatar } from './Avatar';

export function RoleBadge({ role }: { role: Role }) {
  const t = useT();
  if (role === Role.ADMIN) return <ShieldCheck size={14} className="text-accent" aria-label={t('role.admin')} />;
  if (role === Role.MODERATOR) return <Shield size={14} className="text-accent" aria-label={t('role.moderator')} />;
  return null;
}

export function StatusIcons({ p }: { p: Participant }) {
  const t = useT();
  return (
    <span className="flex items-center gap-1 text-muted">
      {p.state?.handRaised && <Hand size={14} className="text-warning" aria-label={t('member.handRaised')} />}
      {p.state?.deafened ? <HeadphoneOff size={14} aria-label={t('member.deafened')} /> : p.state?.micMuted || p.forceMuted ? <MicOff size={14} aria-label={t('member.muted')} /> : null}
      {p.reconnecting ? <RefreshCw size={14} className="animate-spin" aria-label={t('member.reconnecting')} /> : !p.mediaConnected ? <Unplug size={14} aria-label={t('member.noMedia')} /> : null}
    </span>
  );
}

function Row({ p, self }: { p: Participant; self: boolean }) {
  const t = useT();
  const { media } = useServices();
  const speaking = useLevels((s) => !!s.speaking[p.mediaIdentity]);
  const volume = useMedia((s) => s.volumes[p.mediaIdentity] ?? 1);
  const content = (
    <div className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left ${self ? '' : 'hover:bg-surface-2'}`}>
      <Avatar name={p.nickname} uid={p.uid} speaking={speaking} size={28} dimmed={p.reconnecting} />
      <span className="min-w-0 flex-1 truncate text-sm">
        {p.nickname}
        {self && <span className="text-muted">{t('member.you')}</span>}
      </span>
      <RoleBadge role={p.role} />
      <StatusIcons p={p} />
    </div>
  );
  if (self) return <li>{content}</li>;
  return (
    <li>
      <DM.Root>
        <DM.Trigger className="w-full rounded-md outline-none focus-visible:ring-2 focus-visible:ring-accent">{content}</DM.Trigger>
        <DM.Portal>
          <DM.Content side="right" align="start" sideOffset={6} className="z-50 w-56 rounded-lg border border-border bg-surface p-3 shadow-lg">
            <div className="mb-2 truncate text-sm font-medium" title={p.nickname}>
              {p.nickname}
            </div>
            <label className="block text-xs text-muted">
              {t('member.volume')} · {Math.round(volume * 100)}%
              <input
                type="range"
                min={0}
                max={200}
                step={5}
                value={Math.round(volume * 100)}
                onChange={(e) => media.setVolume(p.mediaIdentity, Number(e.target.value) / 100)}
                className="mt-1 w-full accent-[var(--color-accent)]"
              />
            </label>
          </DM.Content>
        </DM.Portal>
      </DM.Root>
    </li>
  );
}

export function ParticipantList() {
  const t = useT();
  const participants = useClient((s) => s.participants);
  const rooms = useClient((s) => s.rooms);
  const selfId = useClient((s) => s.self?.sessionId);
  const byRoom = useMemo(() => {
    const m = new Map<string, Participant[]>();
    for (const p of Object.values(participants)) m.set(p.roomId, [...(m.get(p.roomId) ?? []), p]);
    for (const list of m.values()) list.sort((a, b) => a.nickname.localeCompare(b.nickname));
    return m;
  }, [participants]);
  const roomList = Object.values(rooms).sort((a, b) => (a.id === 'main' ? -1 : b.id === 'main' ? 1 : Number(a.createdAtMs - b.createdAtMs)));
  return (
    <nav aria-label={t('room.main')} className="flex-1 overflow-y-auto px-2">
      {roomList.map((r) => {
        const members = byRoom.get(r.id) ?? [];
        return (
          <section key={r.id} className="mb-3">
            <h2 className="flex items-center justify-between px-2 py-1 text-xs font-semibold uppercase tracking-wide text-muted">
              <span className="truncate">{r.name || t('room.main')}</span>
              <span>{t('room.members', { n: members.length })}</span>
            </h2>
            <ul>
              {members.map((p) => (
                <Row key={p.sessionId} p={p} self={p.sessionId === selfId} />
              ))}
            </ul>
          </section>
        );
      })}
    </nav>
  );
}
