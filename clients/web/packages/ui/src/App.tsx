import { parseAddress } from '@hane/core';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { DesktopIntegration } from './components/DesktopIntegration';
import { TofuWarning } from './components/TofuWarning';
import { I18nContext, pickLocale, translator } from './i18n';
import { ConnectPage } from './pages/ConnectPage';
import { HomePage } from './pages/HomePage';
import { ServicesContext, useClient, useServices, type AppServices } from './services';

// 会议页（侧栏、对话框、共享视图等）按需加载：首屏只有连接页，减小首屏 JS（gzip 后 ≤ 300 KB）
const loadMeetingPage = () => import('./pages/MeetingPage').then((m) => ({ default: m.MeetingPage }));
const MeetingPage = lazy(loadMeetingPage);
// 首屏渲染完后空闲时预先下载，点「连接」时不用再等
if (typeof window !== 'undefined') (window.requestIdleCallback ?? ((f: () => void) => setTimeout(f, 1500)))(() => void loadMeetingPage());

function Router({ defaultAddress, invite }: { defaultAddress?: string; invite?: string }) {
  const { client, media } = useServices();
  const status = useClient((s) => s.status);
  const inMeeting = status === 'connected' || status === 'reconnecting';
  const started = useRef(false);

  // 进入会议后启动媒体；离开（或被拒绝）后释放麦克风
  useEffect(() => {
    if (status === 'connected' && !started.current) {
      started.current = true;
      // 服务器开启了「加入时静音」时，Welcome 中的自身状态是静音
      const s = client.store.getState();
      const self = s.participants[s.self?.sessionId ?? ''];
      void media.setMicMuted(!!self?.state?.micMuted);
      media.start();
    } else if (!inMeeting && status !== 'connecting' && started.current) {
      started.current = false;
      void media.stop();
    }
  }, [status, inMeeting, client, media]);

  // 网络恢复时立即重连，而不是等退避
  useEffect(() => {
    const online = () => client.retryNow();
    window.addEventListener('online', online);
    return () => window.removeEventListener('online', online);
  }, [client]);

  // openhane://host:port?token=…：预填地址；令牌在进入会议后弹窗确认再兑换
  const { platform } = useServices();
  const [link, setLink] = useState<{ address: string; token?: string; invite?: string } | null>(null);
  useEffect(
    () =>
      platform.deepLinks?.onLink((url) => {
        try {
          const a = parseAddress(url);
          const q = new URL(url.replace(/^openhane:/i, 'https:')).searchParams;
          setLink({ address: `${a.host.includes(':') ? `[${a.host}]` : a.host}:${a.port}`, token: q.get('token') ?? undefined, invite: q.get('invite') ?? a.invite });
        } catch {
          // 无效链接：忽略
        }
      }),
    [platform],
  );

  return (
    <>
      <TofuWarning />
      <DesktopIntegration />
      {inMeeting ? (
        <Suspense fallback={null}>
          <MeetingPage pendingToken={link?.token} onTokenHandled={() => setLink((l) => (l ? { address: l.address } : l))} />
        </Suspense>
      ) : (
        // 网页由服务器提供时只能连这一台（加入页）；桌面版和单独部署的网页显示服务器列表
        defaultAddress ? (
          <ConnectPage address={defaultAddress} invite={link?.invite ?? invite} landing={!link && !!invite} />
        ) : (
          <HomePage key={link?.address ?? ''} linkAddress={link?.address} invite={link?.invite ?? invite} />
        )
      )}
    </>
  );
}

export function App({ services, defaultAddress, invite }: { services: AppServices; defaultAddress?: string; invite?: string }) {
  const t = useMemo(() => translator(pickLocale()), []);
  useEffect(() => {
    document.documentElement.lang = pickLocale();
  }, []);
  return (
    <I18nContext.Provider value={t}>
      <ServicesContext.Provider value={services}>
        <Router defaultAddress={defaultAddress} invite={invite} />
      </ServicesContext.Provider>
    </I18nContext.Provider>
  );
}
