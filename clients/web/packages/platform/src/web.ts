import type { IdentityStore, KeyValueStore, PlatformServices } from './index';
import { MemoryIdentityStore, MemoryKeyValueStore } from './memory';

const DB = 'openhane';
const STORE = 'identity';
const SEED_KEY = 'master-seed';

function idb<T>(mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction(STORE, mode);
      const req = op(tx.objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => open.result.close();
    };
  });
}

/** 浏览器：主种子存在 IndexedDB（跟随浏览器配置文件；清除站点数据会丢失）。 */
class IndexedDbIdentityStore implements IdentityStore {
  private cached?: Promise<Uint8Array>;
  getMasterSeed(): Promise<Uint8Array> {
    this.cached ??= (async () => {
      const existing = await idb<Uint8Array | undefined>('readonly', (s) => s.get(SEED_KEY));
      if (existing instanceof Uint8Array && existing.length === 32) return existing;
      const seed = crypto.getRandomValues(new Uint8Array(32));
      await idb('readwrite', (s) => s.put(seed, SEED_KEY));
      return seed;
    })();
    return this.cached;
  }
}

class LocalStorageKeyValueStore implements KeyValueStore {
  constructor(private prefix = 'hane.') {}
  get<T>(key: string): T | undefined {
    try {
      const raw = localStorage.getItem(this.prefix + key);
      return raw == null ? undefined : (JSON.parse(raw) as T);
    } catch {
      return undefined;
    }
  }
  set<T>(key: string, value: T): void {
    try {
      localStorage.setItem(this.prefix + key, JSON.stringify(value));
    } catch {
      // 隐私模式或存储被禁用：放弃持久化
    }
  }
}

export function createWebPlatform(): PlatformServices {
  const hasIdb = typeof indexedDB !== 'undefined';
  let storage: KeyValueStore;
  try {
    localStorage.getItem('hane.probe');
    storage = new LocalStorageKeyValueStore();
  } catch {
    storage = new MemoryKeyValueStore();
  }
  return {
    kind: 'web',
    identity: hasIdb ? new IndexedDbIdentityStore() : new MemoryIdentityStore(),
    storage,
  };
}
