import * as RD from '@radix-ui/react-dialog';
import { ChatImageError, type ChatImageErrorCode } from '@hane/core';
import type { ChatImage } from '@hane/protocol';
import { ArrowUp, CircleAlert, Download, ImageOff, ImagePlus, LoaderCircle, MessagesSquare, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { displaySize, prepareImage, useChatImage, type LoadedImage, type PreparedImage } from '../chatImage';
import { describeError } from '../errors';
import { useT, type Translate } from '../i18n';
import { useClient, useServices } from '../services';
import { Avatar } from './Avatar';

const EMPTY: never[] = [];
/** 同一个人这么久之内连续发的消息合在一起，只显示一次头像和名字 */
const GROUP_WINDOW_MS = 5 * 60 * 1000;
/** 服务端声称的图片大小上限再大，也按这个算 */
const IMAGE_MAX_BYTES = 50 << 20;

function imageError(e: unknown, t: Translate, maxBytes: number): string {
  if (!(e instanceof ChatImageError)) return describeError(e, t);
  const code: ChatImageErrorCode = e.code;
  return t(`chat.imageError.${code}`, { size: `${Math.max(1, Math.round(maxBytes / (1 << 20)))} MB` });
}

/** 房间聊天，与苹果客户端的样式一致。header 是标题栏（桌面版顶部这一行兼作窗口标题栏） */
export function ChatPanel({ headerClassName = '' }: { headerClassName?: string }) {
  const t = useT();
  const { client } = useServices();
  const roomId = useClient((s) => s.media?.roomId ?? 'main');
  const messages = useClient((s) => s.chat[roomId] ?? EMPTY);
  const hasMore = useClient((s) => s.chatHasMore[roomId] ?? false);
  const selfUid = useClient((s) => s.self?.uid);
  const maxBytes = useClient((s) => Math.min(s.serverInfo?.chatImageMaxBytes ?? 0, IMAGE_MAX_BYTES));
  const e2ee = useClient((s) => s.rooms[roomId]?.e2ee ?? false);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  // 待发送的图片（发送前预览）
  const [image, setImage] = useState<(PreparedImage & { url: string }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);

  // 新消息到达时，如果用户停留在底部就自动滚到底
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  useEffect(() => setError(null), [text]);
  useEffect(() => {
    if (!image) return;
    return () => URL.revokeObjectURL(image.url);
  }, [image]);
  // 换房间（或房间的加密状态变了）时丢掉没发出去的图片
  useEffect(() => setImage(null), [roomId, e2ee]);

  const attach = async (file: File | undefined) => {
    if (!file || !maxBytes || busy) return;
    setError(null);
    setBusy(true);
    try {
      const prepared = await prepareImage(file, maxBytes);
      setImage({ ...prepared, url: URL.createObjectURL(prepared.blob) });
      inputRef.current?.focus();
    } catch (e) {
      setError(imageError(e, t, maxBytes));
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    const body = text.trim();
    if ((!body && !image) || busy) return;
    stick.current = true;
    setBusy(true);
    try {
      const imageId = image ? await client.uploadChatImage(image.blob, image) : undefined;
      await client.sendChat(body, { imageId });
      setText('');
      setImage(null);
    } catch (e) {
      setError(imageError(e, t, maxBytes));
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  };

  // 图片加载完高度不变（已按比例占位），但第一次进来时列表可能还没滚到底
  const scrollIfStuck = () => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  };

  const imageFile = (files: FileList | null | undefined) => [...(files ?? [])].find((f) => f.type.startsWith('image/'));

  return (
    <aside
      className="relative flex w-full flex-col border-l border-border bg-surface md:w-80"
      aria-label={t('chat.title')}
      onDragOver={(e) => {
        if (!maxBytes || !e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(e) => {
        if (!maxBytes) return;
        e.preventDefault();
        setDragging(false);
        void attach(imageFile(e.dataTransfer.files));
      }}
    >
      <h2 className={`flex h-12 shrink-0 items-center border-b border-border px-4 text-sm font-semibold ${headerClassName}`}>{t('chat.title')}</h2>
      <div
        ref={listRef}
        className="flex-1 overflow-y-auto px-4 pb-4"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        data-testid="chat-list"
      >
        {hasMore && (
          <button className="mt-3 w-full text-center text-xs text-accent hover:underline" onClick={() => client.loadOlderChat(roomId)}>
            {t('chat.loadMore')}
          </button>
        )}
        {messages.length === 0 && (
          <div className="flex flex-col items-center gap-2 px-4 pt-16 text-center">
            <MessagesSquare size={30} className="text-muted/60" aria-hidden />
            <p className="text-sm font-medium text-muted">{t('chat.empty')}</p>
            <p className="text-xs text-muted">{t('chat.emptyHint')}</p>
          </div>
        )}
        {messages.map((m, i) => {
          const prev = messages[i - 1];
          const grouped = !!prev && prev.senderUid === m.senderUid && Number(m.createdAtMs - prev.createdAtMs) < GROUP_WINDOW_MS;
          const at = new Date(Number(m.createdAtMs));
          return (
            <div key={String(m.id)} className={`flex gap-2.5 text-sm ${grouped ? 'mt-1' : 'mt-3.5'}`}>
              {grouped ? <span className="w-7 shrink-0" /> : <Avatar name={m.senderName} uid={m.senderUid} size={28} />}
              <div className="min-w-0 flex-1">
                {!grouped && (
                  <div className="flex items-baseline gap-2">
                    <span className={`truncate font-semibold ${m.senderUid === selfUid ? 'text-accent' : ''}`}>{m.senderName}</span>
                    <time className="shrink-0 text-xs text-muted" dateTime={at.toISOString()}>
                      {at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </time>
                  </div>
                )}
                {m.image && <MessageImage roomId={m.roomId} image={m.image} onLoad={scrollIfStuck} />}
                {m.text && <p className={`whitespace-pre-wrap break-words ${m.image ? 'mt-1.5' : ''}`}>{m.text}</p>}
              </div>
            </div>
          );
        })}
      </div>
      {error && (
        <p className="flex items-center gap-1.5 px-4 pb-1 text-xs text-danger">
          <CircleAlert size={13} className="shrink-0" aria-hidden />
          {error}
        </p>
      )}
      <form
        className="border-t border-border p-3"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        {image && (
          <div className="relative mb-2 inline-block" data-testid="chat-attachment">
            <img src={image.url} alt={t('chat.image')} className="max-h-24 max-w-40 rounded-lg border border-border object-contain" />
            {busy && (
              <span className="absolute inset-0 flex items-center justify-center rounded-lg bg-black/35 text-white">
                <LoaderCircle size={18} className="animate-spin" aria-hidden />
              </span>
            )}
            <button
              type="button"
              className="absolute -top-2 -right-2 flex size-5 items-center justify-center rounded-full border border-border bg-surface text-muted shadow-sm hover:text-text disabled:opacity-50"
              onClick={() => setImage(null)}
              disabled={busy}
              aria-label={t('chat.removeImage')}
              title={t('chat.removeImage')}
            >
              <X size={12} strokeWidth={2.5} aria-hidden />
            </button>
          </div>
        )}
        <div className="flex items-end gap-2">
          {maxBytes > 0 && (
            <>
              <button
                type="button"
                className="flex size-9 shrink-0 items-center justify-center rounded-full text-muted transition hover:bg-surface-2 hover:text-text disabled:opacity-50"
                onClick={() => fileRef.current?.click()}
                disabled={busy}
                aria-label={t('chat.attachImage')}
                title={t('chat.attachImage')}
                data-testid="chat-attach"
              >
                {busy && !image ? <LoaderCircle size={18} className="animate-spin" aria-hidden /> : <ImagePlus size={18} aria-hidden />}
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  void attach(imageFile(e.target.files));
                  e.target.value = '';
                }}
              />
            </>
          )}
          <textarea
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
            onPaste={(e) => {
              const f = maxBytes ? imageFile(e.clipboardData.files) : undefined;
              if (f) {
                e.preventDefault();
                void attach(f);
              }
            }}
            rows={1}
            placeholder={t('chat.placeholder')}
            aria-label={t('chat.placeholder')}
            className="max-h-32 min-h-9 flex-1 resize-none rounded-[18px] border border-border bg-bg px-3.5 py-2 text-sm outline-none transition-[border-color,box-shadow] placeholder:text-muted focus:border-accent focus:ring-4 focus:ring-accent/15"
          />
          <button
            type="submit"
            className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent-solid text-white transition hover:brightness-110 disabled:bg-surface-2 disabled:text-muted"
            disabled={busy || (!text.trim() && !image)}
            aria-label={t('chat.send')}
            title={t('chat.send')}
          >
            <ArrowUp size={17} strokeWidth={2.5} aria-hidden />
          </button>
        </div>
      </form>
      {dragging && (
        <div className="pointer-events-none absolute inset-2 flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-accent bg-surface/90 text-sm font-medium text-accent">
          <ImagePlus size={26} aria-hidden />
          {t('chat.dropImage')}
        </div>
      )}
    </aside>
  );
}

/** 消息里的图片：按原图比例占好位置再加载，点击看大图 */
function MessageImage({ roomId, image, onLoad }: { roomId: string; image: ChatImage; onLoad: () => void }) {
  const t = useT();
  const { client } = useServices();
  const loaded = useChatImage(client, roomId, image.id);
  const [open, setOpen] = useState(false);
  const size = displaySize(image.width, image.height, 232, 240);
  const box = 'mt-1 block overflow-hidden rounded-lg border border-border bg-surface-2';
  if (loaded === null) {
    return (
      <span className={`${box} flex flex-col items-center justify-center gap-1 text-xs text-muted`} style={{ width: Math.max(size.width, 120), height: Math.min(Math.max(size.height, 72), 120) }} data-testid="chat-image-failed">
        <ImageOff size={18} aria-hidden />
        {t('chat.imageFailed')}
      </span>
    );
  }
  return (
    <>
      <button
        type="button"
        className={`${box} cursor-zoom-in transition hover:brightness-95 ${loaded ? '' : 'animate-pulse'}`}
        style={size}
        onClick={() => loaded && setOpen(true)}
        aria-label={t('chat.openImage')}
        title={t('chat.openImage')}
        data-testid="chat-image"
      >
        {loaded && <img src={loaded.url} alt={t('chat.image')} className="size-full object-cover" onLoad={onLoad} draggable={false} />}
      </button>
      {loaded && <ImageViewer open={open} onOpenChange={setOpen} image={loaded} id={image.id} />}
    </>
  );
}

/** 大图：铺满窗口显示，可以下载 */
function ImageViewer({ open, onOpenChange, image, id }: { open: boolean; onOpenChange: (open: boolean) => void; image: LoadedImage; id: string }) {
  const t = useT();
  const button = 'flex size-9 items-center justify-center rounded-full bg-white/10 text-white transition hover:bg-white/20';
  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <RD.Portal>
        <RD.Overlay className="app-no-drag fixed inset-0 z-40 bg-black/85" />
        <RD.Content className="app-no-drag fixed inset-0 z-50 flex items-center justify-center p-4 outline-none sm:p-10" onClick={() => onOpenChange(false)}>
          <RD.Title className="sr-only">{t('chat.image')}</RD.Title>
          <RD.Description className="sr-only">{t('chat.image')}</RD.Description>
          <img src={image.url} alt={t('chat.image')} className="max-h-full max-w-full rounded-md object-contain shadow-2xl" onClick={(e) => e.stopPropagation()} />
          <div className="absolute top-3 right-3 flex gap-2" onClick={(e) => e.stopPropagation()}>
            <a href={image.url} download={`openhane-${id.slice(0, 8)}.${image.ext}`} className={button} aria-label={t('chat.download')} title={t('chat.download')}>
              <Download size={17} aria-hidden />
            </a>
            <RD.Close className={button} aria-label={t('common.close')} title={t('common.close')}>
              <X size={18} aria-hidden />
            </RD.Close>
          </div>
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}
