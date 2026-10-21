// 成员菜单底部的连接信息（仅管理员）：往返延迟、IP、归属地、客户端类型和版本；IPv6 地址在服务器没有 IPv6 库时提示下载。
import type { GetSessionInfoResult, Platform } from '@hane/protocol';
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { describeError } from '../errors';
import { useT } from '../i18n';
import { useServices } from '../services';
import { Dialog } from './Dialog';
import { platformName } from './MeetingBits';
import { ensureFlagFont, FLAG_FONT_FAMILY, flagEmoji } from '../flags';

/** 延迟最多显示 4 位：再大已经没有区别 */
const latency = (ms: number) => (ms > 9999 ? '9999+ ms' : `${ms} ms`);

export function MemberInfo({ sessionId, platform, onDownloadV6 }: { sessionId: string; platform: Platform; onDownloadV6: () => void }) {
  const t = useT();
  const { client } = useServices();
  const [info, setInfo] = useState<GetSessionInfoResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    client.getSessionInfo(sessionId).then(
      (r) => live && setInfo(r),
      (e) => live && setErr(describeError(e, t)),
    );
    return () => {
      live = false;
    };
  }, [client, sessionId, t]);

  const place = info ? [info.country, info.province, info.city].filter(Boolean).join(' ') : '';
  // 客户端类型和版本，例如 macOS (0.2.0)
  const clientLabel = [platformName(platform), info?.appVersion && `(${info.appVersion})`].filter(Boolean).join(' ');
  return (
    <div className="px-2 py-1.5 text-xs text-muted" data-testid="member-info">
      {err ? (
        <span className="text-danger">{err}</span>
      ) : !info ? (
        t('member.infoLoading')
      ) : (
        <>
          <div className="flex font-mono text-text">
            {info.rttMs > 0 && <span className="shrink-0 whitespace-pre">{latency(info.rttMs)} · </span>}
            {info.ip ? <CopyableIP ip={info.ip} /> : t('member.ipUnknown')}
          </div>
          {info.ipv6DbMissing ? (
            <button type="button" className="text-accent hover:underline" onClick={onDownloadV6} data-testid="geo-v6-missing">
              {t('geo.v6Missing')}
            </button>
          ) : (
            (place || info.isp) && <Line text={[place, info.isp].filter(Boolean).join(' · ')} flag={flagEmoji(info.countryCode)} />
          )}
          {clientLabel && <Line text={clientLabel} />}
        </>
      )}
    </div>
  );
}

/** 一行文字，过长时截断，悬停显示全文；flag 是行首的国旗 emoji */
function Line({ text, flag }: { text: string; flag?: string }) {
  useEffect(() => {
    if (flag) ensureFlagFont();
  }, [flag]);
  return (
    <div className="truncate" title={text}>
      {flag && (
        <span className="mr-1" style={{ fontFamily: FLAG_FONT_FAMILY }} aria-hidden>
          {flag}
        </span>
      )}
      {text}
    </div>
  );
}

/** 点击复制的 IP 地址。放不下时来回滚动，不撑宽菜单（inline-size 包含：宽度不受文字长度影响） */
function CopyableIP({ ip }: { ip: string }) {
  const t = useT();
  const box = useRef<HTMLButtonElement>(null);
  const text = useRef<HTMLSpanElement>(null);
  const [shift, setShift] = useState(0);
  const [copied, setCopied] = useState(false);

  useLayoutEffect(() => {
    if (box.current && text.current) setShift(Math.max(0, text.current.scrollWidth - box.current.clientWidth));
  }, [ip, copied]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(timer);
  }, [copied]);

  // 每秒滚动约 20 px；滚过去和滚回来各占一个周期的 30%
  const style = shift ? ({ '--marquee-shift': `-${shift}px`, '--marquee-duration': `${Math.max(6, shift / 20 / 0.3)}s` } as CSSProperties) : undefined;
  return (
    <button
      ref={box}
      type="button"
      className="min-w-0 flex-1 overflow-hidden text-left [contain:inline-size] hover:text-accent"
      title={t('member.copyIp')}
      onClick={() => navigator.clipboard.writeText(ip).then(() => setCopied(true), () => {})}
      data-testid="member-ip"
    >
      {copied ? (
        <span className="font-sans">{t('member.copied')}</span>
      ) : (
        <span ref={text} className={`inline-block whitespace-nowrap ${shift ? 'hane-marquee' : ''}`} style={style}>
          {ip}
        </span>
      )}
    </button>
  );
}

export function IPv6GeoDialog({ onClose, onNotice }: { onClose: () => void; onNotice: (m: string) => void }) {
  const t = useT();
  const { client } = useServices();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()} title={t('geo.v6Title')} description={t('geo.v6Body')}>
      {err && <p className="mb-3 text-sm text-danger">{err}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" className="rounded-md px-3 py-1.5 text-sm hover:bg-surface-2" disabled={busy} onClick={onClose}>
          {t('common.cancel')}
        </button>
        <button
          type="button"
          className="rounded-md bg-accent px-3 py-1.5 text-sm text-white disabled:opacity-60"
          disabled={busy}
          data-testid="geo-v6-download"
          onClick={async () => {
            setBusy(true);
            setErr(null);
            try {
              await client.downloadIPv6GeoDB();
              onNotice(t('geo.v6Done'));
              onClose();
            } catch (e) {
              setErr(t('geo.v6Failed', { error: describeError(e, t) }));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? t('geo.v6Downloading') : t('geo.v6Download')}
        </button>
      </div>
    </Dialog>
  );
}
