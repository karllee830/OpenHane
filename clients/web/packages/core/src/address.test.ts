import { describe, expect, it } from 'vitest';
import { candidateAddresses, controlUrl, displayAddress, mediaUrl, parseAddress } from './address';

describe('parseAddress', () => {
  it.each([
    ['meet.example.com', { host: 'meet.example.com', port: 9800, secure: true, portImplicit: true }],
    ['meet.example.com:443', { host: 'meet.example.com', port: 443, secure: true }],
    ['203.0.113.10', { host: '203.0.113.10', port: 9800, secure: true, portImplicit: true }],
    ['203.0.113.10:9800', { host: '203.0.113.10', port: 9800, secure: true }],
    ['[2001:db8::1]:9800', { host: '2001:db8::1', port: 9800, secure: true }],
    ['2001:db8::1', { host: '2001:db8::1', port: 9800, secure: true, portImplicit: true }],
    ['[2001:db8::1]', { host: '2001:db8::1', port: 9800, secure: true, portImplicit: true }],
    ['http://localhost:9800', { host: 'localhost', port: 9800, secure: false }],
    ['https://meet.example.com/j/AbC123', { host: 'meet.example.com', port: 443, secure: true, invite: 'AbC123' }],
    ['openhane://meet.example.com?invite=x1', { host: 'meet.example.com', port: 9800, secure: true, invite: 'x1' }],
  ])('%s', (input, want) => {
    expect(parseAddress(input)).toEqual({ invite: undefined, ...want });
  });

  it('rejects bad input', () => {
    for (const bad of ['', 'host:port', 'ftp://x', 'host:70000']) expect(() => parseAddress(bad)).toThrow();
  });

  it('tries 9800 then 443 only when neither scheme nor port is given', () => {
    expect(candidateAddresses(parseAddress('meet.example.com')).map((a) => a.port)).toEqual([9800, 443]);
    for (const explicit of ['meet.example.com:9800', 'https://meet.example.com', 'openhane://meet.example.com', 'http://meet.example.com']) {
      expect(candidateAddresses(parseAddress(explicit))).toHaveLength(1);
    }
  });

  it('builds urls', () => {
    const a = parseAddress('[::1]:9850');
    expect(controlUrl(a)).toBe('wss://[::1]:9850/ws');
    expect(mediaUrl(parseAddress('http://localhost:9800'))).toBe('ws://localhost:9800');
    expect(displayAddress(parseAddress('meet.example.com'))).toBe('meet.example.com');
  });
});
