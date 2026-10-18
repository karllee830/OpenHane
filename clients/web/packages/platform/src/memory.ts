import type { IdentityStore, KeyValueStore } from './index';

/** 内存实现：测试和不能持久化的环境使用。 */
export class MemoryIdentityStore implements IdentityStore {
  constructor(private seed: Uint8Array = crypto.getRandomValues(new Uint8Array(32))) {}
  async getMasterSeed(): Promise<Uint8Array> {
    return this.seed;
  }
}

export class MemoryKeyValueStore implements KeyValueStore {
  private map = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.map.get(key) as T | undefined;
  }
  set<T>(key: string, value: T): void {
    this.map.set(key, value);
  }
}
