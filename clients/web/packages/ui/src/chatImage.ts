// 聊天图片：发送前的压缩、显示时的下载缓存。
import { ChatImageError, validSize, type OpenHaneClient } from '@hane/core';
import { useEffect, useState } from 'react';

/** 上传的图片长边不超过这么多像素（服务端也会缩到这么大） */
export const UPLOAD_MAX_SIDE = 4096;

/**
 * 把用户选的图片变成可以上传的 PNG / JPEG：已经是 PNG / JPEG、不太大的原样上传（服务端会按 EXIF 方向转正）；
 * 其他格式（GIF、WebP、HEIC 等浏览器能解码的）或超过大小 / 尺寸的重新绘制编码，必要时缩小。
 */
export async function prepareImage(file: Blob, maxBytes: number): Promise<Blob> {
  if (!file.type.startsWith('image/')) throw new ChatImageError('unsupported');
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file); // 默认按 EXIF 方向转正
  } catch {
    throw new ChatImageError('unsupported');
  }
  try {
    const native = file.type === 'image/png' || file.type === 'image/jpeg';
    if (native && file.size <= maxBytes && Math.max(bitmap.width, bitmap.height) <= UPLOAD_MAX_SIDE) return file;
    // 截图、带透明的图用 PNG，照片用 JPEG
    const png = file.type === 'image/png' || file.type === 'image/gif';
    let side = UPLOAD_MAX_SIDE;
    for (let i = 0; i < 4; i++) {
      const out = await encode(bitmap, side, png && i === 0 ? 'image/png' : 'image/jpeg', i < 2 ? 0.9 : 0.8);
      if (out.size <= maxBytes) return out;
      side = Math.round(side * 0.7);
    }
    throw new ChatImageError('too_large');
  } finally {
    bitmap.close();
  }
}

function encode(bitmap: ImageBitmap, side: number, type: string, quality: number): Promise<Blob> {
  const scale = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.reject(new ChatImageError('failed'));
  if (type === 'image/jpeg') {
    // JPEG 没有透明通道：透明的地方垫白色，不然会变黑
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new ChatImageError('failed'))), type, quality));
}

/** 消息里图片的显示尺寸：按原图比例放进 maxW × maxH，服务端给的宽高不合格时按正方形 */
export function displaySize(w: number, h: number, maxW: number, maxH: number): { width: number; height: number } {
  if (!validSize(w, h)) return { width: Math.min(maxW, maxH), height: Math.min(maxW, maxH) };
  const scale = Math.min(1, maxW / w, maxH / h);
  return { width: Math.max(24, Math.round(w * scale)), height: Math.max(24, Math.round(h * scale)) };
}

/** 下载好的图片：本地 Blob 地址和扩展名（保存时用） */
export interface LoadedImage {
  url: string;
  ext: 'png' | 'jpg';
}

/** 已下载的图片（房间/图片 → 本地 Blob 地址）。只保留最近的一些，旧的释放掉 */
const cache = new Map<string, Promise<LoadedImage>>();
const CACHE_KEEP = 120;

function load(client: OpenHaneClient, roomId: string, imageId: string): Promise<LoadedImage> {
  const key = `${roomId}/${imageId}`;
  let p = cache.get(key);
  if (p) {
    // 重新放到最后（最近使用）
    cache.delete(key);
    cache.set(key, p);
    return p;
  }
  p = client.loadChatImage(roomId, imageId).then((b) => ({ url: URL.createObjectURL(b), ext: b.type === 'image/png' ? 'png' : 'jpg' }));
  // 失败的不缓存，下次显示时重试
  p.catch(() => cache.delete(key));
  cache.set(key, p);
  while (cache.size > CACHE_KEEP) {
    const [oldKey, old] = cache.entries().next().value!;
    cache.delete(oldKey);
    // 晚一点再释放：可能还有界面在显示它
    void old.then((img) => setTimeout(() => URL.revokeObjectURL(img.url), 60_000)).catch(() => undefined);
  }
  return p;
}

/** 消息里的图片：undefined 表示还在加载，null 表示加载失败 */
export function useChatImage(client: OpenHaneClient, roomId: string, imageId: string): LoadedImage | null | undefined {
  const [img, setImg] = useState<LoadedImage | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    setImg(undefined);
    load(client, roomId, imageId).then(
      (v) => alive && setImg(v),
      () => alive && setImg(null),
    );
    return () => {
      alive = false;
    };
  }, [client, roomId, imageId]);
  return img;
}
