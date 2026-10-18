import { describe, expect, it } from 'vitest';
import { hotkeyTarget } from './keymap';

describe('hotkeyTarget', () => {
  it('maps browser key codes to libuiohook', () => {
    expect(hotkeyTarget('Backquote')).toEqual({ kind: 'key', keycode: 41 });
    expect(hotkeyTarget('KeyV')).toEqual({ kind: 'key', keycode: 47 });
    expect(hotkeyTarget('ControlLeft')).toEqual({ kind: 'key', keycode: 29 });
    expect(hotkeyTarget('F13')).toEqual({ kind: 'key', keycode: 91 });
    expect(hotkeyTarget('Mouse5')).toEqual({ kind: 'mouse', button: 5 });
    expect(hotkeyTarget('IntlRo')).toBeNull();
  });
});
