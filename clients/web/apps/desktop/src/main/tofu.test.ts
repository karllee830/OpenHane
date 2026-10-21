/// <reference types="node" />
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { PinStore, Tofu, formatFingerprint, splitHostPort } from './tofu';

vi.mock('electron', () => ({}));

describe('TOFU preflight', () => {
  const spkiA = Buffer.alloc(32, 1);
  const spkiB = Buffer.alloc(32, 2);

  it('splits host and port', () => {
    expect(splitHostPort('127.0.0.1:9800')).toEqual({ host: '127.0.0.1', port: 9800 });
    expect(splitHostPort('[::1]:9850')).toEqual({ host: '::1', port: 9850 });
    expect(splitHostPort('Meet.Example.com:443')).toEqual({ host: 'Meet.Example.com', port: 443 });
  });

  it('pins on first use, allows the same key, blocks a different key until accepted', async () => {
    const pins = new PinStore(join(mkdtempSync(join(tmpdir(), 'hane-pins-')), 'pins.json'));
    let current = spkiA;
    const mismatches: string[] = [];
    const tofu = new Tofu({} as never, pins, (h, e, a) => mismatches.push(`${h} ${e} ${a}`), async () => ({ spki: current, authorized: false }));

    expect(await tofu.beforeConnect('Server.Local:9800')).toEqual({ allowed: true });
    expect(pins.get('server.local')).toBe(formatFingerprint(spkiA));
    expect(tofu.seenSpki('server.local:9800')).toEqual(spkiA);
    expect(await tofu.beforeConnect('server.local:9800')).toEqual({ allowed: true });

    current = spkiB;
    const v = await tofu.beforeConnect('server.local:9800');
    expect(v.allowed).toBe(false);
    expect(mismatches).toHaveLength(1);
    tofu.accept('server.local', formatFingerprint(spkiB));
    expect(await tofu.beforeConnect('server.local:9800')).toEqual({ allowed: true });
  });

  it('does not pin CA-signed certificates or unreachable servers', async () => {
    const pins = new PinStore(join(mkdtempSync(join(tmpdir(), 'hane-pins-')), 'pins.json'));
    const tofu = new Tofu({} as never, pins, () => {}, async (host) => (host === 'down' ? null : { spki: spkiA, authorized: true }));
    expect(await tofu.beforeConnect('valid.example:443')).toEqual({ allowed: true });
    expect(pins.get('valid.example')).toBeUndefined();
    expect(await tofu.beforeConnect('down:9800')).toEqual({ allowed: true });
  });

  it('check reports a changed key without pinning or warning', async () => {
    const pins = new PinStore(join(mkdtempSync(join(tmpdir(), 'hane-pins-')), 'pins.json'));
    let current = spkiA;
    const mismatches: string[] = [];
    const tofu = new Tofu({} as never, pins, (h) => mismatches.push(h), async () => ({ spki: current, authorized: false }));

    expect(await tofu.check('Server.Local:9800')).toBe(true);
    expect(pins.get('server.local')).toBeUndefined();
    pins.set('server.local', formatFingerprint(spkiA));
    expect(await tofu.check('Server.Local:9800')).toBe(true);
    current = spkiB;
    expect(await tofu.check('server.local:9800')).toBe(false);
    expect(mismatches).toHaveLength(0);
  });
});
