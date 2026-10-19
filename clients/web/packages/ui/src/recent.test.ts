import { MemoryKeyValueStore } from '@hane/platform';
import { describe, expect, it } from 'vitest';
import { MAX_RECENT, cleanServerName, connectTarget, findRecent, forgetServer, loadRecent, matchesServer, relativeTime, rememberServer, serverSubtitle, serverTitle, updateServer, withoutInvite } from './recent';

describe('recent servers', () => {
  it('migrates the old address-only list', () => {
    const s = new MemoryKeyValueStore();
    s.set('recent', ['a.example.com', '10.0.0.2:9900']);
    expect(loadRecent(s)).toEqual([
      { address: 'a.example.com', name: '', at: 0 },
      { address: '10.0.0.2:9900', name: '', at: 0 },
    ]);
  });

  it('puts the latest server first, dedupes equivalent addresses and keeps at most five', () => {
    const s = new MemoryKeyValueStore();
    for (let i = 0; i < 7; i++) rememberServer(s, { address: `s${i}.example.com`, name: `S${i}`, at: i });
    expect(loadRecent(s).map((r) => r.address)).toEqual(['s6.example.com', 's5.example.com', 's4.example.com', 's3.example.com', 's2.example.com']);
    expect(loadRecent(s)).toHaveLength(MAX_RECENT);

    rememberServer(s, { address: 's3.example.com:9800', name: 'S3 新名字', at: 10, password: true });
    const list = loadRecent(s);
    expect(list[0]).toEqual({ address: 's3.example.com:9800', name: 'S3 新名字', at: 10, password: true });
    expect(list.filter((r) => r.name.startsWith('S3'))).toHaveLength(1);
    expect(findRecent(list, 's3.example.com')?.password).toBe(true);
    expect(findRecent(list, 'https://s3.example.com')).toBeUndefined(); // 443 端口：不是同一台
    expect(findRecent(list, '  ')).toBeUndefined();

    expect(forgetServer(s, 's3.example.com:9800').map((r) => r.address)).not.toContain('s3.example.com:9800');
    expect(loadRecent(s)).toHaveLength(MAX_RECENT - 1);
  });

  it('keeps favorites, notes and nicknames', () => {
    const s = new MemoryKeyValueStore();
    rememberServer(s, { address: 'fav.example.com', name: 'Fav', at: 1, nickname: 'Karl' });
    updateServer(s, 'fav.example.com', { favorite: true, note: '研发组' });
    // 收藏的不受条数限制，也不占最近连接的名额
    for (let i = 0; i < 7; i++) rememberServer(s, { address: `s${i}.example.com`, name: '', at: 10 + i });
    let list = loadRecent(s);
    expect(list).toHaveLength(MAX_RECENT + 1);
    expect(findRecent(list, 'fav.example.com')).toEqual({ address: 'fav.example.com', name: 'Fav', at: 1, nickname: 'Karl', favorite: true, note: '研发组' });

    // 再次连接：更新昵称，保留收藏和备注
    rememberServer(s, { address: 'fav.example.com', name: 'Fav', at: 99, nickname: 'K' });
    list = loadRecent(s);
    expect(list[0]).toEqual({ address: 'fav.example.com', name: 'Fav', at: 99, nickname: 'K', favorite: true, note: '研发组' });

    // 取消收藏、清空备注：字段去掉，重新受条数限制
    updateServer(s, 'fav.example.com', { favorite: false, note: '' });
    expect(loadRecent(s)[0]).toEqual({ address: 'fav.example.com', name: 'Fav', at: 99, nickname: 'K' });
    expect(loadRecent(s)).toHaveLength(MAX_RECENT);
  });

  it('searches the list from the address bar', () => {
    const list = [
      { address: '10.0.0.25', name: '', at: 3, nickname: '小李' },
      { address: 'meet.example.com', name: '研发组', at: 2, note: 'Dev' },
    ];
    expect(list.filter((r) => matchesServer(r, '研发')).map((r) => r.address)).toEqual(['meet.example.com']);
    expect(list.filter((r) => matchesServer(r, 'dev')).map((r) => r.address)).toEqual(['meet.example.com']);
    expect(list.filter((r) => matchesServer(r, '小李')).map((r) => r.address)).toEqual(['10.0.0.25']);
    expect(list.filter((r) => matchesServer(r, 'karl', 'Karl')).map((r) => r.address)).toEqual(['meet.example.com']);
    // 搜索词：连第一台匹配的；完整地址：连这个地址（即使与列表里的某个地址前缀相同）
    expect(connectTarget(list, list.filter((r) => matchesServer(r, '研发')), '研发')).toBe('meet.example.com');
    expect(connectTarget(list, list.filter((r) => matchesServer(r, '10.0.0.2')), '10.0.0.2')).toBe('10.0.0.2');
    expect(connectTarget(list, [], 'meet.example.com:9800')).toBe('meet.example.com');
    expect(connectTarget(list, [], 'newhost')).toBe('newhost');
  });

  it('shows the note with the server name beside it', () => {
    expect(cleanServerName('OpenHane')).toBe('');
    const r = { address: 'meet.example.com', name: '研发组', note: '公司' };
    expect(serverTitle(r)).toBe('公司');
    expect(serverSubtitle(r)).toBe('研发组');
    expect(serverTitle({ address: 'meet.example.com', name: '研发组' })).toBe('研发组');
    expect(serverTitle({ address: 'meet.example.com', name: 'OpenHane' })).toBe('meet.example.com');
    expect(serverSubtitle({ name: '研发组', note: '研发组' })).toBe('');
    // 旧记录里没清洗过的名称，显示时也清洗
    expect(serverTitle({ address: 'a', name: 'x\u202ey' })).toBe('xy');
  });

  it('does not keep invite codes', () => {
    expect(withoutInvite('https://meet.example.com/j/abcdEFGH')).toBe('meet.example.com:443');
    expect(withoutInvite('http://10.0.0.2:9800/j/abcdEFGH')).toBe('http://10.0.0.2:9800');
    expect(withoutInvite(' meet.example.com ')).toBe('meet.example.com');
    const s = new MemoryKeyValueStore();
    rememberServer(s, { address: 'openhane://meet.example.com?invite=xyz12345', name: '', at: 1 });
    expect(loadRecent(s)[0]!.address).toBe('meet.example.com:9800');
  });

  it('formats relative times', () => {
    const now = Date.UTC(2026, 9, 14, 12);
    expect(relativeTime(now - 20_000, 'en', undefined, now)).toBe('now');
    expect(relativeTime(now - 20_000, 'zh-CN', '刚刚', now)).toBe('刚刚');
    expect(relativeTime(now - 5 * 60_000, 'en', 'just now', now)).toBe('5 minutes ago');
    expect(relativeTime(now - 3 * 3600_000, 'en', undefined, now)).toBe('3 hours ago');
    expect(relativeTime(now - 86400_000, 'en', undefined, now)).toBe('yesterday');
    expect(relativeTime(now - 3 * 86400_000, 'zh-CN', undefined, now)).toBe('3天前');
    expect(relativeTime(now - 400 * 86400_000, 'zh-CN', undefined, now)).toBe('去年');
  });
});
