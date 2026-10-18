// 房间侧栏：所有房间及成员；点击房间进入，拖拽成员到房间即可移动（主持人），
// 成员菜单里是音量和主持操作，房间菜单里是编辑、全员静音和关闭。
import type { Participant, Room } from '@hane/protocol';
import { ModerationAction, Role, RoomKind } from '@hane/protocol';
import * as DM from '@radix-ui/react-dropdown-menu';
import {
  ArrowRightLeft,
  Ban,
  DoorOpen,
  House,
  KeyRound,
  LayoutGrid,
  Lock,
  LogOut,
  Mic,
  MicOff,
  MonitorOff,
  MoreHorizontal,
  Pencil,
  Plus,
  ShieldCheck,
  Trash2,
  Undo2,
  UserX,
  VideoOff,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { useMemo, useState, type DragEvent, type ReactNode } from 'react';
import { ModerateDialog, type ModerateKind } from '../dialogs/ModerateDialog';
import { RoomDialog, RoomPasswordDialog } from '../dialogs/RoomDialog';
import { describeError } from '../errors';
import { useT } from '../i18n';
import { useClient, useLevels, useMedia, useServices } from '../services';
import { Avatar } from './Avatar';
import { YouTag } from './MeetingBits';
import { RoleBadge, StatusIcons } from './ParticipantList';

const DRAG_TYPE = 'application/x-hane-session';

/** 当前用户的权限（与服务端的规则一致；服务端仍会再次裁决） */
export function usePermissions() {
  const self = useClient((s) => s.self);
  const rooms = useClient((s) => s.rooms);
  const myRoom = useClient((s) => s.media?.roomId ?? 'main');
  const role = self?.role ?? Role.MEMBER;
  const isHostOf = (r: Room | undefined) => !!r && r.kind === RoomKind.TEMPORARY && r.createdBy === self?.uid;
  return {
    role,
    isModerator: role >= Role.MODERATOR,
    canManageRoom: (r: Room) => role >= Role.MODERATOR || isHostOf(r),
    /** 能否对 p 执行（非服务器级的）主持操作：主持人对角色更低的人；房间主持对自己房间里的普通成员 */
    canModerate: (p: Participant) =>
      p.sessionId !== self?.sessionId &&
      (role >= Role.MODERATOR ? p.role < role : isHostOf(rooms[myRoom]) && p.roomId === myRoom && p.role < Role.MODERATOR),
    /** 踢出、封禁、移动到其他房间：服务器级操作，只看服务器角色 */
    canKick: (p: Participant) => p.sessionId !== self?.sessionId && role >= Role.MODERATOR && p.role < role,
  };
}

function MenuItem({ icon, children, onSelect, danger, testId }: { icon: ReactNode; children: ReactNode; onSelect: () => void; danger?: boolean; testId?: string }) {
  return (
    <DM.Item
      onSelect={onSelect}
      data-testid={testId}
      className={`flex cursor-default items-center gap-2 rounded px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-surface-2 ${danger ? 'text-danger' : ''}`}
    >
      {icon}
      {children}
    </DM.Item>
  );
}

const menuContent = 'z-50 min-w-56 rounded-lg border border-border bg-surface p-1.5 shadow-lg';

function MemberRow({ p, self, onNotice, onModerate }: {
  p: Participant;
  self: boolean;
  onNotice: (m: string) => void;
  onModerate: (p: Participant, kind: ModerateKind) => void;
}) {
  const t = useT();
  const { client, media } = useServices();
  const perms = usePermissions();
  const rooms = useClient((s) => s.rooms);
  const speaking = useLevels((s) => !!s.speaking[p.mediaIdentity]);
  const volume = useMedia((s) => s.volumes[p.mediaIdentity] ?? 1);
  const moderate = perms.canModerate(p);
  const kick = perms.canKick(p);
  const draggable = self || kick;
  const [menuOpen, setMenuOpen] = useState(false);
  const run = (f: () => Promise<unknown>) => void f().catch((e) => onNotice(describeError(e, t)));

  const content = (
    <div
      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent ${self ? '' : 'cursor-pointer hover:bg-surface-2'}`}
      draggable={draggable}
      onDragStart={(e: DragEvent) => {
        e.dataTransfer.setData(DRAG_TYPE, p.sessionId);
        e.dataTransfer.effectAllowed = 'move';
      }}
      data-testid={`member-${p.nickname}`}
    >
      <Avatar name={p.nickname} uid={p.uid} speaking={speaking} size={28} dimmed={p.reconnecting} />
      <span className="flex min-w-0 flex-1 items-center gap-1.5 text-sm">
        <span className="truncate">{p.nickname}</span>
        {self && <YouTag />}
      </span>
      <RoleBadge role={p.role} />
      <StatusIcons p={p} />
    </div>
  );
  if (self) return <li>{content}</li>;
  const others = Object.values(rooms).filter((r) => r.id !== p.roomId);
  return (
    <li>
      {/* 菜单在点击（松开）时打开：Radix 默认在按下时打开，会让拖拽无法开始 */}
      <DM.Root open={menuOpen} onOpenChange={setMenuOpen} modal={false}>
        <DM.Trigger asChild disabled>
          <div
            role="button"
            tabIndex={0}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen(true)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setMenuOpen(true);
              }
            }}
          >
            {content}
          </div>
        </DM.Trigger>
        <DM.Portal>
          <DM.Content side="right" align="start" sideOffset={6} className={menuContent}>
            <div className="px-2 pb-1 pt-1 text-sm font-medium">{p.nickname}</div>
            <label className="block px-2 pb-2 text-xs text-muted">
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
            {moderate && (
              <>
                <DM.Separator className="my-1 h-px bg-border" />
                {p.forceMuted ? (
                  <MenuItem icon={<Mic size={15} />} onSelect={() => run(() => client.moderate(p.sessionId, ModerationAction.UNMUTE))} testId="mod-unmute">
                    {t('mod.unmute')}
                  </MenuItem>
                ) : (
                  <MenuItem icon={<MicOff size={15} />} onSelect={() => run(() => client.moderate(p.sessionId, ModerationAction.FORCE_MUTE))} testId="mod-mute">
                    {t('mod.forceMute')}
                  </MenuItem>
                )}
                {p.screenSharing && (
                  <MenuItem icon={<MonitorOff size={15} />} onSelect={() => run(() => client.moderate(p.sessionId, ModerationAction.STOP_SHARE))}>
                    {t('mod.stopShare')}
                  </MenuItem>
                )}
                {p.cameraOn && (
                  <MenuItem icon={<VideoOff size={15} />} onSelect={() => run(() => client.moderate(p.sessionId, ModerationAction.CAMERA_OFF))}>
                    {t('mod.cameraOff')}
                  </MenuItem>
                )}
                {kick && others.length > 0 && (
                  <DM.Sub>
                    <DM.SubTrigger className="flex cursor-default items-center gap-2 rounded px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-surface-2">
                      <ArrowRightLeft size={15} />
                      {t('mod.moveTo')}
                    </DM.SubTrigger>
                    <DM.Portal>
                      <DM.SubContent className={menuContent} sideOffset={4}>
                        {others.map((r) => (
                          <MenuItem key={r.id} icon={<DoorOpen size={15} />} onSelect={() => run(() => client.moveParticipant(p.sessionId, r.id))}>
                            {r.name || t('room.main')}
                          </MenuItem>
                        ))}
                      </DM.SubContent>
                    </DM.Portal>
                  </DM.Sub>
                )}
                {p.roomId !== 'main' && (
                  <MenuItem icon={<LogOut size={15} />} onSelect={() => run(() => client.moderate(p.sessionId, ModerationAction.REMOVE_FROM_ROOM))}>
                    {t('mod.removeFromRoom')}
                  </MenuItem>
                )}
                {kick && (
                  <>
                    <DM.Separator className="my-1 h-px bg-border" />
                    <MenuItem icon={<UserX size={15} />} danger onSelect={() => onModerate(p, 'kick')} testId="mod-kick">
                      {t('mod.kick')}
                    </MenuItem>
                    <MenuItem icon={<Ban size={15} />} danger onSelect={() => onModerate(p, 'ban')} testId="mod-ban">
                      {t('mod.ban')}
                    </MenuItem>
                  </>
                )}
              </>
            )}
          </DM.Content>
        </DM.Portal>
      </DM.Root>
    </li>
  );
}

function RoomSection({ room, members, current, onNotice, onModerate, onEdit, onPassword }: {
  room: Room;
  members: Participant[];
  current: boolean;
  onNotice: (m: string) => void;
  onModerate: (p: Participant, kind: ModerateKind) => void;
  onEdit: (r: Room) => void;
  onPassword: (r: Room) => void;
}) {
  const t = useT();
  const { client } = useServices();
  const perms = usePermissions();
  const selfId = useClient((s) => s.self?.sessionId);
  const participants = useClient((s) => s.participants);
  const [dropping, setDropping] = useState(false);
  const run = (f: () => Promise<unknown>) => void f().catch((e) => onNotice(describeError(e, t)));
  const name = room.name || t('room.main');
  const manage = perms.canManageRoom(room);

  const enter = () => {
    if (current) return;
    if (room.hasPassword && !manage) onPassword(room);
    else run(() => client.joinRoom(room.id));
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDropping(false);
    const id = e.dataTransfer.getData(DRAG_TYPE);
    const p = participants[id];
    if (!p || p.roomId === room.id) return;
    if (id === selfId) enter();
    else if (perms.canKick(p)) run(() => client.moveParticipant(id, room.id));
  };

  return (
    <section
      className={`mb-2 rounded-lg ${dropping ? 'bg-accent/10 ring-1 ring-accent' : ''}`}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
        e.preventDefault();
        setDropping(true);
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={onDrop}
      data-testid={`room-${room.name || 'main'}`}
    >
      <div className={`group flex items-center gap-1 rounded-md px-2 py-1 ${current ? 'text-text' : 'text-muted hover:bg-surface-2'}`}>
        <button className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-xs font-semibold uppercase tracking-wide" onClick={enter} title={current ? undefined : t('room.enter')} data-testid="room-enter">
          {current ? (
            <Volume2 size={14} className="shrink-0 text-accent" aria-hidden />
          ) : room.kind === RoomKind.TEMPORARY ? (
            <LayoutGrid size={14} className="shrink-0" aria-hidden />
          ) : (
            <House size={14} className="shrink-0" aria-hidden />
          )}
          <span className="truncate">{name}</span>
          {room.hasPassword && <KeyRound size={12} aria-label={t('room.hasPassword')} />}
          {room.locked && <Lock size={12} aria-label={t('room.locked')} />}
          {room.e2ee && <ShieldCheck size={12} className="text-success" aria-label={t('room.e2ee')} />}
        </button>
        <span className="rounded-full bg-surface-2 px-1.5 text-[11px] leading-[18px] tabular-nums text-text/75">
          {room.capacity ? `${members.length}/${room.capacity}` : t('room.members', { n: members.length })}
        </span>
        {manage && (
          <DM.Root>
            <DM.Trigger className="rounded p-0.5 opacity-60 hover:bg-surface-2 group-hover:opacity-100" aria-label={t('room.menu')} data-testid="room-menu">
              <MoreHorizontal size={14} />
            </DM.Trigger>
            <DM.Portal>
              <DM.Content align="end" className={menuContent}>
                <MenuItem icon={<Pencil size={15} />} onSelect={() => onEdit(room)} testId="room-edit">
                  {t('room.edit')}
                </MenuItem>
                <MenuItem icon={<VolumeX size={15} />} onSelect={() => run(async () => onNotice(t('room.mutedAll', { n: await client.muteAll(room.id) })))}>
                  {t('room.muteAll')}
                </MenuItem>
                {room.kind === RoomKind.TEMPORARY && (
                  <MenuItem icon={<Trash2 size={15} />} danger onSelect={() => run(() => client.closeRoom(room.id))} testId="room-close">
                    {t('room.close')}
                  </MenuItem>
                )}
              </DM.Content>
            </DM.Portal>
          </DM.Root>
        )}
      </div>
      <ul>
        {members.map((p) => (
          <MemberRow key={p.sessionId} p={p} self={p.sessionId === selfId} onNotice={onNotice} onModerate={onModerate} />
        ))}
      </ul>
    </section>
  );
}

export function RoomSidebar({ onNotice }: { onNotice: (m: string) => void }) {
  const t = useT();
  const { client } = useServices();
  const perms = usePermissions();
  const participants = useClient((s) => s.participants);
  const rooms = useClient((s) => s.rooms);
  const current = useClient((s) => s.media?.roomId ?? 'main');
  const createRole = useClient((s) => s.serverInfo?.roomCreateMinRole || Role.MODERATOR);
  const [dialog, setDialog] = useState<{ kind: 'create' } | { kind: 'edit'; room: Room } | { kind: 'password'; room: Room } | null>(null);
  const [moderating, setModerating] = useState<{ p: Participant; kind: ModerateKind } | null>(null);

  const byRoom = useMemo(() => {
    const m = new Map<string, Participant[]>();
    for (const p of Object.values(participants)) m.set(p.roomId, [...(m.get(p.roomId) ?? []), p]);
    for (const list of m.values()) list.sort((a, b) => a.nickname.localeCompare(b.nickname));
    return m;
  }, [participants]);
  const roomList = Object.values(rooms).sort((a, b) => (a.id === 'main' ? -1 : b.id === 'main' ? 1 : Number(a.createdAtMs - b.createdAtMs)));
  const hasTemp = roomList.some((r) => r.kind === RoomKind.TEMPORARY);

  return (
    <nav aria-label={t('room.list')} className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 px-4 pb-1 text-xs text-muted">
        <span className="flex-1">{t('room.list')}</span>
        {perms.isModerator && hasTemp && (
          <button className="rounded p-1 hover:bg-surface-2" title={t('room.recallAll')} aria-label={t('room.recallAll')} onClick={() => void client.recallAll().catch((e) => onNotice(describeError(e, t)))}>
            <Undo2 size={14} />
          </button>
        )}
        {perms.role >= createRole && (
          <button className="rounded p-1 hover:bg-surface-2" title={t('room.create')} aria-label={t('room.create')} onClick={() => setDialog({ kind: 'create' })} data-testid="room-create">
            <Plus size={14} />
          </button>
        )}
      </div>
      <div className="flex-1 overflow-y-auto px-2">
        {roomList.map((r) => (
          <RoomSection
            key={r.id}
            room={r}
            members={byRoom.get(r.id) ?? []}
            current={r.id === current}
            onNotice={onNotice}
            onModerate={(p, kind) => setModerating({ p, kind })}
            onEdit={(room) => setDialog({ kind: 'edit', room })}
            onPassword={(room) => setDialog({ kind: 'password', room })}
          />
        ))}
      </div>
      {(dialog?.kind === 'create' || dialog?.kind === 'edit') && (
        <RoomDialog room={dialog.kind === 'edit' ? dialog.room : undefined} onClose={() => setDialog(null)} onNotice={onNotice} />
      )}
      {dialog?.kind === 'password' && <RoomPasswordDialog room={dialog.room} onClose={() => setDialog(null)} />}
      {moderating && <ModerateDialog target={moderating.p} kind={moderating.kind} onClose={() => setModerating(null)} onNotice={onNotice} />}
    </nav>
  );
}
