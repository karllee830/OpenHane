import { ArrowUp, CircleAlert, MessagesSquare } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { describeError } from '../errors';
import { useT } from '../i18n';
import { useClient, useServices } from '../services';
import { Avatar } from './Avatar';

const EMPTY: never[] = [];
/** 同一个人这么久之内连续发的消息合在一起，只显示一次头像和名字 */
const GROUP_WINDOW_MS = 5 * 60 * 1000;

/** 房间聊天，与苹果客户端的样式一致。header 是标题栏（桌面版顶部这一行兼作窗口标题栏） */
export function ChatPanel({ headerClassName = '' }: { headerClassName?: string }) {
  const t = useT();
  const { client } = useServices();
  const roomId = useClient((s) => s.media?.roomId ?? 'main');
  const messages = useClient((s) => s.chat[roomId] ?? EMPTY);
  const hasMore = useClient((s) => s.chatHasMore[roomId] ?? false);
  const selfUid = useClient((s) => s.self?.uid);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  // 新消息到达时，如果用户停留在底部就自动滚到底
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  useEffect(() => setError(null), [text]);

  const send = async () => {
    const body = text.trim();
    if (!body) return;
    setText('');
    stick.current = true;
    try {
      await client.sendChat(body);
    } catch (e) {
      setText(body);
      setError(describeError(e, t));
    }
  };

  return (
    <aside className="flex w-full flex-col border-l border-border bg-surface md:w-80" aria-label={t('chat.title')}>
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
          <button className="mt-3 w-full text-center text-xs text-accent hover:underline" onClick={() => client.loadChatHistory(roomId, messages[0]?.id ?? 0n)}>
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
                <p className="whitespace-pre-wrap break-words">{m.text}</p>
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
        className="flex items-end gap-2 border-t border-border p-3"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
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
          disabled={!text.trim()}
          aria-label={t('chat.send')}
          title={t('chat.send')}
        >
          <ArrowUp size={17} strokeWidth={2.5} aria-hidden />
        </button>
      </form>
    </aside>
  );
}
