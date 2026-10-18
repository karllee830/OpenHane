import { ErrorCode } from '@hane/protocol';
import { LocalErrorCode, HaneError } from '@hane/core';
import type { Translate } from './i18n';

/** 把连接 / 请求错误转换成给用户看的说明（给出原因和建议，而不只是「失败」）。 */
export function describeError(err: unknown, t: Translate, serverUrl = ''): string {
  if (!(err instanceof HaneError)) return t('error.generic', { message: String(err) });
  switch (err.code) {
    case LocalErrorCode.UNREACHABLE:
      return t('error.unreachable', { url: serverUrl });
    case LocalErrorCode.TIMEOUT:
      return t('error.timeout');
    case LocalErrorCode.PROTOCOL:
      return t('error.protocol');
    case LocalErrorCode.CONNECTION_LOST:
      return t('error.lost');
    case LocalErrorCode.FINGERPRINT_CHANGED:
    case ErrorCode.TLS_MITM_SUSPECTED:
      return t('error.mitm');
    case ErrorCode.PROTOCOL_VERSION_UNSUPPORTED:
      return t('error.version');
    case ErrorCode.AUTH_FAILED:
      return t('error.auth');
    case ErrorCode.BANNED: {
      const reason = err.detail?.banReason;
      const until = err.detail?.banExpiresAtMs ? t('error.bannedUntil', { time: new Date(Number(err.detail.banExpiresAtMs)).toLocaleString() }) : '';
      const by = err.detail?.byName ? t('error.by', { by: err.detail.byName }) : '';
      return (reason ? t('error.bannedReason', { reason }) : t('error.banned')) + until + by;
    }
    case ErrorCode.PASSWORD_REQUIRED:
      return t('error.passwordRequired');
    case ErrorCode.PASSWORD_INVALID:
      return t('error.passwordInvalid');
    case ErrorCode.SERVER_FULL:
      return t('error.full');
    case ErrorCode.NICKNAME_INVALID:
      return t('error.nickname');
    case ErrorCode.SECURITY_LEVEL_TOO_LOW:
      return t('error.securityLevel', { level: err.detail?.requiredSecurityLevel ?? '?' });
    case ErrorCode.KICKED:
      return (
        (err.detail?.byName ? t('error.kickedBy', { by: err.detail.byName }) : t('error.kicked')) +
        (err.detail?.reason ? t('mod.notice.reason', { reason: err.detail.reason }) : '')
      );
    case ErrorCode.SESSION_REPLACED:
      return t('error.replaced');
    case ErrorCode.RATE_LIMITED:
      return t('error.rateLimited');
    case ErrorCode.PERMISSION_DENIED:
      return t('error.permission');
    case ErrorCode.SHARE_LIMIT_REACHED:
      return t('share.limit');
    case ErrorCode.TOKEN_INVALID:
      return t('redeem.invalid');
    case ErrorCode.TOKEN_EXPIRED:
      return t('redeem.expired');
    case ErrorCode.TOKEN_USED_UP:
      return t('redeem.usedUp');
    case ErrorCode.ROOM_NOT_FOUND:
      return t('error.roomNotFound');
    case ErrorCode.ROOM_FULL:
      return t('error.roomFull');
    case ErrorCode.ROOM_LOCKED:
      return t('error.roomLocked');
    case ErrorCode.ROOM_PASSWORD_INVALID:
      return t('error.roomPassword');
    case ErrorCode.E2EE_UNSUPPORTED:
      return t('error.e2eeUnsupported');
    case ErrorCode.INVALID_ARGUMENT:
      return t('error.generic', { message: err.message });
  }
  return t('error.generic', { message: err.message });
}
