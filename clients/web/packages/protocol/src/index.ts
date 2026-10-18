// 控制协议的 TypeScript 代码（由 proto/generate.sh 生成，勿手改 gen/ 下的文件）。
export * from './gen/openhane/v1/admin_pb';
export * from './gen/openhane/v1/chat_pb';
export * from './gen/openhane/v1/e2ee_pb';
export * from './gen/openhane/v1/envelope_pb';
export * from './gen/openhane/v1/errors_pb';
export * from './gen/openhane/v1/handshake_pb';
export * from './gen/openhane/v1/media_pb';
export * from './gen/openhane/v1/moderation_pb';
export * from './gen/openhane/v1/room_pb';
export * from './gen/openhane/v1/session_pb';
export { create, fromBinary, toBinary, clone } from '@bufbuild/protobuf';

/** 子协议名 */
export const SUBPROTOCOL = 'hane.v1';
/** 客户端支持的协议版本 */
export const PROTOCOL_VERSION = 1;
