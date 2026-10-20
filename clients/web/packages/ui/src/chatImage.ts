// 聊天图片：发送前的压缩、显示时的下载缓存。
import { ChatImageError, validSize, type OpenHaneClient } from '@hane/core';
import { useEffect, useState } from 'react';

/** 发送的图片长边不超过这么多像素（聊天里看足够清楚） */
export const UPLOAD_MAX_SIDE = 2048;
/** 压缩的目标大小：超过时降低质量或尺寸再试（图片传输给语音和视频让路，小一些发得快） */
const TARGET_BYTES = 1 << 20;

/** 准备好上传的图片和它的宽高 */
export interface PreparedImage {
  blob: Blob;
  width: number;
  height: number;
}

/**
 * 发送前在本地压缩：按 EXIF 方向转正，长边缩到 UPLOAD_MAX_SIDE 以内，重新编码（顺带去掉拍摄位置等元数据）。
 * 截图和带透明的图先试 PNG（文字清楚），太大就改用 JPEG；照片用 JPEG，逐步降低质量和尺寸，直到不超过目标大小。
 * 都超过目标时取不超过 maxBytes 的最小的一个
 */
export async function prepareImage(file: Blob, maxBytes: number): Promise<PreparedImage> {
  if (!file.type.startsWith('image/')) throw new ChatImageError('unsupported');
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file); // 默认按 EXIF 方向转正
  } catch {
    throw new ChatImageError('unsupported');
  }
  try {
    const target = Math.min(maxBytes, TARGET_BYTES);
    const attempts: [type: string, side: number, quality: number][] = [
      ...(file.type === 'image/png' || file.type === 'image/gif' ? [['image/png', UPLOAD_MAX_SIDE, 1] as [string, number, number]] : []),
      ['image/jpeg', UPLOAD_MAX_SIDE, 0.85],
      ['image/jpeg', UPLOAD_MAX_SIDE, 0.75],
      ['image/jpeg', Math.round(UPLOAD_MAX_SIDE * 0.7), 0.75],
      ['image/jpeg', Math.round(UPLOAD_MAX_SIDE * 0.5), 0.7],
    ];
    let best: PreparedImage | null = null;
    for (const [type, side, quality] of attempts) {
      const out = await encode(bitmap, side, type, quality);
      if (out.blob.size <= target) return out;
      if (out.blob.size <= maxBytes && (!best || out.blob.size < best.blob.size)) best = out;
    }
    if (best) return best;
    throw new ChatImageError('too_large');
  } finally {
    bitmap.close();
  }
}

function encode(bitmap: ImageBitmap, side: number, type: string, quality: number): Promise<PreparedImage> {
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
  const { width, height } = canvas;
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve({ blob: b, width, height }) : reject(new ChatImageError('failed'))), type, quality));
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
