// 主进程一侧的全局按键说话：按需启动热键进程，只把注册的那个键的按下 / 松开转给渲染进程。

import { join } from 'node:path';
import { systemPreferences, utilityProcess, type UtilityProcess } from 'electron';
import { hotkeyTarget, type HotkeyTarget } from '../shared/keymap';

export class PushToTalkHost {
  private proc: UtilityProcess | null = null;
  private target: HotkeyTarget | null = null;
  private pressed = false;

  constructor(
    private readonly dir: string,
    private readonly onChange: (pressed: boolean) => void,
    private readonly log: (msg: string) => void,
  ) {}

  /** 不可用的原因代码（null 表示可用，界面负责翻译）。macOS 上 libuiohook 需要「辅助功能」权限。 */
  static unavailableReason(): string | null {
    if (process.platform === 'darwin' && !systemPreferences.isTrustedAccessibilityClient(false)) {
      return 'macos-accessibility';
    }
    return null;
  }

  register(code: string): void {
    this.target = code ? hotkeyTarget(code) : null;
    this.setPressed(false);
    if (!this.target) {
      if (code) this.log(`unsupported push-to-talk key ${code}`);
      return;
    }
    if (process.platform === 'darwin' && !systemPreferences.isTrustedAccessibilityClient(true)) {
      return; // 已弹出系统授权提示；授权后重新选择按键即可生效
    }
    this.ensureProcess();
  }

  private ensureProcess() {
    if (this.proc) return;
    const proc = utilityProcess.fork(join(this.dir, 'hotkeys.cjs'), [], { serviceName: 'OpenHane Hotkeys' });
    proc.on('message', (m: { t: string; k?: number; b?: number }) => {
      const t = this.target;
      if (!t) return;
      if (t.kind === 'key' && (m.t === 'down' || m.t === 'up') && m.k === t.keycode) this.setPressed(m.t === 'down');
      if (t.kind === 'mouse' && (m.t === 'mdown' || m.t === 'mup') && m.b === t.button) this.setPressed(m.t === 'mdown');
    });
    proc.on('exit', (code) => {
      this.log(`hotkey process exited (${code})`);
      this.proc = null;
      this.setPressed(false);
    });
    this.proc = proc;
  }

  /** 按住时键盘会重复发送 keydown，只在状态变化时通知 */
  private setPressed(p: boolean) {
    if (p === this.pressed) return;
    this.pressed = p;
    this.onChange(p);
  }

  dispose(): void {
    this.proc?.kill();
    this.proc = null;
  }
}
