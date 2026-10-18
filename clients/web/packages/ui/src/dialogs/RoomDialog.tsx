// 新建 / 编辑房间和输入房间密码。
import type { Room } from '@hane/protocol';
import { E2EEMode, RoomKind } from '@hane/protocol';
import { useState } from 'react';
import { Dialog } from '../components/Dialog';
import { describeError } from '../errors';
import { useT } from '../i18n';
import { useClient, useServices } from '../services';

const input = 'w-full rounded-md border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent';
const TIMEOUTS = [0, 300, 1800, 7200, 86400];
const AUDIO_KBPS = [0, 16, 24, 32, 48];

function Check({ checked, onChange, children, disabled, testId }: { checked: boolean; onChange: (v: boolean) => void; children: React.ReactNode; disabled?: boolean; testId?: string }) {
  return (
    <label className={`flex items-center gap-2 text-sm ${disabled ? 'opacity-60' : ''}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} data-testid={testId} />
      {children}
    </label>
  );
}

export function RoomDialog({ room, onClose, onNotice }: { room?: Room; onClose: () => void; onNotice: (m: string) => void }) {
  const t = useT();
  const { client } = useServices();
  const e2eeMode = useClient((s) => s.media?.policy?.e2ee?.mode ?? E2EEMode.E2EE_MODE_OFF);
  const isMain = room?.kind === RoomKind.MAIN;
  const [name, setName] = useState(room?.name ?? '');
  const [password, setPassword] = useState('');
  const [clearPassword, setClearPassword] = useState(false);
  const [locked, setLocked] = useState(room?.locked ?? false);
  const [capacity, setCapacity] = useState(room?.capacity ?? 0);
  const [timeout, setTimeoutSec] = useState(room?.emptyTimeoutSec ?? 300);
  const [screenMod, setScreenMod] = useState(room?.overrides?.screenModeratorOnly ?? false);
  const [cameraMod, setCameraMod] = useState(room?.overrides?.cameraModeratorOnly ?? false);
  const [e2ee, setE2ee] = useState(room?.overrides?.e2ee ?? false);
  const [audioKbps, setAudioKbps] = useState(room?.overrides?.audioMaxKbps ?? 0);
  const [join, setJoin] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const overrides = { screenModeratorOnly: screenMod, cameraModeratorOnly: cameraMod, e2ee, audioMaxKbps: audioKbps };

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      if (!room) {
        await client.createRoom({ name: name.trim(), password, locked, capacity, emptyTimeoutSec: timeout, overrides, join });
      } else if (isMain) {
        await client.updateRoom(room.id, { capacity, overrides });
      } else {
        await client.updateRoom(room.id, {
          name: name.trim(),
          password: clearPassword ? '' : password || undefined,
          locked,
          capacity,
          emptyTimeoutSec: timeout,
          overrides,
        });
      }
      onNotice(room ? t('room.saved') : t('room.created', { name: name.trim() }));
      onClose();
    } catch (e) {
      setErr(describeError(e, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={room ? t('room.editTitle', { name: room.name || t('room.main') }) : t('room.createTitle')}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {!isMain && (
          <>
            <label className="block text-sm">
              {t('room.name')}
              <input className={`${input} mt-1`} value={name} maxLength={40} required autoFocus onChange={(e) => setName(e.target.value)} data-testid="room-name" />
            </label>
            <label className="block text-sm">
              {t('room.password')}
              <input
                className={`${input} mt-1`}
                type="password"
                autoComplete="new-password"
                value={password}
                disabled={clearPassword}
                placeholder={room?.hasPassword ? t('room.passwordKeep') : t('room.passwordNone')}
                onChange={(e) => setPassword(e.target.value)}
                data-testid="room-password"
              />
            </label>
            {room?.hasPassword && (
              <Check checked={clearPassword} onChange={setClearPassword}>
                {t('room.passwordClear')}
              </Check>
            )}
            <Check checked={locked} onChange={setLocked}>
              {t('room.lockedHint')}
            </Check>
          </>
        )}
        <div className="flex gap-3">
          <label className="block flex-1 text-sm">
            {t('room.capacity')}
            <input className={`${input} mt-1`} type="number" min={0} value={capacity} onChange={(e) => setCapacity(Math.max(0, Number(e.target.value)))} />
          </label>
          {!isMain && (
            <label className="block flex-1 text-sm">
              {t('room.emptyTimeout')}
              <select className={`${input} mt-1`} value={timeout} onChange={(e) => setTimeoutSec(Number(e.target.value))}>
                {TIMEOUTS.map((s) => (
                  <option key={s} value={s}>
                    {s === 0 ? t('room.timeoutNow') : s < 3600 ? t('time.minutes', { n: s / 60 }) : t('time.hours', { n: s / 3600 })}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        <fieldset className="space-y-2 rounded-md border border-border p-3">
          <legend className="px-1 text-xs text-muted">{t('room.overrides')}</legend>
          <Check checked={screenMod} onChange={setScreenMod}>
            {t('room.screenModOnly')}
          </Check>
          <Check checked={cameraMod} onChange={setCameraMod}>
            {t('room.cameraModOnly')}
          </Check>
          <Check checked={e2eeMode === E2EEMode.E2EE_MODE_REQUIRED || e2ee} onChange={setE2ee} disabled={e2eeMode !== E2EEMode.E2EE_MODE_OPTIONAL} testId="room-e2ee">
            {e2eeMode === E2EEMode.E2EE_MODE_REQUIRED ? t('room.e2eeRequired') : e2eeMode === E2EEMode.E2EE_MODE_OPTIONAL ? t('room.e2ee') : t('room.e2eeOff')}
          </Check>
          <label className="flex items-center gap-2 text-sm">
            {t('room.audioMax')}
            <select className="rounded-md border border-border bg-bg px-2 py-1 text-sm" value={audioKbps} onChange={(e) => setAudioKbps(Number(e.target.value))}>
              {AUDIO_KBPS.map((k) => (
                <option key={k} value={k}>
                  {k === 0 ? t('room.audioNoLimit') : `${k} kbps`}
                </option>
              ))}
            </select>
          </label>
        </fieldset>
        {!room && (
          <Check checked={join} onChange={setJoin}>
            {t('room.joinAfterCreate')}
          </Check>
        )}
        {err && <p className="text-sm text-danger">{err}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className="rounded-md border border-border px-4 py-2 text-sm" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" disabled={busy || (!isMain && !name.trim())} className="rounded-md bg-accent-solid px-4 py-2 text-sm text-white disabled:opacity-50" data-testid="room-submit">
            {room ? t('admin.save') : t('room.createSubmit')}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export function RoomPasswordDialog({ room, onClose }: { room: Room; onClose: () => void }) {
  const t = useT();
  const { client } = useServices();
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={t('room.passwordTitle', { name: room.name })}>
      <form
        className="space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await client.joinRoom(room.id, password);
            onClose();
          } catch (e2) {
            setErr(describeError(e2, t));
          }
        }}
      >
        <input className={input} type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} aria-label={t('room.password')} data-testid="room-password-input" />
        {err && <p className="text-sm text-danger">{err}</p>}
        <div className="flex justify-end">
          <button type="submit" className="rounded-md bg-accent-solid px-4 py-2 text-sm text-white">
            {t('room.enter')}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
