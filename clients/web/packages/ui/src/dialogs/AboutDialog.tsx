import { ChevronLeft, ExternalLink } from 'lucide-react';
import { useEffect, useState } from 'react';
// 第三方许可证清单（scripts/licenses/generate.mjs 生成）。体积较大，作为单独的文件按需加载，不打进首屏 JS
import licensesUrl from '../assets/licenses.json?url';
import { Dialog } from '../components/Dialog';
import { LogoMark } from '../components/LogoMark';
import { useT } from '../i18n';
import { useServices } from '../services';

const BUILD = typeof __APP_BUILD__ === 'string' ? __APP_BUILD__ : '';
const SOURCE_URL = 'https://github.com/karllee830/OpenHane';
const LOGO_DESIGNER_URL = 'https://github.com/Kubai087';

interface LicenseGroup {
  license: string;
  packages: string[];
  text: string;
}
interface LicenseList {
  components: number;
  groups: LicenseGroup[];
}

/** 关于羽见：版本、版权、许可证，以及「开源许可」（第三方组件的许可证原文） */
export function AboutDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const t = useT();
  const { client } = useServices();
  const [view, setView] = useState<'about' | 'licenses'>('about');
  useEffect(() => {
    if (!open) setView('about');
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={view === 'about' ? t('about.title') : t('licenses.title')} wide={view === 'licenses'}>
      {view === 'about' ? (
        <div className="flex flex-col items-center gap-3 text-center" data-testid="about">
          <LogoMark size={72} />
          <div>
            <p className="text-lg font-semibold">{t('app.name')}</p>
            <p className="text-sm text-muted">{t('about.version', { version: BUILD ? `${client.appVersion} (${BUILD})` : client.appVersion })}</p>
          </div>
          <p className="text-sm">{t('connect.tagline')}</p>
          <div className="space-y-1 text-xs text-muted">
            <p>Copyright © 2026 Karl Lee (@karllee830)</p>
            <p>{t('about.license')}</p>
            <p>
              {t('about.logo')}
              <a href={LOGO_DESIGNER_URL} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                Kubai087
              </a>
            </p>
          </div>
          <div className="mt-2 flex flex-wrap justify-center gap-2">
            <a href={SOURCE_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-sm hover:bg-surface-2">
              {t('about.source')}
              <ExternalLink size={14} aria-hidden />
            </a>
            <button className="rounded-md bg-accent-solid px-3 py-2 text-sm text-white" onClick={() => setView('licenses')} data-testid="about-licenses">
              {t('about.licenses')}
            </button>
          </div>
        </div>
      ) : (
        <Licenses onBack={() => setView('about')} />
      )}
    </Dialog>
  );
}

function Licenses({ onBack }: { onBack: () => void }) {
  const t = useT();
  const [list, setList] = useState<LicenseList | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    fetch(licensesUrl)
      .then((r) => (r.ok ? (r.json() as Promise<LicenseList>) : Promise.reject(new Error(String(r.status)))))
      .then((l) => alive && setList(l))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="space-y-3" data-testid="licenses">
      <button className="inline-flex items-center gap-1 text-sm text-accent hover:underline" onClick={onBack}>
        <ChevronLeft size={16} aria-hidden />
        {t('about.title')}
      </button>
      {failed ? (
        <p className="text-sm text-danger">{t('licenses.error')}</p>
      ) : !list ? (
        <p className="text-sm text-muted">{t('licenses.loading')}</p>
      ) : (
        <>
          <p className="text-sm text-muted">{t('licenses.summary', { n: String(list.components) })}</p>
          <ul className="divide-y divide-border rounded-lg border border-border">
            {list.groups.map((g, i) => (
              <li key={i}>
                <details className="group">
                  <summary className="cursor-pointer list-none px-3 py-2 text-sm hover:bg-surface-2">
                    <span className="block break-words">{g.packages.join(', ')}</span>
                    <span className="text-xs text-muted">{g.license}</span>
                  </summary>
                  <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words border-t border-border bg-surface-2 px-3 py-2 font-mono text-[11px] leading-relaxed">{g.text}</pre>
                </details>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
