import { ErrorCode, type Error as PbError } from '@hane/protocol';

/** 协议错误（服务端以 Goodbye 或错误响应拒绝）或本地连接错误。 */
export class HaneError extends Error {
  constructor(
    readonly code: ErrorCode | LocalErrorCode,
    message: string,
    readonly detail?: PbError,
  ) {
    super(message);
    this.name = 'HaneError';
  }

  static fromProto(e: PbError | undefined): HaneError {
    return new HaneError(e?.code ?? ErrorCode.INTERNAL, e?.message || ErrorCode[e?.code ?? ErrorCode.INTERNAL] || 'error', e);
  }
}

/** 本地错误码（不在协议中），用负数区分。 */
export enum LocalErrorCode {
  /** 无法建立 WebSocket 连接（地址、端口、服务未运行、证书不被信任） */
  UNREACHABLE = -1,
  /** 连接中途断开 */
  CONNECTION_LOST = -2,
  /** 请求超时 */
  TIMEOUT = -3,
  /** 证书指纹与上次记住的不一致（由平台的 TrustStore 报告） */
  FINGERPRINT_CHANGED = -4,
  /** 服务器返回了不符合协议的消息 */
  PROTOCOL = -5,
  /** 端到端加密房间里，加密还没准备好（媒体连接或密钥交换未完成），暂时不能发聊天 */
  E2EE_NOT_READY = -6,
}

/** 这些错误不应自动重连：重试只会得到同样的结果。 */
export function isFatal(code: ErrorCode | LocalErrorCode): boolean {
  return [
    ErrorCode.PROTOCOL_VERSION_UNSUPPORTED,
    ErrorCode.AUTH_FAILED,
    ErrorCode.TLS_MITM_SUSPECTED,
    ErrorCode.BANNED,
    ErrorCode.PASSWORD_REQUIRED,
    ErrorCode.PASSWORD_INVALID,
    ErrorCode.SECURITY_LEVEL_TOO_LOW,
    ErrorCode.NICKNAME_INVALID,
    ErrorCode.KICKED,
    ErrorCode.SESSION_REPLACED,
    LocalErrorCode.FINGERPRINT_CHANGED,
  ].includes(code);
}
