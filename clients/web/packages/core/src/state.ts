import type {
  ChatMessage,
  MediaGrant,
  MediaPolicy,
  Participant,
  Role,
  Room,
  ServerInfo,
  Snapshot,
} from '@hane/protocol';
import { createStore } from 'zustand/vanilla';
import type { HaneError } from './errors';
import type { ServerAddress } from './address';
import { withCleanName } from './names';

export type ConnectionStatus =
  | 'idle' // 未连接
  | 'connecting' // 首次连接中
  | 'connected'
  | 'reconnecting' // 断线后自动重连中（会话在服务端保留 60 秒）
  | 'failed'; // 连接失败或被拒绝（见 error）

export interface SelfInfo {
  sessionId: string;
  uid: string;
  nickname: string;
  role: Role;
}

/** 当前房间的媒体连接参数。grant 每次变化（新令牌）时 version 加一。 */
export interface MediaTarget {
  roomId: string;
  url: string;
  grant: MediaGrant | undefined;
  policy: MediaPolicy | undefined;
  version: number;
}

export interface ClientState {
  status: ConnectionStatus;
  error: HaneError | null;
  address: ServerAddress | null;
  /** 重连尝试次数（reconnecting 时有效） */
  attempt: number;
  serverId: string | null;
  serverInfo: ServerInfo | null;
  self: SelfInfo | null;
  rooms: Record<string, Room>;
  participants: Record<string, Participant>;
  chat: Record<string, ChatMessage[]>;
  /** 每个房间是否还有更早的聊天记录可以加载 */
  chatHasMore: Record<string, boolean>;
  media: MediaTarget | null;
  /** 最近一次心跳往返时间（毫秒） */
  rttMs: number | null;
}

export const initialState: ClientState = {
  status: 'idle',
  error: null,
  address: null,
  attempt: 0,
  serverId: null,
  serverInfo: null,
  self: null,
  rooms: {},
  participants: {},
  chat: {},
  chatHasMore: {},
  media: null,
  rttMs: null,
};

export const createClientStore = () => createStore<ClientState>()(() => ({ ...initialState }));
export type ClientStore = ReturnType<typeof createClientStore>;

/** 每个房间在内存中最多保留的聊天条数 */
export const CHAT_KEEP = 500;

export function snapshotState(snap: Snapshot | undefined): Pick<ClientState, 'serverInfo' | 'rooms' | 'participants'> {
  const rooms: Record<string, Room> = {};
  const participants: Record<string, Participant> = {};
  for (const r of snap?.rooms ?? []) rooms[r.id] = r;
  for (const p of snap?.participants ?? []) participants[p.sessionId] = p;
  return { serverInfo: withCleanName(snap?.info), rooms, participants };
}

/** 按 id 合并聊天消息（去重、升序、截断）。 */
export function mergeChat(existing: ChatMessage[] | undefined, incoming: ChatMessage[]): ChatMessage[] {
  const byId = new Map<bigint, ChatMessage>();
  for (const m of existing ?? []) byId.set(m.id, m);
  for (const m of incoming) byId.set(m.id, m);
  const all = [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return all.length > CHAT_KEEP ? all.slice(all.length - CHAT_KEEP) : all;
}
