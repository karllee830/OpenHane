// 聊天图片：上传到 POST /api/v1/chat/images，读取 GET /api/v1/chat/images/<房间>/<图片>，都带会话凭据。
// 服务端返回的内容一律不信任：限制读取的字节数、不跟随重定向，检查 ID 格式、尺寸和文件头。

/** 图片的最大边长（服务端保存的不超过 4096，留余量） */
export const CHAT_IMAGE_MAX_SIDE = 8192;
/** 读取一张图片最多多少字节 */
export const CHAT_IMAGE_FETCH_MAX = 64 << 20;

/** 上传失败的原因（服务端返回的 error 字段；其他情况都是 failed） */
export type ChatImageErrorCode = 'too_large' | 'unsupported' | 'rate_limited' | 'storage_full' | 'disabled' | 'forbidden' | 'failed';

export class ChatImageError extends Error {
  constructor(readonly code: ChatImageErrorCode) {
    super(`chat image: ${code}`);
    this.name = 'ChatImageError';
  }
}

const ERROR_CODES = new Set<ChatImageErrorCode>(['too_large', 'unsupported', 'rate_limited', 'storage_full', 'disabled', 'forbidden']);

export function chatImageErrorCode(raw: unknown): ChatImageErrorCode {
  return typeof raw === 'string' && ERROR_CODES.has(raw as ChatImageErrorCode) ? (raw as ChatImageErrorCode) : 'failed';
}

export const isImageId = (id: unknown): id is string => typeof id === 'string' && /^[0-9a-z]{26}$/.test(id);
export const isRoomId = (id: unknown): id is string => typeof id === 'string' && /^[0-9a-z_]{1,32}$/.test(id);

/** 宽高必须是 1–CHAT_IMAGE_MAX_SIDE 的整数，否则当作不合格 */
export function validSize(w: unknown, h: unknown): boolean {
  const ok = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= CHAT_IMAGE_MAX_SIDE;
  return ok(w) && ok(h);
}

/** 读响应体，最多 limit 字节：超了立即停止并报错（恶意服务端可以一直发数据） */
export async function readLimited(r: Response, limit: number): Promise<Uint8Array> {
  const declared = Number(r.headers.get('content-length'));
  if (declared > limit) throw new Error('response too large');
  const reader = r.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      void reader.cancel();
      throw new Error('response too large');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/**
 * 看文件头判断是不是 PNG 或 JPEG（不解码）；PNG 还检查宽高在 1–maxSide 之间。
 * 返回按哪种类型交给浏览器，不合格时返回 null
 */
export function sniffImage(b: Uint8Array, maxSide = CHAT_IMAGE_MAX_SIDE): 'image/png' | 'image/jpeg' | null {
  if (b.length >= 24 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v)) {
    // 第一个块必须是 IHDR，宽高是紧跟其后的两个大端 32 位整数
    if (String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!) !== 'IHDR') return null;
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const w = v.getUint32(16);
    const h = v.getUint32(20);
    return w >= 1 && h >= 1 && w <= maxSide && h <= maxSide ? 'image/png' : null;
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  return null;
}

/**
 * 聊天图片的传输节奏：会议中由媒体层提供，媒体拥堵时放慢、给语音和视频让路（见 @hane/media 的 TrafficPacer）。
 * 没有设置时不限速
 */
export interface TransferPacer {
  /** 这一方向现在合适的分块大小（字节） */
  chunkBytes(direction: 'up' | 'down'): number;
  /** 传输 bytes 字节之前调用：按当前允许的速度等待 */
  wait(direction: 'up' | 'down', bytes: number, signal?: AbortSignal): Promise<void>;
}

/** 没有节奏控制时一块的大小 */
const CHUNK_UNPACED = 1 << 20;
/** 每一块（一次请求）的时限 */
const CHUNK_TIMEOUT_MS = 60_000;

async function errorCode(r: Response): Promise<ChatImageErrorCode> {
  if (r.status === 413) return 'too_large';
  try {
    return chatImageErrorCode((JSON.parse(new TextDecoder().decode(await readLimited(r, 4096))) as { error?: unknown }).error);
  } catch {
    return 'failed';
  }
}

/**
 * 分块上传（POST …/uploads → 按顺序 PUT 每一块 → POST …/finish），每块之前按节奏等待。返回服务端的回应（JSON）。
 * 网络出错时同一块重试一次（服务端会直接确认重复的块）
 */
export async function uploadChunked(base: string, token: string, roomId: string, body: Uint8Array, pacer: TransferPacer | null): Promise<unknown> {
  const auth = { Authorization: `Bearer ${token}` };
  const call = async (url: string, init: RequestInit) => {
    try {
      return await fetch(url, { ...init, headers: { ...auth, ...init.headers }, redirect: 'error', signal: AbortSignal.timeout(CHUNK_TIMEOUT_MS) });
    } catch {
      throw new ChatImageError('failed');
    }
  };
  let r = await call(`${base}/api/v1/chat/images/uploads?room=${encodeURIComponent(roomId)}&size=${body.length}`, { method: 'POST' });
  if (!r.ok) throw new ChatImageError(await errorCode(r));
  const upload = ((await r.json().catch(() => ({}))) as { upload?: unknown }).upload;
  if (!isImageId(upload)) throw new ChatImageError('failed');
  for (let off = 0; off < body.length; ) {
    const n = Math.min(pacer?.chunkBytes('up') ?? CHUNK_UNPACED, body.length - off);
    await pacer?.wait('up', n);
    const chunk = body.subarray(off, off + n);
    const put = () => call(`${base}/api/v1/chat/images/uploads/${upload}?offset=${off}`, { method: 'PUT', body: chunk as BodyInit, headers: { 'Content-Type': 'application/octet-stream' } });
    r = await put().catch(put);
    if (!r.ok) throw new ChatImageError(await errorCode(r));
    off += n;
  }
  r = await call(`${base}/api/v1/chat/images/uploads/${upload}/finish`, { method: 'POST' });
  if (!r.ok) throw new ChatImageError(await errorCode(r));
  try {
    return JSON.parse(new TextDecoder().decode(await readLimited(r, 4096)));
  } catch {
    throw new ChatImageError('failed');
  }
}

/** 分段下载（Range），每段之前按节奏等待；总大小超过 limit 时报错 */
export async function downloadRanged(url: string, token: string, limit: number, pacer: TransferPacer | null): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let total = Infinity;
  let got = 0;
  while (got < total) {
    const n = pacer?.chunkBytes('down') ?? CHUNK_UNPACED;
    await pacer?.wait('down', n);
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Range: `bytes=${got}-${got + n - 1}` },
      redirect: 'error',
      signal: AbortSignal.timeout(CHUNK_TIMEOUT_MS),
    });
    if (r.status === 200) return readLimited(r, limit); // 服务端不支持分段：整个返回
    if (r.status !== 206) throw new Error(String(r.status));
    const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(r.headers.get('content-range') ?? '');
    if (!m || Number(m[1]) !== got) throw new Error('bad content-range');
    total = Number(m[3]);
    if (total > limit) throw new Error('response too large');
    const part = await readLimited(r, n);
    if (!part.length) throw new Error('empty range');
    parts.push(part);
    got += part.length;
  }
  const out = new Uint8Array(got);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
