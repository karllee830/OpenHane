export { OpenHaneClient, backoffMs, type ChatCipher, type ClientOptions, type ConnectParams } from './client';
export { HaneError, LocalErrorCode, isFatal } from './errors';
export { parseAddress, controlUrl, httpBase, mediaUrl, hostPort, displayAddress, candidateAddresses, DEFAULT_PORT, FALLBACK_PORTS, AddressError, type ServerAddress } from './address';
export { deriveIdentity, uidOf, shortUid, toHex, type ServerIdentity } from './identity';
export { cleanChatText, cleanDisplayName, MAX_CHAT_CHARS, MAX_NAME_CHARS } from './names';
export { ChatImageError, CHAT_IMAGE_MAX_SIDE, readLimited, sniffImage, validSize, type ChatImageErrorCode, type TransferPacer } from './images';
export { type ClientState, type ClientStore, type ConnectionStatus, type MediaTarget, type SelfInfo, CHAT_KEEP } from './state';
export {
  chatAAD,
  chatKey,
  openChat,
  sealChat,
  keyPackageAAD,
  openKeyPackage,
  sealKeyPackage,
  newMediaKey,
  safetyCode,
  safetyCodeFromDigest,
  safetyDigest,
  SAFETY_EMOJI,
  verifyE2EEKey,
  type KeyExchange,
} from './e2ee';
