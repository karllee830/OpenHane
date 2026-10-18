// KeyboardEvent.code → libuiohook 键码（uiohook-napi 的 UiohookKey）。设置界面用浏览器的 code 记录热键，
// 全局钩子收到的是 libuiohook 键码，两边在这里对齐。鼠标侧键用 Mouse4 / Mouse5 表示。

const UIOHOOK: Record<string, number> = {
  Backspace: 14, Tab: 15, Enter: 28, CapsLock: 58, Escape: 1, Space: 57,
  PageUp: 3657, PageDown: 3665, End: 3663, Home: 3655,
  ArrowLeft: 57419, ArrowUp: 57416, ArrowRight: 57421, ArrowDown: 57424, Insert: 3666, Delete: 3667,
  Digit0: 11, Digit1: 2, Digit2: 3, Digit3: 4, Digit4: 5, Digit5: 6, Digit6: 7, Digit7: 8, Digit8: 9, Digit9: 10,
  KeyA: 30, KeyB: 48, KeyC: 46, KeyD: 32, KeyE: 18, KeyF: 33, KeyG: 34, KeyH: 35, KeyI: 23, KeyJ: 36, KeyK: 37,
  KeyL: 38, KeyM: 50, KeyN: 49, KeyO: 24, KeyP: 25, KeyQ: 16, KeyR: 19, KeyS: 31, KeyT: 20, KeyU: 22, KeyV: 47,
  KeyW: 17, KeyX: 45, KeyY: 21, KeyZ: 44,
  Numpad0: 82, Numpad1: 79, Numpad2: 80, Numpad3: 81, Numpad4: 75, Numpad5: 76, Numpad6: 77, Numpad7: 71,
  Numpad8: 72, Numpad9: 73, NumpadMultiply: 55, NumpadAdd: 78, NumpadSubtract: 74, NumpadDecimal: 83, NumpadDivide: 3637,
  F1: 59, F2: 60, F3: 61, F4: 62, F5: 63, F6: 64, F7: 65, F8: 66, F9: 67, F10: 68, F11: 87, F12: 88,
  F13: 91, F14: 92, F15: 93, F16: 99, F17: 100, F18: 101, F19: 102, F20: 103, F21: 104, F22: 105, F23: 106, F24: 107,
  Semicolon: 39, Equal: 13, Comma: 51, Minus: 12, Period: 52, Slash: 53, Backquote: 41,
  BracketLeft: 26, Backslash: 43, BracketRight: 27, Quote: 40,
  ControlLeft: 29, ControlRight: 3613, AltLeft: 56, AltRight: 3640, ShiftLeft: 42, ShiftRight: 54,
  MetaLeft: 3675, MetaRight: 3676, NumLock: 69, ScrollLock: 70, PrintScreen: 3639,
};

export type HotkeyTarget = { kind: 'key'; keycode: number } | { kind: 'mouse'; button: number };

/** libuiohook 的鼠标按键编号：1 左、2 右、3 中、4 后退、5 前进 */
export function hotkeyTarget(code: string): HotkeyTarget | null {
  if (code === 'Mouse4') return { kind: 'mouse', button: 4 };
  if (code === 'Mouse5') return { kind: 'mouse', button: 5 };
  const k = UIOHOOK[code];
  return k === undefined ? null : { kind: 'key', keycode: k };
}
