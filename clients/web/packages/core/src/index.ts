export { OpenHaneClient, backoffMs, type ClientOptions, type ConnectParams } from './client';
export { HaneError, LocalErrorCode, isFatal } from './errors';
export { parseAddress, controlUrl, mediaUrl, hostPort, displayAddress, DEFAULT_PORT, AddressError, type ServerAddress } from './address';
export { deriveIdentity, uidOf, shortUid, toHex, type ServerIdentity } from './identity';
export { type ClientState, type ClientStore, type ConnectionStatus, type MediaTarget, type SelfInfo, CHAT_KEEP } from './state';
export { keyPackageAAD, openKeyPackage, sealKeyPackage, newMediaKey, safetyCode, verifyE2EEKey, type KeyExchange } from './e2ee';
