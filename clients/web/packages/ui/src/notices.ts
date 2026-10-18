// 主持操作和被移动的提示文案。
import type { ModerationNotice, Room, YouWereMoved } from '@hane/protocol';
import { ModerationAction, MoveReason } from '@hane/protocol';
import type { Translate } from './i18n';

export function moderationText(n: ModerationNotice, t: Translate): string {
  const by = n.byName || t('role.moderator');
  const reason = n.reason ? t('mod.notice.reason', { reason: n.reason }) : '';
  switch (n.action) {
    case ModerationAction.FORCE_MUTE:
      return t('mod.notice.forceMute', { by }) + reason;
    case ModerationAction.UNMUTE:
      return t('mod.notice.unmute', { by });
    case ModerationAction.STOP_SHARE:
      return t('mod.notice.stopShare', { by }) + reason;
    case ModerationAction.CAMERA_OFF:
      return t('mod.notice.cameraOff', { by }) + reason;
    default:
      return reason;
  }
}

export function moveText(m: YouWereMoved, rooms: Record<string, Room>, t: Translate): string {
  const to = rooms[m.roomId]?.name || t('room.main');
  const from = m.fromRoomName || t('room.main');
  const by = m.byName || t('role.moderator');
  switch (m.reason) {
    case MoveReason.REMOVED:
      return t('move.removed', { by, room: from });
    case MoveReason.ROOM_CLOSED:
      return t('move.closed', { room: from, main: to });
    case MoveReason.RECALLED:
      return t('move.recalled', { by, main: to });
    case MoveReason.E2EE_UNSUPPORTED:
      return t('move.e2ee', { room: from, main: to });
    default:
      return t('move.moved', { by, room: to });
  }
}
